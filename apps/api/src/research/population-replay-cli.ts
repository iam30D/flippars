import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, open, readFile, mkdtemp } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { captureParent } from "./capture-cli.js";
import { verifyCapture } from "./capture-verifier.js";
import { readBoundedJsonl } from "./bounded-jsonl.js";
import { ResearchPopulationReplay } from "./population-replay.js";
import { ResearchTradeSchema } from "./trade-features.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceSchema = z
  .object({
    sessionId: z.string().uuid(),
    fileSha256: digest,
    manifestSha256: digest,
    captureCompletionState: z.enum(["CAPTURED", "CAPTURED_DEGRADED_GUARDS"]).optional(),
    unavailableGuards: z
      .array(z.enum(["coinbase", "kraken"]))
      .max(2)
      .optional(),
  })
  .strict();
const storedTradeSchema = ResearchTradeSchema.omit({ receivedAt: true }).strip();
const lineSchema = z.object({ payload: z.string() });
const payloadSchema = z.object({
  record: z.object({
    kind: z.string(),
    receivedAt: z.string(),
    trade: z.unknown().optional(),
  }),
});
const maxReportBytes = 32 * 1_048_576;
const maxCaptureBytes = 1_024 * 1_048_576;
type Report = ReturnType<ResearchPopulationReplay["finish"]>;
export const REPLAY_IMPLEMENTATION_MODULES = [
  "population-replay-cli",
  "population-replay",
  "trade-features",
  "bounded-jsonl",
  "capture-verifier",
  "capture-cli",
  "capture-domain",
  "capture-writer",
] as const;
const implementationSchema = z
  .record(z.enum(REPLAY_IMPLEMENTATION_MODULES), digest)
  .refine(
    (value) => Object.keys(value).length === REPLAY_IMPLEMENTATION_MODULES.length,
  );

async function implementationDigests() {
  const extension = extname(fileURLToPath(import.meta.url));
  const entries = await Promise.all(
    REPLAY_IMPLEMENTATION_MODULES.map(
      async (name) =>
        [
          name,
          createHash("sha256")
            .update(await readFile(new URL(`./${name}${extension}`, import.meta.url)))
            .digest("hex"),
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLimited(path: string, limit: number): Promise<Buffer> {
  const stream = createReadStream(path, { highWaterMark: 65_536 });
  const closed = new Promise<void>((resolveClosed) =>
    stream.once("close", resolveClosed),
  );
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > limit) throw new Error("Replay evidence read limit exceeded");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy();
    await closed;
  }
}

function repositoryRoot() {
  let path = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(path, "AGENTS.md")) && existsSync(join(path, "package.json")))
      return path;
    path = dirname(path);
  }
  throw new Error("Repository root not found");
}

/** Manifest is written last; a partial directory is never complete evidence. */
export async function writeReplayEvidence(
  parent: string,
  repository: string,
  report: Report,
  source: z.infer<typeof sourceSchema>,
  implementationSha256: Record<string, string>,
): Promise<string> {
  sourceSchema.parse(source);
  implementationSchema.parse(implementationSha256);
  const safeParent = captureParent(parent, repository);
  const bytes = Buffer.from(JSON.stringify(report) + "\n");
  if (bytes.length > maxReportBytes)
    throw new Error("Replay report byte limit exceeded");
  const directory = await mkdtemp(join(safeParent, "replay-"));
  await writeExclusive(join(directory, "report.json"), bytes);
  const manifest = {
    schemaVersion: "flippars.research-replay-manifest/1",
    completionState: "COMPLETE",
    scope: "RETROSPECTIVE_RESEARCH_ONLY",
    productionEligible: false,
    prospectiveEvidenceEligible: false,
    source,
    implementationSha256,
    reportBytes: bytes.length,
    reportSha256: createHash("sha256").update(bytes).digest("hex"),
    decisionCount: report.decisions.length,
    outcomeCount: report.outcomes.length,
  };
  await writeExclusive(
    join(directory, "manifest.json"),
    Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
  );
  return directory;
}

