import { z } from "zod";

import {
  AuditMetadataSchema,
  DataModeSchema,
  HealthFlagSchema,
  PositiveDecimalStringSchema,
  Rfc3339TimestampSchema,
  RiskFlagSchema,
  RiskLevelSchema,
} from "./primitives.js";
import {
  CandleDurationSecondsSchema,
  CandleIntervalSchema,
  PricePositionSchema,
} from "./market.js";

export const SignalTypeSchema = z.enum([
  "FIVE_MINUTE_REVERSAL",
  "FIFTEEN_MINUTE_REVERSAL",
  "FIVE_MINUTE_EARLY_DIRECTION",
]);
export type SignalType = z.infer<typeof SignalTypeSchema>;

export const PredictedCloseRelationSchema = z.enum(["ABOVE_OPEN", "BELOW_OPEN"]);
export type PredictedCloseRelation = z.infer<typeof PredictedCloseRelationSchema>;

export const SignalStatusSchema = z.enum(["ACTIVE", "EXPIRED", "RESOLVED", "VOID"]);
export type SignalStatus = z.infer<typeof SignalStatusSchema>;

export const ModelApprovalStatusSchema = z.enum([
  "DRAFT",
  "SHADOW",
  "APPROVED",
  "RETIRED",
]);
export type ModelApprovalStatus = z.infer<typeof ModelApprovalStatusSchema>;

export const SignalModelReferenceSchema = z
  .object({
    artifactId: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
    approvalStatus: ModelApprovalStatusSchema,
    approvedAt: Rfc3339TimestampSchema.nullable(),
    calibrationVersion: z.string().min(1).max(64),
  })
  .strict();
export type SignalModelReference = z.infer<typeof SignalModelReferenceSchema>;

export const SignalEvidenceKindSchema = z.enum([
  "PRICE_ACTION",
  "ORDER_FLOW",
  "LIQUIDITY",
  "DERIVATIVES",
  "CROSS_VENUE",
  "ON_CHAIN",
  "VERIFIED_EVENT",
]);
export type SignalEvidenceKind = z.infer<typeof SignalEvidenceKindSchema>;

export const SignalEvidenceSchema = z
  .object({
    kind: SignalEvidenceKindSchema,
    label: z.string().min(1).max(120),
    value: z.string().min(1).max(160),
    direction: z.enum(["SUPPORTS", "CONTRADICTS", "NEUTRAL"]),
  })
  .strict();
export type SignalEvidence = z.infer<typeof SignalEvidenceSchema>;

export const SignalSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: SignalTypeSchema,
    status: SignalStatusSchema,
    instrument: z.literal("BTC-USD"),
    interval: CandleIntervalSchema,
    durationSeconds: CandleDurationSecondsSchema,
    windowStart: Rfc3339TimestampSchema,
    windowEnd: Rfc3339TimestampSchema,
    issuedAt: Rfc3339TimestampSchema,
    expiresAt: Rfc3339TimestampSchema,
    openPrice: PositiveDecimalStringSchema,
    currentPrice: PositiveDecimalStringSchema,
    observedPosition: PricePositionSchema,
    predictedCloseRelation: PredictedCloseRelationSchema,
    confidence: z.number().min(0).max(1),
    confidenceThreshold: z.number().min(0).max(1),
    deadbandBps: z.number().nonnegative(),
    leadTimeSeconds: z.number().nonnegative(),
    riskLevel: RiskLevelSchema,
    riskScore: z.number().min(0).max(1),
    riskFlags: z.array(RiskFlagSchema),
    healthFlags: z.array(HealthFlagSchema),
    evidence: z.array(SignalEvidenceSchema).max(20),
    model: SignalModelReferenceSchema,
    audit: AuditMetadataSchema,
    dataMode: DataModeSchema,
    informationalOnly: z.literal(true),
  })
  .strict();
export type Signal = z.infer<typeof SignalSchema>;

export const SignalOutcomeStatusSchema = z.enum([
  "PENDING",
  "CORRECT",
  "INCORRECT",
  "FLAT",
  "VOID",
]);
export type SignalOutcomeStatus = z.infer<typeof SignalOutcomeStatusSchema>;

export const SignalOutcomeSchema = z
  .object({
    signalId: z.string().min(1).max(128),
    status: SignalOutcomeStatusSchema,
    predictedCloseRelation: PredictedCloseRelationSchema,
    actualCloseRelation: PricePositionSchema.nullable(),
    openPrice: PositiveDecimalStringSchema,
    closePrice: PositiveDecimalStringSchema.nullable(),
    windowEnd: Rfc3339TimestampSchema,
    resolvedAt: Rfc3339TimestampSchema.nullable(),
    deadbandBps: z.number().nonnegative(),
    reason: z.string().min(1).max(500).nullable(),
    dataMode: DataModeSchema,
  })
  .strict();
export type SignalOutcome = z.infer<typeof SignalOutcomeSchema>;
