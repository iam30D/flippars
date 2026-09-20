import { z } from "zod";

import { Rfc3339TimestampSchema } from "./primitives.js";
import { SignalTypeSchema } from "./signal.js";

export const BINANCE_SPOT_TARGET_VERSION =
  "binance-spot-trade-close-relation/1" as const;
export const BINANCE_SPOT_FEATURE_SCHEMA_VERSION =
  "binance-spot-signal-features/1" as const;
export const SIGNAL_CANDIDATE_SAMPLING_POLICY_VERSION =
  "flippars-signal-candidate-sampling/2" as const;
export const FIFTEEN_MINUTE_REVERSAL_START_SECONDS = 300 as const;
export const CROSS_VENUE_GUARD_POLICY_VERSION = "btc-usd-cross-venue-health/1" as const;
export const PRE_EVALUATION_POLICY_SCHEMA_VERSION =
  "flippars.pre-evaluation-policy/2" as const;
export const PRE_EVALUATION_POLICY_CANONICALIZATION =
  "SORTED_KEYS_ASCII_JSON_STRING_PREIMAGES_V1" as const;

export const BINANCE_SPOT_SIGNAL_FEATURE_NAMES = [
  "previous_return_bps",
  "previous_range_bps",
  "previous_volume_log1p",
  "previous_trade_count_log1p",
  "previous_buy_ratio",
  "previous_close_location",
  "current_return_from_open_bps",
  "current_range_bps",
  "current_volume_log1p",
  "current_trade_count_log1p",
  "current_buy_ratio",
  "current_close_location",
  "elapsed_ratio",
  "remaining_ratio",
  "return_3_candle_bps",
  "return_12_candle_bps",
  "realized_volatility_12",
  "mean_range_12_bps",
  "previous_volume_relative_12",
  "previous_trade_count_relative_12",
  "current_volume_rate_log1p",
  "current_trade_rate_log1p",
  "current_volume_rate_relative_12",
  "current_trade_rate_relative_12",
] as const;

export const CloseRelationClassSchema = z.enum(["ABOVE_OPEN", "BELOW_OPEN", "AT_OPEN"]);
export type CloseRelationClass = z.infer<typeof CloseRelationClassSchema>;

export const CloseRelationClassOrderSchema = z.tuple([
  z.literal("ABOVE_OPEN"),
  z.literal("BELOW_OPEN"),
  z.literal("AT_OPEN"),
]);

export const BinanceSpotSignalFeatureNamesSchema = z.tuple([
  z.literal("previous_return_bps"),
  z.literal("previous_range_bps"),
  z.literal("previous_volume_log1p"),
  z.literal("previous_trade_count_log1p"),
  z.literal("previous_buy_ratio"),
  z.literal("previous_close_location"),
  z.literal("current_return_from_open_bps"),
  z.literal("current_range_bps"),
  z.literal("current_volume_log1p"),
  z.literal("current_trade_count_log1p"),
  z.literal("current_buy_ratio"),
  z.literal("current_close_location"),
  z.literal("elapsed_ratio"),
  z.literal("remaining_ratio"),
  z.literal("return_3_candle_bps"),
  z.literal("return_12_candle_bps"),
  z.literal("realized_volatility_12"),
  z.literal("mean_range_12_bps"),
  z.literal("previous_volume_relative_12"),
  z.literal("previous_trade_count_relative_12"),
  z.literal("current_volume_rate_log1p"),
  z.literal("current_trade_rate_log1p"),
  z.literal("current_volume_rate_relative_12"),
  z.literal("current_trade_rate_relative_12"),
]);

export const CandidateDecisionScheduleSchema = z
  .object({
    schemaVersion: z.literal("flippars.candidate-decision-schedule/1"),
    kind: z.literal("FIXED_CADENCE"),
    firstDecisionOffsetSeconds: z.number().int().nonnegative(),
    lastDecisionOffsetSeconds: z.number().int().nonnegative(),
    cadenceSeconds: z.number().int().positive().max(60),
    phaseStartSeconds: z.number().int().nonnegative(),
    phaseEndExclusiveSeconds: z.number().int().positive(),
    minimumLeadTimeSeconds: z.number().int().nonnegative(),
    selectionPolicy: z.literal("FIRST_QUALIFIED_PER_WINDOW"),
  })
  .strict()
  .superRefine((schedule, context) => {
    if (
      schedule.lastDecisionOffsetSeconds < schedule.firstDecisionOffsetSeconds ||
      schedule.lastDecisionOffsetSeconds >= schedule.phaseEndExclusiveSeconds ||
      (schedule.lastDecisionOffsetSeconds - schedule.firstDecisionOffsetSeconds) %
        schedule.cadenceSeconds !==
        0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastDecisionOffsetSeconds"],
        message:
          "Last decision must be in phase and on the fixed cadence after the first",
      });
    }
  });

