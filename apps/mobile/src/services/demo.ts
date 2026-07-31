import type { MarketView, SignalView } from "../domain/models";

const iso = (value: number): string => new Date(value).toISOString();
const floorWindow = (nowMs: number, minutes: number): number => {
  const durationMs = minutes * 60_000;
  return Math.floor(nowMs / durationMs) * durationMs;
};

const observation = (id: string, label: string, value: string, detail: string) => ({
  id,
  label,
  value,
  detail,
});

export class DemoRepository {
  private readonly anchorMs = Date.now();

  public market(nowMs: number = Date.now()): MarketView {
    const phase = (nowMs - this.anchorMs) / 7_000;
    const currentPrice = 104_260 + Math.sin(phase) * 31 + Math.cos(phase / 2) * 12;
    const fiveOpenMs = floorWindow(nowMs, 5);
    const fifteenOpenMs = floorWindow(nowMs, 15);
    return {
      compositePrice: currentPrice,
      observedAt: iso(nowMs),
      health: "healthy",
      healthMessage: "Demo feed simulates healthy Coinbase, Kraken and Binance data.",
      venues: ["Coinbase", "Kraken", "Binance"],
      fiveMinute: {
        durationMinutes: 5,
        openingPrice: 104_250,
        currentPrice,
        openedAt: iso(fiveOpenMs),
        closesAt: iso(fiveOpenMs + 5 * 60_000),
      },
      fifteenMinute: {
        durationMinutes: 15,
        openingPrice: 104_180,
        currentPrice,
        openedAt: iso(fifteenOpenMs),
        closesAt: iso(fifteenOpenMs + 15 * 60_000),
      },
    };
  }

