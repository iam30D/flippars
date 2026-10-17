import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewEvaluation } from "./review-model-evaluation.mjs";

function fixture() {
  return {
    schemaVersion: "flippars.model-evaluation/4",
    signalType: "FIVE_MINUTE_EARLY_DIRECTION",
    version: "synthetic.1",
    status: "DRAFT",
    productionEligible: false,
    evaluationScope: "BINANCE_CONDITIONAL_DETERMINISTIC_WINDOW_SAMPLE_DIAGNOSTIC_ONLY",
    brierSkillFraction: 0.06,
    holdout: { expectedCalibrationError: 0.02 },
    holdoutPolicyReplay: {
      alertCount: 100,
      windowCount: 1000,
      precision: 0.8,
      precisionCi95: [0.71, 0.87],
      abstentionRowCounts: { OUT_OF_DISTRIBUTION: 50 },
      perDirection: {
        ABOVE_OPEN: { alertCount: 50, correctCount: 40 },
        BELOW_OPEN: { alertCount: 50, correctCount: 40 },
      },
    },
    productionGuardedPolicyReplay: { alertCount: 0 },
  };
}

test("passing diagnostic points never produce approval", () => {
  const result = reviewEvaluation(fixture());
  assert.equal(result.productionEligible, false);
  assert.equal(result.diagnosticOnly, true);
  assert.ok(Object.values(result.provisionalDiagnosticChecks).every(Boolean));
  assert.equal(result.missingReleaseEvidence.length, 4);
});

test("zero alerts retain unavailable precision and fail precision checks", () => {
  const input = fixture();
  Object.assign(input.holdoutPolicyReplay, {
    alertCount: 0,
    precision: null,
    precisionCi95: null,
    perDirection: {
      ABOVE_OPEN: { alertCount: 0, correctCount: 0 },
      BELOW_OPEN: { alertCount: 0, correctCount: 0 },
    },
  });
  const result = reviewEvaluation(input);
  assert.equal(result.conditionalPrecision, null);
  assert.equal(
    result.provisionalDiagnosticChecks.precisionPointAtLeastSeventyFivePercent,
    false,
  );
});

test("malformed and contradictory evidence fails closed", () => {
  for (const mutate of [
    (e) => {
      e.productionEligible = true;
    },
    (e) => {
      e.brierSkillFraction = NaN;
    },
    (e) => {
      e.holdoutPolicyReplay.precision = 0.99;
    },
    (e) => {
      e.holdoutPolicyReplay.precisionCi95 = [0.9, 0.7];
    },
    (e) => {
      e.holdoutPolicyReplay.perDirection.ABOVE_OPEN.correctCount = 60;
    },
    (e) => {
      e.productionGuardedPolicyReplay.alertCount = 1;
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => reviewEvaluation(input));
  }
});
