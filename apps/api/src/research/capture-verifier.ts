import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { CAPTURE_SOURCES, projectPacket, TradeContinuity } from "./capture-domain.js";
import type { CaptureSource } from "./capture-domain.js";
import { CaptureClockContinuity } from "./capture-clock.js";
import {
  LONG_CAPTURE_MODULES,
  LongCaptureCodeSchema,
  LongCaptureSettingsSchema,
} from "./capture-revisions.js";
import {
  ISOLATED_CAPTURE_MODULES,
  IsolatedCaptureCodeSchema,
  IsolatedCaptureSettingsSchema,
} from "./capture-isolation-profile.js";

const count = z.number().int().safe().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ precision: 3 });
const settingsSchema = z
  .object({
    outputParent: z.string().min(1),
    seconds: count.min(10).max(3_600),
    maxMiB: count.min(1).max(1_024),
  })
  .strict();
const endpoints = [
  {
    source: "binance",
    url: "wss://data-stream.binance.vision/ws/btcusdt@trade?timeUnit=MICROSECOND",
  },
  {
    source: "coinbase",
    url: "wss://ws-feed.exchange.coinbase.com",
    subscription: {
      type: "subscribe",
      product_ids: ["BTC-USD", "USDT-USD"],
      channels: ["ticker", "heartbeat"],
    },
  },
  {
    source: "kraken",
    url: "wss://ws.kraken.com/v2",
    subscription: {
      method: "subscribe",
      params: {
        channel: "ticker",
        symbol: ["BTC/USD", "USDT/USD"],
        snapshot: true,
        event_trigger: "bbo",
      },
    },
  },
];
const legacyManifestSchema = z
  .object({
    schemaVersion: z.literal("flippars.market-capture-manifest/1"),
    sessionId: z.string().uuid(),
    startedAt: timestamp,
    endedAt: timestamp,
    scope: z.literal("RESEARCH_CAPTURE_ONLY"),
    completionState: z.literal("CAPTURED"),
    failure: z.null(),
    productionEligible: z.literal(false),
    guardVerdict: z.literal("UNASSESSED"),
    settings: settingsSchema,
    endpoints: z.unknown(),
    dataPacketCounts: z
      .object({
        binance: count.positive(),
        coinbase: count.positive(),
        kraken: count.positive(),
      })
      .strict(),
    bytes: count.positive().max(1_073_741_824),
    records: count.min(8),
    finalSha256: digest,
    fileSha256: digest,
    codeSha256: z
      .object({
        "capture-cli": digest,
        "capture-domain": digest,
        "capture-writer": digest,
      })
      .strict(),
    limitations: z.array(z.string().min(1)).min(1).max(20),
  })
  .strict();
const manifestSchema = z.discriminatedUnion("schemaVersion", [
  legacyManifestSchema,
  legacyManifestSchema.extend({
    schemaVersion: z.literal("flippars.market-capture-manifest/2"),
    settings: LongCaptureSettingsSchema,
    codeSha256: LongCaptureCodeSchema,
  }),
  legacyManifestSchema.extend({
    schemaVersion: z.literal("flippars.market-capture-manifest/3"),
    completionState: z.enum(["CAPTURED", "CAPTURED_DEGRADED_GUARDS"]),
    settings: IsolatedCaptureSettingsSchema,
    dataPacketCounts: z
      .object({ binance: count.positive(), coinbase: count, kraken: count })
      .strict(),
    unavailableGuards: z.array(z.enum(["coinbase", "kraken"])).max(2),
    records: count.min(4),
    codeSha256: IsolatedCaptureCodeSchema,
  }),
]);
const common = {
  sessionId: z.string().uuid(),
  receivedAt: timestamp,
  receivedMonotonicNs: z.string().regex(/^(?:0|[1-9]\d{0,19})$/u),
};
const source = z.enum(CAPTURE_SOURCES);
const recordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("SESSION_START"),
      collectorRevision: z
        .enum([
          "flippars.market-capture-manifest/2",
          "flippars.market-capture-manifest/3",
        ])
        .optional(),
      endpoints: z.unknown(),
      settings: z.union([settingsSchema, LongCaptureSettingsSchema]),
      scope: z.literal("RESEARCH_CAPTURE_ONLY"),
    })
    .strict(),
  z.object({ ...common, kind: z.literal("CONNECTED"), source }).strict(),
  z
    .object({
      ...common,
      kind: z.literal("GUARD_UNAVAILABLE"),
      source: z.enum(["coinbase", "kraken"]),
      reason: z.enum(["DISCONNECTED", "CONNECTION_ERROR", "DATA_TIMEOUT"]),
      closeCode: z.number().int().min(0).max(4_999).nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.enum(["TRADE", "GUARD_INPUT", "CONTROL", "UNKNOWN"]),
      source,
      raw: z.string().max(65_536),
      eventId: z.string().min(1).max(200),
      trade: z.unknown(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("SESSION_END"),
      reason: z.literal("DURATION_REACHED"),
    })
    .strict(),
]);
const payloadSchema = z
  .object({
    schemaVersion: z.literal("flippars.market-capture/1"),
    sequence: count.positive(),
    previousSha256: digest,
    productionEligible: z.literal(false),
    guardVerdict: z.literal("UNASSESSED"),
    record: recordSchema,
  })
  .strict();
