import { z } from "zod";
import {
  BINANCE_SPOT_FEATURE_SCHEMA_VERSION,
  BINANCE_SPOT_SIGNAL_FEATURE_NAMES,
  BINANCE_SPOT_TARGET_VERSION,
  BinanceSpotForecastTargetSchema,
  BinanceSpotRuntimeCompatibilitySchema,
  BinanceSpotSignalFeatureNamesSchema,
  DatasetManifestSummarySchema,
} from "@flippars/contracts";

const MEBIBYTE = 1_048_576;

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const Rfc3339TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u);
const VersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u);
const FeatureNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,79}$/u);

export const PortableRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !value.includes("\\") && !value.includes(":"), {
    message: "Bundle paths must use portable forward-slash relative paths",
  })
  .refine(
    (value) =>
      !value.startsWith("/") &&
      value.split("/").every((segment) => {
        return (
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          /^[A-Za-z0-9._-]+$/u.test(segment)
        );
      }),
    { message: "Bundle path contains an unsafe segment" },
  );

export const ArtifactSignalTypeSchema = z.enum([
  "FIVE_MINUTE_REVERSAL",
  "FIFTEEN_MINUTE_REVERSAL",
  "FIVE_MINUTE_EARLY_DIRECTION",
]);
export type ArtifactSignalType = z.infer<typeof ArtifactSignalTypeSchema>;

export const CloseRelationSchema = z.enum(["ABOVE_OPEN", "BELOW_OPEN", "AT_OPEN"]);
export type CloseRelation = z.infer<typeof CloseRelationSchema>;

export const CloseRelationTargetSchema = z
  .object({
    kind: z.literal("CANDLE_CLOSE_RELATION"),
    classOrder: z.tuple([
      z.literal("ABOVE_OPEN"),
      z.literal("BELOW_OPEN"),
      z.literal("AT_OPEN"),
    ]),
    deadbandBps: z.number().finite().min(0).max(100),
    labelPolicyVersion: VersionSchema,
  })
  .strict();

const WeightVectorSchema = z.array(z.number().finite()).min(1).max(256);

/**
 * A future training pipeline may produce this artifact, but it remains a draft.
 * Approval is represented only by separately signed approval statements.
 */
export const DraftMultinomialArtifactSchema = z
  .object({
    schemaVersion: z.literal("flippars.multinomial-candidate/2"),
    artifactId: IdentifierSchema,
    version: VersionSchema,
    status: z.literal("DRAFT"),
    signalType: ArtifactSignalTypeSchema,
    target: CloseRelationTargetSchema,
    createdAt: Rfc3339TimestampSchema,
    trainedThrough: Rfc3339TimestampSchema,
    featureSchemaVersion: VersionSchema,
    featureNames: z.array(FeatureNameSchema).min(1).max(256),
    normalization: z
      .object({
        means: z.array(z.number().finite()).min(1).max(256),
        scales: z.array(z.number().finite().positive()).min(1).max(256),
      })
      .strict(),
    model: z
      .object({
        kind: z.literal("MULTINOMIAL_LOGISTIC"),
        weights: z.tuple([WeightVectorSchema, WeightVectorSchema, WeightVectorSchema]),
        biases: z.tuple([
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
        ]),
      })
      .strict(),
    calibration: z
      .object({
        method: z.literal("TEMPERATURE"),
        temperature: z.number().finite().positive().max(1_000_000),
        version: VersionSchema,
        validUntil: Rfc3339TimestampSchema,
      })
      .strict(),
    datasetSha256: Sha256HexSchema,
    trainingCodeSha256: Sha256HexSchema,
    approval: z
      .object({
        approvedAt: z.null(),
        approvedBy: z.null(),
      })
      .strict(),
  })
  .strict()
  .superRefine((artifact, context) => {
    const featureCount = artifact.featureNames.length;
    const names = new Set(artifact.featureNames);
    if (names.size !== featureCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["featureNames"],
        message: "Feature names must be unique",
      });
    }
    if (
      artifact.normalization.means.length !== featureCount ||
      artifact.normalization.scales.length !== featureCount ||
      artifact.model.weights.some((weights) => weights.length !== featureCount)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Feature, normalization, and class-weight dimensions must match",
      });
    }
    const createdAt = Date.parse(artifact.createdAt);
    if (Date.parse(artifact.trainedThrough) > createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trainedThrough"],
        message: "trainedThrough cannot be later than createdAt",
      });
    }
    if (Date.parse(artifact.calibration.validUntil) <= createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["calibration", "validUntil"],
        message: "Calibration must remain valid after artifact creation",
      });
    }
  });

