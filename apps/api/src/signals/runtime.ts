import type { Signal } from "@flippars/contracts";
import type {
  MarketSnapshot,
  ModelRecord,
  SignalExplanation,
  SignalType,
} from "../domain.js";

export interface ModelInput {
  type: SignalType;
  snapshot: MarketSnapshot;
  intervalStart: string;
  intervalEnd: string;
  openPrice: number;
  currentPrice: number;
  highPrice: number;
  lowPrice: number;
  elapsedMs: number;
  remainingMs: number;
  sampleCount: number;
}

export interface ModelCandidate {
  direction: "higher" | "lower";
  confidence: number;
  anomalyScore: number;
  explanation: SignalExplanation;
  canonicalSignal?: Signal;
}

/**
 * The runtime implementation is supplied by the independently validated model
 * package. It must verify the loaded artifact bytes against artifactSha256.
 */
export interface ModelRuntime {
  ready(model: ModelRecord): Promise<boolean>;
  predict(input: ModelInput, model: ModelRecord): Promise<ModelCandidate | null>;
}

/** Fail-closed production default: no artifact means no prediction. */
export class DisabledModelRuntime implements ModelRuntime {
  ready(model: ModelRecord): Promise<boolean> {
    void model;
    return Promise.resolve(false);
  }

  predict(input: ModelInput, model: ModelRecord): Promise<ModelCandidate | null> {
    void input;
    void model;
    return Promise.resolve(null);
  }
}

/** Explicit test helper; never selected by server configuration. */
export class FakeModelRuntime implements ModelRuntime {
  constructor(private readonly candidate: ModelCandidate | null) {}
  ready(): Promise<boolean> {
    return Promise.resolve(true);
  }
  predict(): Promise<ModelCandidate | null> {
    return Promise.resolve(this.candidate);
  }
}
