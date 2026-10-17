import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SignalType } from "@flippars/contracts";
import { z } from "zod";

import { verifyCapture } from "./capture-verifier.js";
import { readBoundedJsonl } from "./bounded-jsonl.js";
import {
  buildResearchDecision,
  buildResearchOutcome,
  ResearchFeatureStream,
  ResearchOutcomeStream,
  ResearchTradeSchema,
} from "./trade-features.js";
import type { ResearchTrade } from "./trade-features.js";

const maximumBytes = 1_024 * 1_048_576;
const envelopeSchema = z.object({ payload: z.string() });
const payloadSchema = z.object({
  record: z.object({
    kind: z.string(),
    receivedAt: z.string(),
    trade: z.unknown().optional(),
  }),
});
const storedTradeSchema = ResearchTradeSchema.omit({ receivedAt: true }).strip();

const targets: SignalType[] = [
  "FIVE_MINUTE_EARLY_DIRECTION",
  "FIVE_MINUTE_REVERSAL",
  "FIFTEEN_MINUTE_REVERSAL",
];

function selection(signalType: SignalType, observedThrough: string) {
  const observedMs = Date.parse(observedThrough);
  const durationMs = signalType === "FIFTEEN_MINUTE_REVERSAL" ? 900_000 : 300_000;
  const startMs = Math.floor(observedMs / durationMs) * durationMs;
  const elapsed = Math.floor((observedMs - startMs) / 15_000) * 15;
  const offset = Math.min(
    elapsed,
    signalType === "FIVE_MINUTE_EARLY_DIRECTION"
      ? 45
      : signalType === "FIFTEEN_MINUTE_REVERSAL"
        ? 870
        : 285,
  );
  return {
    signalType,
    windowStart: new Date(startMs).toISOString(),
    decisionAt: new Date(startMs + offset * 1_000).toISOString(),
    previousWindow: new Date(startMs - durationMs).toISOString(),
  };
}

class ClockDiagnostic {
  minimumReceiveMinusEventMs = Infinity;
  maximumReceiveMinusEventMs = -Infinity;
  moreThanOneMillisecondNegativeCount = 0;

  ingest(trade: ResearchTrade): void {
    const eventMicros =
      BigInt(Date.parse(trade.eventAt.slice(0, 23) + "Z")) * 1_000n +
      BigInt(trade.eventAt.slice(23, 26));
    const difference = BigInt(Date.parse(trade.receivedAt)) * 1_000n - eventMicros;
    this.minimumReceiveMinusEventMs = Math.min(
      this.minimumReceiveMinusEventMs,
      Number(difference) / 1_000,
    );
    this.maximumReceiveMinusEventMs = Math.max(
      this.maximumReceiveMinusEventMs,
      Number(difference) / 1_000,
    );
    if (difference < -1_000n) this.moreThanOneMillisecondNegativeCount++;
  }

  snapshot() {
    return {
      minimumReceiveMinusEventMs: this.minimumReceiveMinusEventMs,
      maximumReceiveMinusEventMs: this.maximumReceiveMinusEventMs,
      moreThanOneMillisecondNegativeCount: this.moreThanOneMillisecondNegativeCount,
      clockVerdict: "UNASSESSED",
      note: "Differences compare two clocks and timestamp precisions. They are not transport-latency measurements or proof of synchronization.",
    };
  }
}

function report(
  observedThrough: string,
  tradeCount: number,
  clock: ClockDiagnostic,
  decisions: unknown[],
) {
  return {
    schemaVersion: "flippars.capture-decision-audit/1",
    scope: "RESEARCH_ONLY",
    productionEligible: false,
    modelLoaded: false,
    guardVerdict: "UNASSESSED",
    observedThrough,
    tradeCount,
    eventReceiveClockDiagnostic: clock.snapshot(),
    decisions,
    warning:
      "Numerical research features/outcomes only. No probability, prediction, public signal, or model approval is produced.",
  };
}