export type DraftMultinomialArtifact = z.infer<typeof DraftMultinomialArtifactSchema>;

const BinanceFeatureBoundVectorSchema = z
  .array(z.number().finite())
  .length(BINANCE_SPOT_SIGNAL_FEATURE_NAMES.length);

const BinanceFeatureBoundsSchema = z
  .object({
    lower: BinanceFeatureBoundVectorSchema,
    upper: BinanceFeatureBoundVectorSchema,
  })
  .strict()
  .superRefine((bounds, context) => {
    for (let index = 0; index < bounds.lower.length; index += 1) {
      if (bounds.lower[index]! > bounds.upper[index]!) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["upper", index],
          message: "Each support upper bound must be at least its lower bound",
        });
      }
    }
  });

/**
 * A fit-partition-only support box. Both raw and normalized bounds are bound so
 * a future provider can abstain before or after artifact normalization.
 */
export const FitSupportEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("flippars.fit-support-envelope/1"),
    version: VersionSchema,
    method: z.literal("FIT_PARTITION_QUANTILE_BOX"),
    fittedPartition: z.literal("MODEL_FIT"),
    fittedThrough: Rfc3339TimestampSchema,
    lowerQuantile: z.number().finite().min(0).max(0.5),
    upperQuantile: z.number().finite().min(0.5).max(1),
    featureNames: BinanceSpotSignalFeatureNamesSchema,
    rawBounds: BinanceFeatureBoundsSchema,
    normalizedBounds: BinanceFeatureBoundsSchema,
    missingValuePolicy: z.literal("ABSTAIN"),
    nonFiniteValuePolicy: z.literal("ABSTAIN"),
    breachPolicy: z.literal("ABSTAIN"),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.lowerQuantile >= envelope.upperQuantile) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["upperQuantile"],
        message: "Support upper quantile must exceed the lower quantile",
      });
    }
  });

export type FitSupportEnvelope = z.infer<typeof FitSupportEnvelopeSchema>;

/**
 * Additive Binance Spot target contract. V2 remains readable for historical
 * dry-run evidence, but only V3 binds target, features, labels, and dataset
 * metadata tightly enough for the Binance-target research path.
 */
