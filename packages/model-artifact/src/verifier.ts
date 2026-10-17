import { TextDecoder } from "node:util";

import type { ZodError } from "zod";

import {
  APPROVAL_ROLES,
  DraftModelArtifactSchema,
  GovernedModelBundleManifestSchema,
  SignedApprovalSetSchema,
  TrustedModelKeyringSchema,
  type ApprovalEvidenceName,
  type ApprovalRole,
  type DraftMultinomialArtifact,
  type DraftModelArtifact,
  type GovernedModelBundleManifest,
  type ModelBundleManifest,
} from "./schema.js";
import { sha256Hex, verifyEd25519ApprovalSignature } from "./crypto.js";

const DAY_MS = 86_400_000;
const ALLOWED_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_JSON_DOCUMENT_BYTES = 64 * 1_024 * 1_024;
const MAX_JSON_DOCUMENT_DEPTH = 128;

class JsonIntegrityScanner {
  private offset = 0;

  public constructor(
    private readonly text: string,
    private readonly label: string,
  ) {}

  public validate(): void {
    this.skipWhitespace();
    if (this.offset === this.text.length) {
      this.fail("must contain a JSON value");
    }
    this.parseValue(0);
    this.skipWhitespace();
    if (this.offset !== this.text.length) {
      this.fail("contains trailing content");
    }
  }

  private parseValue(depth: number): void {
    if (depth > MAX_JSON_DOCUMENT_DEPTH) {
      this.fail(`exceeds the maximum nesting depth of ${MAX_JSON_DOCUMENT_DEPTH}`);
    }

    const character = this.text[this.offset];
    if (character === "{") {
      this.parseObject(depth);
    } else if (character === "[") {
      this.parseArray(depth);
    } else if (character === '"') {
      this.parseString(false);
    } else if (character === "t") {
      this.parseLiteral("true");
    } else if (character === "f") {
      this.parseLiteral("false");
    } else if (character === "n") {
      this.parseLiteral("null");
    } else if (character === "-" || this.isDigit(character)) {
      this.parseNumber();
    } else {
      this.fail("contains an invalid JSON value");
    }
  }

  private parseObject(depth: number): void {
    this.offset += 1;
    this.skipWhitespace();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return;
    }

    const keys = new Set<string>();
    while (true) {
      if (this.text[this.offset] !== '"') {
        this.fail("contains a non-string object key");
      }
      const key = this.parseString(true);
      if (keys.has(key)) {
        this.fail(`contains duplicate object key ${JSON.stringify(key)}`);
      }
      keys.add(key);

      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      this.parseValue(depth + 1);
      this.skipWhitespace();

      const separator = this.text[this.offset];
      if (separator === "}") {
        this.offset += 1;
        return;
      }
      if (separator !== ",") {
        this.fail("contains an invalid object separator");
      }
      this.offset += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): void {
    this.offset += 1;
    this.skipWhitespace();
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return;
    }

