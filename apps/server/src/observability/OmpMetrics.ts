import type { TurnId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import {
  increment,
  metricAttributes,
  ompFirstOutputLatency,
  ompInterruptsTotal,
  ompReplayEventsTotal,
  ompSubagentEventsTotal,
  ompToolUpdatesTotal,
} from "./Metrics.ts";

export type OmpOutputKind = "reasoning" | "text";
export type OmpReplayDisposition = "replayed" | "duplicate" | "gap";
export type OmpSubagentLifecycle = "started" | "progress" | "completed";
export type OmpInterruptDisposition = "requested" | "ignored";

export const makeOmpMetricRecorder = Effect.sync(() => {
  const turnStartedAt = new Map<TurnId, bigint>();
  const observedOutput = new Map<TurnId, Set<OmpOutputKind>>();

  const recordTurnStarted = (turnId: TurnId) =>
    Clock.currentTimeNanos.pipe(
      Effect.tap((startedAt) =>
        Effect.sync(() => {
          turnStartedAt.set(turnId, startedAt);
          observedOutput.delete(turnId);
        }),
      ),
      Effect.asVoid,
    );

  const recordFirstOutput = (turnId: TurnId, output: OmpOutputKind) =>
    Effect.gen(function* () {
      const startedAt = turnStartedAt.get(turnId);
      const observed = observedOutput.get(turnId);
      if (startedAt === undefined || observed?.has(output)) return;
      const endedAt = yield* Clock.currentTimeNanos;
      const elapsed = endedAt > startedAt ? endedAt - startedAt : 0n;
      const nextObserved = observed ?? new Set<OmpOutputKind>();
      nextObserved.add(output);
      observedOutput.set(turnId, nextObserved);
      yield* Metric.update(
        Metric.withAttributes(ompFirstOutputLatency, metricAttributes({ output })),
        Duration.nanos(elapsed),
      );
    });

  const recordTurnFinished = (turnId: TurnId) =>
    Effect.sync(() => {
      turnStartedAt.delete(turnId);
      observedOutput.delete(turnId);
    });

  return {
    recordTurnStarted,
    recordFirstOutput,
    recordTurnFinished,
    recordReplay: (disposition: OmpReplayDisposition) =>
      increment(ompReplayEventsTotal, { disposition }),
    recordToolUpdate: (status: string | undefined) =>
      increment(ompToolUpdatesTotal, { status: status ?? "unknown" }),
    recordSubagentEvent: (lifecycle: OmpSubagentLifecycle) =>
      increment(ompSubagentEventsTotal, { lifecycle }),
    recordInterrupt: (disposition: OmpInterruptDisposition) =>
      increment(ompInterruptsTotal, { disposition }),
  } as const;
});
