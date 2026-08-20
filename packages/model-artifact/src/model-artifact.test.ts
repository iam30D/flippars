import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { describe, it } from "node:test";
import { BINANCE_SPOT_SIGNAL_FEATURE_NAMES } from "@flippars/contracts";

import { parseCliArguments } from "./cli.js";
import { approvalSigningPayload, sha256Hex } from "./crypto.js";
import {
  APPROVAL_ROLES,
  ApprovalStatementSchema,
  BinanceModelBundleManifestSchema,
  DraftBinanceMultinomialArtifactSchema,
  DraftMultinomialArtifactSchema,
  ModelBundleManifestSchema,
  SignedApprovalSetSchema,
  TrustedModelKeyringSchema,
  type ApprovalEvidenceName,
  type ApprovalRole,
  type DraftMultinomialArtifact,
  type GovernedModelBundleManifest,
  type ModelBundleManifest,
  type SignedApprovalSet,
  type TrustedModelKeyring,
} from "./schema.js";
import {
  isOfflineOnlyCandidatePair,
  parseJsonDocument,
  verifyModelBundle,
} from "./verifier.js";

const DAY_MS = 86_400_000;
const SHADOW_START = "2026-01-02T00:00:00.000Z";
const SHADOW_END = new Date(Date.parse(SHADOW_START) + 84 * DAY_MS).toISOString();
const MANIFEST_CREATED_AT = new Date(Date.parse(SHADOW_END) + DAY_MS).toISOString();
const VERIFIED_AT = new Date(Date.parse(MANIFEST_CREATED_AT) + DAY_MS).toISOString();

describe("integrity-safe JSON parsing", () => {
  const parse = (text: string): unknown =>
    parseJsonDocument(Buffer.from(text, "utf8"), "test document");

  it("preserves ordinary JSON whitespace, key order, escapes, and finite floats", () => {
    const parsed = parse(
      ' \t\r\n{"z" : [true,false,null,-0,0,1.25,1e-3,1E+3,"\\/\\b\\f\\n\\r\\t\\u00E9"], "a": 2} \r\n',
    );
    assert.deepEqual(Object.keys(parsed as Record<string, unknown>), ["z", "a"]);
    assert.deepEqual(parsed, {
      z: [true, false, null, -0, 0, 1.25, 0.001, 1_000, "/\b\f\n\r\té"],
      a: 2,
    });
  });

  it("rejects duplicate decoded object keys, including nested escape aliases", () => {
    assert.throws(
      () => parse('{"x":{"a":1,"\\u0061":2}}'),
      /duplicate object key "a"/u,
    );
    assert.throws(() => parse('{"𝄞":1,"\\ud834\\udd1e":2}'), /duplicate object key/u);
  });

  it("rejects unsafe integer values in integer, decimal, and exponent spellings", () => {
    for (const spelling of [
      "10000000000000001",
      "10000000000000001.0",
      "1e+16",
      "-1E16",
    ]) {
      assert.throws(
        () => parse(`{"value":${spelling}}`),
        /outside the JavaScript safe-integer range/u,
      );
    }
    assert.throws(
      () =>
        parse(
          '{"targetJsonPreimage":"{\\"value\\":1e+16}","counterpart":10000000000000001}',
        ),
      /outside the JavaScript safe-integer range/u,
    );
  });

  it("rejects non-finite numeric results and invalid number grammar", () => {
    assert.throws(() => parse('{"value":1e400}'), /non-finite JSON number/u);
    for (const document of ["01", "-01", "1.", "1e", "1e+", "[1x]"]) {
      assert.throws(() => parse(document), /not valid JSON/u);
    }
  });

  it("enforces a bounded nesting depth", () => {
    const atLimit = "[".repeat(128) + "0" + "]".repeat(128);
    const beyondLimit = "[".repeat(129) + "0" + "]".repeat(129);
    assert.equal(parse(atLimit) !== undefined, true);
    assert.throws(() => parse(beyondLimit), /maximum nesting depth of 128/u);
  });
});

interface Fixture {
  readonly artifact: DraftMultinomialArtifact;
  readonly artifactBytes: Uint8Array;
  readonly manifest: ModelBundleManifest;
  readonly manifestBytes: Uint8Array;
  readonly evidenceBytes: Readonly<Partial<Record<ApprovalEvidenceName, Uint8Array>>>;
  readonly approvalSet: SignedApprovalSet;
  readonly keyring: TrustedModelKeyring;
}

