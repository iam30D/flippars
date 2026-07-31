import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LogisticArtifactSchema,
  TrainingRowSchema,
  type TrainingRow,
} from "./schema.js";
import {
  chronologicalPartitions,
  predictCandidate,
  trainCandidate,
} from "./training.js";

function rows(count = 120): TrainingRow[] {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const windowStart = start + index * 300_000;
    const momentum = Math.sin(index / 7);
    const imbalance = ((index % 9) - 4) / 4;
    return TrainingRowSchema.parse({
      id: `row-${index.toString().padStart(4, "0")}`,
      signalType: "FIVE_MINUTE_REVERSAL",
      candidateRelation: index % 2 === 0 ? "ABOVE_OPEN" : "BELOW_OPEN",
      decisionAt: new Date(windowStart + 60_000).toISOString(),
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowStart + 299_000).toISOString(),
      features: {
        momentum,
        imbalance,
        remainingRatio: 0.8,
      },
      correct: momentum + imbalance * 0.35 > 0,
      dataHealthy: true,
      anomalyRisk: 0.1,
    });
  });
}

describe("chronological model laboratory", () => {
  it("purges overlapping windows between chronological partitions", () => {
    const partitions = chronologicalPartitions(rows());
    const lastTrainEnd = Date.parse(partitions.train.at(-1)?.windowEnd ?? "");
    const firstCalibrationDecision = Date.parse(
      partitions.calibration[0]?.decisionAt ?? "",
    );
    const lastCalibrationEnd = Date.parse(
      partitions.calibration.at(-1)?.windowEnd ?? "",
    );
    const firstHoldoutDecision = Date.parse(partitions.holdout[0]?.decisionAt ?? "");
    assert.ok(lastTrainEnd < firstCalibrationDecision);
    assert.ok(lastCalibrationEnd < firstHoldoutDecision);
  });

  it("produces a reproducible draft-only calibrated artifact", () => {
    const options = {
      signalType: "FIVE_MINUTE_REVERSAL" as const,
      version: "candidate-1",
      createdAt: "2026-07-31T00:00:00.000Z",
      iterations: 800,
    };
    const first = trainCandidate(rows(), options);
    const second = trainCandidate(rows(), options);
    assert.deepEqual(first, second);
    assert.equal(first.status, "DRAFT");
    assert.equal(first.approval.approvedAt, null);
    assert.match(first.datasetSha256, /^[a-f0-9]{64}$/u);
    assert.ok(first.holdoutMetrics.sampleCount >= 5);
    assert.deepEqual(LogisticArtifactSchema.parse(first), first);
  });

  it("requires the exact feature schema at inference", () => {
    const artifact = trainCandidate(rows(), {
      signalType: "FIVE_MINUTE_REVERSAL",
      version: "candidate-2",
      createdAt: "2026-07-31T00:00:00.000Z",
      iterations: 800,
    });
    const probability = predictCandidate(artifact, {
      momentum: 0.9,
      imbalance: 0.5,
      remainingRatio: 0.8,
    });
    assert.ok(probability >= 0 && probability <= 1);
    assert.throws(
      () =>
        predictCandidate(artifact, {
          momentum: 0.9,
          remainingRatio: 0.8,
        }),
      /imbalance/u,
    );
  });
});