export const DraftBinanceMultinomialArtifactSchema = z
  .object({
    schemaVersion: z.literal("flippars.multinomial-candidate/3"),
    artifactId: IdentifierSchema,
    version: VersionSchema,
    status: z.literal("DRAFT"),
    signalType: ArtifactSignalTypeSchema,
    target: BinanceSpotForecastTargetSchema,
    createdAt: Rfc3339TimestampSchema,
    modelFitThrough: Rfc3339TimestampSchema,
    calibrationFitThrough: Rfc3339TimestampSchema,
    evaluationThrough: Rfc3339TimestampSchema,
    featureSchemaVersion: z.literal(BINANCE_SPOT_FEATURE_SCHEMA_VERSION),
    featureNames: BinanceSpotSignalFeatureNamesSchema,
    normalization: z
      .object({
        means: z.array(z.number().finite()).min(1).max(256),
        scales: z.array(z.number().finite().positive()).min(1).max(256),
      })
      .strict(),
    model: z
      .object({
        kind: z.literal("MULTINOMIAL_LOGISTIC"),
        weights: z.tuple([WeightVectorSchema, WeightVectorSchema, WeightVectorSchema]),
        biases: z.tuple([
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
        ]),
      })
      .strict(),
    calibration: z
      .object({
        method: z.literal("TEMPERATURE"),
        temperature: z.number().finite().positive().max(1_000_000),
        version: VersionSchema,
        validUntil: Rfc3339TimestampSchema,
      })
      .strict(),
    ood: FitSupportEnvelopeSchema,
    datasetContentSha256: Sha256HexSchema,
    datasetManifestSha256: Sha256HexSchema,
    datasetManifest: DatasetManifestSummarySchema,
    preEvaluationPolicySha256: Sha256HexSchema,
    trainingCodeSha256: Sha256HexSchema,
    approval: z
      .object({
        approvedAt: z.null(),
        approvedBy: z.null(),
      })
      .strict(),
  })
  .strict()
  .superRefine((artifact, context) => {
    const featureCount = artifact.featureNames.length;
    if (
      artifact.normalization.means.length !== featureCount ||
      artifact.normalization.scales.length !== featureCount ||
      artifact.model.weights.some((weights) => weights.length !== featureCount)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Feature, normalization, and class-weight dimensions must match",
      });
    }
    if (artifact.target.signalType !== artifact.signalType) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target", "signalType"],
        message: "Target signalType must match the artifact",
      });
    }
    if (artifact.target.targetVersion !== BINANCE_SPOT_TARGET_VERSION) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target", "targetVersion"],
        message: "Target version is incompatible with the V3 artifact",
      });
    }
    if (
      artifact.datasetContentSha256 !== artifact.datasetManifest.datasetContentSha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["datasetManifest", "datasetContentSha256"],
        message: "Dataset content digest must match its manifest summary",
      });
    }
    if (
      artifact.datasetManifestSha256 !== artifact.datasetManifest.datasetManifestSha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["datasetManifest", "datasetManifestSha256"],
        message: "Full dataset manifest digest must match its summary",
      });
    }
    if (artifact.target.deadbandBps !== artifact.datasetManifest.deadbandBps) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["datasetManifest", "deadbandBps"],
        message: "Dataset and target deadbands must match exactly",
      });
    }
    if (
      JSON.stringify(artifact.target.candidateSchedule) !==
      JSON.stringify(artifact.datasetManifest.candidateSchedule)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["datasetManifest", "candidateSchedule"],
        message: "Dataset and target candidate schedules must match exactly",
      });
    }
    if (
      artifact.datasetManifest.targetVersion !== artifact.target.targetVersion ||
      artifact.datasetManifest.featureSchemaVersion !== artifact.featureSchemaVersion
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["datasetManifest"],
        message: "Dataset target and feature versions must match the artifact",
      });
    }
    const createdAt = Date.parse(artifact.createdAt);
    const modelFitThrough = Date.parse(artifact.modelFitThrough);
    const calibrationFitThrough = Date.parse(artifact.calibrationFitThrough);
    const evaluationThrough = Date.parse(artifact.evaluationThrough);
    if (!(
      Date.parse(artifact.datasetManifest.startAt) < modelFitThrough &&
      modelFitThrough < calibrationFitThrough &&
      calibrationFitThrough < evaluationThrough &&
      evaluationThrough <= Date.parse(artifact.datasetManifest.endAt) &&
      Date.parse(artifact.datasetManifest.endAt) <= createdAt
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelFitThrough"],
        message:
          "Dataset, model-fit, calibration, evaluation, and creation times must be strictly chronological",
      });
    }
    if (artifact.ood.fittedThrough !== artifact.modelFitThrough) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ood", "fittedThrough"],
        message: "OOD support must be fitted only through modelFitThrough",
      });
    }
    for (let index = 0; index < featureCount; index += 1) {
      const expectedLower =
        (artifact.ood.rawBounds.lower[index]! - artifact.normalization.means[index]!) /
        artifact.normalization.scales[index]!;
      const expectedUpper =
        (artifact.ood.rawBounds.upper[index]! - artifact.normalization.means[index]!) /
        artifact.normalization.scales[index]!;
      const lowerTolerance = 1e-8 * Math.max(1, Math.abs(expectedLower));
      const upperTolerance = 1e-8 * Math.max(1, Math.abs(expectedUpper));
      if (
        Math.abs(artifact.ood.normalizedBounds.lower[index]! - expectedLower) >
          lowerTolerance ||
        Math.abs(artifact.ood.normalizedBounds.upper[index]! - expectedUpper) >
          upperTolerance
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ood", "normalizedBounds", index],
          message:
            "Normalized OOD bounds must derive from raw bounds and normalization",
        });
      }
    }
    if (
      artifact.datasetManifest.preparedWindowCount === 0 ||
      artifact.datasetManifest.preparedDecisionRowCount === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["datasetManifest", "preparedWindowCount"],
        message: "A trained artifact requires prepared windows and rows",
      });
    }
    if (Date.parse(artifact.calibration.validUntil) <= createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["calibration", "validUntil"],
        message: "Calibration must remain valid after artifact creation",
      });
    }
  });

export type DraftBinanceMultinomialArtifact = z.infer<
  typeof DraftBinanceMultinomialArtifactSchema
>;

export const DraftModelArtifactSchema = z.union([
  DraftMultinomialArtifactSchema,
  DraftBinanceMultinomialArtifactSchema,
]);
export type DraftModelArtifact = z.infer<typeof DraftModelArtifactSchema>;