describe("governed model artifact contracts", () => {
  it("verifies a complete, role-separated, signed dry-run bundle", () => {
    const fixture = buildFixture();
    const result = verifyModelBundle({
      manifestBytes: fixture.manifestBytes,
      artifactBytes: fixture.artifactBytes,
      evidenceBytes: fixture.evidenceBytes,
      approvalSet: fixture.approvalSet,
      trustedKeyring: fixture.keyring,
      verifiedAt: VERIFIED_AT,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.artifact.status, "DRAFT");
      assert.deepEqual(result.artifact.target.classOrder, [
        "ABOVE_OPEN",
        "BELOW_OPEN",
        "AT_OPEN",
      ]);
      assert.equal(result.approvalStatementIds.length, APPROVAL_ROLES.length);
      assert.equal(result.manifestSha256, sha256Hex(fixture.manifestBytes));
    }
  });

  it("keeps the candidate draft-only and rejects unknown manifest fields", () => {
    const fixture = buildFixture();
    assert.equal(
      DraftMultinomialArtifactSchema.safeParse({
        ...fixture.artifact,
        approval: {
          approvedAt: "2026-04-01T00:00:00.000Z",
          approvedBy: "operator",
        },
      }).success,
      false,
    );
    assert.equal(
      DraftMultinomialArtifactSchema.safeParse({
        ...fixture.artifact,
        target: {
          ...fixture.artifact.target,
          classOrder: ["ABOVE_OPEN", "AT_OPEN", "BELOW_OPEN"],
        },
      }).success,
      false,
    );
    assert.equal(
      ModelBundleManifestSchema.safeParse({
        ...fixture.manifest,
        automaticallyPromote: true,
      }).success,
      false,
    );
  });

  it("fails closed when artifact or evidence bytes are changed", () => {
    const fixture = buildFixture();
    const tamperedArtifact = Buffer.concat([
      fixture.artifactBytes,
      Buffer.from("\n", "utf8"),
    ]);
    const tamperedArtifactResult = verifyModelBundle({
      manifestBytes: fixture.manifestBytes,
      artifactBytes: tamperedArtifact,
      evidenceBytes: fixture.evidenceBytes,
      approvalSet: fixture.approvalSet,
      trustedKeyring: fixture.keyring,
      verifiedAt: VERIFIED_AT,
    });
    assert.equal(tamperedArtifactResult.ok, false);
    if (!tamperedArtifactResult.ok) {
      assert.match(tamperedArtifactResult.issues.join("\n"), /artifact SHA-256/u);
    }

    const tamperedEvidence = {
      ...fixture.evidenceBytes,
      modelCard: Buffer.from("changed", "utf8"),
    };
    const tamperedEvidenceResult = verifyModelBundle({
      manifestBytes: fixture.manifestBytes,
      artifactBytes: fixture.artifactBytes,
      evidenceBytes: tamperedEvidence,
      approvalSet: fixture.approvalSet,
      trustedKeyring: fixture.keyring,
      verifiedAt: VERIFIED_AT,
    });
    assert.equal(tamperedEvidenceResult.ok, false);
    if (!tamperedEvidenceResult.ok) {
      assert.match(tamperedEvidenceResult.issues.join("\n"), /modelCard SHA-256/u);
    }
  });

  it("rejects bad signatures and missing independent roles", () => {
    const fixture = buildFixture();
    const first = fixture.approvalSet.approvals[0];
    assert.ok(first);
    const signatureBytes = Buffer.from(first.signature.value, "base64");
    signatureBytes[0] = (signatureBytes[0] ?? 0) ^ 1;
    const badSignatureSet = SignedApprovalSetSchema.parse({
      ...fixture.approvalSet,
      approvals: [
        {
          ...first,
          signature: {
            ...first.signature,
            value: signatureBytes.toString("base64"),
          },
        },
        ...fixture.approvalSet.approvals.slice(1),
      ],
    });
    const badSignatureResult = verifyModelBundle({
      manifestBytes: fixture.manifestBytes,
      artifactBytes: fixture.artifactBytes,
      evidenceBytes: fixture.evidenceBytes,
      approvalSet: badSignatureSet,
      trustedKeyring: fixture.keyring,
      verifiedAt: VERIFIED_AT,
    });
    assert.equal(badSignatureResult.ok, false);
    if (!badSignatureResult.ok) {
      assert.match(
        badSignatureResult.issues.join("\n"),
        /Ed25519 signature verification failed/u,
      );
    }

    const missingRoleResult = verifyModelBundle({
      manifestBytes: fixture.manifestBytes,
      artifactBytes: fixture.artifactBytes,
      evidenceBytes: fixture.evidenceBytes,
      approvalSet: {
        ...fixture.approvalSet,
        approvals: fixture.approvalSet.approvals.slice(0, -1),
      },
      trustedKeyring: fixture.keyring,
      verifiedAt: VERIFIED_AT,
    });
    assert.equal(missingRoleResult.ok, false);
    if (!missingRoleResult.ok) {
      assert.match(
        missingRoleResult.issues.join("\n"),
        /missing valid SECURITY_REVIEWER approval/u,
      );
    }
  });

  it("enforces shadow sample and duration gates without promoting", () => {
    const fixture = buildFixture();
    const shortenedManifest = ModelBundleManifestSchema.parse({
      ...fixture.manifest,
      gates: {
        ...fixture.manifest.gates,
        shadowStartedAt: new Date(
          Date.parse(fixture.manifest.gates.shadowEndedAt) - 83 * DAY_MS,
        ).toISOString(),
        independentAlertWindows: 299,
        outcomeCounts: {
          ABOVE_OPEN: 149,
          BELOW_OPEN: 140,
          AT_OPEN: 10,
        },
      },
    });
    const result = verifyModelBundle({
      manifestBytes: jsonBytes(shortenedManifest),
      artifactBytes: fixture.artifactBytes,
      evidenceBytes: fixture.evidenceBytes,
      approvalSet: fixture.approvalSet,
      trustedKeyring: fixture.keyring,
      verifiedAt: VERIFIED_AT,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.issues.join("\n"), /shorter than 12 weeks/u);
      assert.match(result.issues.join("\n"), /fewer than 300/u);
    }
  });

  it("offers no CLI signing or promotion option", () => {
    assert.deepEqual(
      parseCliArguments(["--bundle", "bundle", "--keyring", "keys.json"]),
      { bundle: "bundle", keyring: "keys.json" },
    );
    assert.throws(() => parseCliArguments(["--bundle", "bundle", "--promote", "true"]));
    assert.throws(() => parseCliArguments(["--bundle", "bundle", "--sign", "key.pem"]));
  });

  it("validates the v3 Binance lineage, chronology, and fit-only OOD envelope", () => {
    const candidate = buildBinanceCandidate();
    assert.equal(
      DraftBinanceMultinomialArtifactSchema.safeParse(candidate).success,
      true,
    );
    assert.equal(
      isOfflineOnlyCandidatePair(
        candidate.schemaVersion,
        "flippars.model-bundle-manifest/2",
      ),
      true,
    );

    assert.equal(
      DraftBinanceMultinomialArtifactSchema.safeParse({
        ...candidate,
        calibrationFitThrough: "2025-03-01T00:00:00.000Z",
      }).success,
      false,
    );
    assert.equal(
      DraftBinanceMultinomialArtifactSchema.safeParse({
        ...candidate,
        datasetManifestSha256: "f".repeat(64),
      }).success,
      false,
    );
    assert.equal(
      DraftBinanceMultinomialArtifactSchema.safeParse({
        ...candidate,
        ood: {
          ...candidate.ood,
          normalizedBounds: {
            ...candidate.ood.normalizedBounds,
            upper: [2, ...candidate.ood.normalizedBounds.upper.slice(1)],
          },
        },
      }).success,
      false,
    );
  });

  it("rejects a fully valid and signed v3 bundle only at the offline-only boundary", () => {
    const fixture = buildBinanceFixture();
    assert.equal(
      DraftBinanceMultinomialArtifactSchema.safeParse(fixture.artifact).success,
      true,
    );
    assert.equal(
      BinanceModelBundleManifestSchema.safeParse(fixture.manifest).success,
      true,
    );
    assert.equal(fixture.manifest.artifact.sha256, sha256Hex(fixture.artifactBytes));
    assert.equal(
      fixture.manifest.artifact.byteLength,
      fixture.artifactBytes.byteLength,
    );

    const firstApproval = fixture.approvalSet.approvals[0];
    const firstKey = fixture.keyring.keys.find(
      (key) => key.keyId === firstApproval?.statement.signerKeyId,
    );
    assert.ok(firstApproval);
    assert.ok(firstKey);
    assert.equal(
      verify(
        null,
        approvalSigningPayload(firstApproval.statement),
        firstKey.publicKeyPem,
        Buffer.from(firstApproval.signature.value, "base64"),
      ),
      true,
    );

    const result = verifyModelBundle({
      manifestBytes: fixture.manifestBytes,
      artifactBytes: fixture.artifactBytes,
      evidenceBytes: fixture.evidenceBytes,
      approvalSet: fixture.approvalSet,
      trustedKeyring: fixture.keyring,
      verifiedAt: VERIFIED_AT,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.issues, [
        "v3 Binance candidates are offline-only and cannot be promoted",
      ]);
      assert.doesNotMatch(
        result.issues.join("\n"),
        /schema|SHA-256|signer key|signature verification|missing valid/u,
      );
    }
  });
});

