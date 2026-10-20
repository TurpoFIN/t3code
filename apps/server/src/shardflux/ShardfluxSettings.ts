import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Settings from "../serverSettings.ts";
import {
  resolveExecutionBackend,
  SHARDFLUX_INSTANCE_ID,
  shardfluxInstanceConfig,
} from "./ExecutionBackend.ts";

/** Structural equality of plain settings values (records, arrays, primitives). */
export function sameSettingValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).filter(
    (key) => (left as Record<string, unknown>)[key] !== undefined,
  );
  const rightKeys = Object.keys(right).filter(
    (key) => (right as Record<string, unknown>)[key] !== undefined,
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      sameSettingValue(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
    )
  );
}

/**
 * Clients list an ACP instance only when the settings name it, so the Shardflux instance is written
 * to the settings at startup, the way `shard` registers it in stock T3 Code. Rewritten only when it
 * differs, so a restart does not churn the settings file or wake every client.
 */
export const ensureShardfluxInstance = Effect.fn("ShardfluxSettings.ensureInstance")(function* () {
  const environment = yield* HostProcess.Environment;
  if (resolveExecutionBackend(environment) !== "shardflux") return;
  const settings = yield* Settings.ServerSettingsService;
  const current = yield* settings.getSettings;
  const existing = current.providerInstances[SHARDFLUX_INSTANCE_ID];
  const desired = shardfluxInstanceConfig(environment, existing);
  if (existing !== undefined && sameSettingValue(existing, desired)) return;
  yield* settings.updateProviderInstance({
    operation: "upsert",
    instanceId: SHARDFLUX_INSTANCE_ID,
    instance: desired,
  });
});

export const layer = Layer.effectDiscard(
  ensureShardfluxInstance().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Shardflux provider instance could not be saved", cause),
    ),
  ),
);
