import type { ShardfluxThreadStatus } from "@t3tools/contracts";

export interface ShardfluxStatusView {
  readonly label: string;
  readonly detail: string;
  readonly dotClassName: string;
  readonly pingClassName?: string;
}

/** What the row says for a status; null status is the moment before the server's first answer. */
export function shardfluxStatusView(status: ShardfluxThreadStatus | null): ShardfluxStatusView {
  if (status === null) {
    return {
      label: "Checking",
      detail: "Reading this thread's cloud computer.",
      dotClassName: "bg-muted-foreground/40",
    };
  }
  switch (status.state) {
    case "waiting":
      return {
        label: "Not started",
        detail: "This thread's cloud computer starts with its first message.",
        dotClassName: "bg-muted-foreground/40",
      };
    case "starting":
      return {
        label: "Starting",
        detail: "This thread's cloud computer is starting.",
        dotClassName: "bg-warning",
        pingClassName: "bg-warning/60 duration-2000",
      };
    case "running":
      return {
        label: "Running",
        detail: "This thread runs on its own cloud computer.",
        dotClassName: "bg-success",
      };
    case "idle":
      return {
        label: "Idle",
        detail: "Asleep between turns. The next message wakes it.",
        dotClassName: "bg-muted-foreground/40",
      };
    case "stopped":
      return {
        label: "Stopped",
        detail: "This thread's cloud computer has ended.",
        dotClassName: "bg-muted-foreground/40",
      };
    case "failed":
      return {
        label: "Failed",
        detail: "This thread's cloud computer did not start.",
        dotClassName: "bg-destructive",
      };
    case "unavailable":
      return status.reason === "no-api-key"
        ? {
            label: "No API key",
            detail: "Run `shard setup` (or set SHARDFLUX_API_KEY) to show this thread's computer.",
            dotClassName: "bg-muted-foreground/40",
          }
        : {
            label: "Unavailable",
            detail: "Shardflux did not answer. Retrying.",
            dotClassName: "bg-muted-foreground/40",
          };
  }
}
