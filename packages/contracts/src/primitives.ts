import { z } from "zod";

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ZERO_DECIMAL_PATTERN = /^0(?:\.0+)?$/;

/**
 * Lossless wire representation for a decimal value.
 *
 * JSON numbers must never be used for prices or other monetary values because
 * clients may otherwise round them differently. Scientific notation and
 * leading zeroes are intentionally rejected to keep canonical payloads.
 */
export const DecimalStringSchema = z
  .string()
  .regex(DECIMAL_PATTERN, "Expected a canonical decimal string");

export const NonNegativeDecimalStringSchema = z
  .string()
  .regex(
    NON_NEGATIVE_DECIMAL_PATTERN,
    "Expected a canonical non-negative decimal string",
  );

export const PositiveDecimalStringSchema = NonNegativeDecimalStringSchema.refine(
  (value) => !ZERO_DECIMAL_PATTERN.test(value),
  "Expected a positive decimal string",
);

/**
 * Offset-aware RFC3339 timestamp. UTC (`Z`) and explicit numeric offsets are
 * both valid; local timestamps without an offset are rejected.
 */
export const Rfc3339TimestampSchema = z
  .string()
  .datetime({ offset: true, message: "Expected an RFC3339 timestamp" });

export const DataModeSchema = z.enum(["LIVE", "DEMO", "SIMULATION"]);
export type DataMode = z.infer<typeof DataModeSchema>;

export const HealthSeveritySchema = z.enum(["INFO", "WARNING", "ERROR", "CRITICAL"]);
export type HealthSeverity = z.infer<typeof HealthSeveritySchema>;

export const HealthFlagCodeSchema = z.enum([
  "FEED_STALE",
  "QUORUM_NOT_MET",
  "USDT_DEPEG",
  "CROSS_VENUE_DIVERGENCE",
  "CLOCK_SKEW",
  "SEQUENCE_GAP",
  "MODEL_UNAPPROVED",
  "MODEL_STALE",
  "OUT_OF_DISTRIBUTION",
  "INSUFFICIENT_LEAD_TIME",
  "ANOMALY_RISK",
  "DEMO_DATA",
  "SIMULATION_DATA",
]);
export type HealthFlagCode = z.infer<typeof HealthFlagCodeSchema>;

export const HealthFlagSchema = z
  .object({
    code: HealthFlagCodeSchema,
    severity: HealthSeveritySchema,
    message: z.string().min(1).max(500),
    source: z.string().min(1).max(100),
    observedAt: Rfc3339TimestampSchema,
  })
  .strict();
export type HealthFlag = z.infer<typeof HealthFlagSchema>;

export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RiskFlagCodeSchema = z.enum([
  "ABNORMAL_RETURN",
  "ABNORMAL_VOLUME",
  "SPREAD_EXPANSION",
  "LIQUIDITY_WITHDRAWAL",
  "CROSS_VENUE_DISLOCATION",
  "LIQUIDATION_CASCADE",
  "EXTREME_ORDER_BOOK_IMBALANCE",
  "EXCESSIVE_CANCELLATIONS",
  "STABLECOIN_DISLOCATION",
]);
export type RiskFlagCode = z.infer<typeof RiskFlagCodeSchema>;

export const RiskFlagSchema = z
  .object({
    code: RiskFlagCodeSchema,
    severity: RiskLevelSchema,
    message: z.string().min(1).max(500),
    scoreContribution: z.number().min(0).max(1),
  })
  .strict();
export type RiskFlag = z.infer<typeof RiskFlagSchema>;

export const AuditMetadataSchema = z
  .object({
    decisionId: z.string().min(1).max(128),
    engineVersion: z.string().min(1).max(64),
    policyVersion: z.string().min(1).max(64),
    inputSnapshotId: z.string().min(1).max(128),
    forecastId: z.string().min(1).max(128),
    evaluatedAt: Rfc3339TimestampSchema,
    dataMode: DataModeSchema,
  })
  .strict();
export type AuditMetadata = z.infer<typeof AuditMetadataSchema>;
