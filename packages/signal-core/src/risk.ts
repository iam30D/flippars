import type { RiskFlag, RiskLevel } from "@flippars/contracts";

import { clamp, requireFinite } from "./math.js";

export interface ManipulationRiskMetrics {
  readonly absoluteReturnZScore?: number;
  readonly volumeZScore?: number;
  readonly spreadBps?: number;
  readonly liquidityDropPercent?: number;
  readonly crossVenueDivergenceBps?: number;
  readonly liquidationZScore?: number;
  readonly absoluteOrderBookImbalance?: number;
  readonly cancellationRate?: number;
  readonly stablecoinDeviationBps?: number;
}

export interface ManipulationRiskConfig {
  readonly suppressionThreshold: number;
}

export interface ManipulationRiskAssessment {
  readonly score: number;
  readonly level: RiskLevel;
  readonly suppress: boolean;
  readonly flags: readonly RiskFlag[];
  readonly disclaimer: string;
}

export const DEFAULT_RISK_CONFIG: Readonly<ManipulationRiskConfig> = {
  suppressionThreshold: 0.65,
};

function contribution(
  observed: number,
  threshold: number,
  extreme: number,
  weight: number,
): number {
  if (observed <= threshold) {
    return 0;
  }
  return clamp((observed - threshold) / (extreme - threshold)) * weight;
}

function levelForScore(score: number): RiskLevel {
  if (score >= 0.8) {
    return "CRITICAL";
  }
  if (score >= 0.6) {
    return "HIGH";
  }
  if (score >= 0.3) {
    return "MEDIUM";
  }
  return "LOW";
}

export function scoreManipulationRisk(
  metrics: ManipulationRiskMetrics,
  config: ManipulationRiskConfig = DEFAULT_RISK_CONFIG,
): ManipulationRiskAssessment {
  requireFinite(config.suppressionThreshold, "suppressionThreshold", 0);
  if (config.suppressionThreshold > 1) {
    throw new RangeError("suppressionThreshold must not exceed one");
  }

  const values = {
    absoluteReturnZScore: Math.abs(metrics.absoluteReturnZScore ?? 0),
    volumeZScore: Math.max(0, metrics.volumeZScore ?? 0),
    spreadBps: Math.max(0, metrics.spreadBps ?? 0),
    liquidityDropPercent: Math.max(0, metrics.liquidityDropPercent ?? 0),
    crossVenueDivergenceBps: Math.max(0, metrics.crossVenueDivergenceBps ?? 0),
    liquidationZScore: Math.max(0, metrics.liquidationZScore ?? 0),
    absoluteOrderBookImbalance: Math.abs(metrics.absoluteOrderBookImbalance ?? 0),
    cancellationRate: Math.max(0, metrics.cancellationRate ?? 0),
    stablecoinDeviationBps: Math.max(0, metrics.stablecoinDeviationBps ?? 0),
  };

  for (const [label, value] of Object.entries(values)) {
    requireFinite(value, label, 0);
  }

  const entries: readonly {
    readonly code: RiskFlag["code"];
    readonly observed: number;
    readonly threshold: number;
    readonly extreme: number;
    readonly weight: number;
    readonly message: string;
  }[] = [
    {
      code: "ABNORMAL_RETURN",
      observed: values.absoluteReturnZScore,
      threshold: 2,
      extreme: 8,
      weight: 0.2,
      message: "Short-horizon return is statistically unusual",
    },
    {
      code: "ABNORMAL_VOLUME",
      observed: values.volumeZScore,
      threshold: 2,
      extreme: 8,
      weight: 0.15,
      message: "Trading volume is statistically unusual",
    },
    {
      code: "SPREAD_EXPANSION",
      observed: values.spreadBps,
      threshold: 8,
      extreme: 60,
      weight: 0.12,
      message: "Bid/ask spreads have expanded",
    },
    {
      code: "LIQUIDITY_WITHDRAWAL",
      observed: values.liquidityDropPercent,
      threshold: 20,
      extreme: 80,
      weight: 0.15,
      message: "Displayed market depth has fallen sharply",
    },
    {
      code: "CROSS_VENUE_DISLOCATION",
      observed: values.crossVenueDivergenceBps,
      threshold: 20,
      extreme: 150,
      weight: 0.14,
      message: "Venue prices are unusually far apart",
    },
    {
      code: "LIQUIDATION_CASCADE",
      observed: values.liquidationZScore,
      threshold: 2,
      extreme: 8,
      weight: 0.1,
      message: "Liquidations are statistically unusual",
    },
    {
      code: "EXTREME_ORDER_BOOK_IMBALANCE",
      observed: values.absoluteOrderBookImbalance,
      threshold: 0.7,
      extreme: 1,
      weight: 0.06,
      message: "Order-book imbalance is extreme",
    },
    {
      code: "EXCESSIVE_CANCELLATIONS",
      observed: values.cancellationRate,
      threshold: 0.65,
      extreme: 1,
      weight: 0.04,
      message: "Order cancellation activity is unusually high",
    },
    {
      code: "STABLECOIN_DISLOCATION",
      observed: values.stablecoinDeviationBps,
      threshold: 20,
      extreme: 100,
      weight: 0.04,
      message: "USDT is displaced from its USD reference",
    },
  ];

  const weighted = entries.map((entry) => ({
    entry,
    amount: contribution(entry.observed, entry.threshold, entry.extreme, entry.weight),
  }));
  const score = clamp(weighted.reduce((total, item) => total + item.amount, 0));
  const flags: RiskFlag[] = weighted
    .filter((item) => item.amount > 0)
    .map((item) => ({
      code: item.entry.code,
      severity: levelForScore(
        clamp(item.amount / Math.max(item.entry.weight, 0.000_001)),
      ),
      message: item.entry.message,
      scoreContribution: item.amount,
    }));

  return {
    score,
    level: levelForScore(score),
    suppress: score >= config.suppressionThreshold,
    flags,
    disclaimer:
      "This score identifies abnormal market conditions; it does not establish manipulative intent.",
  };
}
