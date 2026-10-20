# Shardflux execution backend (fork)

This fork keeps T3 Code's flow and UI and moves execution to [Shardflux](https://shardflux.dev): every thread
is a Shardflux conversation with its own cloud VM. `T3CODE_EXECUTION_BACKEND=local` restores upstream behavior.

## Shape

The engine is `shard acp`, the Shardflux CLI's ACP agent. A `session/new` is one conversation VM (route `acp`,
branch `shard/acp-<session uuid hex>`); the CLI seeds the VM from the project folder, reconciles files both
ways before and after every prompt, relays permissions, and runs Claude Code or Codex inside the VM. T3 drives
it through its existing ACP runtime, so session events, approvals, models and checkpoints are T3's own.
Everything Shardflux-specific lives in [`apps/server/src/shardflux`](../../apps/server/src/shardflux) behind
upstream seams, so the fork rebases on upstream with small conflicts:

| Seam                    | Hook                                                                                                           | Shardflux module                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Provider instances      | `ProviderInstanceRegistryHydration` derives the instance map and drivers through the backend                   | `ExecutionBackend.ts`                                 |
| Client-visible settings | startup layer in `server.ts`                                                                                   | `ShardfluxSettings.ts`                                |
| Terminals               | `PtySpawnInput.threadId`, set by the terminal manager; `server.ts` provides the wrapped adapter                | `RemotePty.ts`                                        |
| Git                     | a reactor in `server.ts` on terminal `run.updated`                                                             | `BranchLanding.ts`                                    |
| Thread status           | `subscribeShardfluxThreadStatus` (contracts `shardflux.ts`), handled in `ws.ts`; a row in `ThreadDetailsPanel` | `ThreadStatus.ts`, web `ShardfluxThreadStatusRow.tsx` |
| Providers settings      | a server that reports only the Shardflux instance lists no unrun default slots                                 | web `settings/shardfluxProviders.ts`                  |
| Provider icon           | `ProviderInstanceIcon` draws the Shardflux mark for the Shardflux instance                                     | web `ShardfluxMark.tsx`                               |
| Onboarding              | the Agents step lists the environment's own agents when it runs none of the local ones                         | `WelcomeWizard.tsx`                                   |

## Constraints

- **The instance is `shardflux` on the `acpRegistry` driver**, exactly what `shard` registers in stock T3
  Code. `shard agents new --in t3` launches threads with that instance id, and clients only list an ACP
  instance the settings name, so the server writes it at startup. Only the executable
  (`T3CODE_SHARDFLUX_CLI`, else the saved `commandPath`, else `shard`) and the instance environment are
  taken from settings.
- **A thread finds its conversation through its ACP session id.** The provider thread's native id is the
  `shard acp` session `sf-<uuid>`, which names the conversation `acp-<uuid hex>`. The server resolves it once
  through the public conversations API and re-reads the conversation on use, because a move or restore
  changes its VM.
- **The VM terminal and branch landing call the public API with a project key** (`SHARDFLUX_API_KEY`, else
  the key `shard setup` saved). `shard acp` itself also runs on a session login.
- **Landing never touches the checkout.** Files already arrive through the project sync; the branch arrives as
  `refs/remotes/shardflux/<name>` from a `git bundle` made in the VM. T3's own Git actions commit and push.
- **T3's MCP tools are not offered to the cloud agent.** `shard acp` gives the agent the conversation's own
  Shardflux MCP server; T3's MCP endpoint is loopback on this machine.

## Thread status

The server streams each open thread's VM state while its panel is subscribed: it re-reads the conversation and
its workspace every 1.5 s while the VM is not started, starting or idle (a message can change it at any moment)
and every 5 s otherwise, and pushes only changes. `starting` covers the first message's `session/new` (a
Shardflux provider thread with no session id yet, for up to 3 minutes) and the workspace's creating, starting,
resuming and forking states; `idle` is suspending or suspended. The VM name is the workspace's hostname, read
once from the running VM. A failed read after a known state keeps that state.

## Traps

- The guest's exec output holds back the newline after a JSON line until more output follows. `shard acp`
  0.29.1 waits for that newline before parsing a journal frame, so every connection times out after 120 s
  ("Try the message again"). Shardflux CLI builds with the journal fix (a whole JSON object is a whole
  frame) are required; see `T3CODE_SHARDFLUX_CLI`.
- A terminal opened before the thread's first message has no VM yet. It says so and connects once the
  conversation exists; it never falls back to a local shell.
- Upstream suites run with `T3CODE_EXECUTION_BACKEND=local` (`apps/server/vite.config.ts`); the backend's own
  tests are in `apps/server/src/shardflux`, with a live suite gated on `SHARDFLUX_API_KEY` and
  `T3CODE_SHARDFLUX_LIVE_CONVERSATION`.
