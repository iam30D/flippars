import {
  SignalSchema,
  type AuditMetadata,
  type CandleState,
  type PredictedCloseRelation,
  type Signal,
  type SignalType,
} from "@flippars/contracts";

import { deterministicId, parsePositiveDecimal } from "./math.js";
import type { CalibratedForecast, ModelArtifact } from "./model.js";
import { classifyPricePosition } from "./position.js";
import {
  DEFAULT_RISK_CONFIG,
  scoreManipulationRisk,
  type ManipulationRiskAssessment,
  type ManipulationRiskMetrics,
} from "./risk.js";
import { isInsideWindow, toEpochMilliseconds } from "./windows.js";
import type { MarketSnapshot } from "@flippars/contracts";

export type AbstentionReason =
  | "MARKET_UNAVAILABLE"
  | "SNAPSHOT_STALE"
  | "DATA_MODE_MISMATCH"
  | "CANDLE_TYPE_MISMATCH"
  | "OUTSIDE_CANDLE_WINDOW"
  | "MODEL_TYPE_MISMATCH"
  | "MODEL_ARTIFACT_MISMATCH"
  | "MODEL_UNAPPROVED"
  | "CALIBRATION_INVALID"
  | "FORECAST_STALE"
  | "OUT_OF_DISTRIBUTION"
  | "INSUFFICIENT_CONFIDENCE"
  | "ANOMALY_RISK"
  | "NOT_IN_SIGNAL_PHASE"
  | "INSUFFICIENT_LEAD_TIME"
  | "DEAD_BAND"
  | "CURRENT_POSITION_NOT_OPPOSITE"
  | "DUPLICATE";

export interface SignalPolicy {
  readonly confidenceThresholds: Readonly<Record<SignalType, number>>;
  readonly minimumLeadTimeSeconds: Readonly<Record<SignalType, number>>;
  readonly snapshotMaxAgeMs: number;
  readonly allowedFutureClockSkewMs: number;
  readonly forecastMaxAgeMs: number;
  readonly deadbandBps: number;
  readonly fifteenMinuteFinalWindowSeconds: number;
  readonly fiveMinuteEarlyWindowSeconds: number;
  readonly anomalySuppressionThreshold: number;
  readonly allowUnapprovedArtifactsOutsideLive: boolean;
  readonly engineVersion: string;
  readonly policyVersion: string;
}

export interface SignalPolicyOverrides {
  readonly confidenceThresholds?: Partial<Record<SignalType, number>>;
  readonly minimumLeadTimeSeconds?: Partial<Record<SignalType, number>>;
  readonly snapshotMaxAgeMs?: number;
  readonly allowedFutureClockSkewMs?: number;
  readonly forecastMaxAgeMs?: number;
  readonly deadbandBps?: number;
  readonly fifteenMinuteFinalWindowSeconds?: number;
  readonly fiveMinuteEarlyWindowSeconds?: number;
  readonly anomalySuppressionThreshold?: number;
  readonly allowUnapprovedArtifactsOutsideLive?: boolean;
  readonly engineVersion?: string;
  readonly policyVersion?: string;
}

export const DEFAULT_SIGNAL_POLICY: Readonly<SignalPolicy> = {
  confidenceThresholds: {
    FIVE_MINUTE_REVERSAL: 0.75,
    FIFTEEN_MINUTE_REVERSAL: 0.75,
    FIVE_MINUTE_EARLY_DIRECTION: 0.75,
  },
  minimumLeadTimeSeconds: {
    FIVE_MINUTE_REVERSAL: 15,
    FIFTEEN_MINUTE_REVERSAL: 30,
    FIVE_MINUTE_EARLY_DIRECTION: 15,
  },
  snapshotMaxAgeMs: 5_000,
  allowedFutureClockSkewMs: 1_000,
  forecastMaxAgeMs: 30_000,
  deadbandBps: 1,
  fifteenMinuteFinalWindowSeconds: 450,
  fiveMinuteEarlyWindowSeconds: 60,
  anomalySuppressionThreshold: DEFAULT_RISK_CONFIG.suppressionThreshold,
  allowUnapprovedArtifactsOutsideLive: true,
  engineVersion: "signal-core/0.1.0",
  policyVersion: "precision-first/1",
};

