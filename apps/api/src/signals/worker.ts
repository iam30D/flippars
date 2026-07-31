import { createHash } from "node:crypto";
import type {
  MarketSnapshot,
  ModelRecord,
  SignalRecord,
  SignalType,
} from "../domain.js";
import type { MarketCoordinator } from "../market/coordinator.js";
import type { MetricsRegistry } from "../metrics.js";
import type { Repository } from "../repositories/repository.js";
import type { ModelCandidate, ModelInput, ModelRuntime } from "./runtime.js";
import type { SafetyController } from "./safety.js";

interface TrackedCandle {
  start: number;
  end: number;
  open: number;
  current: number;
  high: number;
  low: number;
  samples: number;
  trustedOpen: boolean;
}

export interface SignalWorkerOptions {
  confidenceThreshold: number;
  minimumLeadTimeMs: number;
  dataMode: "live" | "simulation";
}

export class SignalWorker {
  private readonly candles = new Map<string, TrackedCandle>();
  private readonly modelCache = new Map<
    SignalType,
    { value: ModelRecord | null; expiresAt: number }
  >();
  private unsubscribe: (() => void) | null = null;
  private processing = Promise.resolve();

  constructor(
    private readonly market: MarketCoordinator,
    private readonly repository: Repository,
    private readonly runtime: ModelRuntime,
    private readonly safety: SafetyController,
    private readonly metrics: MetricsRegistry,
    private readonly options: SignalWorkerOptions,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.market.onSnapshot((snapshot) => {
      this.processing = this.processing
        .then(() => this.evaluate(snapshot))
        .catch(() => {
          this.metrics.increment("flippars_signal_worker_errors_total");
          this.safety.setDegraded("signal worker evaluation failure");
        });
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.processing;
  }

  private async evaluate(snapshot: MarketSnapshot): Promise<void> {
    if (this.options.dataMode !== "live") return this.abstain("non_live_data");
    if (!snapshot.health.healthy) return this.abstain("market_unhealthy");
    this.updateCandle(snapshot, 300_000);
    this.updateCandle(snapshot, 900_000);
    if (!this.safety.canEmit()) return this.abstain("safety_gate");

    for (const type of [
      "five_minute_reversal",
      "fifteen_minute_reversal",
      "five_minute_early_direction",
    ] as const) {
      await this.evaluateType(type, snapshot);
    }
  }

  private async evaluateType(
    type: SignalType,
    snapshot: MarketSnapshot,
  ): Promise<void> {
    const duration = type === "fifteen_minute_reversal" ? 900_000 : 300_000;
    const candle = this.candleFor(snapshot, duration);
    if (!candle) return this.abstain("candle_unavailable", type);
    if (!candle.trustedOpen) return this.abstain("untrusted_interval_open", type);
    const now = Date.parse(snapshot.observedAt);
    const elapsedMs = now - candle.start;
    const remainingMs = candle.end - now;
    if (remainingMs < this.options.minimumLeadTimeMs)
      return this.abstain("insufficient_lead_time", type);
    if (type === "fifteen_minute_reversal" && elapsedMs < 450_000)
      return this.abstain("outside_final_7m30s", type);
    if (type === "five_minute_early_direction" && elapsedMs > 60_000)
      return this.abstain("outside_first_60s", type);

    const model = await this.approvedModel(type);
    if (!model || model.status !== "approved" || !model.approvedAt)
      return this.abstain("model_unapproved", type);
    if (!(await this.runtime.ready(model)))
      return this.abstain("artifact_not_loaded_or_hash_mismatch", type);

    const input: ModelInput = {
      type,
      snapshot,
      intervalStart: new Date(candle.start).toISOString(),
      intervalEnd: new Date(candle.end).toISOString(),
      openPrice: candle.open,
      currentPrice: candle.current,
      highPrice: candle.high,
      lowPrice: candle.low,
      elapsedMs,
      remainingMs,
      sampleCount: candle.samples,
    };
    const candidate = await this.runtime.predict(input, model);
    if (!candidate) return this.abstain("model_abstained", type);
    const policyFailure = this.policyFailure(
      type,
      input,
      candidate,
      Math.max(this.options.confidenceThreshold, model.minimumConfidence),
    );
    if (policyFailure) return this.abstain(policyFailure, type);

    const canonical = candidate.canonicalSignal;
    const signal: SignalRecord = {
      id: canonical?.id ?? deterministicSignalId(type, input.intervalStart, model.id),
      type,
      direction: candidate.direction,
      openPrice: candle.open,
      currentPrice: candle.current,
      confidence: candidate.confidence,
      intervalStart: input.intervalStart,
      intervalEnd: input.intervalEnd,
      issuedAt: snapshot.observedAt,
      expiresAt: input.intervalEnd,
      modelId: model.id,
      modelVersion: model.version,
      explanation: candidate.explanation,
      outcome: null,
      ...(canonical ? { canonical } : {}),
    };
    const result = await this.repository.createSignal(signal);
    if (!result.created) return this.abstain("interval_signal_already_exists", type);
    this.metrics.increment("flippars_signals_created_total", { type });
    this.market.emit("signal", result.signal);
  }

  private policyFailure(
    type: SignalType,
    input: ModelInput,
    candidate: ModelCandidate,
    threshold: number,
  ): string | null {
    if (
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < threshold ||
      candidate.confidence > 1
    )
      return "confidence_below_threshold";
    if (!Number.isFinite(candidate.anomalyScore) || candidate.anomalyScore > 0.5)
      return "anomaly_risk";
    if (type.endsWith("reversal")) {
      const position =
        input.currentPrice > input.openPrice
          ? "above"
          : input.currentPrice < input.openPrice
            ? "below"
            : "at";
      if (position === "at") return "price_at_open";
      if (position === "above" && candidate.direction !== "lower")
        return "not_a_reversal";
      if (position === "below" && candidate.direction !== "higher")
        return "not_a_reversal";
    }
    return null;
  }

  private updateCandle(snapshot: MarketSnapshot, duration: number): void {
    const at = Date.parse(snapshot.observedAt);
    const start = Math.floor(at / duration) * duration;
    const key = `${duration}:${start}`;
    const existing = this.candles.get(key);
    if (existing) {
      existing.current = snapshot.price;
      existing.high = Math.max(existing.high, snapshot.price);
      existing.low = Math.min(existing.low, snapshot.price);
      existing.samples += 1;
    } else {
      this.candles.set(key, {
        start,
        end: start + duration,
        open: snapshot.price,
        current: snapshot.price,
        high: snapshot.price,
        low: snapshot.price,
        samples: 1,
        trustedOpen: at - start <= 5_000,
      });
    }
    for (const [candidateKey, value] of this.candles) {
      if (value.end < at - 900_000) this.candles.delete(candidateKey);
    }
  }

  private candleFor(snapshot: MarketSnapshot, duration: number): TrackedCandle | null {
    const at = Date.parse(snapshot.observedAt);
    return (
      this.candles.get(`${duration}:${Math.floor(at / duration) * duration}`) ?? null
    );
  }

  private async approvedModel(type: SignalType): Promise<ModelRecord | null> {
    const cached = this.modelCache.get(type);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.repository.getApprovedModel(type);
    this.modelCache.set(type, { value, expiresAt: Date.now() + 30_000 });
    return value;
  }

  private abstain(reason: string, type = "all"): void {
    this.metrics.increment("flippars_signal_abstentions_total", { reason, type });
  }
}

function deterministicSignalId(
  type: SignalType,
  intervalStart: string,
  modelId: string,
): string {
  const digest = createHash("sha256")
    .update(`${type}\u001f${intervalStart}\u001f${modelId}`)
    .digest("hex")
    .slice(0, 24);
  return `signal_${digest}`;
}
