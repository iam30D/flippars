import type { SignalType } from "@flippars/contracts";
import {
  ResearchFeatureStream,
  ResearchOutcomePopulation,
  ResearchTradeSchema,
} from "./trade-features.js";
import type { ResearchTrade } from "./trade-features.js";

const targets: SignalType[] = [
  "FIVE_MINUTE_EARLY_DIRECTION",
  "FIVE_MINUTE_REVERSAL",
  "FIFTEEN_MINUTE_REVERSAL",
];
function timestamp(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new Error("Noncanonical replay timestamp");
  return time;
}

/** Full scheduled population for a bounded, immutable research interval. */
export class ResearchPopulationReplay {
  private readonly start: number;
  private readonly end: number;
  private next: number;
  private previous: ResearchTrade | undefined;
  private failed = false;
  private finished = false;
  private count = 0;
  private readonly decisions: Array<{
    id: string;
    signalType: SignalType;
    windowStart: string;
    decisionAt: string;
    decision: ReturnType<ResearchFeatureStream["snapshot"]>;
  }> = [];
  private readonly states;

  constructor(
    private readonly startedAt: string,
    private readonly observedThrough: string,
  ) {
    this.start = timestamp(startedAt);
    this.end = timestamp(observedThrough);
    if (this.end <= this.start || this.end - this.start > 14_400_000)
      throw new Error("Population replay requires an interval of at most four hours");
    this.next = Math.ceil(this.start / 15_000) * 15_000;
    this.states = targets.map((signalType) => {
      const duration = signalType === "FIFTEEN_MINUTE_REVERSAL" ? 900_000 : 300_000;
      const starts: string[] = [];
      for (
        let at = Math.floor(this.start / duration) * duration;
        at < this.end;
        at += duration
      )
        starts.push(new Date(at).toISOString());
      return {
        signalType,
        duration,
        features: new ResearchFeatureStream(signalType),
        outcomes: new ResearchOutcomePopulation(signalType, starts, observedThrough),
      };
    });
  }

  ingest(input: unknown): void {
    if (this.failed || this.finished) throw new Error("Replay is no longer writable");
    try {
      const trade = ResearchTradeSchema.parse(input);
      const received = timestamp(trade.receivedAt);
      if (
        received < this.start ||
        received > this.end ||
        (this.previous &&
          (BigInt(trade.tradeId) !== BigInt(this.previous.tradeId) + 1n ||
            trade.eventAt < this.previous.eventAt ||
            trade.receivedAt < this.previous.receivedAt))
      )
        throw new Error("Population replay continuity failure");
      this.advance(received);
      for (const state of this.states) {
        state.features.ingest(trade);
        state.outcomes.ingest(trade);
      }
      this.previous = trade;
      this.count++;
    } catch {
      this.failed = true;
      throw new Error("Invalid or discontinuous population replay");
    }
  }

  finish() {
    if (this.failed || !this.count)
      throw new Error("Population replay cannot complete");
    if (!this.finished) {
      try {
        this.advance(this.end);
        this.finished = true;
      } catch {
        this.failed = true;
        throw new Error("Population replay finalization failed");
      }
    }
    return structuredClone({
      schemaVersion: "flippars.research-population-replay/1",
      scope: "RETROSPECTIVE_RESEARCH_ONLY",
      productionEligible: false,
      prospectiveEvidenceEligible: false,
      modelLoaded: false,
      guardVerdict: "UNASSESSED",
      startedAt: this.startedAt,
      observedThrough: this.observedThrough,
      tradeCount: this.count,
      decisions: this.decisions,
      outcomes: this.states.flatMap((state) => state.outcomes.snapshot()),
      warning:
        "All scheduled research decisions, including abstentions. No model predictions, approval, or prospective shadow credit.",
    });
  }

  private advance(through: number): void {
    while (this.next <= through) {
      for (const state of this.states) {
        const start = Math.floor(this.next / state.duration) * state.duration;
        const offset = (this.next - start) / 1_000;
        const eligible =
          state.signalType === "FIVE_MINUTE_EARLY_DIRECTION"
            ? offset >= 15 && offset <= 45
            : state.signalType === "FIVE_MINUTE_REVERSAL"
              ? offset >= 15 && offset <= 285
              : offset >= 300 && offset <= 870;
        if (!eligible) continue;
        if (this.decisions.length >= 2_000)
          throw new Error("Decision population limit exceeded");
        const windowStart = new Date(start).toISOString();
        const decisionAt = new Date(this.next).toISOString();
        this.decisions.push({
          id: `research:BTCUSDT:${state.signalType}:${windowStart}:${offset}`,
          signalType: state.signalType,
          windowStart,
          decisionAt,
          decision: state.features.snapshot({ windowStart, decisionAt }),
        });
      }
      this.next += 15_000;
    }
  }
}