export interface SignalEvaluationInput {
  readonly snapshot: MarketSnapshot;
  readonly candle: CandleState;
  readonly forecast: CalibratedForecast;
  readonly artifact: ModelArtifact;
  readonly riskMetrics?: ManipulationRiskMetrics;
  readonly evaluatedAt?: string;
}

export interface DecisionAudit extends AuditMetadata {
  readonly artifactStatus: ModelArtifact["status"];
}

export interface EmittedSignalDecision {
  readonly kind: "SIGNAL";
  readonly signal: Signal;
  readonly riskAssessment: ManipulationRiskAssessment;
}

export interface AbstainedSignalDecision {
  readonly kind: "ABSTAIN";
  readonly signalType: SignalType;
  readonly reason: AbstentionReason;
  readonly detail: string;
  readonly evaluatedAt: string;
  readonly windowStart: string;
  readonly audit: DecisionAudit;
  readonly riskAssessment: ManipulationRiskAssessment;
}

export type SignalDecision = EmittedSignalDecision | AbstainedSignalDecision;

export class SignalDeduplicator {
  readonly #emitted = new Set<string>();

  public has(signalType: SignalType, windowStart: string): boolean {
    return this.#emitted.has(this.key(signalType, windowStart));
  }

  public record(signalType: SignalType, windowStart: string): void {
    this.#emitted.add(this.key(signalType, windowStart));
  }

  public hydrate(entries: readonly Pick<Signal, "type" | "windowStart">[]): void {
    for (const entry of entries) {
      this.record(entry.type, entry.windowStart);
    }
  }

  public prune(before: string): void {
    const boundary = toEpochMilliseconds(before);
    for (const key of this.#emitted) {
      const separator = key.indexOf("|");
      const windowStart = key.slice(separator + 1);
      if (toEpochMilliseconds(windowStart) < boundary) {
        this.#emitted.delete(key);
      }
    }
  }

  public clear(): void {
    this.#emitted.clear();
  }

  public key(signalType: SignalType, windowStart: string): string {
    return `${signalType}|${new Date(toEpochMilliseconds(windowStart)).toISOString()}`;
  }
}

function expectedCandle(
  signalType: SignalType,
): Pick<CandleState, "interval" | "durationSeconds"> {
  return signalType === "FIFTEEN_MINUTE_REVERSAL"
    ? { interval: "15m", durationSeconds: 900 }
    : { interval: "5m", durationSeconds: 300 };
}

function isOpposite(
  observed: CandleState["observedPosition"],
  predicted: PredictedCloseRelation,
): boolean {
  return (
    (observed === "ABOVE_OPEN" && predicted === "BELOW_OPEN") ||
    (observed === "BELOW_OPEN" && predicted === "ABOVE_OPEN")
  );
}

export class SignalEngine {
  public readonly policy: Readonly<SignalPolicy>;
  public readonly deduplicator: SignalDeduplicator;

  public constructor(
    overrides: SignalPolicyOverrides = {},
    deduplicator = new SignalDeduplicator(),
  ) {
    this.policy = {
      ...DEFAULT_SIGNAL_POLICY,
      ...overrides,
      confidenceThresholds: {
        ...DEFAULT_SIGNAL_POLICY.confidenceThresholds,
        ...overrides.confidenceThresholds,
      },
      minimumLeadTimeSeconds: {
        ...DEFAULT_SIGNAL_POLICY.minimumLeadTimeSeconds,
        ...overrides.minimumLeadTimeSeconds,
      },
    };
    this.deduplicator = deduplicator;
    this.#validatePolicy();
  }

