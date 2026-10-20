import type { ServerProvider } from "@t3tools/contracts";

/** The instance id the Shardflux execution backend (fork) runs every thread on. */
export const SHARDFLUX_INSTANCE_ID = "shardflux";

/** True when the server runs threads only on Shardflux: it reports the Shardflux instance and nothing else. */
export function isShardfluxOnlyServer(providers: ReadonlyArray<ServerProvider>): boolean {
  return (
    providers.length > 0 &&
    providers.every((provider) => String(provider.instanceId) === SHARDFLUX_INSTANCE_ID)
  );
}

/** The display name the server gives the Shardflux instance (fixed, not user-editable on this backend). */
export const SHARDFLUX_DISPLAY_NAME = "Shardflux";