export const BinanceSpotForecastTargetSchema = z
  .object({
    kind: z.literal("BINANCE_SPOT_CANDLE_CLOSE_RELATION"),
    targetVersion: z.literal(BINANCE_SPOT_TARGET_VERSION),
    decisionPolicyVersion: z.literal(SIGNAL_CANDIDATE_SAMPLING_POLICY_VERSION),
    crossVenueGuardPolicyVersion: z.literal(CROSS_VENUE_GUARD_POLICY_VERSION),
    signalType: SignalTypeSchema,
    venue: z.literal("BINANCE"),
    marketType: z.literal("SPOT"),
    symbol: z.literal("BTCUSDT"),
    quoteAsset: z.literal("USDT"),
    input: z.literal("TRADE"),
    timeBasis: z.literal("EVENT_TIME"),
    tradeOrdering: z.literal("EVENT_TIME_THEN_TRADE_ID"),
    windowAlignment: z.literal("UTC_EPOCH"),
    windowBounds: z.literal("HALF_OPEN"),
    durationSeconds: z.union([z.literal(300), z.literal(900)]),
    openDefinition: z.literal("FIRST_TRADE_AT_OR_AFTER_WINDOW_START"),
    closeDefinition: z.literal("LAST_TRADE_BEFORE_WINDOW_END"),
    targetPriceNormalization: z.literal("NONE"),
    classOrder: CloseRelationClassOrderSchema,
    deadbandBps: z.number().finite().min(0).max(100),
    labelPolicyVersion: z.literal(BINANCE_SPOT_TARGET_VERSION),
    candidateSchedule: CandidateDecisionScheduleSchema,
  })
  .strict()
  .superRefine((target, context) => {
    const expectedDuration =
      target.signalType === "FIFTEEN_MINUTE_REVERSAL" ? 900 : 300;
    if (target.durationSeconds !== expectedDuration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSeconds"],
        message: `${target.signalType} requires a ${expectedDuration}-second target`,
      });
    }
    const schedule = target.candidateSchedule;
    const expectedPhaseStart =
      target.signalType === "FIFTEEN_MINUTE_REVERSAL"
        ? FIFTEEN_MINUTE_REVERSAL_START_SECONDS
        : 0;
    const expectedPhaseEnd =
      target.signalType === "FIVE_MINUTE_EARLY_DIRECTION" ? 60 : expectedDuration;
    const expectedFirstDecisionOffset =
      target.signalType === "FIFTEEN_MINUTE_REVERSAL"
        ? FIFTEEN_MINUTE_REVERSAL_START_SECONDS
        : 15;
    const expectedLastDecisionOffset =
      target.signalType === "FIFTEEN_MINUTE_REVERSAL"
        ? 870
        : target.signalType === "FIVE_MINUTE_EARLY_DIRECTION"
          ? 45
          : 285;
    const expectedMinimumLead =
      target.signalType === "FIFTEEN_MINUTE_REVERSAL" ? 30 : 15;
    if (
      schedule.phaseStartSeconds !== expectedPhaseStart ||
      schedule.phaseEndExclusiveSeconds !== expectedPhaseEnd ||
      schedule.firstDecisionOffsetSeconds !== expectedFirstDecisionOffset ||
      schedule.lastDecisionOffsetSeconds !== expectedLastDecisionOffset ||
      schedule.cadenceSeconds !== 15 ||
      schedule.minimumLeadTimeSeconds !== expectedMinimumLead
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateSchedule"],
        message:
          `Policy V2 requires phase [${expectedPhaseStart}, ${expectedPhaseEnd}), ` +
          `offsets ${expectedFirstDecisionOffset}..${expectedLastDecisionOffset}, 15-second cadence, and ` +
          `${expectedMinimumLead}-second minimum lead`,
      });
    }
    if (
      schedule.firstDecisionOffsetSeconds < schedule.phaseStartSeconds ||
      schedule.firstDecisionOffsetSeconds >= schedule.phaseEndExclusiveSeconds
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateSchedule", "firstDecisionOffsetSeconds"],
        message: "First decision offset must be inside the signal phase",
      });
    }
    if (
      schedule.firstDecisionOffsetSeconds >
      expectedDuration - schedule.minimumLeadTimeSeconds
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateSchedule", "minimumLeadTimeSeconds"],
        message: "First decision does not satisfy minimum lead time",
      });
    }
    if (
      schedule.lastDecisionOffsetSeconds >
      expectedDuration - schedule.minimumLeadTimeSeconds
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateSchedule", "minimumLeadTimeSeconds"],
        message: "Every scheduled decision must satisfy minimum lead time",
      });
    }
  });

export type BinanceSpotForecastTarget = z.infer<typeof BinanceSpotForecastTargetSchema>;

