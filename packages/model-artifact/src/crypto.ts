import { createHash, createPublicKey, verify } from "node:crypto";

import { ApprovalStatementSchema, type ApprovalStatement } from "./schema.js";

const PAYLOAD_DOMAIN = "flippars-model-approval-v1";
const FIELD_SEPARATOR = "\u001f";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Produces the complete domain-separated byte sequence an independent signer
 * signs. This package intentionally exposes no private-key or signing function.
 */
export function approvalSigningPayload(input: ApprovalStatement): Uint8Array {
  const statement = ApprovalStatementSchema.parse(input);
  const fields = [
    PAYLOAD_DOMAIN,
    statement.schemaVersion,
    statement.statementId,
    statement.decision,
    statement.releaseStage,
    statement.manifestSha256,
    statement.artifactId,
    statement.artifactVersion,
    statement.signalType,
    statement.approverId,
    statement.approverRole,
    statement.signerKeyId,
    statement.signedAt,
    statement.validUntil,
  ];
  return Buffer.from(fields.join(FIELD_SEPARATOR), "utf8");
}

export function verifyEd25519ApprovalSignature(input: {
  readonly statement: ApprovalStatement;
  readonly signatureBase64: string;
  readonly publicKeyPem: string;
}): boolean {
  try {
    const signature = Buffer.from(input.signatureBase64, "base64");
    if (
      signature.length !== 64 ||
      signature.toString("base64") !== input.signatureBase64
    ) {
      return false;
    }
    const key = createPublicKey(input.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, approvalSigningPayload(input.statement), key, signature);
  } catch {
    return false;
  }
}