function buildBinanceCandidate() {
  const schedule = {
    schemaVersion: "flippars.candidate-decision-schedule/1",
    kind: "FIXED_CADENCE",
    firstDecisionOffsetSeconds: 15,
    lastDecisionOffsetSeconds: 285,
    cadenceSeconds: 15,
    phaseStartSeconds: 0,
    phaseEndExclusiveSeconds: 300,
    minimumLeadTimeSeconds: 15,
    selectionPolicy: "FIRST_QUALIFIED_PER_WINDOW",
  } as const;
  const zeroVector = BINANCE_SPOT_SIGNAL_FEATURE_NAMES.map(() => 0);
  const oneVector = BINANCE_SPOT_SIGNAL_FEATURE_NAMES.map(() => 1);
  const datasetContentSha256 = "c".repeat(64);
  const datasetManifestSha256 = "d".repeat(64);
  return {
    schemaVersion: "flippars.multinomial-candidate/3",
    artifactId: "candidate:FIVE_MINUTE_REVERSAL:2026.3",
    version: "2026.3",
    status: "DRAFT",
    signalType: "FIVE_MINUTE_REVERSAL",
    target: {
      kind: "BINANCE_SPOT_CANDLE_CLOSE_RELATION",
      targetVersion: "binance-spot-trade-close-relation/1",
      decisionPolicyVersion: "flippars-signal-candidate-sampling/1",
      crossVenueGuardPolicyVersion: "btc-usd-cross-venue-health/1",
      signalType: "FIVE_MINUTE_REVERSAL",
      venue: "BINANCE",
      marketType: "SPOT",
      symbol: "BTCUSDT",
      quoteAsset: "USDT",
      input: "TRADE",
      timeBasis: "EVENT_TIME",
      tradeOrdering: "EVENT_TIME_THEN_TRADE_ID",
      windowAlignment: "UTC_EPOCH",
      windowBounds: "HALF_OPEN",
      durationSeconds: 300,
      openDefinition: "FIRST_TRADE_AT_OR_AFTER_WINDOW_START",
      closeDefinition: "LAST_TRADE_BEFORE_WINDOW_END",
      targetPriceNormalization: "NONE",
      classOrder: ["ABOVE_OPEN", "BELOW_OPEN", "AT_OPEN"],
      deadbandBps: 5,
      labelPolicyVersion: "binance-spot-trade-close-relation/1",
      candidateSchedule: schedule,
    },
    createdAt: "2025-06-03T00:00:00.000Z",
    modelFitThrough: "2025-04-01T00:00:00.000Z",
    calibrationFitThrough: "2025-05-01T00:00:00.000Z",
    evaluationThrough: "2025-06-01T00:00:00.000Z",
    featureSchemaVersion: "binance-spot-signal-features/1",
    featureNames: BINANCE_SPOT_SIGNAL_FEATURE_NAMES,
    normalization: { means: zeroVector, scales: oneVector },
    model: {
      kind: "MULTINOMIAL_LOGISTIC",
      weights: [zeroVector, zeroVector, zeroVector],
      biases: [0, 0, 0],
    },
    calibration: {
      method: "TEMPERATURE",
      temperature: 1,
      version: "temperature.2026.3",
      validUntil: "2027-01-01T00:00:00.000Z",
    },
    ood: {
      schemaVersion: "flippars.fit-support-envelope/1",
      version: "fit-quantile-box.2026.3",
      method: "FIT_PARTITION_QUANTILE_BOX",
      fittedPartition: "MODEL_FIT",
      fittedThrough: "2025-04-01T00:00:00.000Z",
      lowerQuantile: 0.005,
      upperQuantile: 0.995,
      featureNames: BINANCE_SPOT_SIGNAL_FEATURE_NAMES,
      rawBounds: { lower: zeroVector, upper: oneVector },
      normalizedBounds: { lower: zeroVector, upper: oneVector },
      missingValuePolicy: "ABSTAIN",
      nonFiniteValuePolicy: "ABSTAIN",
      breachPolicy: "ABSTAIN",
    },
    datasetContentSha256,
    datasetManifestSha256,
    datasetManifest: {
      schemaVersion: "flippars.dataset-manifest-summary/3",
      datasetContentSha256,
      datasetManifestSha256,
      lineageKind: "PUBLIC_BINANCE_ARCHIVE",
      preparedArchiveIndexSha256: "a".repeat(64),
      acquisitionArchiveIndexSha256: "b".repeat(64),
      acquisitionManifestSha256: "c".repeat(64),
      rejectLogSha256: "b".repeat(64),
      source: "BINANCE_DATA_VISION",
      dataKind: "TRADES",
      symbol: "BTCUSDT",
      targetVersion: "binance-spot-trade-close-relation/1",
      featureSchemaVersion: "binance-spot-signal-features/1",
      deadbandBps: 5,
      candidateSchedule: schedule,
      windowCountUnit: "UNIQUE_WINDOW_START",
      sourceIntegrityRequired: true,
      crossVenueGuardAvailability: "UNAVAILABLE",
      productionEligible: false,
      archiveCount: 152,
      archiveChecksumsVerified: true,
      officialTransportEvidenceVerified: true,
      sourceStartDateInclusive: "2025-01-01",
      sourceEndDateExclusive: "2025-06-02",
      sourceDayCount: 152,
      startAt: "2025-01-01T00:00:00.000Z",
      endAt: "2025-06-02T00:00:00.000Z",
      acceptedTradeCount: 1_000,
      rejectedTradeCount: 0,
      gapCount: 0,
      duplicateTradeCount: 0,
      preparedWindowCount: 400,
      preparedDecisionRowCount: 4_000,
      partitionWindowCounts: {
        modelFit: 240,
        calibration: 80,
        evaluation: 80,
      },
    },
    preEvaluationPolicySha256: "e".repeat(64),
    trainingCodeSha256: "f".repeat(64),
    approval: { approvedAt: null, approvedBy: null },
  } as const;
}

