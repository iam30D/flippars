import { z } from "zod";

const IsoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");

const FeatureMapSchema = z
  .record(z.string().min(1).max(80), z.number().finite())
  .refine((features) => Object.keys(features).length > 0, "Features are required");

export const LabSignalTypeSchema = z.enum([
  "FIVE_MINUTE_REVERSAL",
  "FIFTEEN_MINUTE_REVERSAL",
  "FIVE_MINUTE_EARLY_DIRECTION",
]);

export const TrainingRowSchema = z
  .object({
    id: z.string().min(1).max(160),
    signalType: LabSignalTypeSchema,
    candidateRelation: z.enum(["ABOVE_OPEN", "BELOW_OPEN"]),
    decisionAt: IsoTimestampSchema,
    windowStart: IsoTimestampSchema,
    windowEnd: IsoTimestampSchema,
    features: FeatureMapSchema,
    correct: z.boolean(),
    dataHealthy: z.boolean(),
    anomalyRisk: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((row, context) => {
    const decision = Date.parse(row.decisionAt);
    const start = Date.parse(row.windowStart);
    const end = Date.parse(row.windowEnd);
    if (!(start <= decision && decision < end)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "decisionAt must be inside the half-open market window",
        path: ["decisionAt"],
      });
    }
  });

export type TrainingRow = z.infer<typeof TrainingRowSchema>;

const MetricsSchema = z
  .object({
    sampleCount: z.number().int().nonnegative(),
    positives: z.number().int().nonnegative(),
    brierScore: z.number().min(0).max(1),
    logLoss: z.number().nonnegative(),
    expectedCalibrationError: z.number().min(0).max(1),
    precisionAtThreshold: z.number().min(0).max(1),
    coverageAtThreshold: z.number().min(0).max(1),
    threshold: z.number().min(0.5).max(1),
  })
  .strict();

export const LogisticArtifactSchema = z
  .object({
    schemaVersion: z.literal("flippars.logistic-candidate/1"),
    artifactId: z.string().min(1),
    version: z.string().min(1),
    status: z.literal("DRAFT"),
    signalType: LabSignalTypeSchema,
    createdAt: IsoTimestampSchema,
    trainedThrough: IsoTimestampSchema,
    featureNames: z.array(z.string().min(1)).min(1),
    normalization: z
      .object({
        means: z.array(z.number().finite()),
        scales: z.array(z.number().positive()),
      })
      .strict(),
    model: z
      .object({
        weights: z.array(z.number().finite()),
        bias: z.number().finite(),
      })
      .strict(),
    calibration: z
      .object({
        method: z.literal("PLATT"),
        slope: z.number().finite(),
        intercept: z.number().finite(),
        version: z.string().min(1),
        validUntil: IsoTimestampSchema,
      })
      .strict(),
    datasetSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    holdoutMetrics: MetricsSchema,
    approval: z
      .object({
        approvedAt: z.null(),
        approvedBy: z.null(),
      })
      .strict(),
  })
  .strict()
  .superRefine((artifact, context) => {
    const count = artifact.featureNames.length;
    if (
      artifact.normalization.means.length !== count ||
      artifact.normalization.scales.length !== count ||
      artifact.model.weights.length !== count
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Feature, normalization, and weight dimensions must match",
      });
    }
  });

export type LogisticArtifact = z.infer<typeof LogisticArtifactSchema>;
export type ModelMetrics = z.infer<typeof MetricsSchema>;