export const BinanceSpotRuntimeCompatibilitySchema = z
  .object({
    schemaVersion: z.literal("flippars.binance-runtime-compatibility/1"),
    targetVersion: z.literal(BINANCE_SPOT_TARGET_VERSION),
    featureSchemaVersion: z.literal(BINANCE_SPOT_FEATURE_SCHEMA_VERSION),
    decisionPolicyVersion: z.literal(SIGNAL_CANDIDATE_SAMPLING_POLICY_VERSION),
    crossVenueGuardPolicyVersion: z.literal(CROSS_VENUE_GUARD_POLICY_VERSION),
    signalType: SignalTypeSchema,
    durationSeconds: z.union([z.literal(300), z.literal(900)]),
    deadbandBps: z.number().finite().min(0).max(100),
    classOrder: CloseRelationClassOrderSchema,
    candidateSchedule: CandidateDecisionScheduleSchema,
    oodVersion: z.string().min(1).max(80),
  })
  .strict()
  .superRefine((runtime, context) => {
    const expectedDuration =
      runtime.signalType === "FIFTEEN_MINUTE_REVERSAL" ? 900 : 300;
    if (runtime.durationSeconds !== expectedDuration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSeconds"],
        message: `${runtime.signalType} requires a ${expectedDuration}-second runtime`,
      });
    }
    const schedule = runtime.candidateSchedule;
    const expectedPhaseStart =
      runtime.signalType === "FIFTEEN_MINUTE_REVERSAL"
        ? FIFTEEN_MINUTE_REVERSAL_START_SECONDS
        : 0;
    const expectedPhaseEnd =
      runtime.signalType === "FIVE_MINUTE_EARLY_DIRECTION" ? 60 : expectedDuration;
    const expectedFirstDecisionOffset =
      runtime.signalType === "FIFTEEN_MINUTE_REVERSAL"
        ? FIFTEEN_MINUTE_REVERSAL_START_SECONDS
        : 15;
    const expectedLastDecisionOffset =
      runtime.signalType === "FIFTEEN_MINUTE_REVERSAL"
        ? 870
        : runtime.signalType === "FIVE_MINUTE_EARLY_DIRECTION"
          ? 45
          : 285;
    const expectedMinimumLead =
      runtime.signalType === "FIFTEEN_MINUTE_REVERSAL" ? 30 : 15;
    if (
      schedule.phaseStartSeconds !== expectedPhaseStart ||
      schedule.phaseEndExclusiveSeconds !== expectedPhaseEnd ||
      schedule.firstDecisionOffsetSeconds !== expectedFirstDecisionOffset ||
      schedule.lastDecisionOffsetSeconds !== expectedLastDecisionOffset ||
      schedule.cadenceSeconds !== 15 ||
      schedule.minimumLeadTimeSeconds !== expectedMinimumLead
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateSchedule"],
        message:
          `Policy V2 requires phase [${expectedPhaseStart}, ${expectedPhaseEnd}), ` +
          `offsets ${expectedFirstDecisionOffset}..${expectedLastDecisionOffset}, 15-second cadence, and ` +
          `${expectedMinimumLead}-second minimum lead`,
      });
    }
    if (
      schedule.firstDecisionOffsetSeconds < schedule.phaseStartSeconds ||
      schedule.firstDecisionOffsetSeconds >= schedule.phaseEndExclusiveSeconds ||
      schedule.firstDecisionOffsetSeconds >
        expectedDuration - schedule.minimumLeadTimeSeconds
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateSchedule", "firstDecisionOffsetSeconds"],
        message: "First decision must be in phase and satisfy minimum lead time",
      });
    }
    if (
      schedule.lastDecisionOffsetSeconds >
      expectedDuration - schedule.minimumLeadTimeSeconds
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateSchedule", "minimumLeadTimeSeconds"],
        message: "Every scheduled decision must satisfy minimum lead time",
      });
    }
  });

export type BinanceSpotRuntimeCompatibility = z.infer<
  typeof BinanceSpotRuntimeCompatibilitySchema
>;

const FeatureValuesSchema = z
  .object({
    previous_return_bps: z.number().finite(),
    previous_range_bps: z.number().finite().nonnegative(),
    previous_volume_log1p: z.number().finite().nonnegative(),
    previous_trade_count_log1p: z.number().finite().nonnegative(),
    previous_buy_ratio: z.number().finite().min(0).max(1),
    previous_close_location: z.number().finite().min(0).max(1),
    current_return_from_open_bps: z.number().finite(),
    current_range_bps: z.number().finite().nonnegative(),
    current_volume_log1p: z.number().finite().nonnegative(),
    current_trade_count_log1p: z.number().finite().nonnegative(),
    current_buy_ratio: z.number().finite().min(0).max(1),
    current_close_location: z.number().finite().min(0).max(1),
    elapsed_ratio: z.number().finite().min(0).max(1),
    remaining_ratio: z.number().finite().min(0).max(1),
    return_3_candle_bps: z.number().finite(),
    return_12_candle_bps: z.number().finite(),
    realized_volatility_12: z.number().finite().nonnegative(),
    mean_range_12_bps: z.number().finite().nonnegative(),
    previous_volume_relative_12: z.number().finite().nonnegative(),
    previous_trade_count_relative_12: z.number().finite().nonnegative(),
    current_volume_rate_log1p: z.number().finite().nonnegative(),
    current_trade_rate_log1p: z.number().finite().nonnegative(),
    current_volume_rate_relative_12: z.number().finite().nonnegative(),
    current_trade_rate_relative_12: z.number().finite().nonnegative(),
  })
  .strict();

const CanonicalTradeIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .max(40);
const validationIssue = (path: (string | number)[], message: string) => ({
  code: "custom" as const,
  path,
  message,
});

