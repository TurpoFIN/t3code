import type { Shardflux } from "@shardflux/sdk";
import type { ShardfluxThreadStatus, ShardfluxVmState, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { resolveExecutionBackend } from "./ExecutionBackend.ts";
import * as ThreadBindings from "./ThreadBindings.ts";

type Workspace = Awaited<ReturnType<Shardflux["workspaces"]["get"]>>;
type WorkspaceObservedState = Workspace["state"];

/**
 * A VM that is on its way, or that the next message will create or wake, is followed closely so the panel shows
 * it starting; a running or ended VM is read less often.
 */
const SETTLING_POLL = "1500 millis";
const SETTLED_POLL = "5 seconds";

export function vmStateOf(observed: WorkspaceObservedState): ShardfluxVmState {
  switch (observed) {
    case "creating":
    case "starting":
    case "resuming":
    case "forking":
      return "starting";
    case "running":
      return "running";
    case "suspending":
    case "suspended":
      return "idle";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

const status = (
  state: ShardfluxVmState,
  extra: Partial<Omit<ShardfluxThreadStatus, "backend" | "state">> = {},
): ShardfluxThreadStatus => ({
  backend: "shardflux",
  state,
  vmName: null,
  conversationId: null,
  reason: null,
  ...extra,
});

export const LOCAL_BACKEND_STATUS: ShardfluxThreadStatus = {
  backend: "local",
  state: "unavailable",
  vmName: null,
  conversationId: null,
  reason: null,
};

/** The status a binding lookup shows before the VM itself is read. */
export function statusOfLookup(
  lookup: Exclude<ThreadBindings.ShardfluxBindingLookup, { _tag: "bound" }>,
): ShardfluxThreadStatus {
  switch (lookup._tag) {
    case "no-client":
      return status("unavailable", { reason: "no-api-key" });
    case "not-started":
      return status("waiting");
    case "pending":
      return status("starting");
    case "failed":
      return status("unavailable", { reason: "api-unreachable" });
  }
}

export function sameStatus(left: ShardfluxThreadStatus, right: ShardfluxThreadStatus): boolean {
  return (
    left.backend === right.backend &&
    left.state === right.state &&
    left.vmName === right.vmName &&
    left.conversationId === right.conversationId &&
    left.reason === right.reason
  );
}

export class ShardfluxThreadStatusService extends Context.Service<
  ShardfluxThreadStatusService,
  {
    /** The thread's VM state now and on every change, read from the Shardflux API while subscribed. */
    readonly stream: (threadId: ThreadId) => Stream.Stream<ShardfluxThreadStatus>;
  }
>()("t3/shardflux/ThreadStatus/ShardfluxThreadStatusService") {}

export const make = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const bindings = yield* ThreadBindings.ShardfluxThreadBindings;
  // A workspace keeps its hostname for good; it is read once, from the running VM.
  const hostnames = new Map<string, string>();

  const hostnameOf = Effect.fn("ShardfluxThreadStatus.hostnameOf")(
    function* (workspace: Workspace) {
      const known = hostnames.get(workspace.id);
      if (known !== undefined) return known;
      if (!workspace.ready) return null;
      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() => workspace.cell()),
        (cell) => Effect.tryPromise(() => cell.exec.run(["hostname"], { timeoutMs: 15_000 })),
        (cell) => Effect.sync(() => cell.close()),
      );
      const hostname = result.stdout.trim();
      if (result.exitCode !== 0 || hostname === "") return null;
      hostnames.set(workspace.id, hostname);
      return hostname;
    },
    Effect.orElseSucceed(() => null),
  );

  const read = Effect.fn("ShardfluxThreadStatus.read")(function* (threadId: ThreadId) {
    const lookup = yield* bindings.lookup(threadId);
    if (lookup._tag !== "bound") return statusOfLookup(lookup);
    const { binding, client } = lookup;
    const workspace = yield* Effect.tryPromise(() =>
      client.workspaces.get(binding.workspaceId),
    ).pipe(Effect.option);
    if (workspace._tag === "None") {
      return status("unavailable", {
        reason: "api-unreachable",
        conversationId: binding.conversationId,
      });
    }
    const state = vmStateOf(workspace.value.state);
    const vmName =
      hostnames.get(binding.workspaceId) ??
      (state === "running" ? yield* hostnameOf(workspace.value) : null);
    return status(state, { vmName, conversationId: binding.conversationId });
  });

  const stream = (threadId: ThreadId): Stream.Stream<ShardfluxThreadStatus> =>
    resolveExecutionBackend(environment) === "local"
      ? Stream.succeed(LOCAL_BACKEND_STATUS)
      : Stream.callback<ShardfluxThreadStatus>((queue) =>
          Effect.gen(function* () {
            let last: ShardfluxThreadStatus | null = null;
            while (true) {
              const next = yield* read(threadId);
              // A failed read after a known state keeps showing that state rather than flickering.
              const transient = next.reason === "api-unreachable" && last !== null;
              if (!transient && (last === null || !sameStatus(last, next))) {
                last = next;
                yield* Queue.offer(queue, next);
              }
              const settling =
                last?.state === "starting" || last?.state === "waiting" || last?.state === "idle";
              yield* Effect.sleep(settling ? SETTLING_POLL : SETTLED_POLL);
            }
          }),
        );

  return { stream } satisfies ShardfluxThreadStatusService["Service"];
});

export const layer = Layer.effect(ShardfluxThreadStatusService, make);
