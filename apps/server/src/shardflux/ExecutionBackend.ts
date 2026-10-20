import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerSettings,
} from "@t3tools/contracts";

/**
 * Where threads run. This fork's default is Shardflux: every thread is a Shardflux conversation VM, driven
 * through `shard acp` (the Shardflux CLI's ACP agent), and no provider runs on this machine.
 * `T3CODE_EXECUTION_BACKEND=local` restores upstream T3 Code's local providers.
 */
export type ExecutionBackend = "shardflux" | "local";

/** The id `shard` itself registers in T3's settings and launches threads with (`shard agents new --in t3`). */
export const SHARDFLUX_INSTANCE_ID = ProviderInstanceId.make("shardflux");
export const SHARDFLUX_DISPLAY_NAME = "Shardflux";

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

type Environment = Readonly<Record<string, string | undefined>>;

export function resolveExecutionBackend(env: Environment): ExecutionBackend {
  return env.T3CODE_EXECUTION_BACKEND?.trim().toLowerCase() === "local" ? "local" : "shardflux";
}

/** The `shard` executable: T3CODE_SHARDFLUX_CLI, else the one the settings name, else `shard` on PATH. */
export function shardfluxCommandPath(env: Environment, existing?: ProviderInstanceConfig): string {
  const configured = env.T3CODE_SHARDFLUX_CLI?.trim();
  if (configured) return configured;
  const config = existing?.config;
  const saved =
    typeof config === "object" && config !== null && "commandPath" in config
      ? (config as { commandPath?: unknown }).commandPath
      : undefined;
  return typeof saved === "string" && saved.trim() ? saved.trim() : "shard";
}

/**
 * The Shardflux instance: T3's ACP runtime over `shard acp`, which gives each thread its own conversation VM,
 * seeds it from the project folder and syncs the files back after every prompt. Only the executable and the
 * instance's environment variables are taken from saved settings; what it runs is fixed.
 */
export function shardfluxInstanceConfig(
  env: Environment,
  existing?: ProviderInstanceConfig,
): ProviderInstanceConfig {
  return {
    driver: ACP_REGISTRY_DRIVER,
    displayName: SHARDFLUX_DISPLAY_NAME,
    ...(existing?.accentColor ? { accentColor: existing.accentColor } : {}),
    ...(existing?.environment ? { environment: existing.environment } : {}),
    enabled: true,
    config: {
      source: "local",
      commandPath: shardfluxCommandPath(env, existing),
      commandArgs: ["acp"],
    },
  };
}

/** The drivers a backend may instantiate: with Shardflux, only the ACP runtime that `shard acp` uses. */
export function executionBackendDrivers<Driver extends { readonly driverKind: ProviderDriverKind }>(
  backend: ExecutionBackend,
  drivers: ReadonlyArray<Driver>,
): ReadonlyArray<Driver> {
  return backend === "local"
    ? drivers
    : drivers.filter((driver) => driver.driverKind === ACP_REGISTRY_DRIVER);
}

/** With Shardflux the instance map is exactly the Shardflux instance, whatever else the settings hold. */
export function executionBackendConfigMap(
  backend: ExecutionBackend,
  env: Environment,
  settings: ServerSettings,
  derive: (settings: ServerSettings) => ProviderInstanceConfigMap,
): ProviderInstanceConfigMap {
  if (backend === "local") return derive(settings);
  return {
    [SHARDFLUX_INSTANCE_ID]: shardfluxInstanceConfig(
      env,
      settings.providerInstances[SHARDFLUX_INSTANCE_ID],
    ),
  } as ProviderInstanceConfigMap;
}