  public evaluate(input: SignalEvaluationInput): SignalDecision {
    const evaluatedMs = toEpochMilliseconds(
      input.evaluatedAt ?? input.snapshot.observedAt,
    );
    const evaluatedAt = new Date(evaluatedMs).toISOString();
    const audit: DecisionAudit = {
      decisionId: deterministicId(
        "decision",
        input.snapshot.id,
        input.forecast.id,
        input.forecast.signalType,
        input.candle.windowStart,
        evaluatedAt,
      ),
      engineVersion: this.policy.engineVersion,
      policyVersion: this.policy.policyVersion,
      inputSnapshotId: input.snapshot.id,
      forecastId: input.forecast.id,
      evaluatedAt,
      dataMode: input.snapshot.dataMode,
      artifactStatus: input.artifact.status,
    };
    const stablecoinDeviationBps =
      input.snapshot.usdtUsdRate === null
        ? 0
        : Math.abs(
            parsePositiveDecimal(input.snapshot.usdtUsdRate, "usdtUsdRate") - 1,
          ) * 10_000;
    const riskAssessment = scoreManipulationRisk(
      {
        crossVenueDivergenceBps:
          input.riskMetrics?.crossVenueDivergenceBps ??
          input.snapshot.crossVenueSpreadBps ??
          0,
        stablecoinDeviationBps:
          input.riskMetrics?.stablecoinDeviationBps ?? stablecoinDeviationBps,
        ...(input.riskMetrics?.absoluteReturnZScore === undefined
          ? {}
          : {
              absoluteReturnZScore: input.riskMetrics.absoluteReturnZScore,
            }),
        ...(input.riskMetrics?.volumeZScore === undefined
          ? {}
          : { volumeZScore: input.riskMetrics.volumeZScore }),
        ...(input.riskMetrics?.spreadBps === undefined
          ? {}
          : { spreadBps: input.riskMetrics.spreadBps }),
        ...(input.riskMetrics?.liquidityDropPercent === undefined
          ? {}
          : {
              liquidityDropPercent: input.riskMetrics.liquidityDropPercent,
            }),
        ...(input.riskMetrics?.liquidationZScore === undefined
          ? {}
          : { liquidationZScore: input.riskMetrics.liquidationZScore }),
        ...(input.riskMetrics?.absoluteOrderBookImbalance === undefined
          ? {}
          : {
              absoluteOrderBookImbalance: input.riskMetrics.absoluteOrderBookImbalance,
            }),
        ...(input.riskMetrics?.cancellationRate === undefined
          ? {}
          : { cancellationRate: input.riskMetrics.cancellationRate }),
      },
      {
        suppressionThreshold: this.policy.anomalySuppressionThreshold,
      },
    );
    const abstain = (
      reason: AbstentionReason,
      detail: string,
    ): AbstainedSignalDecision => ({
      kind: "ABSTAIN",
      signalType: input.forecast.signalType,
      reason,
      detail,
      evaluatedAt,
      windowStart: input.candle.windowStart,
      audit: {
        decisionId: audit.decisionId,
        engineVersion: audit.engineVersion,
        policyVersion: audit.policyVersion,
        inputSnapshotId: audit.inputSnapshotId,
        forecastId: audit.forecastId,
        evaluatedAt: audit.evaluatedAt,
        dataMode: audit.dataMode,
        artifactStatus: audit.artifactStatus,
      },
      riskAssessment,
    });

    if (
      input.snapshot.compositePrice === null ||
      input.snapshot.health === "UNAVAILABLE" ||
      input.snapshot.eligibleVenueCount < input.snapshot.quorum
    ) {
      return abstain(
        "MARKET_UNAVAILABLE",
        "The venue quorum did not produce a trustworthy composite price",
      );
    }

    const snapshotAgeMs = evaluatedMs - toEpochMilliseconds(input.snapshot.observedAt);
    if (
      snapshotAgeMs > this.policy.snapshotMaxAgeMs ||
      snapshotAgeMs < -this.policy.allowedFutureClockSkewMs
    ) {
      return abstain(
        "SNAPSHOT_STALE",
        "The market snapshot is outside the permitted time-skew window",
      );
    }

    if (
      input.snapshot.dataMode !== input.candle.dataMode ||
      input.snapshot.dataMode !== audit.dataMode
    ) {
      return abstain("DATA_MODE_MISMATCH", "Snapshot and candle data modes must match");
    }

    const requiredCandle = expectedCandle(input.forecast.signalType);
    if (
      input.candle.durationSeconds !== requiredCandle.durationSeconds ||
      input.candle.interval !== requiredCandle.interval
    ) {
      return abstain(
        "CANDLE_TYPE_MISMATCH",
        `${input.forecast.signalType} requires a ${requiredCandle.interval} candle`,
      );
    }

    if (
      !isInsideWindow(input.candle.windowStart, input.candle.windowEnd, evaluatedMs)
    ) {
      return abstain(
        "OUTSIDE_CANDLE_WINDOW",
        "Evaluation must occur inside the candle's half-open UTC window",
      );
    }

    if (input.artifact.signalType !== input.forecast.signalType) {
      return abstain(
        "MODEL_TYPE_MISMATCH",
        "The model artifact is not approved for this signal type",
      );
    }
    if (input.forecast.artifactId !== input.artifact.artifactId) {
      return abstain(
        "MODEL_ARTIFACT_MISMATCH",
        "The forecast does not reference the supplied model artifact",
      );
    }

    if (
      input.snapshot.dataMode === "LIVE" &&
      (input.artifact.status !== "APPROVED" ||
        input.artifact.approvedAt === null ||
        toEpochMilliseconds(input.artifact.approvedAt) > evaluatedMs)
    ) {
      return abstain(
        "MODEL_UNAPPROVED",
        "Live signals require an approved model artifact",
      );
    }
    if (
      input.snapshot.dataMode !== "LIVE" &&
      !this.policy.allowUnapprovedArtifactsOutsideLive &&
      input.artifact.status !== "APPROVED"
    ) {
      return abstain(
        "MODEL_UNAPPROVED",
        "Policy requires approved artifacts in this data mode",
      );
    }

    if (
      !input.forecast.calibrated ||
      input.forecast.calibrationVersion !== input.artifact.calibrationVersion ||
      toEpochMilliseconds(input.artifact.calibrationValidUntil) < evaluatedMs ||
      !Number.isFinite(input.forecast.probability) ||
      input.forecast.probability < 0 ||
      input.forecast.probability > 1
    ) {
      return abstain(
        "CALIBRATION_INVALID",
        "Forecast calibration is absent, mismatched, expired, or invalid",
      );
    }

    const forecastAgeMs = evaluatedMs - toEpochMilliseconds(input.forecast.generatedAt);
    if (
      forecastAgeMs > this.policy.forecastMaxAgeMs ||
      forecastAgeMs < -this.policy.allowedFutureClockSkewMs
    ) {
      return abstain(
        "FORECAST_STALE",
        "Forecast is stale or timestamped too far in the future",
      );
    }
    if (input.forecast.outOfDistribution) {
      return abstain(
        "OUT_OF_DISTRIBUTION",
        "Current conditions are outside the model's validated domain",
      );
    }

    const confidenceThreshold =
      this.policy.confidenceThresholds[input.forecast.signalType];
    if (input.forecast.probability < confidenceThreshold) {
      return abstain(
        "INSUFFICIENT_CONFIDENCE",
        `Calibrated probability is below the ${confidenceThreshold} threshold`,
      );
    }
    if (riskAssessment.suppress) {
      return abstain(
        "ANOMALY_RISK",
        "Abnormal-market risk exceeds the signal suppression threshold",
      );
    }

    const windowStartMs = toEpochMilliseconds(input.candle.windowStart);
    const windowEndMs = toEpochMilliseconds(input.candle.windowEnd);
    const elapsedSeconds = (evaluatedMs - windowStartMs) / 1_000;
    const remainingSeconds = (windowEndMs - evaluatedMs) / 1_000;
    const minimumLeadTime =
      this.policy.minimumLeadTimeSeconds[input.forecast.signalType];

    if (remainingSeconds < minimumLeadTime) {
      return abstain(
        "INSUFFICIENT_LEAD_TIME",
        `Only ${remainingSeconds.toFixed(3)} seconds remain in the candle`,
      );
    }

    if (
      input.forecast.signalType === "FIFTEEN_MINUTE_REVERSAL" &&
      elapsedSeconds < this.policy.fifteenMinuteFinalWindowSeconds
    ) {
      return abstain(
        "NOT_IN_SIGNAL_PHASE",
        "The 15-minute reversal is limited to the final 7 minutes 30 seconds",
      );
    }
    if (
      input.forecast.signalType === "FIVE_MINUTE_EARLY_DIRECTION" &&
      elapsedSeconds >= this.policy.fiveMinuteEarlyWindowSeconds
    ) {
      return abstain(
        "NOT_IN_SIGNAL_PHASE",
        "The early-direction signal is limited to the first 60 seconds",
      );
    }

    const observedPosition = classifyPricePosition(
      input.candle.currentPrice,
      input.candle.openPrice,
      this.policy.deadbandBps,
    );
    if (input.forecast.signalType !== "FIVE_MINUTE_EARLY_DIRECTION") {
      if (observedPosition === "AT_OPEN") {
        return abstain(
          "DEAD_BAND",
          "Current price is inside the neutral band around the open",
        );
      }
      if (!isOpposite(observedPosition, input.forecast.predictedCloseRelation)) {
        return abstain(
          "CURRENT_POSITION_NOT_OPPOSITE",
          "A reversal alert requires current price to remain opposite the predicted close",
        );
      }
    }

    if (this.deduplicator.has(input.forecast.signalType, input.candle.windowStart)) {
      return abstain(
        "DUPLICATE",
        "One alert of this type has already been emitted for this UTC window",
      );
    }

    const signalId = deterministicId(
      "signal",
      input.forecast.signalType,
      input.candle.windowStart,
      input.artifact.artifactId,
    );
    const signalAudit: AuditMetadata = {
      decisionId: audit.decisionId,
      engineVersion: audit.engineVersion,
      policyVersion: audit.policyVersion,
      inputSnapshotId: audit.inputSnapshotId,
      forecastId: audit.forecastId,
      evaluatedAt: audit.evaluatedAt,
      dataMode: audit.dataMode,
    };
    const signal = SignalSchema.parse({
      id: signalId,
      type: input.forecast.signalType,
      status: "ACTIVE",
      instrument: "BTC-USD",
      interval: input.candle.interval,
      durationSeconds: input.candle.durationSeconds,
      windowStart: input.candle.windowStart,
      windowEnd: input.candle.windowEnd,
      issuedAt: evaluatedAt,
      expiresAt: input.candle.windowEnd,
      openPrice: input.candle.openPrice,
      currentPrice: input.candle.currentPrice,
      observedPosition,
      predictedCloseRelation: input.forecast.predictedCloseRelation,
      confidence: input.forecast.probability,
      confidenceThreshold,
      deadbandBps: this.policy.deadbandBps,
      leadTimeSeconds: remainingSeconds,
      riskLevel: riskAssessment.level,
      riskScore: riskAssessment.score,
      riskFlags: riskAssessment.flags,
      healthFlags: input.snapshot.healthFlags,
      evidence: input.forecast.evidence,
      model: {
        artifactId: input.artifact.artifactId,
        version: input.artifact.version,
        approvalStatus: input.artifact.status,
        approvedAt: input.artifact.approvedAt,
        calibrationVersion: input.artifact.calibrationVersion,
      },
      audit: signalAudit,
      dataMode: input.snapshot.dataMode,
      informationalOnly: true,
    });
    this.deduplicator.record(input.forecast.signalType, input.candle.windowStart);
    return { kind: "SIGNAL", signal, riskAssessment };
  }

  #validatePolicy(): void {
    for (const [signalType, threshold] of Object.entries(
      this.policy.confidenceThresholds,
    )) {
      if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) {
        throw new RangeError(
          `${signalType} confidence threshold must be between 0.5 and 1`,
        );
      }
    }
    for (const [signalType, leadTime] of Object.entries(
      this.policy.minimumLeadTimeSeconds,
    )) {
      if (!Number.isFinite(leadTime) || leadTime < 0) {
        throw new RangeError(`${signalType} lead time must be non-negative`);
      }
    }
    if (
      this.policy.fifteenMinuteFinalWindowSeconds !== 450 ||
      this.policy.fiveMinuteEarlyWindowSeconds !== 60
    ) {
      throw new RangeError("Approved signal windows are fixed at 450 and 60 seconds");
    }
    if (!Number.isFinite(this.policy.deadbandBps) || this.policy.deadbandBps < 0) {
      throw new RangeError("deadbandBps must be non-negative");
    }
  }
}