    while (true) {
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const separator = this.text[this.offset];
      if (separator === "]") {
        this.offset += 1;
        return;
      }
      if (separator !== ",") {
        this.fail("contains an invalid array separator");
      }
      this.offset += 1;
      this.skipWhitespace();
    }
  }

  private parseString(decode: false): undefined;
  private parseString(decode: true): string;
  private parseString(decode: boolean): string | undefined {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const character = this.text[this.offset]!;
      if (character === '"') {
        this.offset += 1;
        if (!decode) return undefined;
        try {
          return JSON.parse(this.text.slice(start, this.offset)) as string;
        } catch {
          this.fail("contains an invalid object key");
        }
      }
      if (character.charCodeAt(0) < 0x20) {
        this.fail("contains an unescaped control character");
      }
      if (character !== "\\") {
        this.offset += 1;
        continue;
      }

      const escape = this.text[this.offset + 1];
      if (
        escape === '"' ||
        escape === "\\" ||
        escape === "/" ||
        escape === "b" ||
        escape === "f" ||
        escape === "n" ||
        escape === "r" ||
        escape === "t"
      ) {
        this.offset += 2;
        continue;
      }
      if (escape !== "u") {
        this.fail("contains an invalid JSON escape");
      }
      for (let index = this.offset + 2; index < this.offset + 6; index += 1) {
        const codeUnit = this.text.charCodeAt(index);
        const hexadecimal =
          (codeUnit >= 0x30 && codeUnit <= 0x39) ||
          (codeUnit >= 0x41 && codeUnit <= 0x46) ||
          (codeUnit >= 0x61 && codeUnit <= 0x66);
        if (!hexadecimal) {
          this.fail("contains an invalid Unicode escape");
        }
      }
      this.offset += 6;
    }

    this.fail("contains an unterminated JSON string");
  }

  private parseNumber(): void {
    const start = this.offset;
    if (this.text[this.offset] === "-") {
      this.offset += 1;
    }

    const firstDigit = this.text[this.offset];
    if (firstDigit === "0") {
      this.offset += 1;
    } else if (firstDigit !== undefined && firstDigit >= "1" && firstDigit <= "9") {
      this.offset += 1;
      while (this.isDigit(this.text[this.offset])) this.offset += 1;
    } else {
      this.fail("contains an invalid JSON number");
    }

    if (this.text[this.offset] === ".") {
      this.offset += 1;
      if (!this.isDigit(this.text[this.offset])) {
        this.fail("contains an invalid JSON number");
      }
      while (this.isDigit(this.text[this.offset])) this.offset += 1;
    }

    const exponent = this.text[this.offset];
    if (exponent === "e" || exponent === "E") {
      this.offset += 1;
      const sign = this.text[this.offset];
      if (sign === "+" || sign === "-") this.offset += 1;
      if (!this.isDigit(this.text[this.offset])) {
        this.fail("contains an invalid JSON number");
      }
      while (this.isDigit(this.text[this.offset])) this.offset += 1;
    }

    const numeric = Number(this.text.slice(start, this.offset));
    if (!Number.isFinite(numeric)) {
      this.fail("contains a non-finite JSON number");
    }
    if (Number.isInteger(numeric) && !Number.isSafeInteger(numeric)) {
      this.fail("contains an integer outside the JavaScript safe-integer range");
    }
  }

  private parseLiteral(literal: "false" | "null" | "true"): void {
    if (!this.text.startsWith(literal, this.offset)) {
      this.fail("contains an invalid JSON literal");
    }
    this.offset += literal.length;
  }

  private skipWhitespace(): void {
    while (true) {
      const codeUnit = this.text.charCodeAt(this.offset);
      if (
        codeUnit !== 0x20 &&
        codeUnit !== 0x09 &&
        codeUnit !== 0x0a &&
        codeUnit !== 0x0d
      ) {
        return;
      }
      this.offset += 1;
    }
  }

  private isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }

  private expect(expected: string): void {
    if (this.text[this.offset] !== expected) {
      this.fail(`must contain ${JSON.stringify(expected)} at this position`);
    }
    this.offset += 1;
  }

  private fail(message: string): never {
    throw new TypeError(
      `${this.label} is not valid JSON: ${message} at offset ${this.offset}`,
    );
  }
}

export const PROVISIONAL_GATE_POLICY = Object.freeze({
  minimumBrierSkillFraction: 0.05,
  maximumExpectedCalibrationError: 0.03,
  maximumCalibrationBinError: 0.05,
  minimumShadowDurationDays: 84,
  minimumIndependentAlertWindows: 300,
  minimumObservedPrecision: 0.75,
  minimumObservedPrecisionCi95Lower: 0.7,
});

export interface ModelBundleVerificationInput {
  readonly manifestBytes: Uint8Array;
  readonly artifactBytes: Uint8Array;
  readonly evidenceBytes: Readonly<Partial<Record<ApprovalEvidenceName, Uint8Array>>>;
  readonly approvalSet: unknown;
  readonly trustedKeyring: unknown;
  readonly verifiedAt?: string;
  readonly requiredApprovalRoles?: readonly ApprovalRole[];
}

