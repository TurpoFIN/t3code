import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import {
  executionBackendConfigMap,
  executionBackendDrivers,
  resolveExecutionBackend,
  SHARDFLUX_INSTANCE_ID,
  shardfluxCommandPath,
  shardfluxInstanceConfig,
} from "./ExecutionBackend.ts";

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

// What `shard` (CLI 0.29.1, t3-provider.ts) writes into ~/.t3/userdata/settings.json on every run.
const REGISTERED_BY_SHARD = {
  driver: ProviderDriverKind.make("acpRegistry"),
  displayName: "Shardflux",
  enabled: true,
  config: { source: "local", commandPath: "shard", commandArgs: ["acp"] },
};

describe("resolveExecutionBackend", () => {
  it("runs on Shardflux unless the local backend is asked for", () => {
    expect(resolveExecutionBackend({})).toBe("shardflux");
    expect(resolveExecutionBackend({ T3CODE_EXECUTION_BACKEND: "shardflux" })).toBe("shardflux");
    expect(resolveExecutionBackend({ T3CODE_EXECUTION_BACKEND: " Local " })).toBe("local");
    // An unknown value never silently turns local providers back on.
    expect(resolveExecutionBackend({ T3CODE_EXECUTION_BACKEND: "codex" })).toBe("shardflux");
  });
});

describe("shardfluxCommandPath", () => {
  it("prefers T3CODE_SHARDFLUX_CLI, then the saved executable, then shard on PATH", () => {
    const saved = {
      ...REGISTERED_BY_SHARD,
      config: { ...REGISTERED_BY_SHARD.config, commandPath: "/opt/shard/bin/shard" },
    };
    expect(shardfluxCommandPath({ T3CODE_SHARDFLUX_CLI: "/usr/local/bin/shard" }, saved)).toBe(
      "/usr/local/bin/shard",
    );
    expect(shardfluxCommandPath({}, saved)).toBe("/opt/shard/bin/shard");
    expect(shardfluxCommandPath({}, undefined)).toBe("shard");
    expect(
      shardfluxCommandPath(
        {},
        { driver: ProviderDriverKind.make("acpRegistry"), config: "garbage" },
      ),
    ).toBe("shard");
  });
});

describe("shardfluxInstanceConfig", () => {
  it("is the instance shard itself registers, so shard's own launches keep routing to it", () => {
    expect(shardfluxInstanceConfig({}, REGISTERED_BY_SHARD)).toEqual(REGISTERED_BY_SHARD);
  });

  it("forces what runs but keeps the instance's own environment and colour", () => {
    const edited = {
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: "Something else",
      accentColor: "#0ea5e9",
      environment: [
        { name: "SHARDFLUX_API_URL", value: "https://api.staging.shardflux.dev", sensitive: false },
      ],
      enabled: false,
      config: { source: "registry", agentId: "devin", commandArgs: ["--other"] },
    };
    expect(shardfluxInstanceConfig({}, edited)).toEqual({
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: "Shardflux",
      accentColor: "#0ea5e9",
      environment: [
        { name: "SHARDFLUX_API_URL", value: "https://api.staging.shardflux.dev", sensitive: false },
      ],
      enabled: true,
      config: { source: "local", commandPath: "shard", commandArgs: ["acp"] },
    });
  });
});

describe("executionBackendDrivers", () => {
  it("leaves only the ACP runtime that shard acp runs on", () => {
    const kinds = (backend: "shardflux" | "local") =>
      executionBackendDrivers(backend, BUILT_IN_DRIVERS).map((driver) => driver.driverKind);
    expect(kinds("shardflux")).toEqual(["acpRegistry"]);
    expect(kinds("local")).toEqual(BUILT_IN_DRIVERS.map((driver) => driver.driverKind));
    expect(kinds("local")).toContain("codex");
  });
});

describe("executionBackendConfigMap", () => {
  const settings = settingsWith({
    providerInstances: {
      [ProviderInstanceId.make("codex_work")]: { driver: ProviderDriverKind.make("codex") },
      [ProviderInstanceId.make("devin")]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        config: { source: "registry", agentId: "devin" },
      },
    },
  });

  it("is exactly the Shardflux instance, whatever else the settings hold", () => {
    const map = executionBackendConfigMap(
      "shardflux",
      {},
      settings,
      deriveProviderInstanceConfigMap,
    );
    expect(Object.keys(map)).toEqual([SHARDFLUX_INSTANCE_ID]);
    expect(map[SHARDFLUX_INSTANCE_ID]).toEqual(REGISTERED_BY_SHARD);
  });

  it("is upstream's map with the local backend", () => {
    expect(
      executionBackendConfigMap("local", {}, settings, deriveProviderInstanceConfigMap),
    ).toEqual(deriveProviderInstanceConfigMap(settings));
  });
});
