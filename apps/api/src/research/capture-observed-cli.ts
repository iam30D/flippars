import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { runLongCapture } from "./capture-session.js";
import { RuntimeWitness } from "./runtime-witness.js";

async function boundedEvidenceFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536)
    throw new Error("Unsafe observer evidence file");
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(65_537);
  let size = 0;
  try {
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 65_536) throw new Error("Observer evidence file exceeds limit");
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

async function sourceDigests() {
  const extension = extname(fileURLToPath(import.meta.url));
  return Object.fromEntries(
    await Promise.all(
      ["capture-observed-cli", "runtime-witness"].map(
        async (name) =>
          [
            name,
            createHash("sha256")
              .update(await readFile(new URL(`./${name}${extension}`, import.meta.url)))
              .digest("hex"),
          ] as const,
      ),
    ),
  );
}

/** Observer context is bound separately; the seven-module collector remains intact. */
export async function runObservedCapture(
  options: Parameters<typeof runLongCapture>[0],
  capture: typeof runLongCapture = runLongCapture,
) {
  const implementationSha256 = await sourceDigests();
  const witness = new RuntimeWitness();
  let result: Record<string, unknown>;
  try {
    result = await capture(options);
  } finally {
    witness.stop();
  }
  const runtime = witness.stop();
  const recorded = z
    .object({
      root: z.string().min(1),
      sessionId: z.string().uuid(),
      completionState: z.enum(["CAPTURED", "CAPTURED_DEGRADED_GUARDS", "INCOMPLETE"]),
      fileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .parse(result);
  const manifestPath = join(recorded.root, "manifest.json");
  const manifestBytes = await boundedEvidenceFile(manifestPath);
  if (JSON.stringify(await sourceDigests()) !== JSON.stringify(implementationSha256))
    throw new Error("Observer changed during capture");
  const payload = JSON.stringify({
    ...runtime,
    captureSessionId: recorded.sessionId,
    captureCompletionState: recorded.completionState,
    captureFileSha256: recorded.fileSha256,
    captureManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    observerImplementationSha256: implementationSha256,
  });
  const bytes = Buffer.from(
    JSON.stringify({
      payload,
      sha256: createHash("sha256").update(payload).digest("hex"),
    }) + "\n",
  );
  if (bytes.length > 65_536) throw new Error("Runtime witness byte limit exceeded");
  const witnessPath = join(recorded.root, "runtime-witness.json");
  const handle = await open(witnessPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    ...result,
    root: recorded.root,
    completionState: recorded.completionState,
    runtimeWitnessPath: witnessPath,
    runtimeWitnessSha256: createHash("sha256").update(bytes).digest("hex"),
    runtime,
  };
}

/** Integrity and source binding only; capture integrity must be checked separately. */
export async function verifyObservedRuntime(directory: string) {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("Unsafe runtime witness root");
  const manifestBytes = await boundedEvidenceFile(join(directory, "manifest.json"));
  const bytes = await boundedEvidenceFile(join(directory, "runtime-witness.json"));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const digest = z.string().regex(/^[a-f0-9]{64}$/u);
  const envelope = z
    .object({ payload: z.string(), sha256: digest })
    .strict()
    .parse(JSON.parse(decoder.decode(bytes)) as unknown);
  if (createHash("sha256").update(envelope.payload).digest("hex") !== envelope.sha256)
    throw new Error("Runtime witness digest mismatch");
  const finite = z.number().finite().nonnegative();
  const report = z
    .object({
      schemaVersion: z.literal("flippars.runtime-witness/1"),
      scope: z.literal("RESEARCH_ONLY"),
      productionEligible: z.literal(false),
      prospectiveEvidenceEligible: z.literal(false),
      startedAt: z.string().datetime({ precision: 3 }),
      endedAt: z.string().datetime({ precision: 3 }),
      nodeVersion: z.string().max(80),
      resolutionMs: z.literal(20),
      nominalCallbackIntervalMs: z.literal(1_000),
      callbackIntervalsObserved: finite.int(),
      unobservedTerminalTailMs: finite,
      largestCallbackIntervals: z
        .array(
          z
            .object({
              from: z.string().datetime({ precision: 3 }),
              through: z.string().datetime({ precision: 3 }),
              elapsedMs: finite,
              delayBeyondNominalMs: finite,
            })
            .strict(),
        )
        .max(32),
      eventLoop: z
        .object({
          samples: finite.int(),
          minimumMs: finite.nullable(),
          maximumMs: finite.nullable(),
          meanMs: finite.nullable(),
          p99Ms: finite.nullable(),
        })
        .strict(),
      captureSessionId: z.string().uuid(),
      captureCompletionState: z.enum([
        "CAPTURED",
        "CAPTURED_DEGRADED_GUARDS",
        "INCOMPLETE",
      ]),
      captureFileSha256: digest,
      captureManifestSha256: digest,
      observerImplementationSha256: z
        .object({ "capture-observed-cli": digest, "runtime-witness": digest })
        .strict(),
      note: z.string(),
    })
    .strict()
    .parse(JSON.parse(envelope.payload) as unknown);
  const manifest = z
    .object({
      sessionId: z.string().uuid(),
      fileSha256: digest,
      completionState: z.enum(["CAPTURED", "CAPTURED_DEGRADED_GUARDS", "INCOMPLETE"]),
    })
    .parse(JSON.parse(decoder.decode(manifestBytes)) as unknown);
  if (
    report.captureManifestSha256 !==
      createHash("sha256").update(manifestBytes).digest("hex") ||
    report.captureSessionId !== manifest.sessionId ||
    report.captureFileSha256 !== manifest.fileSha256 ||
    report.captureCompletionState !== manifest.completionState
  )
    throw new Error("Runtime witness capture binding mismatch");
  return {
    integrityVerified: true,
    productionEligible: false,
    prospectiveEvidenceEligible: false,
    captureSessionId: report.captureSessionId,
    captureCompletionState: report.captureCompletionState,
    runtimeWitnessSha256: createHash("sha256").update(bytes).digest("hex"),
    eventLoop: report.eventLoop,
    largestCallbackIntervalMs: report.largestCallbackIntervals[0]?.elapsedMs ?? null,
    callbackIntervalsObserved: report.callbackIntervalsObserved,
    unobservedTerminalTailMs: report.unobservedTerminalTailMs,
    note: "Integrity and capture binding only; no cause, clock accuracy, network health, or model approval inferred.",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === "--verify") {
      process.stdout.write(
        JSON.stringify(await verifyObservedRuntime(args[1]!), null, 2) + "\n",
      );
      return;
    }
    if (args.length === 1 && args[0] === "--help") {
      process.stdout.write(
        "Usage: npm run capture:market:observed -- --output-parent <existing-external-directory> [--seconds 600] [--max-mib 256]\n",
      );
      return;
    }
    const flags = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (
        !key ||
        !["--output-parent", "--seconds", "--max-mib"].includes(key) ||
        !value ||
        flags.has(key)
      )
        throw new Error("Invalid observed capture arguments");
      flags.set(key, value);
    }
    const result = await runObservedCapture({
      outputParent: flags.get("--output-parent") ?? "",
      seconds: Number(flags.get("--seconds") ?? "600"),
      maxMiB: Number(flags.get("--max-mib") ?? "256"),
    });
    process.stdout.write(
      JSON.stringify(
        {
          root: result.root,
          completionState: result.completionState,
          runtimeWitnessPath: result.runtimeWitnessPath,
          witness: await verifyObservedRuntime(result.root),
        },
        null,
        2,
      ) + "\n",
    );
    if (result.completionState !== "CAPTURED") process.exitCode = 1;
  })().catch(() => {
    process.stderr.write(
      "Observed research capture failed. Preserve partial evidence; no model was enabled.\n",
    );
    process.exitCode = 1;
  });
}
