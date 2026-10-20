import type { Shardflux } from "@shardflux/sdk";
import type { OrchestrationV2ProviderThread, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { SHARDFLUX_INSTANCE_ID } from "./ExecutionBackend.ts";
import * as ShardfluxCloud from "./ShardfluxCloud.ts";

/** Where a thread runs: its Shardflux conversation and the computer and worktree that conversation has now. */
export interface ShardfluxConversationBinding {
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly worktreePath: string;
  /** `shard/<name>`: the conversation's own branch in its computer and in the project hub. */
  readonly branch: string;
  readonly baseCommit: string;
  /** The linked folder for a conversation started from one (`file://` repository), else null. */
  readonly localFolder: string | null;
}

const ACP_SESSION_ID = /^sf-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** `shard acp` names a session's conversation after it: `sf-<uuid>` runs as `acp-<uuid without dashes>`. */
export function conversationNameForAcpSession(sessionId: string): string | null {
  const match = ACP_SESSION_ID.exec(sessionId);
  return match ? `acp-${match[1]!.replaceAll("-", "")}` : null;
}

/** The ACP session of the thread's newest Shardflux provider thread, if it has started one. */
export function shardfluxAcpSessionId(
  providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
): string | null {
  const candidates = providerThreads
    .filter((providerThread) => providerThread.providerInstanceId === SHARDFLUX_INSTANCE_ID)
    .flatMap((providerThread) => {
      const nativeId = providerThread.nativeThreadRef?.nativeId;
      return nativeId && ACP_SESSION_ID.test(nativeId)
        ? [{ nativeId, updatedAt: DateTime.toEpochMillis(providerThread.updatedAt) }]
        : [];
    })
    .toSorted((left, right) => right.updatedAt - left.updatedAt);
  return candidates[0]?.nativeId ?? null;
}

export function localFolderOf(repoRemote: string): string | null {
  if (!repoRemote.startsWith("file://")) return null;
  try {
    return decodeURIComponent(new URL(repoRemote).pathname);
  } catch {
    return null;
  }
}

type Conversation = Awaited<ReturnType<Shardflux["conversations"]["get"]>>;

const bindingOf = (conversation: Conversation): ShardfluxConversationBinding => ({
  conversationId: conversation.id,
  workspaceId: conversation.workspace_id,
  worktreePath: conversation.worktree_path,
  branch: conversation.branch,
  baseCommit: conversation.base_commit,
  localFolder: localFolderOf(conversation.repo_remote),
});

/** The conversation whose branch is `shard/<name>`, among those changed since `since`. */
export const findConversationByName = (client: Shardflux, name: string, since: string) =>
  Effect.tryPromise(async () => {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await client.conversations.list({
        updatedAfter: since,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      const found = result.data.find((conversation) => conversation.branch === `shard/${name}`);
      if (found) return found.id;
      if (!result.nextCursor) return null;
      cursor = result.nextCursor;
    }
    return null;
  });

export class ShardfluxThreadBindings extends Context.Service<
  ShardfluxThreadBindings,
  {
    /** Null until the thread's first message has given it a conversation, or without Shardflux access. */
    readonly resolve: (threadId: ThreadId) => Effect.Effect<ShardfluxConversationBinding | null>;
  }
>()("t3/shardflux/ThreadBindings/ShardfluxThreadBindings") {}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const cloud = yield* ShardfluxCloud.ShardfluxCloud;
  // A session names one conversation for good; its computer can change (a move, a restore), so only the id is kept.
  const conversationIds = new Map<string, string>();

  const resolve = Effect.fn("ShardfluxThreadBindings.resolve")(
    function* (threadId: ThreadId) {
      const client = yield* cloud.client;
      if (client === null) return null;
      const records = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
      const sessionId = shardfluxAcpSessionId(records.providerThreads);
      const name = sessionId ? conversationNameForAcpSession(sessionId) : null;
      if (!sessionId || !name) return null;
      let conversationId = conversationIds.get(sessionId);
      if (conversationId === undefined) {
        // The conversation starts after its thread; an hour of slack covers clock skew.
        const since = DateTime.formatIso(DateTime.subtract(records.thread.createdAt, { hours: 1 }));
        const found = yield* findConversationByName(client, name, since);
        if (found === null) return null;
        conversationId = found;
        conversationIds.set(sessionId, conversationId);
      }
      const id = conversationId;
      const conversation = yield* Effect.tryPromise(() => client.conversations.get(id));
      return bindingOf(conversation);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Shardflux thread binding unavailable", cause).pipe(Effect.as(null)),
    ),
  );

  return { resolve } satisfies ShardfluxThreadBindings["Service"];
});

export const layer = Layer.effect(ShardfluxThreadBindings, make);