const envelopeSchema = z.object({ payload: z.string(), sha256: digest }).strict();

async function regularFile(path: string, maximum: number) {
  const info = await lstat(path, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > BigInt(maximum) ||
    info.size === 0n
  ) {
    throw new Error("Capture file missing, unsafe, empty, or oversized");
  }
  return info;
}

/** Read-only integrity and semantic verification. Never an approval or healthy-data verdict. */
export async function verifyCapture(
  directory: string,
): Promise<Record<string, unknown>> {
  const root = resolve(directory);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Unsafe capture root");
  const manifestPath = join(root, "manifest.json");
  const eventPath = join(root, "events.jsonl");
  const manifestInfo = await regularFile(manifestPath, 65_536);
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > 65_536) throw new Error("Oversized manifest");
  const manifest = manifestSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
    ) as unknown,
  );
  if (!isDeepStrictEqual(manifest.endpoints, endpoints))
    throw new Error("Unsupported endpoint contract");
  if (Date.parse(manifest.endedAt) < Date.parse(manifest.startedAt))
    throw new Error("Manifest clock regression");
  const modulePath = fileURLToPath(import.meta.url);
  const isolated = manifest.schemaVersion === "flippars.market-capture-manifest/3";
  const modules = isolated
    ? ISOLATED_CAPTURE_MODULES
    : manifest.schemaVersion === "flippars.market-capture-manifest/2"
      ? LONG_CAPTURE_MODULES
      : (["capture-cli", "capture-domain", "capture-writer"] as const);
  const recordedModules: Record<string, string> = manifest.codeSha256;
  for (const name of modules) {
    const bytes = await readFile(join(dirname(modulePath), name + extname(modulePath)));
    if (createHash("sha256").update(bytes).digest("hex") !== recordedModules[name]) {
      throw new Error(
        "Recorded collector code does not match this verifier's collector modules",
      );
    }
  }
  const eventsInfo = await regularFile(eventPath, manifest.settings.maxMiB * 1_048_576);
  if (eventsInfo.size !== BigInt(manifest.bytes))
    throw new Error("Capture byte length mismatch");
  const fileHash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = Buffer.alloc(0);
  let bytesRead = 0;
  let records = 0;
  let previous = "0".repeat(64);
  let previousMono = 0n;
  let previousWall = manifest.startedAt;
  let ended = false;
  const connected = new Set<CaptureSource>();
  const unavailableGuards = new Set<CaptureSource>();
  const continuity = new TradeContinuity();
  const dataCounts = { binance: 0, coinbase: 0, kraken: 0 };
  const instruments: Record<CaptureSource, Set<string>> = {
    binance: new Set(),
    coinbase: new Set(),
    kraken: new Set(),
  };
  let firstTradeAt: string | null = null;
  let lastTradeAt: string | null = null;
  let lastTradeReceivedAt: string | null = null;
  const clock =
    manifest.schemaVersion !== "flippars.market-capture-manifest/1"
      ? new CaptureClockContinuity(manifest.startedAt)
      : null;
  const lastDataMono = { binance: 0n, coinbase: 0n, kraken: 0n };
  const acceptLine = (line: Buffer): void => {
    if (line.length === 0 || line.length > 524_288 || ended)
      throw new Error("Invalid capture line or record after session end");
    const envelope = envelopeSchema.parse(JSON.parse(decoder.decode(line)) as unknown);
    const sha = createHash("sha256").update(envelope.payload).digest("hex");
    if (sha !== envelope.sha256) throw new Error("Capture record digest mismatch");
    const payload = payloadSchema.parse(JSON.parse(envelope.payload) as unknown);
    if (payload.sequence !== records + 1 || payload.previousSha256 !== previous)
      throw new Error("Capture sequence or chain mismatch");
    const record = payload.record;
    clock?.accept(record.receivedAt, record.receivedMonotonicNs);
    const mono = BigInt(record.receivedMonotonicNs);
    if (
      clock &&
      (isolated ? (["binance"] as const) : CAPTURE_SOURCES).some(
        (name) => mono - lastDataMono[name] > 31_000_000_000n,
      )
    )
      throw new Error("Capture source liveness discontinuity");
    if (
      record.sessionId !== manifest.sessionId ||
      mono < previousMono ||
      record.receivedAt < previousWall ||
      record.receivedAt > manifest.endedAt
    ) {
      throw new Error("Capture identity or clock ordering mismatch");
    }
    if (record.kind === "SESSION_START") {
      if (
        records !== 0 ||
        record.collectorRevision !==
          (manifest.schemaVersion !== "flippars.market-capture-manifest/1"
            ? manifest.schemaVersion
            : undefined) ||
        !isDeepStrictEqual(record.settings, manifest.settings) ||
        !isDeepStrictEqual(record.endpoints, endpoints)
      )
        throw new Error("Invalid session start");
    } else if (records === 0) throw new Error("Missing session start");
    else if (record.kind === "CONNECTED") {
      if (connected.has(record.source) || unavailableGuards.has(record.source))
        throw new Error("Unexpected reconnect");
      connected.add(record.source);
    } else if (record.kind === "GUARD_UNAVAILABLE") {
      if (!isolated || unavailableGuards.has(record.source))
        throw new Error("Unexpected guard lifecycle record");
      unavailableGuards.add(record.source);
    } else if (record.kind === "SESSION_END") {
      if (
        mono < BigInt(manifest.settings.seconds) * 1_000_000_000n ||
        (isolated ? !connected.has("binance") : connected.size !== 3)
      )
        throw new Error("Incomplete duration or connections");
      ended = true;
    } else if ("source" in record && "raw" in record) {
      if (!connected.has(record.source) || unavailableGuards.has(record.source))
        throw new Error("Data before connection or after guard retirement");
      const projected = projectPacket(record.source, record.raw);
      if (
        projected.kind !== record.kind ||
        projected.eventId !== record.eventId ||
        !isDeepStrictEqual(projected.trade, record.trade)
      )
        throw new Error("Stored projection disagrees with raw packet");
      if (projected.kind === "TRADE" || projected.kind === "GUARD_INPUT") {
        dataCounts[record.source]++;
        lastDataMono[record.source] = mono;
      }
      if (projected.trade) {
        continuity.accept(projected.trade);
        firstTradeAt ??= projected.trade.eventAt;
        lastTradeAt = projected.trade.eventAt;
        lastTradeReceivedAt = record.receivedAt;
        instruments.binance.add("BTCUSDT");
      } else if (projected.kind === "GUARD_INPUT") {
        const raw = JSON.parse(record.raw) as Record<string, unknown>;
        if (record.source === "coinbase")
          instruments.coinbase.add(String(raw["product_id"]));
        if (record.source === "kraken") {
          for (const item of raw["data"] as Array<{ symbol: string }>)
            instruments.kraken.add(item.symbol);
        }
      }
    }
    previous = envelope.sha256;
    previousMono = mono;
    previousWall = record.receivedAt;
    records++;
  };
  const stream = createReadStream(eventPath, { highWaterMark: 65_536 });
  const closed = new Promise<void>((resolveClosed) =>
    stream.once("close", resolveClosed),
  );
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytesRead += buffer.length;
      if (bytesRead > manifest.bytes)
        throw new Error("Capture grew during verification");
      fileHash.update(buffer);
      pending = Buffer.concat([pending, buffer]);
      let newline = pending.indexOf(10);
      while (newline !== -1) {
        acceptLine(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }
      if (pending.length > 524_288)
        throw new Error("Capture line exceeds bounded parser limit");
    }
  } finally {
    stream.destroy();
    await closed;
  }
  if (
    pending.length !== 0 ||
    !ended ||
    records !== manifest.records ||
    bytesRead !== manifest.bytes ||
    previous !== manifest.finalSha256 ||
    fileHash.digest("hex") !== manifest.fileSha256 ||
    !isDeepStrictEqual(dataCounts, manifest.dataPacketCounts)
  ) {
    throw new Error("Capture terminal evidence mismatch");
  }
  if (manifest.schemaVersion === "flippars.market-capture-manifest/3") {
    const expected = (["coinbase", "kraken"] as const).filter(
      (name) => unavailableGuards.has(name) || !dataCounts[name],
    );
    if (
      !isDeepStrictEqual(expected, manifest.unavailableGuards) ||
      manifest.completionState !==
        (expected.length ? "CAPTURED_DEGRADED_GUARDS" : "CAPTURED")
    )
      throw new Error("Guard degradation was hidden or misreported");
  }
  for (const [path, before] of [
    [eventPath, eventsInfo],
    [manifestPath, manifestInfo],
  ] as const) {
    const after = await lstat(path, { bigint: true });
    if (
      !after.isFile() ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("Capture changed during verification");
  }
  return {
    schemaVersion: "flippars.market-capture-verification/1",
    verified: true,
    sessionId: manifest.sessionId,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    captureRevision: manifest.schemaVersion,
    captureCompletionState: manifest.completionState,
    unavailableGuards:
      manifest.schemaVersion === "flippars.market-capture-manifest/3"
        ? manifest.unavailableGuards
        : [],
    productionEligible: false,
    guardVerdict: "UNASSESSED",
    records,
    bytes: bytesRead,
    dataPacketCounts: dataCounts,
    observedInstruments: Object.fromEntries(
      CAPTURE_SOURCES.map((name) => [name, [...instruments[name]].sort()]),
    ),
    firstTradeAt,
    lastTradeAt,
    lastTradeReceivedAt,
    fileSha256: manifest.fileSha256,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    warning:
      "Verified research capture integrity, not feature parity, healthy market data, model performance, or approval.",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  (async () => {
    if (process.argv.length !== 3) throw new Error("Expected capture directory");
    process.stdout.write(
      JSON.stringify(await verifyCapture(process.argv[2]!), null, 2) + "\n",
    );
  })().catch(() => {
    process.stderr.write(
      "Capture verification failed. Preserve the session; do not consume it as verified research data.\n",
    );
    process.exitCode = 1;
  });
}
