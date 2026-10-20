import { PtyConnection, type Shardflux } from "@shardflux/sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import { resolveExecutionBackend } from "./ExecutionBackend.ts";
import * as ShardfluxCloud from "./ShardfluxCloud.ts";
import * as ThreadBindings from "./ThreadBindings.ts";

const WAITING_NOTICE =
  "\x1b[2mShardflux: this thread's cloud computer starts with its first message. " +
  "This terminal connects to it then.\x1b[0m\r\n";
const NO_KEY_NOTICE =
  "\x1b[31mShardflux: no API key on this machine. Run `shard setup` (or set SHARDFLUX_API_KEY) " +
  "and open the terminal again.\x1b[0m\r\n";
const BINDING_POLL = "3 seconds";
const WAKE_TIMEOUT_MS = 120_000;
/** Input typed while the VM shell is still opening; more than this is dropped rather than held unbounded. */
const PENDING_INPUT_LIMIT = 64 * 1024;
// Above Linux's pid_max and macOS's 99,998: the terminal manager's local process-table polls never match a real process.
const REMOTE_PID_BASE = 2_000_000_000;
let nextRemotePid = REMOTE_PID_BASE;

export interface RemotePtySource {
  readonly resolveBinding: Effect.Effect<ThreadBindings.ShardfluxConversationBinding | null>;
  readonly client: Effect.Effect<Shardflux | null>;
}

/** What the connection reports to the terminal it serves. */
interface RemotePtySink {
  readonly size: () => { readonly cols: number; readonly rows: number };
  readonly data: (text: string) => void;
  readonly exit: (event: PtyAdapter.PtyExitEvent) => void;
  readonly attached: (connection: PtyConnection | undefined) => void;
}

/** The innermost message: promise failures arrive wrapped, and the SDK's error is their cause. */
function failureMessage(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    const next = current instanceof Error ? current.cause : undefined;
    if (!(next instanceof Error)) break;
    current = next;
  }
  return current instanceof Error && current.message ? current.message : "the VM terminal failed";
}

const waitForBinding = Effect.fn("ShardfluxPty.waitForBinding")(function* (
  source: RemotePtySource,
  sink: RemotePtySink,
) {
  let noticed = false;
  for (;;) {
    const binding = yield* source.resolveBinding;
    if (binding) return binding;
    if (!noticed) {
      sink.data(WAITING_NOTICE);
      noticed = true;
    }
    yield* Effect.sleep(BINDING_POLL);
  }
});

/** A login shell in the conversation VM's worktree, attached until it exits or the terminal is killed. */
const connect = Effect.fn("ShardfluxPty.connect")(function* (
  source: RemotePtySource,
  sink: RemotePtySink,
  term: string,
) {
  const client = yield* source.client;
  if (client === null) {
    sink.data(NO_KEY_NOTICE);
    sink.exit({ exitCode: 1, signal: null });
    return;
  }
  const binding = yield* waitForBinding(source, sink);
  const workspace = yield* Effect.tryPromise(() => client.workspaces.get(binding.workspaceId));
  if (!workspace.ready) {
    yield* Effect.tryPromise((signal) => workspace.wake({ timeoutMs: WAKE_TIMEOUT_MS, signal }));
  }
  const cell = yield* Effect.acquireRelease(
    Effect.sync(() => workspace.cell()),
    (opened) => Effect.sync(() => opened.close()),
  );
  const size = sink.size();
  const session = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      cell.pty.open({
        argv: ["bash", "-l"],
        cwd: binding.worktreePath,
        rows: size.rows,
        cols: size.cols,
        env: { TERM: term, COLORTERM: "truecolor" },
      }),
    ),
    (opened) => Effect.promise(() => cell.pty.close(opened.session_id).catch(() => undefined)),
  );
  yield* Effect.tryPromise(async (signal) => {
    const connection = await PtyConnection.attach(cell, session.session_id, 0, signal);
    await connection.ready;
    sink.attached(connection);
    const current = sink.size();
    connection.resize(current.rows, current.cols);
    const decoder = new TextDecoder();
    try {
      for await (const message of connection.messages()) {
        if (message.type === "output" && message.data) {
          const text = decoder.decode(Buffer.from(message.data, "base64"), { stream: true });
          if (text) sink.data(text);
        } else if (message.type === "exit") {
          sink.exit({
            exitCode: message.session?.exit_code ?? 0,
            signal: message.session?.term_signal ?? null,
          });
          return;
        } else if (message.type === "error") {
          throw new Error(message.error?.error.message ?? "the VM terminal failed");
        }
      }
      sink.exit({ exitCode: 0, signal: null });
    } finally {
      sink.attached(undefined);
      await connection.close({ force: true }).catch(() => undefined);
    }
  });
}, Effect.scoped);