export const EvidenceReferenceSchema = z
  .object({
    path: PortableRelativePathSchema,
    sha256: Sha256HexSchema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(64 * MEBIBYTE),
    producedAt: Rfc3339TimestampSchema,
    producedBy: z.string().min(1).max(160),
    mediaType: z.enum([
      "application/json",
      "application/pdf",
      "text/csv",
      "text/markdown",
      "text/plain",
    ]),
  })
  .strict();

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const ApprovalEvidenceSchema = z
  .object({
    modelCard: EvidenceReferenceSchema,
    datasetLineage: EvidenceReferenceSchema,
    reproducibleExperiment: EvidenceReferenceSchema,
    independentValidation: EvidenceReferenceSchema,
    shadowReport: EvidenceReferenceSchema,
    thresholdApproval: EvidenceReferenceSchema,
    policyDocument: EvidenceReferenceSchema,
    monitoringPlan: EvidenceReferenceSchema,
    rollbackPlan: EvidenceReferenceSchema,
    canaryPlan: EvidenceReferenceSchema,
    canaryReport: EvidenceReferenceSchema.nullable(),
  })
  .strict();

export type ApprovalEvidence = z.infer<typeof ApprovalEvidenceSchema>;
export type ApprovalEvidenceName = keyof ApprovalEvidence;

export const ReleaseStageSchema = z.enum(["CANARY", "GENERAL"]);
export type ReleaseStage = z.infer<typeof ReleaseStageSchema>;

export const GateSummarySchema = z
  .object({
    brierSkillFraction: z.number().finite().min(-1).max(1),
    brierSkillCi95Lower: z.number().finite().min(-1).max(1),
    expectedCalibrationError: z.number().finite().min(0).max(1),
    maximumCalibrationBinError: z.number().finite().min(0).max(1),
    bothDirectionalClassesPass: z.boolean(),
    shadowStartedAt: Rfc3339TimestampSchema,
    shadowEndedAt: Rfc3339TimestampSchema,
    independentAlertWindows: z.number().int().nonnegative(),
    observedPrecision: z.number().finite().min(0).max(1),
    observedPrecisionCi95Lower: z.number().finite().min(0).max(1),
    observedCoverage: z.number().finite().min(0).max(1),
    predeclaredCoverageFloor: z.number().finite().min(0).max(1),
    outcomeCounts: z
      .object({
        ABOVE_OPEN: z.number().int().nonnegative(),
        BELOW_OPEN: z.number().int().nonnegative(),
        AT_OPEN: z.number().int().nonnegative(),
      })
      .strict(),
    leadTimeFloorPass: z.boolean(),
    integrityFloorPass: z.boolean(),
    latencyFloorPass: z.boolean(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (Date.parse(summary.shadowEndedAt) <= Date.parse(summary.shadowStartedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shadowEndedAt"],
        message: "shadowEndedAt must be later than shadowStartedAt",
      });
    }
    if (summary.observedCoverage < summary.predeclaredCoverageFloor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedCoverage"],
        message: "Observed coverage is below its predeclared floor",
      });
    }
  });

export const ModelBundleManifestSchema = z
  .object({
    schemaVersion: z.literal("flippars.model-bundle-manifest/1"),
    bundleId: IdentifierSchema,
    createdAt: Rfc3339TimestampSchema,
    requestedReleaseStage: ReleaseStageSchema,
    artifactId: IdentifierSchema,
    artifactVersion: VersionSchema,
    signalType: ArtifactSignalTypeSchema,
    target: CloseRelationTargetSchema,
    artifact: z
      .object({
        format: z.literal("flippars.multinomial-candidate/2"),
        path: PortableRelativePathSchema,
        sha256: Sha256HexSchema,
        byteLength: z
          .number()
          .int()
          .positive()
          .max(512 * MEBIBYTE),
      })
      .strict(),
    runtime: z
      .object({
        featureSchemaVersion: VersionSchema,
        policyVersion: VersionSchema,
        policyDocumentSha256: Sha256HexSchema,
        calibrationVersion: VersionSchema,
        calibrationValidUntil: Rfc3339TimestampSchema,
        minimumConfidence: z.number().finite().min(0.5).max(1),
      })
      .strict(),
    datasetSha256: Sha256HexSchema,
    evidence: ApprovalEvidenceSchema,
    gates: GateSummarySchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const createdAt = Date.parse(manifest.createdAt);
    if (Date.parse(manifest.runtime.calibrationValidUntil) <= createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime", "calibrationValidUntil"],
        message: "Calibration must remain valid after manifest creation",
      });
    }
    const evidence = Object.entries(manifest.evidence).filter(
      (entry): entry is [ApprovalEvidenceName, EvidenceReference] => entry[1] !== null,
    );
    const paths = [manifest.artifact.path, ...evidence.map(([, value]) => value.path)];
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "Artifact and evidence paths must be unique",
      });
    }
    for (const [name, reference] of evidence) {
      if (Date.parse(reference.producedAt) > createdAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence", name, "producedAt"],
          message: "Evidence cannot postdate the manifest",
        });
      }
    }
    if (
      Date.parse(manifest.evidence.shadowReport.producedAt) <
      Date.parse(manifest.gates.shadowEndedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "shadowReport", "producedAt"],
        message: "The shadow report must be produced after shadow completion",
      });
    }
    if (
      manifest.requestedReleaseStage === "GENERAL" &&
      manifest.evidence.canaryReport === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "canaryReport"],
        message: "General release requires a canary report",
      });
    }
  });

