import { assert, describe, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Metric from "effect/Metric";
import * as TestClock from "effect/testing/TestClock";

import { makeOmpMetricRecorder } from "./OmpMetrics.ts";

const matchingSnapshots = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.filter(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("OMP metrics", () => {
  it.effect("records each first output kind once per turn without turn identifiers", () =>
    Effect.gen(function* () {
      const recorder = yield* makeOmpMetricRecorder;
      const turnId = TurnId.make("turn-observability-test");
      const duration = Duration.millis(250);
      const fiber = yield* Effect.gen(function* () {
        yield* recorder.recordTurnStarted(turnId);
        yield* Effect.sleep(duration);
        yield* recorder.recordFirstOutput(turnId, "reasoning");
        yield* recorder.recordFirstOutput(turnId, "reasoning");
        yield* recorder.recordFirstOutput(turnId, "text");
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(duration);
      yield* Fiber.join(fiber);

      const snapshots = yield* Metric.snapshot;
      const reasoning = matchingSnapshots(snapshots, "t3_omp_first_output_latency", {
        output: "reasoning",
      });
      const text = matchingSnapshots(snapshots, "t3_omp_first_output_latency", { output: "text" });
      assert.equal(reasoning.length, 1);
      assert.equal(text.length, 1);
      assert.equal(reasoning[0]?.attributes?.turnId, undefined);
      assert.equal(reasoning[0]?.type === "Histogram" ? reasoning[0].state.count : undefined, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("uses bounded lifecycle and disposition attributes", () =>
    Effect.gen(function* () {
      const recorder = yield* makeOmpMetricRecorder;
      yield* recorder.recordReplay("duplicate");
      yield* recorder.recordReplay("gap");
      yield* recorder.recordToolUpdate("completed");
      yield* recorder.recordSubagentEvent("started");
      yield* recorder.recordInterrupt("requested");

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        matchingSnapshots(snapshots, "t3_omp_replay_events_total", {
          disposition: "duplicate",
        }).length,
        1,
      );
      assert.equal(
        matchingSnapshots(snapshots, "t3_omp_replay_events_total", { disposition: "gap" }).length,
        1,
      );
      assert.equal(
        matchingSnapshots(snapshots, "t3_omp_tool_updates_total", { status: "completed" }).length,
        1,
      );
      assert.equal(
        matchingSnapshots(snapshots, "t3_omp_subagent_events_total", { lifecycle: "started" })
          .length,
        1,
      );
      assert.equal(
        matchingSnapshots(snapshots, "t3_omp_interrupts_total", { disposition: "requested" })
          .length,
        1,
      );
    }),
  );
});