const unalignedWindowIssue = validationIssue(
  ["windowStart"],
  "Target window must align to UTC epoch",
);
const unscheduledDecisionIssue = validationIssue(
  ["decisionOffsetSeconds"],
  "Decision must use the policy-v1 schedule",
);
const unorderedTradeIssue = validationIssue(
  ["lastIncludedTradeId"],
  "Equal-time trades must use increasing IDs",
);
const elapsedRatioIssue = validationIssue(
  ["values", "elapsed_ratio"],
  "elapsed_ratio must match decisionAt",
);
const remainingRatioIssue = validationIssue(
  ["values", "remaining_ratio"],
  "remaining_ratio must match decisionAt",
);

export const BinanceSpotFeatureVectorSchema = z
  .object({
    schemaVersion: z.literal(BINANCE_SPOT_FEATURE_SCHEMA_VERSION),
    targetVersion: z.literal(BINANCE_SPOT_TARGET_VERSION),
    signalType: SignalTypeSchema,
    decisionAt: Rfc3339TimestampSchema,
    windowStart: Rfc3339TimestampSchema,
    windowEnd: Rfc3339TimestampSchema,
    windowOpenTradeEventAt: Rfc3339TimestampSchema,
    windowOpenTradeId: CanonicalTradeIdSchema,
    lastIncludedTradeEventAt: Rfc3339TimestampSchema,
    lastIncludedTradeId: CanonicalTradeIdSchema,
    decisionPolicyVersion: z.literal(SIGNAL_CANDIDATE_SAMPLING_POLICY_VERSION),
    decisionOffsetSeconds: z.number().int().nonnegative(),
    pointInTimeCutoff: z.literal("EVENT_TIME_LT_DECISION_AT"),
    completedLookbackPolicy: z.literal("REQUIRE_13_CONTIGUOUS_COMPLETED_WINDOWS"),
    sourceIntegrityHealthy: z.literal(true),
    crossVenueGuardAvailability: z.literal("UNAVAILABLE"),
    productionEligible: z.literal(false),
    zeroRangeCloseLocation: z.literal(0.5),
    missingValuePolicy: z.literal("ABSTAIN"),
    featureNames: BinanceSpotSignalFeatureNamesSchema,
    values: FeatureValuesSchema,
  })
  .strict()
  .superRefine((vector, context) => {
    const decisionAt = Date.parse(vector.decisionAt);
    const windowStart = Date.parse(vector.windowStart);
    const windowEnd = Date.parse(vector.windowEnd);
    const windowOpenTradeEventAt = Date.parse(vector.windowOpenTradeEventAt);
    const lastIncludedTradeEventAt = Date.parse(vector.lastIncludedTradeEventAt);
    if (!(windowStart <= decisionAt && decisionAt < windowEnd)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisionAt"],
        message: "decisionAt must be inside the half-open target window",
      });
    }
    if (!(
      windowStart <= windowOpenTradeEventAt &&
      windowOpenTradeEventAt <= lastIncludedTradeEventAt &&
      lastIncludedTradeEventAt < decisionAt
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastIncludedTradeEventAt"],
        message:
          "Open and included trades must be ordered inside the causal decision window",
      });
    }
    if ((decisionAt - windowStart) / 1_000 !== vector.decisionOffsetSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisionOffsetSeconds"],
        message: "decisionOffsetSeconds must match decisionAt minus windowStart",
      });
    }
    const durationMs =
      (vector.signalType === "FIFTEEN_MINUTE_REVERSAL" ? 900 : 300) * 1_000;
    if (windowEnd - windowStart !== durationMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["windowEnd"],
        message: "Target window duration does not match signalType",
      });
    }
    const windowAligned =
      windowStart / durationMs === Math.trunc(windowStart / durationMs);
    if (!windowAligned) context.addIssue(unalignedWindowIssue);
    const offsetStart =
      vector.signalType === "FIFTEEN_MINUTE_REVERSAL"
        ? FIFTEEN_MINUTE_REVERSAL_START_SECONDS
        : 15;
    const offsetEnd =
      vector.signalType === "FIFTEEN_MINUTE_REVERSAL"
        ? 870
        : vector.signalType === "FIVE_MINUTE_EARLY_DIRECTION"
          ? 45
          : 285;
    const cadenceStep = (vector.decisionOffsetSeconds - offsetStart) / 15;
    const scheduled =
      vector.decisionOffsetSeconds >= offsetStart &&
      vector.decisionOffsetSeconds <= offsetEnd &&
      cadenceStep === Math.trunc(cadenceStep);
    if (!scheduled) context.addIssue(unscheduledDecisionIssue);
    const sameTradeTime = windowOpenTradeEventAt === lastIncludedTradeEventAt;
    if (
      sameTradeTime &&
      BigInt(vector.windowOpenTradeId) > BigInt(vector.lastIncludedTradeId)
    ) {
      context.addIssue(unorderedTradeIssue);
    }
    const expectedElapsed = (vector.decisionOffsetSeconds * 1_000) / durationMs;
    if (Math.abs(vector.values.elapsed_ratio - expectedElapsed) > 1e-9) {
      context.addIssue(elapsedRatioIssue);
    }
    if (Math.abs(vector.values.remaining_ratio - (1 - expectedElapsed)) > 1e-9) {
      context.addIssue(remainingRatioIssue);
    }
    const ratioTotal = vector.values.elapsed_ratio + vector.values.remaining_ratio;
    if (Math.abs(ratioTotal - 1) > 1e-9) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["values", "remaining_ratio"],
        message: "elapsed_ratio and remaining_ratio must sum to one",
      });
    }
  });