export function auditResearchTrades(trades: ResearchTrade[]): Record<string, unknown> {
  const observedThrough = trades.at(-1)?.receivedAt;
  if (!observedThrough) throw new Error("No captured trades");
  const clock = new ClockDiagnostic();
  for (const trade of trades) clock.ingest(trade);
  const decisions = targets.map((signalType) => {
    const { windowStart, decisionAt, previousWindow } = selection(
      signalType,
      observedThrough,
    );
    return {
      signalType,
      windowStart,
      decisionAt,
      decision: buildResearchDecision({ signalType, windowStart, decisionAt, trades }),
      previousWindowOutcome: buildResearchOutcome({
        signalType,
        windowStart: previousWindow,
        observedThrough,
        trades,
      }),
    };
  });
  return report(observedThrough, trades.length, clock, decisions);
}

/** One replay for fixed end-of-capture cutoffs; not a live serving interface. */
export class ResearchCaptureReplay {
  private readonly clock = new ClockDiagnostic();
  private count = 0;
  private failed = false;
  private lastReceipt: string | undefined;
  private readonly states;

  constructor(private readonly observedThrough: string) {
    z.string().datetime({ precision: 3 }).parse(observedThrough);
    this.states = targets.map((signalType) => {
      const chosen = selection(signalType, observedThrough);
      return {
        chosen,
        features: new ResearchFeatureStream(signalType),
        outcome: new ResearchOutcomeStream({
          signalType,
          windowStart: chosen.previousWindow,
          observedThrough,
        }),
        decision: undefined as
          ReturnType<ResearchFeatureStream["snapshot"]> | undefined,
      };
    });
  }

  ingest(input: unknown): void {
    if (this.failed) throw new Error("Replay failed; start a new replay");
    try {
      const trade = ResearchTradeSchema.parse(input);
      if (
        trade.receivedAt > this.observedThrough ||
        (this.lastReceipt && trade.receivedAt < this.lastReceipt)
      )
        throw new Error("Replay receipt order or terminal cutoff mismatch");
      this.lastReceipt = trade.receivedAt;
      this.count++;
      this.clock.ingest(trade);
      for (const state of this.states) {
        if (!state.decision && trade.receivedAt >= state.chosen.decisionAt)
          state.decision = state.features.snapshot(state.chosen);
        if (!state.decision) state.features.ingest(trade);
        state.outcome.ingest(trade);
      }
    } catch {
      this.failed = true;
      throw new Error("Invalid or discontinuous replay input");
    }
  }

  snapshot(): Record<string, unknown> {
    if (this.failed || !this.count || this.lastReceipt !== this.observedThrough)
      throw new Error("Replay terminal trade receipt mismatch");
    return structuredClone(
      report(
        this.observedThrough,
        this.count,
        this.clock,
        this.states.map((state) => ({
          signalType: state.chosen.signalType,
          windowStart: state.chosen.windowStart,
          decisionAt: state.chosen.decisionAt,
          decision: state.decision ?? state.features.snapshot(state.chosen),
          previousWindowOutcome: state.outcome.snapshot(),
        })),
      ),
    );
  }
}

/** Two passes bind bounded replay state to verified evidence before publishing results. */
export async function auditCaptureDecisions(
  directory: string,
): Promise<Record<string, unknown>> {
  const path = join(resolve(directory), "events.jsonl");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes)
    throw new Error("Audit requires a regular capture up to 1 GiB");
  const verification = await verifyCapture(directory);
  const observedThrough = z
    .string()
    .datetime({ precision: 3 })
    .parse(verification["lastTradeReceivedAt"]);
  const replay = new ResearchCaptureReplay(observedThrough);
  const evidence = await readBoundedJsonl(path, maximumBytes, (line) => {
    const envelope = envelopeSchema.parse(JSON.parse(line) as unknown);
    const { record } = payloadSchema.parse(JSON.parse(envelope.payload) as unknown);
    if (record.kind !== "TRADE") return;
    replay.ingest(
      ResearchTradeSchema.parse({
        ...storedTradeSchema.parse(record.trade),
        receivedAt: record.receivedAt,
      }),
    );
  });
  if (
    evidence.sha256 !== verification["fileSha256"] ||
    evidence.bytes !== verification["bytes"]
  )
    throw new Error("Capture changed after verification");
  return {
    ...replay.snapshot(),
    captureSessionId: verification["sessionId"],
    captureFileSha256: verification["fileSha256"],
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
      JSON.stringify(await auditCaptureDecisions(process.argv[2]!), null, 2) + "\n",
    );
  })().catch(() => {
    process.stderr.write(
      "Research decision audit failed. Preserve the capture; no model was loaded or enabled.\n",
    );
    process.exitCode = 1;
  });
}
