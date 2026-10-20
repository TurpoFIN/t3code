import { Shardflux } from "@shardflux/sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const DEFAULT_API_URL = "https://api.shardflux.dev";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ShardfluxCredentials {
  readonly apiKey: string;
  readonly apiUrl: string;
}

/** The API the Shardflux CLI talks to: SHARDFLUX_API_URL, else SHARDFLUX_BASE_URL, else production. */
export function shardfluxApiUrl(env: Environment): string {
  return (
    env.SHARDFLUX_API_URL?.trim() ||
    env.SHARDFLUX_BASE_URL?.trim() ||
    DEFAULT_API_URL
  ).replace(/\/+$/, "");
}

/** `shard`'s config dir: SHARDFLUX_CONFIG_DIR, else $XDG_CONFIG_HOME/shardflux, else ~/.config/shardflux. */
export function shardfluxConfigDir(
  env: Environment,
  home: string,
  platform: NodeJS.Platform,
  join: (...parts: ReadonlyArray<string>) => string,
): string {
  const configured = env.SHARDFLUX_CONFIG_DIR?.trim();
  if (configured) return configured;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "shardflux");
  const appData = env.APPDATA?.trim();
  if (platform === "win32" && appData) return join(appData, "shardflux");
  return join(home, ".config", "shardflux");
}

const CredentialsFile = Schema.Struct({
  profiles: Schema.Record(
    Schema.String,
    Schema.Struct({
      api_key: Schema.optional(Schema.Struct({ token: Schema.String })),
    }),
  ),
});
const decodeCredentialsFile = Schema.decodeUnknownOption(Schema.fromJsonString(CredentialsFile));

/** The project API key `shard setup` saved for this API URL in the CLI's credentials file, if any. */
export function savedApiKey(credentialsJson: string, apiUrl: string): string | null {
  const parsed = decodeCredentialsFile(credentialsJson);
  if (parsed._tag === "None") return null;
  const token = parsed.value.profiles[apiUrl]?.api_key?.token;
  return token?.startsWith("sfk_") ? token : null;
}

export class ShardfluxCloud extends Context.Service<
  ShardfluxCloud,
  {
    /**
     * The public API client, or null when this machine has no Shardflux project API key. The key is the one the
     * Shardflux CLI would use: SHARDFLUX_API_KEY, else the key `shard setup` saved. `shard acp` itself also runs on a
     * session login, but the VM terminal and branch landing call the API with a key.
     */
    readonly client: Effect.Effect<Shardflux | null>;
  }
>()("t3/shardflux/ShardfluxCloud") {}

export const make = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const apiUrl = shardfluxApiUrl(environment);
  const credentialsPath = path.join(
    shardfluxConfigDir(environment, home, platform, path.join),
    "credentials.json",
  );
  let cached: Shardflux | undefined;

  const readApiKey = Effect.gen(function* () {
    const fromEnvironment = environment.SHARDFLUX_API_KEY?.trim();
    if (fromEnvironment) return fromEnvironment;
    const text = yield* fileSystem
      .readFileString(credentialsPath)
      .pipe(Effect.orElseSucceed(() => ""));
    return savedApiKey(text, apiUrl);
  });

  return {
    // A missing key is read again on the next use, so `shard setup` takes effect without a restart.
    client: Effect.gen(function* () {
      if (cached !== undefined) return cached;
      const apiKey = yield* readApiKey;
      if (apiKey === null) return null;
      const created = yield* Effect.try(() => new Shardflux({ apiKey, baseUrl: apiUrl })).pipe(
        Effect.tapError((cause) => Effect.logWarning("Shardflux API key is not usable", cause)),
        Effect.orElseSucceed(() => null),
      );
      if (created !== null) cached = created;
      return created;
    }),
  } satisfies ShardfluxCloud["Service"];
});

export const layer = Layer.effect(ShardfluxCloud, make);