export type ModelBundleManifest = z.infer<typeof ModelBundleManifestSchema>;

export const BinanceModelBundleManifestSchema = z
  .object({
    schemaVersion: z.literal("flippars.model-bundle-manifest/2"),
    bundleId: IdentifierSchema,
    createdAt: Rfc3339TimestampSchema,
    requestedReleaseStage: ReleaseStageSchema,
    artifactId: IdentifierSchema,
    artifactVersion: VersionSchema,
    signalType: ArtifactSignalTypeSchema,
    target: BinanceSpotForecastTargetSchema,
    artifact: z
      .object({
        format: z.literal("flippars.multinomial-candidate/3"),
        path: PortableRelativePathSchema,
        sha256: Sha256HexSchema,
        byteLength: z
          .number()
          .int()
          .positive()
          .max(512 * MEBIBYTE),
      })
      .strict(),
    runtime: z
      .object({
        compatibility: BinanceSpotRuntimeCompatibilitySchema,
        policyVersion: VersionSchema,
        policyDocumentSha256: Sha256HexSchema,
        calibrationVersion: VersionSchema,
        calibrationValidUntil: Rfc3339TimestampSchema,
        minimumConfidence: z.number().finite().min(0.5).max(1),
      })
      .strict(),
    datasetContentSha256: Sha256HexSchema,
    datasetManifestSha256: Sha256HexSchema,
    evidence: ApprovalEvidenceSchema,
    gates: GateSummarySchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const compatibility = manifest.runtime.compatibility;
    if (
      manifest.signalType !== manifest.target.signalType ||
      manifest.signalType !== compatibility.signalType
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime", "compatibility", "signalType"],
        message: "Manifest, target, and runtime signal types must match",
      });
    }
    if (
      compatibility.targetVersion !== manifest.target.targetVersion ||
      compatibility.decisionPolicyVersion !== manifest.target.decisionPolicyVersion ||
      compatibility.crossVenueGuardPolicyVersion !==
        manifest.target.crossVenueGuardPolicyVersion ||
      compatibility.durationSeconds !== manifest.target.durationSeconds ||
      compatibility.deadbandBps !== manifest.target.deadbandBps ||
      JSON.stringify(compatibility.candidateSchedule) !==
        JSON.stringify(manifest.target.candidateSchedule) ||
      compatibility.classOrder.some(
        (relation, index) => relation !== manifest.target.classOrder[index],
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime", "compatibility"],
        message: "Runtime compatibility metadata must exactly match the target",
      });
    }
    const createdAt = Date.parse(manifest.createdAt);
    if (Date.parse(manifest.runtime.calibrationValidUntil) <= createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime", "calibrationValidUntil"],
        message: "Calibration must remain valid after manifest creation",
      });
    }
    const evidence = Object.entries(manifest.evidence).filter(
      (entry): entry is [ApprovalEvidenceName, EvidenceReference] => entry[1] !== null,
    );
    const paths = [manifest.artifact.path, ...evidence.map(([, value]) => value.path)];
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "Artifact and evidence paths must be unique",
      });
    }
    for (const [name, reference] of evidence) {
      if (Date.parse(reference.producedAt) > createdAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence", name, "producedAt"],
          message: "Evidence cannot postdate the manifest",
        });
      }
    }
    if (
      Date.parse(manifest.evidence.shadowReport.producedAt) <
      Date.parse(manifest.gates.shadowEndedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "shadowReport", "producedAt"],
        message: "The shadow report must be produced after shadow completion",
      });
    }
    if (
      manifest.requestedReleaseStage === "GENERAL" &&
      manifest.evidence.canaryReport === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "canaryReport"],
        message: "General release requires a canary report",
      });
    }
  });

