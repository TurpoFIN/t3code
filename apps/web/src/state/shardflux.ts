import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** A thread's Shardflux VM state (fork), pushed by the server while the thread is open. */
export const shardfluxThreadStatus = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:shardflux:thread-status",
    tag: WS_METHODS.subscribeShardfluxThreadStatus,
  },
);
