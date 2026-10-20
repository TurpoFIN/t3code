import * as NodeOS from "node:os";

import { Shardflux } from "@shardflux/sdk";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe } from "vite-plus/test";

import { ShardfluxPtyProcess } from "./RemotePty.ts";
import * as ThreadBindings from "./ThreadBindings.ts";
import * as ThreadStatus from "./ThreadStatus.ts";
import {
  findConversationByName,
  localFolderOf,
  type ShardfluxConversationBinding,
} from "./ThreadBindings.ts";

/**
 * Against a real Shardflux conversation VM. Runs only with SHARDFLUX_API_KEY and
 * T3CODE_SHARDFLUX_LIVE_CONVERSATION (a conversation id this key's project can reach); CI skips it.
 */
const conversationId = process.env.T3CODE_SHARDFLUX_LIVE_CONVERSATION?.trim() ?? "";
const live = Boolean(process.env.SHARDFLUX_API_KEY?.trim() && conversationId);

const conversation = Effect.gen(function* () {
  const sdk = new Shardflux();
  const found = yield* Effect.tryPromise(() => sdk.conversations.get(conversationId));
  const binding: ShardfluxConversationBinding = {
    conversationId: found.id,
    workspaceId: found.workspace_id,
    worktreePath: found.worktree_path,
    branch: found.branch,
    baseCommit: found.base_commit,
    localFolder: localFolderOf(found.repo_remote),
  };
  return { sdk, found, binding };
});

/** A terminal on the conversation's VM with everything it prints collected. */
const openTerminal = (sdk: Shardflux, binding: ShardfluxConversationBinding) =>
  Effect.gen(function* () {
    let output = "";
    const terminal = yield* ShardfluxPtyProcess.open(
      { cols: 120, rows: 30 },
      { resolveBinding: Effect.succeed(binding), client: Effect.succeed(sdk) },
      "xterm-256color",
    );
    terminal.onData((data) => {
      output += data;
    });
    const exited = Effect.callback<{ exitCode: number; signal: number | null }>((resume) => {
      terminal.onExit((event) => resume(Effect.succeed(event)));
    });
    const waitFor = (text: string) =>
      Effect.gen(function* () {
        for (let polls = 0; polls < 360 && !output.includes(text); polls++) {
          yield* Effect.sleep("250 millis");
        }
        return output;
      });
    return { terminal, exited, waitFor, output: () => output };
  });

describe.runIf(live)("Shardflux live", () => {
  it.live("finds a thread's conversation by the branch shard acp gives it", () =>
    Effect.gen(function* () {
      const { sdk, found } = yield* conversation;
      const since = DateTime.formatIso(
        DateTime.subtract(DateTime.makeUnsafe(found.created_at), { hours: 1 }),
      );
      const name = found.branch.replace(/^shard\//, "");
      assert.strictEqual(yield* findConversationByName(sdk, name, since), found.id);
      assert.strictEqual(
        yield* findConversationByName(sdk, "acp-00000000000000000000000000000000", since),
        null,
      );
    }),
  );

  it.live("runs the thread's terminal in the conversation VM, in its worktree", () =>
    Effect.gen(function* () {
      const { sdk, found, binding } = yield* conversation;
      const workspace = yield* Effect.tryPromise(() => sdk.workspaces.get(found.workspace_id));
      if (!workspace.ready) yield* Effect.tryPromise(() => workspace.wake({ timeoutMs: 120_000 }));
      const cell = workspace.cell();
      const vmHostname = (yield* Effect.tryPromise(() =>
        cell.exec.run(["hostname"], { timeoutMs: 30_000 }),
      )).stdout.trim();
      cell.close();

      const { terminal, exited, output } = yield* openTerminal(sdk, binding);
      // Typed before the shell is up: the process holds it until the VM attachment opens.
      terminal.write(
        `printf 'live:%s:%s:%s\\n' "$(hostname)" "$PWD" "$(git branch --show-current)"; exit 7\n`,
      );
      const result = yield* exited.pipe(Effect.timeout("90 seconds"));

      assert.strictEqual(result.exitCode, 7);
      assert.include(output(), `live:${vmHostname}:${found.worktree_path}:${found.branch}`);
      assert.notStrictEqual(vmHostname, NodeOS.hostname());
    }),
  );

  it.live(
    "shows the thread's VM as running, named by its hostname, and then idle once it sleeps",
    () =>
      Effect.gen(function* () {
        const { sdk, found, binding } = yield* conversation;
        const workspace = yield* Effect.tryPromise(() => sdk.workspaces.get(found.workspace_id));
        if (!workspace.ready)
          yield* Effect.tryPromise(() => workspace.wake({ timeoutMs: 120_000 }));
        const cell = workspace.cell();
        const vmHostname = (yield* Effect.tryPromise(() =>
          cell.exec.run(["hostname"], { timeoutMs: 30_000 }),
        )).stdout.trim();
        cell.close();

        const bindings = Layer.succeed(ThreadBindings.ShardfluxThreadBindings, {
          resolve: () => Effect.succeed(binding),
          lookup: () => Effect.succeed({ _tag: "bound", binding, client: sdk } as const),
        });
        const firstStatus = Effect.gen(function* () {
          const service = yield* ThreadStatus.ShardfluxThreadStatusService;
          return yield* service.stream(ThreadId.make("live-status")).pipe(Stream.runHead);
        }).pipe(
          Effect.provide(ThreadStatus.layer.pipe(Layer.provide(bindings))),
          // The suite runs with T3CODE_EXECUTION_BACKEND=local for upstream's tests; this one is the Shardflux backend.
          Effect.provideService(HostProcess.Environment, {
            ...process.env,
            T3CODE_EXECUTION_BACKEND: "shardflux",
          }),
        );

        const running = yield* firstStatus;
        assert.deepStrictEqual(running._tag === "Some" ? running.value : null, {
          backend: "shardflux",
          state: "running",
          vmName: vmHostname,
          conversationId: found.id,
          reason: null,
        });
        assert.notStrictEqual(vmHostname, NodeOS.hostname());

        if (process.env.T3CODE_SHARDFLUX_LIVE_SUSPEND === "1") {
          const awake = yield* Effect.tryPromise(() => sdk.workspaces.get(found.workspace_id));
          yield* Effect.tryPromise(() => awake.suspend());
          const idle = yield* firstStatus;
          assert.strictEqual(idle._tag === "Some" ? idle.value.state : null, "idle");
        }
      }),
  );

  it.live("closes the VM shell when the terminal is killed", () =>
    Effect.gen(function* () {
      const { sdk, binding } = yield* conversation;
      const { terminal, exited, waitFor } = yield* openTerminal(sdk, binding);
      terminal.write("echo ready-$((40 + 2))\n");
      assert.include(yield* waitFor("ready-42"), "ready-42");
      terminal.kill();
      assert.deepStrictEqual(yield* exited, { exitCode: 0, signal: 15 });
    }),
  );
});
