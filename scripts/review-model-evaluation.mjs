import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const fraction = z.number().finite().min(0).max(1);
const count = z.number().int().nonnegative();
const EvaluationProjection = z.object({
  schemaVersion: z.literal("flippars.model-evaluation/4"),
  signalType: z.enum([
    "FIVE_MINUTE_EARLY_DIRECTION",
    "FIVE_MINUTE_REVERSAL",
    "FIFTEEN_MINUTE_REVERSAL",
  ]),
  version: z.string().min(1),
  status: z.literal("DRAFT"),
  productionEligible: z.literal(false),
  evaluationScope: z.literal(
    "BINANCE_CONDITIONAL_DETERMINISTIC_WINDOW_SAMPLE_DIAGNOSTIC_ONLY",
  ),
  brierSkillFraction: z.number().finite(),
  holdout: z.object({ expectedCalibrationError: fraction }),
  holdoutPolicyReplay: z.object({
    alertCount: count,
    windowCount: count.positive(),
    precision: fraction.nullable(),
    precisionCi95: z.tuple([fraction, fraction]).nullable(),
    abstentionRowCounts: z.record(count),
    perDirection: z.object({
      ABOVE_OPEN: z.object({ alertCount: count, correctCount: count }),
      BELOW_OPEN: z.object({ alertCount: count, correctCount: count }),
    }),
  }),
  productionGuardedPolicyReplay: z.object({ alertCount: z.literal(0) }),
});

/** Diagnostic projection only: never a promotion or full evidence verifier. */
export function reviewEvaluation(value) {
  const e = EvaluationProjection.parse(value);
  const policy = e.holdoutPolicyReplay;
  const directions = Object.values(policy.perDirection);
  const correct = directions.reduce((total, item) => total + item.correctCount, 0);
  if (
    policy.alertCount > policy.windowCount ||
    directions.some((item) => item.correctCount > item.alertCount) ||
    directions.reduce((total, item) => total + item.alertCount, 0) !==
      policy.alertCount ||
    (policy.alertCount === 0
      ? policy.precision !== null || policy.precisionCi95 !== null
      : policy.precision === null ||
        Math.abs(policy.precision - correct / policy.alertCount) > 1e-12) ||
    (policy.precisionCi95 !== null && policy.precisionCi95[0] > policy.precisionCi95[1])
  ) {
    throw new Error("Contradictory alert counts, precision, or uncertainty");
  }
  return {
    schemaVersion: "flippars.evaluation-review/1",
    signalType: e.signalType,
    version: e.version,
    diagnosticOnly: true,
    productionEligible: false,
    evaluationScope: e.evaluationScope,
    brierSkillFraction: e.brierSkillFraction,
    allScheduledExpectedCalibrationError: e.holdout.expectedCalibrationError,
    conditionalAlerts: policy.alertCount,
    conditionalWindowCoverage: policy.alertCount / policy.windowCount,
    conditionalPrecision: policy.precision,
    conditionalPrecisionCi95: policy.precisionCi95,
    conditionalAbstentionRowCounts: policy.abstentionRowCounts,
    provisionalDiagnosticChecks: {
      brierSkillPointAtLeastFivePercent: e.brierSkillFraction >= 0.05,
      allScheduledEceAtMostThreePercent: e.holdout.expectedCalibrationError <= 0.03,
      precisionPointAtLeastSeventyFivePercent:
        policy.precision !== null && policy.precision >= 0.75,
      precisionLowerBoundAtLeastSeventyPercent:
        policy.precisionCi95 !== null && policy.precisionCi95[0] >= 0.7,
    },
    missingReleaseEvidence: [
      "Full-population policy evaluation and baseline-skill uncertainty",
      "Emitted-subset calibration and adequately supported bins",
      "Live receive-time, trade-feature, outcome, and cross-venue guard parity",
      "Prospective shadow, independent approvals, signing, canary, and rollback",
    ],
    warning:
      "Diagnostic checks cannot approve a model. Abstention counts are visited decision rows, not exclusive window rates; replay stops after the first alert in a window.",
  };
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error(
      "Usage: node scripts/review-model-evaluation.mjs <evaluation.json>",
    );
  }
  const path = resolve(process.argv[2]);
  const info = await stat(path);
  if (!info.isFile() || info.size > 2_000_000) {
    throw new Error("Evaluation must be a regular JSON file at most 2 MB");
  }
  const bytes = await readFile(path);
  if (bytes.length > 2_000_000) throw new Error("Evaluation exceeds 2 MB");
  const report = reviewEvaluation(JSON.parse(bytes.toString("utf8")));
  process.stdout.write(
    JSON.stringify(
      { ...report, evaluationSha256: createHash("sha256").update(bytes).digest("hex") },
      null,
      2,
    ) + "\n",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    process.stderr.write(
      "Evaluation review failed: invalid, inconsistent, unsupported, or unreadable input.\n",
    );
    process.exitCode = 1;
  });
}
