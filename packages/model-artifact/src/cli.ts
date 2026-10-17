#!/usr/bin/env node
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  GovernedModelBundleManifestSchema,
  type ApprovalEvidenceName,
} from "./schema.js";
import { parseJsonDocument, verifyModelBundle } from "./verifier.js";

const MANIFEST_MAX_BYTES = 256 * 1_024;
const APPROVALS_MAX_BYTES = 256 * 1_024;
const KEYRING_MAX_BYTES = 256 * 1_024;

interface CliArguments {
  readonly bundle: string;
  readonly keyring: string;
}

export function parseCliArguments(values: readonly string[]): CliArguments {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new CliUsageError();
    const name = key.slice(2);
    if (name !== "bundle" && name !== "keyring") throw new CliUsageError();
    if (parsed.has(name)) throw new CliUsageError();
    parsed.set(name, value);
  }
  const bundle = parsed.get("bundle");
  const keyring = parsed.get("keyring");
  if (!bundle || !keyring) throw new CliUsageError();
  return { bundle, keyring };
}

export async function runCli(values: readonly string[]): Promise<number> {
  if (values.length === 1 && values[0] === "--help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    const options = parseCliArguments(values);
    const bundleRoot = await checkedBundleRoot(options.bundle);
    const manifestBytes = await readBundleFile(
      bundleRoot,
      "manifest.json",
      MANIFEST_MAX_BYTES,
    );
    const manifest = GovernedModelBundleManifestSchema.parse(
      parseJsonDocument(manifestBytes, "manifest.json"),
    );
    const artifactBytes = await readBundleFile(
      bundleRoot,
      manifest.artifact.path,
      manifest.artifact.byteLength,
      manifest.artifact.byteLength,
    );
    const evidenceBytes: Partial<Record<ApprovalEvidenceName, Uint8Array>> = {};
    for (const [name, reference] of Object.entries(manifest.evidence) as Array<
      [ApprovalEvidenceName, (typeof manifest.evidence)[ApprovalEvidenceName]]
    >) {
      if (reference === null) continue;
      evidenceBytes[name] = await readBundleFile(
        bundleRoot,
        reference.path,
        reference.byteLength,
        reference.byteLength,
      );
    }
    const approvalBytes = await readBundleFile(
      bundleRoot,
      "approvals.json",
      APPROVALS_MAX_BYTES,
    );
    const keyringBytes = await readStandaloneFile(options.keyring, KEYRING_MAX_BYTES);
    const result = verifyModelBundle({
      manifestBytes,
      artifactBytes,
      evidenceBytes,
      approvalSet: parseJsonDocument(approvalBytes, "approvals.json"),
      trustedKeyring: parseJsonDocument(keyringBytes, "trusted keyring"),
    });
    if (!result.ok) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, dryRun: true, issues: result.issues })}\n`,
      );
      return 1;
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        dryRun: true,
        bundleId: result.manifest.bundleId,
        releaseStage: result.manifest.requestedReleaseStage,
        manifestSha256: result.manifestSha256,
        artifactSha256: result.artifactSha256,
        approvalStatementIds: result.approvalStatementIds,
        note: "Offline verification only; no model was registered, promoted, or enabled.",
      })}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${usage()}\n`);
      return 2;
    }
    process.stderr.write(
      `Bundle verification failed: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
    return 1;
  }
}

async function checkedBundleRoot(input: string): Promise<string> {
  const requested = resolve(input);
  const details = await lstat(requested);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("Bundle root must be a real directory, not a symbolic link");
  }
  return realpath(requested);
}

async function readBundleFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
  expectedBytes?: number,
): Promise<Uint8Array> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new Error(`Bundle path contains a symbolic link: ${relativePath}`);
    }
  }
  const details = await lstat(current);
  if (!details.isFile()) throw new Error(`Bundle path is not a file: ${relativePath}`);
  if (details.size > maximumBytes) {
    throw new Error(`Bundle file exceeds its size limit: ${relativePath}`);
  }
  if (expectedBytes !== undefined && details.size !== expectedBytes) {
    throw new Error(`Bundle file size does not match manifest: ${relativePath}`);
  }
  return readFile(current);
}

async function readStandaloneFile(
  input: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const path = resolve(input);
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("Trusted keyring must be a real file, not a symbolic link");
  }
  if (details.size > maximumBytes) throw new Error("Trusted keyring is too large");
  return readFile(path);
}

function usage(): string {
  return "Usage: flippars-model-bundle-verify --bundle <directory> --keyring <trusted-keys.json>";
}

class CliUsageError extends Error {}

const directlyInvoked =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (directlyInvoked) process.exitCode = await runCli(process.argv.slice(2));
