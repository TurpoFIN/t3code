import { Schema } from "effect";

import { ThreadId } from "./baseSchemas.ts";

/**
 * Where a thread's Shardflux cloud computer is (fork): `waiting` until the thread's first message creates it,
 * `idle` while it sleeps between turns (the next message wakes it), `unavailable` when this server cannot
 * read it (no Shardflux API key, or the API did not answer).
 */
export const ShardfluxVmState = Schema.Literals([
  "waiting",
  "starting",
  "running",
  "idle",
  "stopped",
  "failed",
  "unavailable",
]);
export type ShardfluxVmState = typeof ShardfluxVmState.Type;

export const ShardfluxThreadStatusInput = Schema.Struct({ threadId: ThreadId });
export type ShardfluxThreadStatusInput = typeof ShardfluxThreadStatusInput.Type;

export const ShardfluxThreadStatus = Schema.Struct({
  /** `local` when the server runs upstream's local backend (`T3CODE_EXECUTION_BACKEND=local`): nothing to show. */
  backend: Schema.Literals(["shardflux", "local"]),
  state: ShardfluxVmState,
  /** The VM's hostname, once it has run. */
  vmName: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  /** `no-api-key` when the server has no Shardflux API key to read the VM with. */
  reason: Schema.NullOr(Schema.Literals(["no-api-key", "api-unreachable"])),
});
export type ShardfluxThreadStatus = typeof ShardfluxThreadStatus.Type;