function buildBinanceFixture() {
  const legacy = buildFixture();
  const artifact = DraftBinanceMultinomialArtifactSchema.parse(buildBinanceCandidate());
  const artifactBytes = jsonBytes(artifact);
  const manifest = BinanceModelBundleManifestSchema.parse({
    schemaVersion: "flippars.model-bundle-manifest/2",
    bundleId: "bundle:FIVE_MINUTE_REVERSAL:2026.3",
    createdAt: MANIFEST_CREATED_AT,
    requestedReleaseStage: "CANARY",
    artifactId: artifact.artifactId,
    artifactVersion: artifact.version,
    signalType: artifact.signalType,
    target: artifact.target,
    artifact: {
      format: artifact.schemaVersion,
      path: "artifact/candidate-v3.json",
      sha256: sha256Hex(artifactBytes),
      byteLength: artifactBytes.byteLength,
    },
    runtime: {
      compatibility: {
        schemaVersion: "flippars.binance-runtime-compatibility/1",
        targetVersion: artifact.target.targetVersion,
        featureSchemaVersion: artifact.featureSchemaVersion,
        decisionPolicyVersion: artifact.target.decisionPolicyVersion,
        crossVenueGuardPolicyVersion: artifact.target.crossVenueGuardPolicyVersion,
        signalType: artifact.signalType,
        durationSeconds: artifact.target.durationSeconds,
        deadbandBps: artifact.target.deadbandBps,
        classOrder: artifact.target.classOrder,
        candidateSchedule: artifact.target.candidateSchedule,
        oodVersion: artifact.ood.version,
      },
      policyVersion: "precision-first.1",
      policyDocumentSha256: legacy.manifest.evidence.policyDocument.sha256,
      calibrationVersion: artifact.calibration.version,
      calibrationValidUntil: artifact.calibration.validUntil,
      minimumConfidence: 0.75,
    },
    datasetContentSha256: artifact.datasetContentSha256,
    datasetManifestSha256: artifact.datasetManifestSha256,
    evidence: legacy.manifest.evidence,
    gates: legacy.manifest.gates,
  });
  const manifestBytes = jsonBytes(manifest);
  const manifestSha256 = sha256Hex(manifestBytes);
  const signers = APPROVAL_ROLES.map((role, index) =>
    signer(role, index, manifest, manifestSha256),
  );
  return {
    artifact,
    artifactBytes,
    manifest,
    manifestBytes,
    evidenceBytes: legacy.evidenceBytes,
    approvalSet: SignedApprovalSetSchema.parse({
      schemaVersion: "flippars.model-approval-set/1",
      approvals: signers.map((value) => value.approval),
    }),
    keyring: TrustedModelKeyringSchema.parse({
      schemaVersion: "flippars.trusted-model-keys/1",
      keys: signers.map((value) => value.trustedKey),
    }),
  };
}