export type BinanceSpotFeatureVector = z.infer<typeof BinanceSpotFeatureVectorSchema>;

export const CloseRelationProbabilitiesSchema = z
  .object({
    ABOVE_OPEN: z.number().finite().min(0).max(1),
    BELOW_OPEN: z.number().finite().min(0).max(1),
    AT_OPEN: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((probabilities, context) => {
    const sum =
      probabilities.ABOVE_OPEN + probabilities.BELOW_OPEN + probabilities.AT_OPEN;
    if (Math.abs(sum - 1) > 1e-6) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Three-class probabilities must sum to one",
      });
    }
  });

export type CloseRelationProbabilities = z.infer<
  typeof CloseRelationProbabilitiesSchema
>;

export const ThreeClassForecastSchema = z
  .object({
    schemaVersion: z.literal("flippars.three-class-forecast/1"),
    id: z.string().min(1).max(160),
    signalType: SignalTypeSchema,
    artifactId: z.string().min(1).max(160),
    targetVersion: z.literal(BINANCE_SPOT_TARGET_VERSION),
    featureSchemaVersion: z.literal(BINANCE_SPOT_FEATURE_SCHEMA_VERSION),
    generatedAt: Rfc3339TimestampSchema,
    decisionAt: Rfc3339TimestampSchema,
    predictedClass: CloseRelationClassSchema,
    probabilities: CloseRelationProbabilitiesSchema,
    calibrated: z.boolean(),
    calibrationVersion: z.string().min(1).max(80),
    outOfDistribution: z.boolean(),
  })
  .strict()
  .superRefine((forecast, context) => {
    const order = ["ABOVE_OPEN", "BELOW_OPEN", "AT_OPEN"] as const;
    const predicted = order.reduce((best, candidate) =>
      forecast.probabilities[candidate] > forecast.probabilities[best]
        ? candidate
        : best,
    );
    if (forecast.predictedClass !== predicted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["predictedClass"],
        message: "predictedClass must be the deterministic probability argmax",
      });
    }
  });

export type ThreeClassForecast = z.infer<typeof ThreeClassForecastSchema>;

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const CanonicalUtcDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    );
  }, "Date must be a canonical UTC calendar date");
