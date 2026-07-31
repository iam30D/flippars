import type { SignalRecord } from "../domain.js";
import type { MetricsRegistry } from "../metrics.js";
import type { Repository } from "../repositories/repository.js";

export class OutcomeEvaluator {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repository: Repository,
    private readonly metrics: MetricsRegistry,
    private readonly neutralBandBps: number,
    private readonly pollMs = 5_000,
    private readonly onResolved?: (signal: SignalRecord) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const signal of await this.repository.unresolvedSignals(
        now.toISOString(),
        100,
      )) {
        await this.evaluate(signal, now);
      }
    } finally {
      this.running = false;
    }
  }

  private async evaluate(signal: SignalRecord, now: Date): Promise<void> {
    const closePrice = await this.repository.closePriceAt(signal.intervalEnd, 10_000);
    const outcome =
      closePrice === null ? "void" : classify(signal, closePrice, this.neutralBandBps);
    const record = {
      signalId: signal.id,
      result: outcome,
      closePrice,
      evaluatedAt: now.toISOString(),
      reason:
        closePrice === null
          ? "No healthy composite observation near interval close"
          : `Close evaluated with ${this.neutralBandBps} bps neutral band`,
    } as const;
    const created = await this.repository.createOutcome(record);
    if (created) {
      this.metrics.increment("flippars_signal_outcomes_total", { result: outcome });
      this.onResolved?.({ ...signal, outcome: record });
    }
  }
}

function classify(
  signal: SignalRecord,
  close: number,
  neutralBandBps: number,
): "correct" | "incorrect" | "flat" {
  const changeBps = ((close - signal.openPrice) / signal.openPrice) * 10_000;
  if (Math.abs(changeBps) <= neutralBandBps) return "flat";
  const actual = changeBps > 0 ? "higher" : "lower";
  return actual === signal.direction ? "correct" : "incorrect";
}