function buildFixture(): Fixture {
  const artifact = DraftMultinomialArtifactSchema.parse({
    schemaVersion: "flippars.multinomial-candidate/2",
    artifactId: "candidate:FIVE_MINUTE_REVERSAL:2026.1",
    version: "2026.1",
    status: "DRAFT",
    signalType: "FIVE_MINUTE_REVERSAL",
    target: {
      kind: "CANDLE_CLOSE_RELATION",
      classOrder: ["ABOVE_OPEN", "BELOW_OPEN", "AT_OPEN"],
      deadbandBps: 1,
      labelPolicyVersion: "close-relation.1",
    },
    createdAt: "2026-01-01T12:00:00.000Z",
    trainedThrough: "2025-12-31T23:55:00.000Z",
    featureSchemaVersion: "features.1",
    featureNames: ["returnBps", "remainingRatio"],
    normalization: {
      means: [0, 0.5],
      scales: [10, 0.25],
    },
    model: {
      kind: "MULTINOMIAL_LOGISTIC",
      weights: [
        [0.2, 0.1],
        [-0.2, 0.1],
        [0, -0.1],
      ],
      biases: [0.1, -0.1, 0],
    },
    calibration: {
      method: "TEMPERATURE",
      temperature: 1.1,
      version: "temperature.2026.1",
      validUntil: "2027-01-01T00:00:00.000Z",
    },
    datasetSha256: "a".repeat(64),
    trainingCodeSha256: "b".repeat(64),
    approval: { approvedAt: null, approvedBy: null },
  });
  const artifactBytes = jsonBytes(artifact);

  const evidenceBytes: Partial<Record<ApprovalEvidenceName, Uint8Array>> = {};
  const producedAt = new Date(Date.parse(SHADOW_END) + 60_000).toISOString();
  const reference = (name: ApprovalEvidenceName) => {
    const bytes = Buffer.from(`# ${name}\ncontrolled test evidence\n`, "utf8");
    evidenceBytes[name] = bytes;
    return {
      path: `evidence/${name}.md`,
      sha256: sha256Hex(bytes),
      byteLength: bytes.byteLength,
      producedAt,
      producedBy: "independent-test-fixture",
      mediaType: "text/markdown",
    } as const;
  };
  const policyDocument = reference("policyDocument");
  const manifest = ModelBundleManifestSchema.parse({
    schemaVersion: "flippars.model-bundle-manifest/1",
    bundleId: "bundle:FIVE_MINUTE_REVERSAL:2026.1",
    createdAt: MANIFEST_CREATED_AT,
    requestedReleaseStage: "CANARY",
    artifactId: artifact.artifactId,
    artifactVersion: artifact.version,
    signalType: artifact.signalType,
    target: artifact.target,
    artifact: {
      format: artifact.schemaVersion,
      path: "artifact/candidate.json",
      sha256: sha256Hex(artifactBytes),
      byteLength: artifactBytes.byteLength,
    },
    runtime: {
      featureSchemaVersion: artifact.featureSchemaVersion,
      policyVersion: "precision-first.1",
      policyDocumentSha256: policyDocument.sha256,
      calibrationVersion: artifact.calibration.version,
      calibrationValidUntil: artifact.calibration.validUntil,
      minimumConfidence: 0.75,
    },
    datasetSha256: artifact.datasetSha256,
    evidence: {
      modelCard: reference("modelCard"),
      datasetLineage: reference("datasetLineage"),
      reproducibleExperiment: reference("reproducibleExperiment"),
      independentValidation: reference("independentValidation"),
      shadowReport: reference("shadowReport"),
      thresholdApproval: reference("thresholdApproval"),
      policyDocument,
      monitoringPlan: reference("monitoringPlan"),
      rollbackPlan: reference("rollbackPlan"),
      canaryPlan: reference("canaryPlan"),
      canaryReport: null,
    },
    gates: {
      brierSkillFraction: 0.06,
      brierSkillCi95Lower: 0.01,
      expectedCalibrationError: 0.02,
      maximumCalibrationBinError: 0.04,
      bothDirectionalClassesPass: true,
      shadowStartedAt: SHADOW_START,
      shadowEndedAt: SHADOW_END,
      independentAlertWindows: 300,
      observedPrecision: 0.8,
      observedPrecisionCi95Lower: 0.72,
      observedCoverage: 0.2,
      predeclaredCoverageFloor: 0.1,
      outcomeCounts: {
        ABOVE_OPEN: 150,
        BELOW_OPEN: 140,
        AT_OPEN: 10,
      },
      leadTimeFloorPass: true,
      integrityFloorPass: true,
      latencyFloorPass: true,
    },
  });
  const manifestBytes = jsonBytes(manifest);
  const manifestSha256 = sha256Hex(manifestBytes);

  const signers = APPROVAL_ROLES.map((role, index) =>
    signer(role, index, manifest, manifestSha256),
  );
  return {
    artifact,
    artifactBytes,
    manifest,
    manifestBytes,
    evidenceBytes,
    approvalSet: SignedApprovalSetSchema.parse({
      schemaVersion: "flippars.model-approval-set/1",
      approvals: signers.map((value) => value.approval),
    }),
    keyring: TrustedModelKeyringSchema.parse({
      schemaVersion: "flippars.trusted-model-keys/1",
      keys: signers.map((value) => value.trustedKey),
    }),
  };
}

