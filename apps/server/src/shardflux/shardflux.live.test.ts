import * as NodeOS from "node:os";

import { Shardflux } from "@shardflux/sdk";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import { ShardfluxPtyProcess } from "./RemotePty.ts";
import {
  findConversationByName,
  localFolderOf,
  type ShardfluxConversationBinding,
} from "./ThreadBindings.ts";

/**
 * Against a real Shardflux conversation VM. Runs only with SHARDFLUX_API_KEY and
 * T3CODE_SHARDFLUX_LIVE_CONVERSATION (a conversation id this key's project can reach); CI skips it.
 */
const conversationId = process.env.T3CODE_SHARDFLUX_LIVE_CONVERSATION?.trim() ?? "";
const live = Boolean(process.env.SHARDFLUX_API_KEY?.trim() && conversationId);

const conversation = Effect.gen(function* () {
  const sdk = new Shardflux();
  const found = yield* Effect.tryPromise(() => sdk.conversations.get(conversationId));
  const binding: ShardfluxConversationBinding = {
    conversationId: found.id,
    workspaceId: found.workspace_id,
    worktreePath: found.worktree_path,
    branch: found.branch,
    baseCommit: found.base_commit,
    localFolder: localFolderOf(found.repo_remote),
  };
  return { sdk, found, binding };
});

/** A terminal on the conversation's VM with everything it prints collected. */
const openTerminal = (sdk: Shardflux, binding: ShardfluxConversationBinding) =>
  Effect.gen(function* () {
    let output = "";
    const terminal = yield* ShardfluxPtyProcess.open(
      { cols: 120, rows: 30 },
      { resolveBinding: Effect.succeed(binding), client: Effect.succeed(sdk) },
      "xterm-256color",
    );
    terminal.onData((data) => {
      output += data;
    });
    const exited = Effect.callback<{ exitCode: number; signal: number | null }>((resume) => {
      terminal.onExit((event) => resume(Effect.succeed(event)));
    });
    const waitFor = (text: string) =>
      Effect.gen(function* () {
        for (let polls = 0; polls < 360 && !output.includes(text); polls++) {
          yield* Effect.sleep("250 millis");
        }
        return output;
      });
    return { terminal, exited, waitFor, output: () => output };
  });

describe.runIf(live)("Shardflux live", () => {
  it.live("finds a thread's conversation by the branch shard acp gives it", () =>
    Effect.gen(function* () {
      const { sdk, found } = yield* conversation;
      const since = DateTime.formatIso(
        DateTime.subtract(DateTime.makeUnsafe(found.created_at), { hours: 1 }),
      );
      const name = found.branch.replace(/^shard\//, "");
      assert.strictEqual(yield* findConversationByName(sdk, name, since), found.id);
      assert.strictEqual(
        yield* findConversationByName(sdk, "acp-00000000000000000000000000000000", since),
        null,
      );
    }),
  );

  it.live("runs the thread's terminal in the conversation VM, in its worktree", () =>
    Effect.gen(function* () {
      const { sdk, found, binding } = yield* conversation;
      const workspace = yield* Effect.tryPromise(() => sdk.workspaces.get(found.workspace_id));
      if (!workspace.ready) yield* Effect.tryPromise(() => workspace.wake({ timeoutMs: 120_000 }));
      const cell = workspace.cell();
      const vmHostname = (yield* Effect.tryPromise(() =>
        cell.exec.run(["hostname"], { timeoutMs: 30_000 }),
      )).stdout.trim();
      cell.close();

      const { terminal, exited, output } = yield* openTerminal(sdk, binding);
      // Typed before the shell is up: the process holds it until the VM attachment opens.
      terminal.write(
        `printf 'live:%s:%s:%s\\n' "$(hostname)" "$PWD" "$(git branch --show-current)"; exit 7\n`,
      );
      const result = yield* exited.pipe(Effect.timeout("90 seconds"));

      assert.strictEqual(result.exitCode, 7);
      assert.include(output(), `live:${vmHostname}:${found.worktree_path}:${found.branch}`);
      assert.notStrictEqual(vmHostname, NodeOS.hostname());
    }),
  );

  it.live("closes the VM shell when the terminal is killed", () =>
    Effect.gen(function* () {
      const { sdk, binding } = yield* conversation;
      const { terminal, exited, waitFor } = yield* openTerminal(sdk, binding);
      terminal.write("echo ready-$((40 + 2))\n");
      assert.include(yield* waitFor("ready-42"), "ready-42");
      terminal.kill();
      assert.deepStrictEqual(yield* exited, { exitCode: 0, signal: 15 });
    }),
  );
});
