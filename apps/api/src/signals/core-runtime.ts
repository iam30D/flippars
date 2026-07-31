import {
  CandleStateSchema,
  type CandleState,
  type MarketSnapshot,
} from "@flippars/contracts";
import {
  SignalEngine,
  type CalibratedForecast,
  type ModelArtifact,
  type ManipulationRiskMetrics,
  type SignalPolicyOverrides,
} from "@flippars/signal-core";
import type { ModelRecord } from "../domain.js";
import { presentMarketSnapshot, toWireSignalType } from "../transport/presenters.js";
import type { ModelCandidate, ModelInput, ModelRuntime } from "./runtime.js";

export interface ValidatedForecastProvider {
  /** Must load the artifact and verify its bytes against model.artifactSha256. */
  verifyArtifact(model: ModelRecord, artifact: ModelArtifact): Promise<boolean>;
  /** Returns every approved anomaly feature, or null to force abstention. */
  riskMetrics(
    input: ModelInput,
    snapshot: MarketSnapshot,
  ): Promise<Required<ManipulationRiskMetrics> | null>;
  forecast(
    input: ModelInput,
    snapshot: MarketSnapshot,
    candle: CandleState,
    artifact: ModelArtifact,
  ): Promise<CalibratedForecast | null>;
}

export class DisabledForecastProvider implements ValidatedForecastProvider {
  verifyArtifact(): Promise<boolean> {
    return Promise.resolve(false);
  }
  riskMetrics(): Promise<null> {
    return Promise.resolve(null);
  }
  forecast(): Promise<null> {
    return Promise.resolve(null);
  }
}

/** Adapter that makes the shared, audited signal-core policy authoritative. */
export class CoreModelRuntime implements ModelRuntime {
  private readonly engine: SignalEngine;

  constructor(
    private readonly provider: ValidatedForecastProvider,
    policy: SignalPolicyOverrides = {},
  ) {
    this.engine = new SignalEngine(policy);
  }

  async ready(model: ModelRecord): Promise<boolean> {
    const artifact = artifactFromModel(model);
    return (
      artifact !== null &&
      model.status === "approved" &&
      Boolean(model.approvedAt) &&
      (await this.provider.verifyArtifact(model, artifact))
    );
  }

  async predict(input: ModelInput, model: ModelRecord): Promise<ModelCandidate | null> {
    const artifact = artifactFromModel(model);
    if (!artifact) return null;
    const snapshot = presentMarketSnapshot(
      input.snapshot,
      "LIVE",
      new Date(input.snapshot.observedAt),
    );
    const candle = toCandle(input, this.engine.policy.deadbandBps);
    const riskMetrics = await this.provider.riskMetrics(input, snapshot);
    if (!riskMetrics || !completeRiskMetrics(riskMetrics)) return null;
    const forecast = await this.provider.forecast(input, snapshot, candle, artifact);
    if (!forecast) return null;
    const decision = this.engine.evaluate({
      snapshot,
      candle,
      forecast,
      artifact,
      riskMetrics,
      evaluatedAt: input.snapshot.observedAt,
    });
    if (decision.kind === "ABSTAIN") return null;
    return {
      direction:
        decision.signal.predictedCloseRelation === "ABOVE_OPEN" ? "higher" : "lower",
      confidence: decision.signal.confidence,
      anomalyScore: decision.riskAssessment.score,
      explanation: {
        summary: `${decision.signal.type} forecast passed calibrated confidence, market-health, timing, and anomaly gates.`,
        evidence: decision.signal.evidence.map((evidence) => ({
          label: evidence.label,
          value: evidence.value,
          direction:
            evidence.direction === "SUPPORTS"
              ? "supports"
              : evidence.direction === "CONTRADICTS"
                ? "opposes"
                : "neutral",
        })),
        limitations: [
          "Informational only; short-horizon forecasts remain probabilistic and can be wrong.",
        ],
      },
      canonicalSignal: decision.signal,
    };
  }
}

function toCandle(input: ModelInput, deadbandBps: number): CandleState {
  const dataMode = "LIVE" as const;
  const deltaBps = ((input.currentPrice - input.openPrice) / input.openPrice) * 10_000;
  return CandleStateSchema.parse({
    instrument: "BTC-USD",
    interval: input.type === "fifteen_minute_reversal" ? "15m" : "5m",
    durationSeconds: input.type === "fifteen_minute_reversal" ? 900 : 300,
    windowStart: input.intervalStart,
    windowEnd: input.intervalEnd,
    openPrice: decimal(input.openPrice),
    currentPrice: decimal(input.currentPrice),
    highPrice: decimal(input.highPrice),
    lowPrice: decimal(input.lowPrice),
    observedPosition:
      Math.abs(deltaBps) <= deadbandBps
        ? "AT_OPEN"
        : deltaBps > 0
          ? "ABOVE_OPEN"
          : "BELOW_OPEN",
    deadbandBps,
    sampleCount: input.sampleCount,
    lastUpdatedAt: input.snapshot.observedAt,
    elapsedSeconds: input.elapsedMs / 1_000,
    remainingSeconds: input.remainingMs / 1_000,
    complete: input.remainingMs <= 0,
    dataMode,
  });
}

function artifactFromModel(model: ModelRecord): ModelArtifact | null {
  const metadata = model.metadata;
  const calibrationVersion = stringField(metadata, "calibrationVersion");
  const calibrationValidUntil = stringField(metadata, "calibrationValidUntil");
  const featureSchemaVersion = stringField(metadata, "featureSchemaVersion");
  const trainedThrough = stringField(metadata, "trainedThrough");
  if (
    !calibrationVersion ||
    !calibrationValidUntil ||
    !featureSchemaVersion ||
    !trainedThrough
  )
    return null;
  return {
    artifactId: model.id,
    version: model.version,
    signalType: toWireSignalType(model.signalType),
    status:
      model.status === "approved"
        ? "APPROVED"
        : model.status === "shadow"
          ? "SHADOW"
          : model.status === "retired"
            ? "RETIRED"
            : "DRAFT",
    approvedAt: model.approvedAt,
    calibrationVersion,
    calibrationValidUntil,
    featureSchemaVersion,
    trainedThrough,
  };
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function decimal(value: number): string {
  return value.toFixed(10).replace(/(?:\.0+|(?:(\.\d*?[1-9])0+))$/, "$1");
}

function completeRiskMetrics(metrics: Required<ManipulationRiskMetrics>): boolean {
  return Object.values(metrics).every((value) => Number.isFinite(value));
}
