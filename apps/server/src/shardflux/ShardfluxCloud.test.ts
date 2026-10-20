import { describe, expect, it } from "vite-plus/test";

import { savedApiKey, shardfluxApiUrl, shardfluxConfigDir } from "./ShardfluxCloud.ts";
import { sameSettingValue } from "./ShardfluxSettings.ts";

const join = (...parts: ReadonlyArray<string>) => parts.join("/");

// The credentials file `shard auth login` and `shard setup` write (CLI credentials.ts, format version 1).
const credentialsFile = (profiles: Record<string, unknown>) =>
  `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`;

describe("shardfluxConfigDir", () => {
  it("follows the Shardflux CLI's precedence", () => {
    expect(shardfluxConfigDir({ SHARDFLUX_CONFIG_DIR: "/srv/sf" }, "/home/a", "linux", join)).toBe(
      "/srv/sf",
    );
    expect(shardfluxConfigDir({ XDG_CONFIG_HOME: "/home/a/.xdg" }, "/home/a", "linux", join)).toBe(
      "/home/a/.xdg/shardflux",
    );
    expect(
      shardfluxConfigDir({ APPDATA: "C:/Users/a/AppData/Roaming" }, "/home/a", "win32", join),
    ).toBe("C:/Users/a/AppData/Roaming/shardflux");
    expect(shardfluxConfigDir({ APPDATA: "/ignored" }, "/home/a", "darwin", join)).toBe(
      "/home/a/.config/shardflux",
    );
  });
});

describe("shardfluxApiUrl", () => {
  it("uses the CLI's variables and drops a trailing slash", () => {
    expect(shardfluxApiUrl({})).toBe("https://api.shardflux.dev");
    expect(shardfluxApiUrl({ SHARDFLUX_API_URL: "https://api.staging.shardflux.dev/" })).toBe(
      "https://api.staging.shardflux.dev",
    );
    expect(shardfluxApiUrl({ SHARDFLUX_BASE_URL: "https://example.test" })).toBe(
      "https://example.test",
    );
  });
});

describe("savedApiKey", () => {
  const key = "sfk_abcdefghijklmnop_SECRETSECRET";

  it("reads the project key saved for this API URL only", () => {
    const text = credentialsFile({
      "https://api.shardflux.dev": {
        session: { token: "sfu_session", expires_at: null, user: null, state: "active" },
        api_key: {
          token: key,
          id: "k1",
          key_id: "abcdefghijklmnop",
          project_id: "p",
          name: "laptop",
        },
      },
      "https://api.staging.shardflux.dev": {
        api_key: {
          token: "sfk_qrstuvwxyzabcdef_STAGING",
          id: "k2",
          key_id: "q",
          project_id: "p",
          name: "s",
        },
      },
    });
    expect(savedApiKey(text, "https://api.shardflux.dev")).toBe(key);
    expect(savedApiKey(text, "https://api.staging.shardflux.dev")).toBe(
      "sfk_qrstuvwxyzabcdef_STAGING",
    );
    expect(savedApiKey(text, "https://elsewhere.test")).toBeNull();
  });

  it("finds nothing in a session-only login, a missing file or a damaged one", () => {
    const sessionOnly = credentialsFile({
      "https://api.shardflux.dev": {
        session: { token: "sfu_x", expires_at: null, user: null, state: "active" },
      },
    });
    expect(savedApiKey(sessionOnly, "https://api.shardflux.dev")).toBeNull();
    expect(savedApiKey("", "https://api.shardflux.dev")).toBeNull();
    expect(savedApiKey('{"version":1,"profiles":', "https://api.shardflux.dev")).toBeNull();
    expect(
      savedApiKey(
        credentialsFile({ "https://api.shardflux.dev": { api_key: { token: "sfu_not_a_key" } } }),
        "https://api.shardflux.dev",
      ),
    ).toBeNull();
  });
});

describe("sameSettingValue", () => {
  it("compares settings structurally and ignores absent keys", () => {
    expect(sameSettingValue({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 })).toBe(true);
    expect(sameSettingValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameSettingValue({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameSettingValue({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    expect(sameSettingValue([], {})).toBe(false);
    expect(sameSettingValue(null, {})).toBe(false);
  });
});
