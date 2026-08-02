import { z } from "zod";

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
