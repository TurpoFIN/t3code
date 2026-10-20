import type { EnvironmentId, ShardfluxThreadStatus, ThreadId } from "@t3tools/contracts";
import { CloudIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { shardfluxThreadStatus } from "~/state/shardflux";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";
import { shardfluxStatusView } from "./ShardfluxThreadStatusRow.logic";

/** The thread's Shardflux computer (fork): where it runs and its state, with the VM on hover. */
export function ShardfluxThreadStatusRow({
  environmentId,
  threadId,
  isDraft,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  isDraft: boolean;
}) {
  const query = useEnvironmentQuery(
    isDraft ? null : shardfluxThreadStatus({ environmentId, input: { threadId } }),
  );
  const status: ShardfluxThreadStatus | null = isDraft
    ? { backend: "shardflux", state: "waiting", vmName: null, conversationId: null, reason: null }
    : query.data;
  if (status?.backend === "local") return null;
  const view = shardfluxStatusView(status);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`Shardflux: ${view.label}`}
            data-testid="shardflux-thread-status"
            data-state={status?.state ?? "checking"}
            className={cn(
              THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
              "flex cursor-default items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            )}
          />
        }
      >
        <CloudIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className={cn("flex-1 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          Shardflux
        </span>
        <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <ConnectionStatusDot
            dotClassName={view.dotClassName}
            pingClassName={view.pingClassName ?? null}
          />
          {view.label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        <div className="flex flex-col gap-0.5">
          <span>{view.detail}</span>
          {status?.vmName ? (
            <span className="text-muted-foreground">
              VM <span className="font-mono">{status.vmName}</span>
            </span>
          ) : null}
          {status?.conversationId ? (
            <span className="text-muted-foreground">
              Conversation <span className="font-mono">{status.conversationId}</span>
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
