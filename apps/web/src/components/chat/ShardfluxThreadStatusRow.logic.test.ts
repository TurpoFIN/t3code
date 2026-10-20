import type { ShardfluxThreadStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shardfluxStatusView } from "./ShardfluxThreadStatusRow.logic";

const status = (overrides: Partial<ShardfluxThreadStatus>): ShardfluxThreadStatus => ({
  backend: "shardflux",
  state: "running",
  vmName: null,
  conversationId: null,
  reason: null,
  ...overrides,
});

describe("shardfluxStatusView", () => {
  it("gives each VM state a short label and T3's status colour for it", () => {
    const views = (["waiting", "starting", "running", "idle", "stopped", "failed"] as const).map(
      (state) => {
        const view = shardfluxStatusView(status({ state }));
        return [state, view.label, view.dotClassName, view.pingClassName ?? null];
      },
    );
    expect(views).toEqual([
      ["waiting", "Not started", "bg-muted-foreground/40", null],
      ["starting", "Starting", "bg-warning", "bg-warning/60 duration-2000"],
      ["running", "Running", "bg-success", null],
      ["idle", "Idle", "bg-muted-foreground/40", null],
      ["stopped", "Stopped", "bg-muted-foreground/40", null],
      ["failed", "Failed", "bg-destructive", null],
    ]);
  });

  it("says what is missing when the VM cannot be read, and checks before the first answer", () => {
    expect(shardfluxStatusView(status({ state: "unavailable", reason: "no-api-key" })).label).toBe(
      "No API key",
    );
    expect(
      shardfluxStatusView(status({ state: "unavailable", reason: "api-unreachable" })).label,
    ).toBe("Unavailable");
    expect(shardfluxStatusView(null).label).toBe("Checking");
  });
});