export type BinanceModelBundleManifest = z.infer<
  typeof BinanceModelBundleManifestSchema
>;

export const GovernedModelBundleManifestSchema = z.union([
  ModelBundleManifestSchema,
  BinanceModelBundleManifestSchema,
]);
export type GovernedModelBundleManifest = z.infer<
  typeof GovernedModelBundleManifestSchema
>;

export const APPROVAL_ROLES = [
  "INDEPENDENT_VALIDATOR",
  "MODEL_OWNER",
  "PRODUCT_OWNER",
  "SECURITY_REVIEWER",
] as const;

export const ApprovalRoleSchema = z.enum(APPROVAL_ROLES);
export type ApprovalRole = z.infer<typeof ApprovalRoleSchema>;

export const ApprovalStatementSchema = z
  .object({
    schemaVersion: z.literal("flippars.model-approval-statement/1"),
    statementId: IdentifierSchema,
    decision: z.literal("APPROVE"),
    releaseStage: ReleaseStageSchema,
    manifestSha256: Sha256HexSchema,
    artifactId: IdentifierSchema,
    artifactVersion: VersionSchema,
    signalType: ArtifactSignalTypeSchema,
    approverId: IdentifierSchema,
    approverRole: ApprovalRoleSchema,
    signerKeyId: IdentifierSchema,
    signedAt: Rfc3339TimestampSchema,
    validUntil: Rfc3339TimestampSchema,
  })
  .strict()
  .superRefine((statement, context) => {
    if (Date.parse(statement.validUntil) <= Date.parse(statement.signedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validUntil"],
        message: "Approval validity must extend beyond signedAt",
      });
    }
  });

export type ApprovalStatement = z.infer<typeof ApprovalStatementSchema>;

export const SignedApprovalSchema = z
  .object({
    statement: ApprovalStatementSchema,
    signature: z
      .object({
        algorithm: z.literal("ED25519"),
        encoding: z.literal("base64"),
        value: z
          .string()
          .min(80)
          .max(120)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
      })
      .strict(),
  })
  .strict();

export type SignedApproval = z.infer<typeof SignedApprovalSchema>;

export const SignedApprovalSetSchema = z
  .object({
    schemaVersion: z.literal("flippars.model-approval-set/1"),
    approvals: z.array(SignedApprovalSchema).min(1).max(16),
  })
  .strict();

export type SignedApprovalSet = z.infer<typeof SignedApprovalSetSchema>;

export const TrustedModelKeySchema = z
  .object({
    keyId: IdentifierSchema,
    approverId: IdentifierSchema,
    approverRole: ApprovalRoleSchema,
    algorithm: z.literal("ED25519"),
    publicKeyPem: z
      .string()
      .min(80)
      .max(4_096)
      .refine(
        (value) =>
          value.startsWith("-----BEGIN PUBLIC KEY-----\n") &&
          value.trimEnd().endsWith("-----END PUBLIC KEY-----"),
        "Expected a PEM encoded public key",
      ),
    validFrom: Rfc3339TimestampSchema,
    validUntil: Rfc3339TimestampSchema.nullable(),
    revokedAt: Rfc3339TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((key, context) => {
    if (
      key.validUntil !== null &&
      Date.parse(key.validUntil) <= Date.parse(key.validFrom)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validUntil"],
        message: "Key validUntil must be later than validFrom",
      });
    }
    if (
      key.revokedAt !== null &&
      Date.parse(key.revokedAt) < Date.parse(key.validFrom)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revokedAt"],
        message: "Key cannot be revoked before it becomes valid",
      });
    }
  });

export type TrustedModelKey = z.infer<typeof TrustedModelKeySchema>;

export const TrustedModelKeyringSchema = z
  .object({
    schemaVersion: z.literal("flippars.trusted-model-keys/1"),
    keys: z.array(TrustedModelKeySchema).min(1).max(64),
  })
  .strict()
  .superRefine((keyring, context) => {
    const keyIds = keyring.keys.map((key) => key.keyId);
    if (new Set(keyIds).size !== keyIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keys"],
        message: "Trusted key IDs must be unique",
      });
    }
  });

export type TrustedModelKeyring = z.infer<typeof TrustedModelKeyringSchema>;