  public signals(nowMs: number = Date.now()): readonly SignalView[] {
    const fiveOpenMs = floorWindow(nowMs, 5);
    const fifteenOpenMs = floorWindow(nowMs, 15);
    const active: readonly SignalView[] = [
      {
        id: `demo-5r-${fiveOpenMs}`,
        kind: "five_minute_reversal",
        direction: "higher",
        probability: 0.82,
        openingPrice: 104_250,
        currentPriceAtIssue: 104_218,
        issuedAt: iso(nowMs - 18_000),
        expiresAt: iso(fiveOpenMs + 5 * 60_000),
        modelVersion: "reversal-5m-demo.3",
        calibrationVersion: "demo-calibration.2",
        confidenceThreshold: 0.75,
        leadTimeSeconds: 74,
        riskLevel: "low",
        riskScore: 0.14,
        observedPosition: "below",
        outcome: "pending",
        observations: [
          observation(
            "flow",
            "Trade-flow reversal",
            "+1.8σ",
            "Aggressive buying recovered while price remained below the interval open.",
          ),
          observation(
            "depth",
            "Bid depth",
            "+27%",
            "Composite bid depth strengthened across the three demo venues.",
          ),
        ],
        modelFactors: [
          observation(
            "calibration",
            "Calibrated probability",
            "82%",
            "Probability is calibrated against held-out intervals in this illustrative demo.",
          ),
          observation(
            "regime",
            "Regime fit",
            "Strong",
            "Current simulated volatility is inside the model's validated range.",
          ),
        ],
        reportedContext: [],
        riskFlags: ["Demo values — not a live market signal"],
        dataMode: "demo",
        audit: {
          decisionId: `demo-decision-5r-${fiveOpenMs}`,
          policyVersion: "demo-policy.1",
          inputSnapshotId: `demo-snapshot-${nowMs}`,
          evaluatedAt: iso(nowMs - 18_000),
        },
      },
      {
        id: `demo-15r-${fifteenOpenMs}`,
        kind: "fifteen_minute_reversal",
        direction: "lower",
        probability: 0.78,
        openingPrice: 104_180,
        currentPriceAtIssue: 104_266,
        issuedAt: iso(nowMs - 42_000),
        expiresAt: iso(fifteenOpenMs + 15 * 60_000),
        modelVersion: "reversal-15m-demo.2",
        calibrationVersion: "demo-calibration.2",
        confidenceThreshold: 0.75,
        leadTimeSeconds: 156,
        riskLevel: "medium",
        riskScore: 0.31,
        observedPosition: "above",
        outcome: "pending",
        observations: [
          observation(
            "liquidity",
            "Offer liquidity",
            "+22%",
            "Simulated sell-side liquidity accumulated above the composite.",
          ),
        ],
        modelFactors: [
          observation(
            "calibration-15",
            "Calibrated probability",
            "78%",
            "Illustrative probability for interface evaluation only.",
          ),
        ],
        reportedContext: [],
        riskFlags: ["Demo values — not a live market signal"],
        dataMode: "demo",
        audit: {
          decisionId: `demo-decision-15r-${fifteenOpenMs}`,
          policyVersion: "demo-policy.1",
          inputSnapshotId: `demo-snapshot-${nowMs}`,
          evaluatedAt: iso(nowMs - 42_000),
        },
      },
      {
        id: `demo-5d-${fiveOpenMs}`,
        kind: "five_minute_early_direction",
        direction: "higher",
        probability: 0.76,
        openingPrice: 104_250,
        currentPriceAtIssue: 104_257,
        issuedAt: iso(fiveOpenMs + 31_000),
        expiresAt: iso(fiveOpenMs + 5 * 60_000),
        modelVersion: "direction-5m-demo.4",
        calibrationVersion: "demo-calibration.3",
        confidenceThreshold: 0.74,
        leadTimeSeconds: 240,
        riskLevel: "low",
        riskScore: 0.09,
        observedPosition: "above",
        outcome: "pending",
        observations: [
          observation(
            "venue",
            "Cross-venue agreement",
            "3 of 3",
            "All simulated venues moved in the predicted direction during the first minute.",
          ),
        ],
        modelFactors: [
          observation(
            "calibration-early",
            "Calibrated probability",
            "76%",
            "Illustrative probability for interface evaluation only.",
          ),
        ],
        reportedContext: [],
        riskFlags: ["Demo values — not a live market signal"],
        dataMode: "demo",
        audit: {
          decisionId: `demo-decision-5d-${fiveOpenMs}`,
          policyVersion: "demo-policy.1",
          inputSnapshotId: `demo-snapshot-${fiveOpenMs + 31_000}`,
          evaluatedAt: iso(fiveOpenMs + 31_000),
        },
      },
    ];
    const outcomes = ["correct", "incorrect", "flat", "void", "correct"] as const;
    const past = outcomes.map((outcome, index): SignalView => {
      const issuedAtMs = fiveOpenMs - (index + 1) * 5 * 60_000 + 35_000;
      return {
        id: `demo-history-${index}-${issuedAtMs}`,
        kind: index % 2 === 0 ? "five_minute_reversal" : "five_minute_early_direction",
        direction: index % 3 === 0 ? "lower" : "higher",
        probability: 0.74 + index * 0.02,
        openingPrice: 104_100 - index * 20,
        currentPriceAtIssue: 104_124 - index * 23,
        issuedAt: iso(issuedAtMs),
        expiresAt: iso(floorWindow(issuedAtMs, 5) + 5 * 60_000),
        modelVersion: "demo-history.1",
        calibrationVersion: "demo-calibration.1",
        confidenceThreshold: 0.72,
        leadTimeSeconds: 210,
        riskLevel: outcome === "void" ? "high" : "low",
        riskScore: outcome === "void" ? 0.78 : 0.18,
        observedPosition: index % 3 === 0 ? "above" : "below",
        outcome,
        outcomePrice: 104_090 - index * 12,
        observations: [
          observation(
            `history-observation-${index}`,
            "Archived observation",
            "Recorded",
            "Preserved with the original demo signal.",
          ),
        ],
        modelFactors: [
          observation(
            `history-factor-${index}`,
            "Archived model factor",
            "Recorded",
            "Preserved with the original demo model version.",
          ),
        ],
        reportedContext: [],
        riskFlags:
          outcome === "void"
            ? ["Demo venue interruption invalidated scoring"]
            : ["Demo values — not a live market signal"],
        dataMode: "demo",
        audit: {
          decisionId: `demo-history-decision-${index}`,
          policyVersion: "demo-policy.1",
          inputSnapshotId: `demo-history-snapshot-${index}`,
          evaluatedAt: iso(issuedAtMs),
        },
      };
    });
    return [...active, ...past];
  }
}
