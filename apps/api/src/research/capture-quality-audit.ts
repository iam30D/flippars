import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readBoundedJsonl } from "./bounded-jsonl.js";
import { verifyCapture } from "./capture-verifier.js";
import { CAPTURE_SOURCES } from "./capture-domain.js";

const stamp = z.string().datetime({ precision: 3 });
const recordSchema = z.object({
  kind: z.enum([
    "SESSION_START",
    "CONNECTED",
    "SESSION_END",
    "TRADE",
    "GUARD_INPUT",
    "CONTROL",
    "UNKNOWN",
    "GUARD_UNAVAILABLE",
  ]),
  receivedAt: stamp,
  receivedMonotonicNs: z.string().regex(/^(?:0|[1-9]\d{0,19})$/u),
  source: z.enum(CAPTURE_SOURCES).optional(),
  raw: z.string().max(65_536).optional(),
  trade: z.unknown().optional(),
});
const tradeSchema = z.object({
  eventAt: z.string().datetime({ precision: 6 }),
  publishedAt: z.string().datetime({ precision: 6 }),
});
const instruments = [
  "binance:BTCUSDT",
  "coinbase:BTC-USD",
  "coinbase:USDT-USD",
  "kraken:BTC/USD",
  "kraken:USDT/USD",
] as const;
type Timeline = {
  count: number;
  firstAt: string | null;
  firstMono: bigint | null;
  lastAt: string | null;
  lastMono: bigint | null;
  maximumDataGapMs: number;
  longestGap: { from: string; through: string } | null;
};
const timeline = (): Timeline => ({
  count: 0,
  firstAt: null,
  firstMono: null,
  lastAt: null,
  lastMono: null,
  maximumDataGapMs: 0,
  longestGap: null,
});
function canonicalMs(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value)
    throw new Error("Invalid timestamp");
  return result;
}
function micros(value: string): bigint {
  return (
    BigInt(canonicalMs(value.slice(0, 23) + "Z")) * 1_000n + BigInt(value.slice(23, 26))
  );
}

/** Fixed diagnostic bands, not model thresholds or a transport-latency estimate. */
class DifferenceSummary {
  private count = 0;
  private minimum = Infinity;
  private maximum = -Infinity;
  private negative = 0;
  private overOneSecond = 0;
  private overFiveSeconds = 0;
  private readonly bins = [0, 0, 0, 0, 0, 0];

  accept(differenceMicros: bigint): void {
    const value = Number(differenceMicros) / 1_000;
    this.count++;
    this.minimum = Math.min(this.minimum, value);
    this.maximum = Math.max(this.maximum, value);
    if (differenceMicros < -1_000n) this.negative++;
    if (differenceMicros > 1_000_000n) this.overOneSecond++;
    if (differenceMicros > 5_000_000n) this.overFiveSeconds++;
    const index =
      value < 0
        ? 0
        : value <= 100
          ? 1
          : value <= 500
            ? 2
            : value <= 1_000
              ? 3
              : value <= 5_000
                ? 4
                : 5;
    this.bins[index] = this.bins[index]! + 1;
  }

  snapshot() {
    return {
      count: this.count,
      minimumMs: this.count ? this.minimum : null,
      maximumMs: this.count ? this.maximum : null,
      moreThanOneMsNegativeCount: this.negative,
      overOneSecondCount: this.overOneSecond,
      overFiveSecondsCount: this.overFiveSeconds,
      bands: {
        belowZero: this.bins[0],
        zeroThrough100Ms: this.bins[1],
        over100Through500Ms: this.bins[2],
        over500Through1000Ms: this.bins[3],
        over1000Through5000Ms: this.bins[4],
        over5000Ms: this.bins[5],
      },
    };
  }
}

/** Coarse receipt diagnostics; never supplies a healthy-data verdict. */
export class ResearchCaptureQuality {
  private readonly sources = new Map(
    CAPTURE_SOURCES.map((source) => [source, timeline()]),
  );
  private readonly observedInstruments = new Map<string, Timeline>(
    instruments.map((name) => [name, timeline()]),
  );
  private readonly receiptMinusEvent = new DifferenceSummary();
  private readonly receiptMinusPublication = new DifferenceSummary();
  private readonly publicationMinusEvent = new DifferenceSummary();
  private previousMono = 0n;
  private previousWall = "";
  private terminalMono: bigint | null = null;
  private failed = false;
  private started = false;

