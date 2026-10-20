import type { Shardflux } from "@shardflux/sdk";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { ShardfluxPtyProcess } from "./RemotePty.ts";

const collect = (terminal: ShardfluxPtyProcess) => {
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  const exited = Effect.callback<{ exitCode: number; signal: number | null }>((resume) => {
    terminal.onExit((event) => resume(Effect.succeed(event)));
  });
  return { output: () => output, exited };
};

it.effect("without an API key the terminal says how to add one and exits", () =>
  Effect.gen(function* () {
    const terminal = yield* ShardfluxPtyProcess.open(
      { cols: 80, rows: 24 },
      { resolveBinding: Effect.succeed(null), client: Effect.succeed(null) },
      "xterm-256color",
    );
    const { output, exited } = collect(terminal);
    assert.deepStrictEqual(yield* exited, { exitCode: 1, signal: null });
    assert.include(output(), "shard setup");
  }),
);

it.effect(
  "before the thread's first message it waits for the VM, says so once, and stops on kill",
  () =>
    Effect.gen(function* () {
      let lookups = 0;
      const terminal = yield* ShardfluxPtyProcess.open(
        { cols: 80, rows: 24 },
        {
          resolveBinding: Effect.sync(() => {
            lookups++;
            return null;
          }),
          // An empty client: any call to it before a binding exists would fail the test.
          client: Effect.succeed({} as Shardflux),
        },
        "xterm-256color",
      );
      const { output, exited } = collect(terminal);
      // Input typed while waiting is held, not lost or sent anywhere.
      terminal.write("ls\n");
      yield* TestClock.adjust("10 seconds");
      assert.isAtLeast(lookups, 3);
      assert.strictEqual(output().split("first message").length - 1, 1);
      const exitFiber = yield* Effect.forkChild(exited);
      terminal.kill();
      assert.deepStrictEqual(yield* Fiber.join(exitFiber), { exitCode: 0, signal: 15 });
    }),
);