const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const DatasetManifestSummarySchema = z
  .object({
    schemaVersion: z.union([
      z.literal("flippars.dataset-manifest-summary/3"),
      z.literal("flippars.dataset-manifest-summary/4"),
    ]),
    datasetContentSha256: Sha256HexSchema,
    datasetManifestSha256: Sha256HexSchema,
    lineageKind: z.enum([
      "PUBLIC_BINANCE_ARCHIVE",
      "LOCAL_ARCHIVE_REPLAY",
      "SYNTHETIC_LOCAL",
    ]),
    preparedArchiveIndexSha256: Sha256HexSchema,
    acquisitionArchiveIndexSha256: Sha256HexSchema.nullable(),
    acquisitionManifestSha256: Sha256HexSchema.nullable(),
    rejectLogSha256: Sha256HexSchema,
    source: z.enum(["BINANCE_DATA_VISION", "LOCAL_ARCHIVE_REPLAY", "SYNTHETIC_LOCAL"]),
    dataKind: z.literal("TRADES"),
    symbol: z.literal("BTCUSDT"),
    targetVersion: z.literal(BINANCE_SPOT_TARGET_VERSION),
    featureSchemaVersion: z.literal(BINANCE_SPOT_FEATURE_SCHEMA_VERSION),
    deadbandBps: z.number().finite().min(0).max(100),
    candidateSchedule: CandidateDecisionScheduleSchema,
    windowCountUnit: z.literal("UNIQUE_WINDOW_START"),
    sourceIntegrityRequired: z.literal(true),
    crossVenueGuardAvailability: z.literal("UNAVAILABLE"),
    productionEligible: z.literal(false),
    archiveCount: NonNegativeSafeIntegerSchema,
    archiveChecksumsVerified: z.boolean(),
    officialTransportEvidenceVerified: z.boolean(),
    sourceStartDateInclusive: CanonicalUtcDateSchema.nullable(),
    sourceEndDateExclusive: CanonicalUtcDateSchema.nullable(),
    sourceDayCount: NonNegativeSafeIntegerSchema,
    startAt: Rfc3339TimestampSchema,
    endAt: Rfc3339TimestampSchema,
    acceptedTradeCount: NonNegativeSafeIntegerSchema,
    rejectedTradeCount: NonNegativeSafeIntegerSchema,
    gapCount: NonNegativeSafeIntegerSchema,
    duplicateTradeCount: NonNegativeSafeIntegerSchema,
    preparedWindowCount: NonNegativeSafeIntegerSchema,
    preparedDecisionRowCount: NonNegativeSafeIntegerSchema,
    partitionWindowCounts: z
      .object({
        modelFit: NonNegativeSafeIntegerSchema,
        calibration: NonNegativeSafeIntegerSchema,
        evaluation: NonNegativeSafeIntegerSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const expectedSource = {
      PUBLIC_BINANCE_ARCHIVE: "BINANCE_DATA_VISION",
      LOCAL_ARCHIVE_REPLAY: "LOCAL_ARCHIVE_REPLAY",
      SYNTHETIC_LOCAL: "SYNTHETIC_LOCAL",
    } as const;
    if (manifest.source !== expectedSource[manifest.lineageKind]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: "Source name must match the lineage kind",
      });
    }
    const isPublic = manifest.lineageKind === "PUBLIC_BINANCE_ARCHIVE";
    if (
      manifest.schemaVersion === "flippars.dataset-manifest-summary/3" &&
      manifest.gapCount !== 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gapCount"],
        message: "Dataset manifest summary V3 is gap-free",
      });
    }
    if (
      manifest.archiveChecksumsVerified !== isPublic ||
      manifest.officialTransportEvidenceVerified !== isPublic ||
      (isPublic
        ? manifest.acquisitionArchiveIndexSha256 === null ||
          manifest.acquisitionManifestSha256 === null
        : manifest.acquisitionArchiveIndexSha256 !== null ||
          manifest.acquisitionManifestSha256 !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineageKind"],
        message:
          "Official checksum and transport claims require public Binance acquisition evidence",
      });
    }
    if (
      isPublic &&
      (manifest.archiveCount === 0 ||
        manifest.acceptedTradeCount === 0 ||
        manifest.rejectedTradeCount !== 0 ||
        manifest.duplicateTradeCount !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineageKind"],
        message:
          "Public Binance lineage requires nonempty, rejection-free, duplicate-free source data",
      });
    }
    if (manifest.sourceDayCount !== manifest.archiveCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceDayCount"],
        message: "Source day count must match archive count",
      });
    }
    if (manifest.archiveCount === 0) {
      if (
        manifest.sourceStartDateInclusive !== null ||
        manifest.sourceEndDateExclusive !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sourceStartDateInclusive"],
          message: "Archive-free lineage cannot claim a source date range",
        });
      }
    } else if (
      manifest.sourceStartDateInclusive === null ||
      manifest.sourceEndDateExclusive === null ||
      (Date.parse(`${manifest.sourceEndDateExclusive}T00:00:00.000Z`) -
        Date.parse(`${manifest.sourceStartDateInclusive}T00:00:00.000Z`)) /
        86_400_000 !==
        manifest.sourceDayCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceEndDateExclusive"],
        message: "Source date range must match source day count",
      });
    }
    if (Date.parse(manifest.endAt) <= Date.parse(manifest.startAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endAt"],
        message: "Dataset endAt must be later than startAt",
      });
    }
    if (manifest.preparedDecisionRowCount < manifest.preparedWindowCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preparedDecisionRowCount"],
        message: "preparedDecisionRowCount cannot be smaller than preparedWindowCount",
      });
    }
    const partitionWindowCount =
      manifest.partitionWindowCounts.modelFit +
      manifest.partitionWindowCounts.calibration +
      manifest.partitionWindowCounts.evaluation;
    if (partitionWindowCount !== manifest.preparedWindowCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["partitionWindowCounts"],
        message:
          "Partition counts must cover every unique prepared window exactly once",
      });
    }
  });

export const DatasetManifestSummaryV3Schema = DatasetManifestSummarySchema.refine(
  (manifest) => manifest.schemaVersion === "flippars.dataset-manifest-summary/3",
  {
    path: ["schemaVersion"],
    message: "Expected dataset manifest summary V3",
  },
);
export const DatasetManifestSummaryV4Schema = DatasetManifestSummarySchema.refine(
  (manifest) => manifest.schemaVersion === "flippars.dataset-manifest-summary/4",
  {
    path: ["schemaVersion"],
    message: "Expected dataset manifest summary V4",
  },
);
export type DatasetManifestSummary = z.infer<typeof DatasetManifestSummarySchema>;

const CanonicalNonNegativeDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u);

const ConfidenceThresholdDecimalSchema = CanonicalNonNegativeDecimalStringSchema.refine(
  (value) => value === "1" || /^0\.[5-9]\d*$/u.test(value),
  "Confidence threshold must be a canonical decimal between 0.5 and 1",
);

const MAX_CANONICAL_JSON_PREIMAGE_CHARACTERS = 1_048_576;
const MAX_CANONICAL_JSON_PREIMAGE_DEPTH = 64;

type CanonicalJsonValueKind = "array" | "object" | "scalar";

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

function canonicalPythonJsonString(value: string): string {
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const codeUnit = value.charCodeAt(index);
    if (character === '"') {
      result += '\\"';
    } else if (character === "\\") {
      result += "\\\\";
    } else if (character === "\b") {
      result += "\\b";
    } else if (character === "\f") {
      result += "\\f";
    } else if (character === "\n") {
      result += "\\n";
    } else if (character === "\r") {
      result += "\\r";
    } else if (character === "\t") {
      result += "\\t";
    } else if (codeUnit < 0x20 || codeUnit > 0x7e) {
      result += "\\u" + codeUnit.toString(16).padStart(4, "0");
    } else {
      result += character;
    }
  }
  return result + '"';
}