function signer(
  role: ApprovalRole,
  index: number,
  manifest: GovernedModelBundleManifest,
  manifestSha256: string,
): {
  readonly approval: unknown;
  readonly trustedKey: unknown;
} {
  const pair = generateKeyPairSync("ed25519");
  const statement = ApprovalStatementSchema.parse({
    schemaVersion: "flippars.model-approval-statement/1",
    statementId: `statement:${index}`,
    decision: "APPROVE",
    releaseStage: manifest.requestedReleaseStage,
    manifestSha256,
    artifactId: manifest.artifactId,
    artifactVersion: manifest.artifactVersion,
    signalType: manifest.signalType,
    approverId: `approver:${index}`,
    approverRole: role,
    signerKeyId: `model-key:${index}`,
    signedAt: new Date(Date.parse(manifest.createdAt) + 60_000).toISOString(),
    validUntil: "2026-12-01T00:00:00.000Z",
  });
  return {
    approval: {
      statement,
      signature: {
        algorithm: "ED25519",
        encoding: "base64",
        value: signApproval(statement, pair.privateKey),
      },
    },
    trustedKey: {
      keyId: statement.signerKeyId,
      approverId: statement.approverId,
      approverRole: statement.approverRole,
      algorithm: "ED25519",
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
      validFrom: "2025-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
      revokedAt: null,
    },
  };
}

function signApproval(
  statement: Parameters<typeof approvalSigningPayload>[0],
  privateKey: KeyObject,
): string {
  return sign(null, approvalSigningPayload(statement), privateKey).toString("base64");
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