export interface VerifiedModelBundle {
  readonly ok: true;
  readonly manifest: ModelBundleManifest;
  readonly artifact: DraftMultinomialArtifact;
  readonly manifestSha256: string;
  readonly artifactSha256: string;
  readonly verifiedAt: string;
  readonly approvalStatementIds: readonly string[];
}

export interface RejectedModelBundle {
  readonly ok: false;
  readonly issues: readonly string[];
}

export type ModelBundleVerification = VerifiedModelBundle | RejectedModelBundle;
export const isOfflineOnlyCandidatePair = (
  artifact: string,
  manifest: string,
): boolean =>
  artifact === "flippars.multinomial-candidate/3" &&
  manifest === "flippars.model-bundle-manifest/2";

export function parseJsonDocument(bytes: Uint8Array, label: string): unknown {
  if (bytes.byteLength > MAX_JSON_DOCUMENT_BYTES) {
    throw new TypeError(`${label} exceeds the maximum JSON document size`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${label} is not valid UTF-8`);
  }
  new JsonIntegrityScanner(text, label).validate();
  return JSON.parse(text) as unknown;
}

export function verifyModelBundle(
  input: ModelBundleVerificationInput,
): ModelBundleVerification {
  const issues: string[] = [];
  const verifiedAt = parseVerificationTime(input.verifiedAt, issues);

  const manifestJson = parseBytes(input.manifestBytes, "manifest.json", issues);
  const artifactJson = parseBytes(input.artifactBytes, "artifact", issues);
  const manifestResult = GovernedModelBundleManifestSchema.safeParse(manifestJson);
  const artifactResult = DraftModelArtifactSchema.safeParse(artifactJson);
  const approvalResult = SignedApprovalSetSchema.safeParse(input.approvalSet);
  const keyringResult = TrustedModelKeyringSchema.safeParse(input.trustedKeyring);

  if (!manifestResult.success) {
    issues.push(...formatZodIssues("manifest.json", manifestResult.error));
  }
  if (!artifactResult.success) {
    issues.push(...formatZodIssues("artifact", artifactResult.error));
  }
  if (!approvalResult.success) {
    issues.push(...formatZodIssues("approvals.json", approvalResult.error));
  }
  if (!keyringResult.success) {
    issues.push(...formatZodIssues("trusted keyring", keyringResult.error));
  }
  if (
    !verifiedAt ||
    !manifestResult.success ||
    !artifactResult.success ||
    !approvalResult.success ||
    !keyringResult.success
  ) {
    return rejected(issues);
  }

  const manifest = manifestResult.data;
  const artifact = artifactResult.data;
  const manifestSha256 = sha256Hex(input.manifestBytes);
  const artifactSha256 = sha256Hex(input.artifactBytes);
  const verifiedAtMs = Date.parse(verifiedAt);

  verifyArtifactReference(
    manifest,
    artifact,
    input.artifactBytes.byteLength,
    artifactSha256,
    issues,
  );
  if (isOfflineOnlyCandidatePair(artifact.schemaVersion, manifest.schemaVersion)) {
    issues.push("v3 Binance candidates are offline-only and cannot be promoted");
  }
  verifyEvidence(manifest, input.evidenceBytes, issues);
  verifyGovernanceGates(manifest, artifact, verifiedAtMs, issues);

  const validApprovals: Array<{
    readonly statementId: string;
    readonly role: ApprovalRole;
    readonly approverId: string;
    readonly keyId: string;
  }> = [];
  const statementIds = new Set<string>();
  for (const approval of approvalResult.data.approvals) {
    const statement = approval.statement;
    const prefix = `approval ${statement.statementId}`;
    let valid = true;
    if (statementIds.has(statement.statementId)) {
      issues.push(`${prefix}: duplicate statementId`);
      valid = false;
    }
    statementIds.add(statement.statementId);
    if (statement.manifestSha256 !== manifestSha256) {
      issues.push(`${prefix}: manifest digest does not match manifest.json`);
      valid = false;
    }
    if (
      statement.artifactId !== manifest.artifactId ||
      statement.artifactVersion !== manifest.artifactVersion ||
      statement.signalType !== manifest.signalType
    ) {
      issues.push(`${prefix}: artifact identity does not match the manifest`);
      valid = false;
    }
    if (statement.releaseStage !== manifest.requestedReleaseStage) {
      issues.push(`${prefix}: release stage does not match the manifest`);
      valid = false;
    }
    const signedAtMs = Date.parse(statement.signedAt);
    if (signedAtMs < Date.parse(manifest.createdAt)) {
      issues.push(`${prefix}: signedAt predates the completed manifest`);
      valid = false;
    }
    if (signedAtMs > verifiedAtMs + ALLOWED_FUTURE_CLOCK_SKEW_MS) {
      issues.push(`${prefix}: signedAt is too far in the future`);
      valid = false;
    }
    if (Date.parse(statement.validUntil) < verifiedAtMs) {
      issues.push(`${prefix}: approval has expired`);
      valid = false;
    }
    if (
      Date.parse(statement.validUntil) >
      Date.parse(manifest.runtime.calibrationValidUntil)
    ) {
      issues.push(`${prefix}: approval validity exceeds calibration validity`);
      valid = false;
    }

    const key = keyringResult.data.keys.find(
      (candidate) => candidate.keyId === statement.signerKeyId,
    );
    if (!key) {
      issues.push(`${prefix}: signer key is not trusted`);
      valid = false;
    } else {
      if (
        key.approverId !== statement.approverId ||
        key.approverRole !== statement.approverRole
      ) {
        issues.push(`${prefix}: signer identity or role does not match the keyring`);
        valid = false;
      }
      if (signedAtMs < Date.parse(key.validFrom)) {
        issues.push(`${prefix}: key was not valid when the statement was signed`);
        valid = false;
      }
      if (key.validUntil !== null && Date.parse(key.validUntil) < verifiedAtMs) {
        issues.push(`${prefix}: trusted key is no longer valid`);
        valid = false;
      }
      if (key.revokedAt !== null && Date.parse(key.revokedAt) <= verifiedAtMs) {
        issues.push(`${prefix}: trusted key has been revoked`);
        valid = false;
      }
      if (
        !verifyEd25519ApprovalSignature({
          statement,
          signatureBase64: approval.signature.value,
          publicKeyPem: key.publicKeyPem,
        })
      ) {
        issues.push(`${prefix}: Ed25519 signature verification failed`);
        valid = false;
      }
    }
    if (valid) {
      validApprovals.push({
        statementId: statement.statementId,
        role: statement.approverRole,
        approverId: statement.approverId,
        keyId: statement.signerKeyId,
      });
    }
  }

  const requiredRoles = input.requiredApprovalRoles ?? APPROVAL_ROLES;
  const requiredApprovals = requiredRoles.flatMap((role) => {
    const matching = validApprovals.filter((approval) => approval.role === role);
    if (matching.length === 0) issues.push(`missing valid ${role} approval`);
    return matching.slice(0, 1);
  });
  if (
    new Set(requiredApprovals.map((approval) => approval.approverId)).size !==
    requiredApprovals.length
  ) {
    issues.push("required approvals must use distinct approver identities");
  }
  if (
    new Set(requiredApprovals.map((approval) => approval.keyId)).size !==
    requiredApprovals.length
  ) {
    issues.push("required approvals must use distinct signing keys");
  }

  if (issues.length > 0) return rejected(issues);
  if (
    manifest.schemaVersion !== "flippars.model-bundle-manifest/1" ||
    artifact.schemaVersion !== "flippars.multinomial-candidate/2"
  ) {
    return rejected(["only the governed v1/v2 bundle pair can be verified"]);
  }
  return {
    ok: true,
    manifest,
    artifact,
    manifestSha256,
    artifactSha256,
    verifiedAt,
    approvalStatementIds: requiredApprovals.map((approval) => approval.statementId),
  };
}

function verifyArtifactReference(
  manifest: GovernedModelBundleManifest,
  artifact: DraftModelArtifact,
  byteLength: number,
  digest: string,
  issues: string[],
): void {
  if (manifest.artifact.byteLength !== byteLength) {
    issues.push("artifact byte length does not match the manifest");
  }
  if (manifest.artifact.sha256 !== digest) {
    issues.push("artifact SHA-256 does not match the manifest");
  }
  if (
    artifact.artifactId !== manifest.artifactId ||
    artifact.version !== manifest.artifactVersion ||
    artifact.signalType !== manifest.signalType
  ) {
    issues.push("draft artifact identity does not match the manifest");
  }
  if (
    artifact.schemaVersion === "flippars.multinomial-candidate/2" &&
    manifest.schemaVersion === "flippars.model-bundle-manifest/1"
  ) {
    if (
      artifact.target.kind !== manifest.target.kind ||
      artifact.target.deadbandBps !== manifest.target.deadbandBps ||
      artifact.target.labelPolicyVersion !== manifest.target.labelPolicyVersion ||
      artifact.target.classOrder.some(
        (relation, index) => relation !== manifest.target.classOrder[index],
      )
    ) {
      issues.push("draft artifact target does not match the manifest");
    }
    if (artifact.featureSchemaVersion !== manifest.runtime.featureSchemaVersion) {
      issues.push("feature schema version does not match the manifest");
    }
  } else if (
    artifact.schemaVersion === "flippars.multinomial-candidate/3" &&
    manifest.schemaVersion === "flippars.model-bundle-manifest/2"
  ) {
    if (JSON.stringify(artifact.target) !== JSON.stringify(manifest.target)) {
      issues.push("draft artifact target does not match the manifest");
    }
    if (
      artifact.featureSchemaVersion !==
      manifest.runtime.compatibility.featureSchemaVersion
    ) {
      issues.push("feature schema version does not match the manifest");
    }
    if (artifact.target.deadbandBps !== manifest.runtime.compatibility.deadbandBps) {
      issues.push("artifact deadband does not match runtime compatibility metadata");
    }
    if (
      JSON.stringify(artifact.target.candidateSchedule) !==
      JSON.stringify(manifest.runtime.compatibility.candidateSchedule)
    ) {
      issues.push("artifact candidate schedule does not match runtime metadata");
    }
    if (artifact.ood.version !== manifest.runtime.compatibility.oodVersion) {
      issues.push("artifact OOD support version does not match runtime metadata");
    }
    if (
      artifact.datasetContentSha256 !== manifest.datasetContentSha256 ||
      artifact.datasetManifestSha256 !== manifest.datasetManifestSha256
    ) {
      issues.push("dataset content or manifest digest does not match the manifest");
    }
    if (
      artifact.datasetManifest.lineageKind !== "PUBLIC_BINANCE_ARCHIVE" ||
      !artifact.datasetManifest.archiveChecksumsVerified ||
      !artifact.datasetManifest.officialTransportEvidenceVerified ||
      artifact.datasetManifest.acquisitionArchiveIndexSha256 === null ||
      artifact.datasetManifest.acquisitionManifestSha256 === null
    ) {
      issues.push(
        "dataset lacks public Binance lineage with fresh official checksum transport evidence",
      );
    }
  } else {
    issues.push("artifact and manifest schema versions are incompatible");
  }
  if (
    artifact.calibration.version !== manifest.runtime.calibrationVersion ||
    artifact.calibration.validUntil !== manifest.runtime.calibrationValidUntil
  ) {
    issues.push("calibration identity or validity does not match the manifest");
  }
  if (
    artifact.schemaVersion === "flippars.multinomial-candidate/2" &&
    manifest.schemaVersion === "flippars.model-bundle-manifest/1" &&
    artifact.datasetSha256 !== manifest.datasetSha256
  ) {
    issues.push("dataset digest does not match the manifest");
  }
}

function verifyEvidence(
  manifest: GovernedModelBundleManifest,
  supplied: Readonly<Partial<Record<ApprovalEvidenceName, Uint8Array>>>,
  issues: string[],
): void {
  for (const [name, reference] of Object.entries(manifest.evidence) as Array<
    [
      ApprovalEvidenceName,
      GovernedModelBundleManifest["evidence"][ApprovalEvidenceName],
    ]
  >) {
    if (reference === null) continue;
    const bytes = supplied[name];
    if (!bytes) {
      issues.push(`missing evidence bytes for ${name}`);
      continue;
    }
    if (bytes.byteLength !== reference.byteLength) {
      issues.push(`${name} byte length does not match the manifest`);
    }
    if (sha256Hex(bytes) !== reference.sha256) {
      issues.push(`${name} SHA-256 does not match the manifest`);
    }
  }
  if (
    manifest.runtime.policyDocumentSha256 !== manifest.evidence.policyDocument.sha256
  ) {
    issues.push("runtime policy digest does not match policyDocument evidence");
  }
}

function verifyGovernanceGates(
  manifest: GovernedModelBundleManifest,
  artifact: DraftModelArtifact,
  verifiedAtMs: number,
  issues: string[],
): void {
  const gates = manifest.gates;
  const policy = PROVISIONAL_GATE_POLICY;
  if (gates.brierSkillFraction < policy.minimumBrierSkillFraction) {
    issues.push("Brier skill is below the provisional 5% floor");
  }
  if (gates.brierSkillCi95Lower <= 0) {
    issues.push("Brier skill 95% confidence-interval lower bound is not above zero");
  }
  if (gates.expectedCalibrationError > policy.maximumExpectedCalibrationError) {
    issues.push("expected calibration error exceeds 0.03");
  }
  if (gates.maximumCalibrationBinError > policy.maximumCalibrationBinError) {
    issues.push("maximum sampled calibration-bin error exceeds 0.05");
  }
  if (!gates.bothDirectionalClassesPass) {
    issues.push("both directional classes have not demonstrated value");
  }
  const shadowDuration =
    Date.parse(gates.shadowEndedAt) - Date.parse(gates.shadowStartedAt);
  if (shadowDuration < policy.minimumShadowDurationDays * DAY_MS) {
    issues.push("prospective shadow duration is shorter than 12 weeks");
  }
  if (gates.independentAlertWindows < policy.minimumIndependentAlertWindows) {
    issues.push("fewer than 300 independent shadow alert windows were recorded");
  }
  const outcomeCount = Object.values(gates.outcomeCounts).reduce(
    (total, count) => total + count,
    0,
  );
  if (outcomeCount !== gates.independentAlertWindows) {
    issues.push("shadow outcome counts do not cover every independent alert window");
  }
  if (gates.observedPrecision < policy.minimumObservedPrecision) {
    issues.push("observed shadow precision is below 75%");
  }
  if (gates.observedPrecisionCi95Lower < policy.minimumObservedPrecisionCi95Lower) {
    issues.push("observed precision 95% lower bound is below 70%");
  }
  if (!gates.leadTimeFloorPass) issues.push("lead-time floor did not pass");
  if (!gates.integrityFloorPass) issues.push("integrity floor did not pass");
  if (!gates.latencyFloorPass) issues.push("latency floor did not pass");
  if (Date.parse(artifact.createdAt) > Date.parse(gates.shadowStartedAt)) {
    issues.push("artifact was not frozen before prospective shadow began");
  }
  if (Date.parse(gates.shadowEndedAt) > Date.parse(manifest.createdAt)) {
    issues.push("manifest was created before prospective shadow ended");
  }
  if (Date.parse(manifest.runtime.calibrationValidUntil) <= verifiedAtMs) {
    issues.push("calibration has expired at verification time");
  }
}

function parseVerificationTime(
  value: string | undefined,
  issues: string[],
): string | null {
  const parsed = new Date(value ?? Date.now());
  if (!Number.isFinite(parsed.getTime())) {
    issues.push("verifiedAt is not a valid timestamp");
    return null;
  }
  return parsed.toISOString();
}

function parseBytes(bytes: Uint8Array, label: string, issues: string[]): unknown {
  try {
    return parseJsonDocument(bytes, label);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : `${label} is invalid`);
    return null;
  }
}

function formatZodIssues(label: string, error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
    return `${label}${path}: ${issue.message}`;
  });
}

function rejected(issues: readonly string[]): RejectedModelBundle {
  return {
    ok: false,
    issues: [...new Set(issues)],
  };
}
