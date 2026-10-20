import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { landedRefFor } from "./BranchLanding.ts";
import {
  conversationNameForAcpSession,
  localFolderOf,
  shardfluxAcpSessionId,
} from "./ThreadBindings.ts";

// Recorded 2026-10-20 from the live API: `shard acp` session sf-0f0e3865-… ran as conversation
// conv_jldjbsyhidl5ri3xneukkrfguy on branch shard/acp-0f0e3865694b46859f554278ec6c49fe.
const RECORDED_SESSION = "sf-0f0e3865-694b-4685-9f55-4278ec6c49fe";
const RECORDED_BRANCH = "shard/acp-0f0e3865694b46859f554278ec6c49fe";

const providerThread = (input: {
  readonly instance: string;
  readonly nativeId: string | null;
  readonly updatedAt: string;
}): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(`pt-${input.instance}-${input.updatedAt}`),
  driver: ProviderDriverKind.make("acpRegistry"),
  providerInstanceId: ProviderInstanceId.make(input.instance),
  providerSessionId: null,
  appThreadId: null,
  ownerNodeId: null,
  nativeThreadRef:
    input.nativeId === null
      ? null
      : {
          driver: ProviderDriverKind.make("acpRegistry"),
          nativeId: input.nativeId,
          strength: "strong",
        },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: DateTime.makeUnsafe(input.updatedAt),
  updatedAt: DateTime.makeUnsafe(input.updatedAt),
});

describe("conversationNameForAcpSession", () => {
  it("names the conversation the way shard acp does", () => {
    expect(`shard/${conversationNameForAcpSession(RECORDED_SESSION)}`).toBe(RECORDED_BRANCH);
  });

  it("refuses ids that are not shard acp sessions", () => {
    expect(conversationNameForAcpSession("shardflux-probe")).toBeNull();
    expect(conversationNameForAcpSession("sf-not-a-uuid")).toBeNull();
    expect(conversationNameForAcpSession(`${RECORDED_SESSION}x`)).toBeNull();
    expect(conversationNameForAcpSession("conv_jldjbsyhidl5ri3xneukkrfguy")).toBeNull();
  });
});

describe("shardfluxAcpSessionId", () => {
  it("takes the newest Shardflux session and ignores other instances and unstarted threads", () => {
    const newer = "sf-cf75b7b7-cc11-4cf2-a627-f3059de74054";
    expect(
      shardfluxAcpSessionId([
        providerThread({
          instance: "shardflux",
          nativeId: RECORDED_SESSION,
          updatedAt: "2026-10-20T01:00:00Z",
        }),
        providerThread({
          instance: "shardflux",
          nativeId: newer,
          updatedAt: "2026-10-20T02:00:00Z",
        }),
        providerThread({
          instance: "devin",
          nativeId: "sf-00000000-0000-0000-0000-000000000000",
          updatedAt: "2026-10-20T03:00:00Z",
        }),
        providerThread({
          instance: "shardflux",
          nativeId: null,
          updatedAt: "2026-10-20T04:00:00Z",
        }),
      ]),
    ).toBe(newer);
    expect(shardfluxAcpSessionId([])).toBeNull();
  });
});

describe("localFolderOf", () => {
  it("reads the linked folder of a conversation started from one", () => {
    // A repo_remote the live API returned for a folder with spaces and parentheses in its name.
    expect(
      localFolderOf(
        "file:///home/alex/.config/shardflux/onboarding-projects/sample-xgNKaZ/Daylight (sample)",
      ),
    ).toBe("/home/alex/.config/shardflux/onboarding-projects/sample-xgNKaZ/Daylight (sample)");
    expect(localFolderOf("file:///Users/marcsmeds/code/recursive-spec-splitter")).toBe(
      "/Users/marcsmeds/code/recursive-spec-splitter",
    );
    expect(localFolderOf("https://github.com/turpofin/shardflux")).toBeNull();
    expect(localFolderOf("")).toBeNull();
  });
});

describe("landedRefFor", () => {
  it("lands shard/<name> as shardflux/<name> and nothing else", () => {
    expect(landedRefFor(RECORDED_BRANCH)).toBe(
      "refs/remotes/shardflux/acp-0f0e3865694b46859f554278ec6c49fe",
    );
    expect(landedRefFor("shard/2aamfhan4sb2rew23vyudydwb4")).toBe(
      "refs/remotes/shardflux/2aamfhan4sb2rew23vyudydwb4",
    );
    expect(landedRefFor("")).toBeNull();
    expect(landedRefFor("main")).toBeNull();
    expect(landedRefFor("shard/../../heads/main")).toBeNull();
    expect(landedRefFor("shard/Upper")).toBeNull();
  });
});