/**
 * A login shell in the thread's conversation VM, in its worktree, behind T3's local PTY interface. Output, input
 * and resizes travel over the VM's PTY attachment; killing the terminal closes the VM's shell session.
 */
export class ShardfluxPtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = nextRemotePid++;
  private readonly encoder = new TextEncoder();
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private connection: PtyConnection | undefined;
  private pendingInput: Uint8Array[] = [];
  private pendingInputBytes = 0;
  private size: { cols: number; rows: number };
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;
  private replay = "";
  private fiber: Fiber.Fiber<void> | undefined;

  private constructor(size: { cols: number; rows: number }) {
    this.size = size;
  }

  /** Opens the terminal; its connection to the VM runs detached until the shell exits or the terminal is killed. */
  static readonly open = Effect.fn("ShardfluxPty.open")(function* (
    size: { cols: number; rows: number },
    source: RemotePtySource,
    term: string,
  ) {
    const terminal = new ShardfluxPtyProcess(size);
    terminal.fiber = yield* Effect.forkDetach(
      connect(source, terminal.sink(), term).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.sync(() => {
                terminal.emitData(
                  `\r\n\x1b[31mShardflux terminal: ${failureMessage(Cause.squash(cause))}\x1b[0m\r\n`,
                );
                terminal.emitExit({ exitCode: 1, signal: null });
              }),
        ),
      ),
    );
    return terminal;
  });

  write(data: string): void {
    const bytes = this.encoder.encode(data);
    if (this.connection) {
      this.connection.input(bytes);
      return;
    }
    if (this.pendingInputBytes + bytes.length > PENDING_INPUT_LIMIT) return;
    this.pendingInput.push(bytes);
    this.pendingInputBytes += bytes.length;
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    this.connection?.resize(rows, cols);
  }

  kill(): void {
    if (this.exitEvent) return;
    this.emitExit({ exitCode: 0, signal: 15 });
    if (this.fiber) Effect.runFork(Fiber.interrupt(this.fiber));
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    // Output written before the manager subscribed (the waiting notice) is not lost.
    if (this.replay) {
      callback(this.replay);
      this.replay = "";
    }
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent) {
      callback(this.exitEvent);
      return () => undefined;
    }
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  private sink(): RemotePtySink {
    return {
      size: () => this.size,
      data: (text) => this.emitData(text),
      exit: (event) => this.emitExit(event),
      attached: (connection) => {
        this.connection = connection;
        if (!connection) return;
        for (const bytes of this.pendingInput) connection.input(bytes);
        this.pendingInput = [];
        this.pendingInputBytes = 0;
      },
    };
  }

  private emitData(data: string): void {
    if (this.dataListeners.size === 0) this.replay += data;
    for (const listener of this.dataListeners) listener(data);
  }

  private emitExit(event: PtyAdapter.PtyExitEvent): void {
    if (this.exitEvent) return;
    this.exitEvent = event;
    for (const listener of this.exitListeners) listener(event);
    this.exitListeners.clear();
  }
}

/**
 * T3's PTY seam with Shardflux as the backend: a terminal that belongs to a thread runs in that thread's
 * conversation VM. Terminals without a thread, and every terminal with the local backend, stay on node-pty.
 */
export const make = Effect.gen(function* () {
  const local = yield* PtyAdapter.PtyAdapter;
  const environment = yield* HostProcess.Environment;
  const bindings = yield* ThreadBindings.ShardfluxThreadBindings;
  const cloud = yield* ShardfluxCloud.ShardfluxCloud;
  const backend = resolveExecutionBackend(environment);

  const spawn: PtyAdapter.PtyAdapter["Service"]["spawn"] = (input) => {
    if (backend === "local" || input.threadId === undefined) return local.spawn(input);
    const threadId = ThreadId.make(input.threadId);
    return ShardfluxPtyProcess.open(
      { cols: input.cols, rows: input.rows },
      { resolveBinding: bindings.resolve(threadId), client: cloud.client },
      input.env.TERM ?? "xterm-256color",
    );
  };
  return { spawn } satisfies PtyAdapter.PtyAdapter["Service"];
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make).pipe(
  Layer.provide(NodePtyAdapter.layer),
);
