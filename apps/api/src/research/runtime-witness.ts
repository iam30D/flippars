import { monitorEventLoopDelay } from "node:perf_hooks";

/** Bounded timer evidence for one collector process; no network-health inference. */
export class RuntimeWitness {
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 });
  private readonly timer: NodeJS.Timeout;
  private previousMono = process.hrtime.bigint();
  private previousAt = new Date().toISOString();
  private readonly startedAt = this.previousAt;
  private intervals = 0;
  private stopped: ReturnType<RuntimeWitness["summary"]> | undefined;
  private readonly largest: Array<{
    from: string;
    through: string;
    elapsedMs: number;
    delayBeyondNominalMs: number;
  }> = [];

  constructor() {
    this.histogram.enable();
    this.timer = setInterval(() => this.sample(), 1_000);
    this.timer.unref();
  }

  stop() {
    if (!this.stopped) {
      clearInterval(this.timer);
      this.histogram.disable();
      this.stopped = this.summary();
    }
    return structuredClone(this.stopped);
  }

  private sample(): void {
    const mono = process.hrtime.bigint();
    const at = new Date().toISOString();
    const elapsedMs = Number(mono - this.previousMono) / 1_000_000;
    this.intervals++;
    this.largest.push({
      from: this.previousAt,
      through: at,
      elapsedMs,
      delayBeyondNominalMs: Math.max(0, elapsedMs - 1_000),
    });
    this.largest.sort((left, right) => right.elapsedMs - left.elapsedMs);
    if (this.largest.length > 32) this.largest.pop();
    this.previousMono = mono;
    this.previousAt = at;
  }

  private summary() {
    const count = this.histogram.count;
    return {
      schemaVersion: "flippars.runtime-witness/1" as const,
      scope: "RESEARCH_ONLY" as const,
      productionEligible: false as const,
      prospectiveEvidenceEligible: false as const,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      nodeVersion: process.version,
      resolutionMs: 20,
      nominalCallbackIntervalMs: 1_000,
      callbackIntervalsObserved: this.intervals,
      largestCallbackIntervals: this.largest,
      // This partial interval is not mixed with full nominal intervals.
      unobservedTerminalTailMs:
        Number(process.hrtime.bigint() - this.previousMono) / 1_000_000,
      eventLoop: {
        samples: count,
        minimumMs: count ? this.histogram.min / 1_000_000 : null,
        maximumMs: count ? this.histogram.max / 1_000_000 : null,
        meanMs: count ? this.histogram.mean / 1_000_000 : null,
        p99Ms: count ? this.histogram.percentile(99) / 1_000_000 : null,
      },
      note: "Collector-process timer responsiveness, including scheduling pauses. Not CPU utilization, absolute clock accuracy, network latency, or proof of an interruption's cause. Startup and the terminal unsampled tail remain visible; monitoring adds overhead.",
    };
  }
}
