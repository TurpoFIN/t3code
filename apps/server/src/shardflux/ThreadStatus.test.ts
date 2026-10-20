import { ThreadId, type ShardfluxThreadStatus } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as ThreadBindings from "./ThreadBindings.ts";
import {
  LOCAL_BACKEND_STATUS,
  ShardfluxThreadStatusService,
  layer,
  statusOfLookup,
  vmStateOf,
} from "./ThreadStatus.ts";

const THREAD = ThreadId.make("thread-status-test");

describe("vmStateOf", () => {
  it("reads every workspace state the API reports as one of the panel's states", () => {
    // The API's observed_state values (@shardflux/sdk 0.30.4, components.schemas.Workspace).
    expect({
      creating: vmStateOf("creating"),
      starting: vmStateOf("starting"),
      resuming: vmStateOf("resuming"),
      forking: vmStateOf("forking"),
      running: vmStateOf("running"),
      suspending: vmStateOf("suspending"),
      suspended: vmStateOf("suspended"),
      stopping: vmStateOf("stopping"),
      deleting: vmStateOf("deleting"),
      deleted: vmStateOf("deleted"),
      failed: vmStateOf("failed"),
    }).toEqual({
      creating: "starting",
      starting: "starting",
      resuming: "starting",
      forking: "starting",
      running: "running",
      suspending: "idle",
      suspended: "idle",
      stopping: "stopped",
      deleting: "stopped",
      deleted: "stopped",
      failed: "failed",
    });
  });
});

describe("statusOfLookup", () => {
  it("says why a thread has no VM to read yet", () => {
    expect(statusOfLookup({ _tag: "not-started" }).state).toBe("waiting");
    expect(statusOfLookup({ _tag: "pending" }).state).toBe("starting");
    expect(statusOfLookup({ _tag: "no-client" })).toMatchObject({
      state: "unavailable",
      reason: "no-api-key",
    });
    expect(statusOfLookup({ _tag: "failed" })).toMatchObject({
      state: "unavailable",
      reason: "api-unreachable",
    });
  });
});

/** The status service over a thread whose binding lookups answer `lookups` in turn (the last one repeats). */
const serviceWith = (
  lookups: ReadonlyArray<ThreadBindings.ShardfluxBindingLookup>,
  environment: Record<string, string> = {},
) => {
  let call = 0;
  const bindings = Layer.succeed(ThreadBindings.ShardfluxThreadBindings, {
    resolve: () => Effect.succeed(null),
    lookup: () => Effect.sync(() => lookups[Math.min(call++, lookups.length - 1)]!),
  });
  return layer.pipe(
    Layer.provide(bindings),
    Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
  );
};

const collect = (count: number, advance: Duration.Input) =>
  Effect.gen(function* () {
    const service = yield* ShardfluxThreadStatusService;
    const seen: Array<ShardfluxThreadStatus> = [];
    const fiber = yield* service.stream(THREAD).pipe(
      Stream.take(count),
      Stream.runForEach((status) => Effect.sync(() => seen.push(status))),
      Effect.forkChild,
    );
    for (let step = 0; step < 20 && seen.length < count; step++) {
      yield* TestClock.adjust(advance);
    }
    yield* Fiber.interrupt(fiber);
    return seen.map((status) => status.state);
  });

describe("ShardfluxThreadStatusService", () => {
  it.effect("pushes each change once and keeps a known state through a failed read", () =>
    collect(3, "1500 millis").pipe(
      Effect.map((states) =>
        assert.deepStrictEqual(states, ["waiting", "starting", "unavailable"]),
      ),
      Effect.provide(
        serviceWith([
          { _tag: "not-started" },
          { _tag: "not-started" },
          { _tag: "pending" },
          { _tag: "failed" },
          { _tag: "pending" },
          { _tag: "no-client" },
        ]),
      ),
    ),
  );

  it.effect("shows nothing to run on under upstream's local backend", () =>
    Effect.gen(function* () {
      const service = yield* ShardfluxThreadStatusService;
      const all = yield* Stream.runCollect(service.stream(THREAD));
      assert.deepStrictEqual(Array.from(all), [LOCAL_BACKEND_STATUS]);
    }).pipe(
      Effect.provide(serviceWith([{ _tag: "not-started" }], { T3CODE_EXECUTION_BACKEND: "local" })),
    ),
  );
});
