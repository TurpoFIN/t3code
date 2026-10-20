import type { Shardflux } from "@shardflux/sdk";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { isTerminalRunStatus } from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as ShardfluxCloud from "./ShardfluxCloud.ts";
import * as ThreadBindings from "./ThreadBindings.ts";

export class ShardfluxBranchLandingError extends Schema.TaggedError<ShardfluxBranchLandingError>()(
  "ShardfluxBranchLandingError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Shardflux branch landing failed: ${this.detail}`;
  }
}

/** Where a conversation's branch lands in the linked repository: `shard/<name>` arrives as `shardflux/<name>`. */
export function landedRefFor(branch: string): string | null {
  const match = /^shard\/([a-z0-9][a-z0-9-]{0,63})$/.exec(branch);
  return match ? `refs/remotes/shardflux/${match[1]}` : null;
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export type LandingOutcome =
  | { readonly status: "landed"; readonly ref: string; readonly tip: string }
  | {
      readonly status: "skipped";
      readonly reason: "no_binding" | "no_commits" | "up_to_date" | "no_folder";
    };

export class ShardfluxBranchLanding extends Context.Service<
  ShardfluxBranchLanding,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Brings the thread's conversation branch from its VM into the linked repository as a remote-tracking ref.
     * The checkout, its index and its branches are never touched: the files themselves already arrived through
     * the Shardflux project sync, and T3's own Git actions commit and push them.
     */
    readonly land: (threadId: ThreadId) => Effect.Effect<LandingOutcome>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/shardflux/BranchLanding/ShardfluxBranchLanding") {}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const bindings = yield* ThreadBindings.ShardfluxThreadBindings;
  const cloud = yield* ShardfluxCloud.ShardfluxCloud;
  const processes = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    processes
      .run({ command: "git", args: ["-C", cwd, ...args], timeout: "2 minutes" })
      .pipe(Effect.map((output) => ({ ok: output.code === 0, stdout: output.stdout.trim() })));

  const localFolderOf = Effect.fn("ShardfluxBranchLanding.localFolder")(function* (
    threadId: ThreadId,
    binding: ThreadBindings.ShardfluxConversationBinding,
  ) {
    if (binding.localFolder) return binding.localFolder;
    const { thread } = yield* projections.getThreadRecords(threadId, []);
    if (thread.worktreePath) return thread.worktreePath;
    const project = yield* projects.get(thread.projectId);
    return Option.isSome(project) ? project.value.workspaceRoot : null;
  });

  const vmGit = (client: Shardflux, binding: ThreadBindings.ShardfluxConversationBinding) =>
    Effect.acquireRelease(
      Effect.tryPromise(async () => {
        const workspace = await client.workspaces.get(binding.workspaceId);
        if (!workspace.ready) await workspace.wake({ timeoutMs: 120_000 });
        return workspace.cell();
      }),
      (cell) => Effect.sync(() => cell.close()),
    );

  const land = Effect.fn("ShardfluxBranchLanding.land")(
    function* (threadId: ThreadId) {
      const client = yield* cloud.client;
      const binding = yield* bindings.resolve(threadId);
      if (client === null || binding === null) {
        return { status: "skipped", reason: "no_binding" } satisfies LandingOutcome;
      }
      const ref = landedRefFor(binding.branch);
      const folder = yield* localFolderOf(threadId, binding);
      if (ref === null || folder === null) {
        return { status: "skipped", reason: "no_folder" } satisfies LandingOutcome;
      }
      const cell = yield* vmGit(client, binding);
      const tip = yield* Effect.tryPromise(() =>
        cell.exec.run(["git", "-C", binding.worktreePath, "rev-parse", "--verify", "-q", "HEAD"], {
          timeoutMs: 30_000,
        }),
      ).pipe(Effect.map((result) => result.stdout.trim()));
      if (!OBJECT_ID.test(tip) || tip === binding.baseCommit) {
        return { status: "skipped", reason: "no_commits" } satisfies LandingOutcome;
      }
      const current = yield* git(folder, ["rev-parse", "--verify", "-q", ref]);
      if (current.ok && current.stdout === tip) {
        return { status: "skipped", reason: "up_to_date" } satisfies LandingOutcome;
      }
      // Only what the linked repository lacks travels: the commits after the conversation's start, when that
      // start is here; otherwise the branch's whole history.
      const hasBase = (yield* git(folder, ["cat-file", "-e", `${binding.baseCommit}^{commit}`])).ok;
      const bundlePath = `/tmp/t3code-shardflux-${ref.split("/").at(-1)}.bundle`;
      const created = yield* Effect.tryPromise(() =>
        cell.exec.run(
          [
            "git",
            "-C",
            binding.worktreePath,
            "bundle",
            "create",
            bundlePath,
            "HEAD",
            ...(hasBase ? ["--not", binding.baseCommit] : []),
          ],
          { timeoutMs: 120_000 },
        ),
      );
      if (created.exitCode !== 0) {
        return yield* new ShardfluxBranchLandingError({
          detail: `git bundle in the VM: ${created.stderr.trim()}`,
        });
      }
      const bytes = yield* Effect.tryPromise(() => cell.files.read(bundlePath));
      const localBundle = yield* fileSystem.makeTempFileScoped({ prefix: "t3code-shardflux-" });
      yield* fileSystem.writeFile(localBundle, bytes);
      const fetched = yield* git(folder, [
        "fetch",
        "--quiet",
        "--no-tags",
        localBundle,
        `+HEAD:${ref}`,
      ]);
      if (!fetched.ok)
        return yield* new ShardfluxBranchLandingError({ detail: `git fetch of ${binding.branch}` });
      yield* Effect.logInfo("Shardflux branch landed", { threadId, ref, tip });
      return { status: "landed", ref, tip } satisfies LandingOutcome;
    },
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.logWarning("Shardflux branch landing failed", cause).pipe(
        Effect.as({ status: "skipped", reason: "no_binding" } satisfies LandingOutcome),
      ),
    ),
  );

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    land(threadId).pipe(Effect.asVoid),
  );

  const start: ShardfluxBranchLanding["Service"]["start"] = Effect.fn(
    "ShardfluxBranchLanding.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "run.updated" && isTerminalRunStatus(event.payload.status)
          ? worker.enqueue(event.threadId)
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Shardflux landing event stream failed", cause),
        ),
      ),
    );
  });

  return { start, land, drain: worker.drain } satisfies ShardfluxBranchLanding["Service"];
});

export const layer = Layer.effect(ShardfluxBranchLanding, make);

/** Starts landing after every Shardflux run; inert for threads that are not on Shardflux. */
export const layerStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const landing = yield* ShardfluxBranchLanding;
    yield* landing.start();
  }),
).pipe(Layer.provideMerge(layer));