export async function replayCapture(directory: string) {
  const implementationSha256 = await implementationDigests();
  const verification = await verifyCapture(directory);
  const startedAt = z
    .string()
    .datetime({ precision: 3 })
    .parse(verification["startedAt"]);
  const endedAt = z.string().datetime({ precision: 3 }).parse(verification["endedAt"]);
  const replay = new ResearchPopulationReplay(startedAt, endedAt);
  const evidence = await readBoundedJsonl(
    join(resolve(directory), "events.jsonl"),
    maxCaptureBytes,
    (line) => {
      const envelope = lineSchema.parse(JSON.parse(line) as unknown);
      const { record } = payloadSchema.parse(JSON.parse(envelope.payload) as unknown);
      if (record.kind === "TRADE")
        replay.ingest({
          ...storedTradeSchema.parse(record.trade),
          receivedAt: record.receivedAt,
        });
    },
  );
  if (
    evidence.sha256 !== verification["fileSha256"] ||
    evidence.bytes !== verification["bytes"]
  )
    throw new Error("Capture changed after verification");
  if (
    JSON.stringify(await implementationDigests()) !==
    JSON.stringify(implementationSha256)
  )
    throw new Error("Replay implementation changed during processing");
  return {
    report: replay.finish(),
    source: sourceSchema.parse({
      sessionId: verification["sessionId"],
      fileSha256: verification["fileSha256"],
      manifestSha256: verification["manifestSha256"],
      captureCompletionState: verification["captureCompletionState"],
      unavailableGuards: verification["unavailableGuards"],
    }),
    implementationSha256,
  };
}

/** Integrity-only review; hashes do not establish model or prospective validity. */
export async function verifyReplayEvidence(directory: string) {
  const manifestSchema = z
    .object({
      schemaVersion: z.literal("flippars.research-replay-manifest/1"),
      completionState: z.literal("COMPLETE"),
      scope: z.literal("RETROSPECTIVE_RESEARCH_ONLY"),
      productionEligible: z.literal(false),
      prospectiveEvidenceEligible: z.literal(false),
      source: sourceSchema,
      implementationSha256: implementationSchema,
      reportBytes: z.number().int().positive().max(maxReportBytes),
      reportSha256: digest,
      decisionCount: z.number().int().nonnegative().max(2_000),
      outcomeCount: z.number().int().nonnegative().max(192),
    })
    .strict();
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("Invalid replay directory");
  const manifestPath = join(directory, "manifest.json");
  const reportPath = join(directory, "report.json");
  const manifestInfo = await lstat(manifestPath);
  const reportInfo = await lstat(reportPath);
  if (
    !manifestInfo.isFile() ||
    manifestInfo.isSymbolicLink() ||
    manifestInfo.size > 65_536 ||
    !reportInfo.isFile() ||
    reportInfo.isSymbolicLink() ||
    reportInfo.size > maxReportBytes
  )
    throw new Error("Invalid replay evidence files");
  const manifest = manifestSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readLimited(manifestPath, 65_536),
      ),
    ) as unknown,
  );
  const bytes = await readLimited(reportPath, maxReportBytes);
  if (
    bytes.length !== manifest.reportBytes ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.reportSha256
  )
    throw new Error("Replay report integrity mismatch");
  const report = z
    .object({
      schemaVersion: z.literal("flippars.research-population-replay/1"),
      scope: z.literal("RETROSPECTIVE_RESEARCH_ONLY"),
      productionEligible: z.literal(false),
      prospectiveEvidenceEligible: z.literal(false),
      modelLoaded: z.literal(false),
      guardVerdict: z.literal("UNASSESSED"),
      startedAt: z.string().datetime({ precision: 3 }),
      observedThrough: z.string().datetime({ precision: 3 }),
      tradeCount: z.number().int().positive(),
      decisions: z.array(z.unknown()).max(2_000),
      outcomes: z.array(z.unknown()).max(192),
      warning: z.string(),
    })
    .strict()
    .parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    );
  if (
    report.decisions.length !== manifest.decisionCount ||
    report.outcomes.length !== manifest.outcomeCount
  )
    throw new Error("Replay population count mismatch");
  return { integrityVerified: true, ...manifest };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  (async () => {
    if (process.argv[2] === "--verify" && process.argv.length === 4) {
      process.stdout.write(
        JSON.stringify(await verifyReplayEvidence(process.argv[3]!), null, 2) + "\n",
      );
      return;
    }
    if (process.argv.length !== 4)
      throw new Error("Expected capture directory and existing external output parent");
    const result = await replayCapture(process.argv[2]!);
    const repository = repositoryRoot();
    const directory = await writeReplayEvidence(
      process.argv[3]!,
      repository,
      result.report,
      result.source,
      result.implementationSha256,
    );
    process.stdout.write(
      JSON.stringify(
        { directory, ...(await verifyReplayEvidence(directory)) },
        null,
        2,
      ) + "\n",
    );
  })().catch(() => {
    process.stderr.write(
      "Population replay failed. Preserve partial evidence; no model was enabled.\n",
    );
    process.exitCode = 1;
  });
}