function comparePythonUnicodeCodePoints(left: string, right: string): number {
  let leftOffset = 0;
  let rightOffset = 0;

  while (leftOffset < left.length && rightOffset < right.length) {
    const leftCodePoint = left.codePointAt(leftOffset)!;
    const rightCodePoint = right.codePointAt(rightOffset)!;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
    leftOffset += leftCodePoint > 0xffff ? 2 : 1;
    rightOffset += rightCodePoint > 0xffff ? 2 : 1;
  }

  if (leftOffset === left.length && rightOffset === right.length) {
    return 0;
  }
  return leftOffset === left.length ? -1 : 1;
}

function canonicalPythonFloatSpelling(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("Canonical JSON preimage contains a non-finite JSON number");
  }
  if (Object.is(value, -0)) {
    return "-0.0";
  }
  const exponential = value.toExponential();
  const separator = exponential.lastIndexOf("e");
  const mantissa = exponential.slice(0, separator);
  const exponent = Number(exponential.slice(separator + 1));
  if (exponent < -4 || exponent >= 16) {
    const sign = exponent >= 0 ? "+" : "-";
    return mantissa + "e" + sign + Math.abs(exponent).toString().padStart(2, "0");
  }
  const fixed = value.toString();
  return fixed.includes(".") ? fixed : fixed + ".0";
}

class CanonicalJsonPreimageParser {
  private readonly numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;

  private offset = 0;

  public constructor(private readonly text: string) {}

  public parseObjectRoot(): Record<string, unknown> {
    const kind = this.parseValue(0);
    if (kind !== "object") {
      this.fail("must have a plain-object root");
    }
    if (this.offset !== this.text.length) {
      this.fail("contains trailing content");
    }

    const parsed: unknown = JSON.parse(this.text);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      this.fail("must have a plain-object root");
    }
    return parsed as Record<string, unknown>;
  }

  private parseValue(depth: number): CanonicalJsonValueKind {
    if (depth > MAX_CANONICAL_JSON_PREIMAGE_DEPTH) {
      this.fail("exceeds the maximum nesting depth");
    }

    const character = this.text[this.offset];
    if (character === "{") return this.parseObject(depth);
    if (character === "[") return this.parseArray(depth);
    if (character === '"') {
      this.parseString();
      return "scalar";
    }
    if (character === "t") {
      this.parseLiteral("true");
      return "scalar";
    }
    if (character === "f") {
      this.parseLiteral("false");
      return "scalar";
    }
    if (character === "n") {
      this.parseLiteral("null");
      return "scalar";
    }
    if (character === "-" || (character !== undefined && /\d/u.test(character))) {
      this.parseNumber();
      return "scalar";
    }

    this.fail("contains whitespace or an invalid JSON token");
  }

  private parseObject(depth: number): CanonicalJsonValueKind {
    this.offset += 1;
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return "object";
    }

    let previousKey: string | undefined;
    while (true) {
      if (this.text[this.offset] !== '"') {
        this.fail("contains whitespace or a non-string object key");
      }
      const key = this.parseString();
      if (
        previousKey !== undefined &&
        comparePythonUnicodeCodePoints(key, previousKey) <= 0
      ) {
        this.fail("object keys must be unique and strictly ascending");
      }
      previousKey = key;
      this.expect(":");
      this.parseValue(depth + 1);

      const separator = this.text[this.offset];
      if (separator === "}") {
        this.offset += 1;
        return "object";
      }
      if (separator !== ",") {
        this.fail("contains whitespace or an invalid object separator");
      }
      this.offset += 1;
    }
  }

  private parseArray(depth: number): CanonicalJsonValueKind {
    this.offset += 1;
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return "array";
    }

    while (true) {
      this.parseValue(depth + 1);
      const separator = this.text[this.offset];
      if (separator === "]") {
        this.offset += 1;
        return "array";
      }
      if (separator !== ",") {
        this.fail("contains whitespace or an invalid array separator");
      }
      this.offset += 1;
    }
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const character = this.text[this.offset]!;
      if (character === '"') {
        this.offset += 1;
        const token = this.text.slice(start, this.offset);
        const value: unknown = JSON.parse(token);
        if (typeof value !== "string") {
          this.fail("contains an invalid JSON string");
        }
        if (token !== canonicalPythonJsonString(value)) {
          this.fail("contains a non-canonical JSON string spelling");
        }
        return value;
      }
      if (character.charCodeAt(0) < 0x20) {
        this.fail("contains an unescaped control character");
      }
      if (character !== "\\") {
        this.offset += 1;
        continue;
      }

      const escape = this.text[this.offset + 1];
      if (escape === undefined) {
        this.fail("contains an unterminated JSON escape");
      }
      if ('"\\/bfnrt'.includes(escape)) {
        this.offset += 2;
        continue;
      }
      if (escape !== "u") {
        this.fail("contains an invalid JSON escape");
      }
      const hexadecimal = this.text.slice(this.offset + 2, this.offset + 6);
      if (!/^[a-fA-F0-9]{4}$/u.test(hexadecimal)) {
        this.fail("contains an invalid Unicode escape");
      }
      this.offset += 6;
    }

    this.fail("contains an unterminated JSON string");
  }

  private parseNumber(): void {
    this.numberPattern.lastIndex = this.offset;
    const match = this.numberPattern.exec(this.text);
    if (match === null) {
      this.fail("contains an invalid JSON number");
    }
    const spelling = match[0];
    const isFloatingPoint = /[.eE]/u.test(spelling);
    const numeric = Number(spelling);
    if (!isFloatingPoint && !Number.isSafeInteger(numeric)) {
      this.fail("contains an integer outside the JavaScript safe-integer range");
    }
    if (!Number.isFinite(numeric)) {
      this.fail("contains a non-finite JSON number");
    }
    const canonical = isFloatingPoint
      ? canonicalPythonFloatSpelling(numeric)
      : BigInt(spelling).toString();
    if (spelling !== canonical) {
      this.fail("contains a non-canonical JSON number spelling");
    }
    this.offset += spelling.length;
  }

  private parseLiteral(literal: "false" | "null" | "true"): void {
    if (!this.text.startsWith(literal, this.offset)) {
      this.fail("contains an invalid JSON literal");
    }
    this.offset += literal.length;
  }

  private expect(expected: string): void {
    if (this.text[this.offset] !== expected) {
      this.fail(`must contain ${JSON.stringify(expected)} at this position`);
    }
    this.offset += 1;
  }

  private fail(message: string): never {
    throw new TypeError(`Canonical JSON preimage ${message} at offset ${this.offset}`);
  }
}

