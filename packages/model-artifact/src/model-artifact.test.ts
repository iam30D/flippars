import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, it } from "node:test";

import { parseCliArguments } from "./cli.js";
import { approvalSigningPayload, sha256Hex } from "./crypto.js";
import {
  APPROVAL_ROLES,
  ApprovalStatementSchema,
  DraftMultinomialArtifactSchema,
  ModelBundleManifestSchema,
  SignedApprovalSetSchema,
  TrustedModelKeyringSchema,
  type ApprovalEvidenceName,
  type ApprovalRole,
  type DraftMultinomialArtifact,
  type ModelBundleManifest,
  type SignedApprovalSet,
  type TrustedModelKeyring,
} from "./schema.js";
import { verifyModelBundle } from "./verifier.js";

const DAY_MS = 86_400_000;
const SHADOW_START = "2026-01-02T00:00:00.000Z";
const SHADOW_END = new Date(Date.parse(SHADOW_START) + 84 * DAY_MS).toISOString();
const MANIFEST_CREATED_AT = new Date(Date.parse(SHADOW_END) + DAY_MS).toISOString();
const VERIFIED_AT = new Date(Date.parse(MANIFEST_CREATED_AT) + DAY_MS).toISOString();

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
});

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
  manifest: ModelBundleManifest,
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