  ingest(input: unknown): void {
    if (this.failed || this.terminalMono !== null)
      throw new Error("Quality audit is no longer writable");
    try {
      const record = recordSchema.parse(input);
      if (
        (!this.started && record.kind !== "SESSION_START") ||
        (this.started && record.kind === "SESSION_START")
      )
        throw new Error("Invalid quality session boundary");
      this.started = true;
      canonicalMs(record.receivedAt);
      const mono = BigInt(record.receivedMonotonicNs);
      if (mono < this.previousMono || record.receivedAt < this.previousWall)
        throw new Error("Quality audit clock regression");
      this.previousMono = mono;
      this.previousWall = record.receivedAt;
      if (record.kind === "SESSION_END") {
        this.terminalMono = mono;
        return;
      }
      if (record.kind !== "TRADE" && record.kind !== "GUARD_INPUT") return;
      if (!record.source) throw new Error("Missing data source");
      const names: string[] = [];
      if (record.kind === "TRADE") {
        if (record.source !== "binance") throw new Error("Wrong trade source");
        const trade = tradeSchema.parse(record.trade);
        const received = BigInt(canonicalMs(record.receivedAt)) * 1_000n;
        const event = micros(trade.eventAt);
        const published = micros(trade.publishedAt);
        this.receiptMinusEvent.accept(received - event);
        this.receiptMinusPublication.accept(received - published);
        this.publicationMinusEvent.accept(published - event);
        names.push("binance:BTCUSDT");
      } else {
        const raw: unknown = JSON.parse(z.string().parse(record.raw));
        if (record.source === "coinbase") {
          const value = z
            .object({
              type: z.literal("ticker"),
              product_id: z.enum(["BTC-USD", "USDT-USD"]),
            })
            .parse(raw);
          names.push(`coinbase:${value.product_id}`);
        } else if (record.source === "kraken") {
          const value = z
            .object({
              channel: z.literal("ticker"),
              data: z
                .array(z.object({ symbol: z.enum(["BTC/USD", "USDT/USD"]) }))
                .min(1)
                .max(2),
            })
            .parse(raw);
          for (const item of value.data) names.push(`kraken:${item.symbol}`);
        } else throw new Error("Wrong guard source");
      }
      const timelines = [this.sources.get(record.source)!];
      for (const name of new Set(names))
        timelines.push(this.observedInstruments.get(name)!);
      for (const state of timelines) {
        if (state.lastMono !== null) {
          const gap = Number(mono - state.lastMono) / 1_000_000;
          if (gap > state.maximumDataGapMs) {
            state.maximumDataGapMs = gap;
            state.longestGap = { from: state.lastAt!, through: record.receivedAt };
          }
        }
        state.count++;
        state.firstAt ??= record.receivedAt;
        state.firstMono ??= mono;
        state.lastAt = record.receivedAt;
        state.lastMono = mono;
      }
    } catch {
      this.failed = true;
      throw new Error("Invalid quality audit input");
    }
  }

  finish() {
    if (this.failed || this.terminalMono === null)
      throw new Error("Quality audit incomplete");
    const describe = (state: Timeline) => ({
      count: state.count,
      firstAt: state.firstAt,
      lastAt: state.lastAt,
      initialDataWaitMs:
        state.firstMono === null ? null : Number(state.firstMono) / 1_000_000,
      terminalDataSilenceMs:
        state.lastMono === null
          ? null
          : Number(this.terminalMono! - state.lastMono) / 1_000_000,
      maximumDataGapMs: state.maximumDataGapMs,
      longestGap: state.longestGap ? { ...state.longestGap } : null,
    });
    return {
      schemaVersion: "flippars.capture-quality-audit/1",
      scope: "RESEARCH_ONLY",
      productionEligible: false,
      modelLoaded: false,
      guardVerdict: "UNASSESSED",
      clockVerdict: "UNASSESSED",
      sources: Object.fromEntries(
        [...this.sources].map(([key, value]) => [key, describe(value)]),
      ),
      instruments: Object.fromEntries(
        [...this.observedInstruments].map(([key, value]) => [key, describe(value)]),
      ),
      receiptMinusEvent: this.receiptMinusEvent.snapshot(),
      receiptMinusPublication: this.receiptMinusPublication.snapshot(),
      publicationMinusEvent: this.publicationMinusEvent.snapshot(),
      note: "Timing differences compare clocks; they are not measured transport latency or proof of synchronization. Source activity cannot substitute for each instrument. Gaps identify observations, not their cause or a healthy-data verdict.",
    };
  }
}

export async function auditCaptureQuality(directory: string) {
  const verification = await verifyCapture(directory);
  const audit = new ResearchCaptureQuality();
  const evidence = await readBoundedJsonl(
    join(resolve(directory), "events.jsonl"),
    1_073_741_824,
    (line) => {
      const envelope = z
        .object({ payload: z.string() })
        .parse(JSON.parse(line) as unknown);
      const payload = z
        .object({ record: z.unknown() })
        .parse(JSON.parse(envelope.payload) as unknown);
      audit.ingest(payload.record);
    },
  );
  if (
    evidence.sha256 !== verification["fileSha256"] ||
    evidence.bytes !== verification["bytes"]
  )
    throw new Error("Capture changed after verification");
  return {
    ...audit.finish(),
    captureSessionId: verification["sessionId"],
    captureFileSha256: evidence.sha256,
    captureManifestSha256: verification["manifestSha256"],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  (async () => {
    if (process.argv.length !== 3) throw new Error("Expected capture directory");
    process.stdout.write(
      JSON.stringify(await auditCaptureQuality(process.argv[2]!), null, 2) + "\n",
    );
  })().catch(() => {
    process.stderr.write(
      "Capture quality audit failed. No model or data-health approval was produced.\n",
    );
    process.exitCode = 1;
  });
}