/**
 * Validates the exact ASCII JSON bytes hashed by the Python training producer.
 * Numeric tokens must use Python's canonical spelling, and integer tokens must
 * fit the JavaScript safe-integer range so the returned object is not rounded.
 */
export function parseCanonicalJsonObjectPreimage(
  text: string,
): Record<string, unknown> {
  if (text.length < 2 || text.length > MAX_CANONICAL_JSON_PREIMAGE_CHARACTERS) {
    throw new TypeError("Canonical JSON preimage has an invalid length");
  }
  if (!isAscii(text)) {
    throw new TypeError("Canonical JSON preimage must contain only ASCII characters");
  }
  return new CanonicalJsonPreimageParser(text).parseObjectRoot();
}

export const PreEvaluationPolicySchema = z
  .object({
    schemaVersion: z.literal(PRE_EVALUATION_POLICY_SCHEMA_VERSION),
    canonicalization: z.literal(PRE_EVALUATION_POLICY_CANONICALIZATION),
    signalType: SignalTypeSchema,
    targetJsonPreimage: z.string().min(2).max(32_768),
    targetSha256: Sha256HexSchema,
    featureNames: BinanceSpotSignalFeatureNamesSchema,
    fitStateJsonPreimage: z.string().min(2).max(1_048_576),
    fitStateSha256: Sha256HexSchema,
    samplingJsonPreimage: z.string().min(2).max(262_144),
    samplingSha256: Sha256HexSchema,
    baselineSelectionPartition: z.literal("CALIBRATION"),
    selectedBaselineKind: z.enum([
      "GLOBAL_TRAIN_CLASS_FREQUENCY",
      "TRAIN_CURRENT_RELATION_PHASE_FREQUENCY",
    ]),
    confidenceThresholdDecimal: ConfidenceThresholdDecimalSchema,
    deadbandBpsDecimal: z.literal("5"),
    thresholdSelection: z.literal("PREDECLARED_NO_EVALUATION_ACCESS"),
    challengerSelection: z.literal("NOT_RUN"),
    evaluationUse: z.literal("REPORT_ONLY_NO_MODEL_OR_POLICY_SELECTION"),
  })
  .strict()
  .superRefine((policy, context) => {
    for (const field of [
      "targetJsonPreimage",
      "fitStateJsonPreimage",
      "samplingJsonPreimage",
    ] as const) {
      try {
        parseCanonicalJsonObjectPreimage(policy[field]);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message:
            error instanceof Error ? error.message : "Invalid canonical JSON preimage",
        });
      }
    }
  });

export type PreEvaluationPolicy = z.infer<typeof PreEvaluationPolicySchema>;

function canonicalAsciiJson(value: unknown, path: string): string {
  if (typeof value === "string") {
    if (!isAscii(value)) {
      throw new TypeError(`Canonical policy string is not ASCII at ${path}`);
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError(`Canonical policy string is not JSON-encodable at ${path}`);
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => canonicalAsciiJson(item, `${path}[${index}]`))
      .join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const prototype: object | null = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Canonical policy value is not a plain object at ${path}`);
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        if (!isAscii(key)) {
          throw new TypeError(`Canonical policy key is not ASCII at ${path}`);
        }
        return `${JSON.stringify(key)}:${canonicalAsciiJson(record[key], `${path}.${key}`)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError(
    `Canonical policy values must contain only objects, arrays, and ASCII strings at ${path}`,
  );
}

export function canonicalPreEvaluationPolicyJson(value: unknown): string {
  return canonicalAsciiJson(PreEvaluationPolicySchema.parse(value), "$");
}
