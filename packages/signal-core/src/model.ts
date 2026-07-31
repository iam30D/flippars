import type {
  CandleState,
  ModelApprovalStatus,
  PredictedCloseRelation,
  SignalEvidence,
  SignalType,
} from "@flippars/contracts";

export interface ModelArtifact {
  readonly artifactId: string;
  readonly version: string;
  readonly signalType: SignalType;
  readonly status: ModelApprovalStatus;
  readonly approvedAt: string | null;
  readonly calibrationVersion: string;
  readonly calibrationValidUntil: string;
  readonly featureSchemaVersion: string;
  readonly trainedThrough: string;
}

export interface CalibratedForecast {
  readonly id: string;
  readonly signalType: SignalType;
  readonly artifactId: string;
  readonly generatedAt: string;
  readonly predictedCloseRelation: PredictedCloseRelation;
  readonly probability: number;
  readonly calibrated: boolean;
  readonly calibrationVersion: string;
  readonly outOfDistribution: boolean;
  readonly evidence: readonly SignalEvidence[];
}

export interface ForecastContext {
  readonly signalType: SignalType;
  readonly candle: CandleState;
  readonly evaluatedAt: string;
}

export interface CalibratedForecastProvider {
  forecast(
    context: ForecastContext,
  ): CalibratedForecast | null | Promise<CalibratedForecast | null>;
}
