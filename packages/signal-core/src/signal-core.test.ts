import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CandleDurationSeconds,
  DataMode,
  MarketSnapshot,
  PredictedCloseRelation,
  Signal,
  SignalType,
} from "@flippars/contracts";

import {
  CandleTracker,
  SignalEngine,
  buildCompositeSnapshot,
  evaluateSignalOutcome,
  generateSimulationSnapshots,
  getUtcAlignedWindow,
  replayExplicitPrices,
  scoreManipulationRisk,
  type CalibratedForecast,
  type ModelArtifact,
} from "./index.js";

const BASE_MS = Date.parse("2026-07-31T12:00:00.000Z");

function time(seconds: number): string {
  return new Date(BASE_MS + seconds * 1_000).toISOString();
}

function snapshot(
  at: string,
  price: string,
  dataMode: DataMode = "LIVE",
): MarketSnapshot {
  return buildCompositeSnapshot({
    observedAt: at,
    producedAt: at,
    dataMode,
    usdtUsdRate: "1",
    quotes: [
      {
        venue: "COINBASE",
        symbol: "BTC-USD",
        price,
        eventAt: at,
      },
      {
        venue: "KRAKEN",
        symbol: "XBT/USD",
        price,
        eventAt: at,
      },
      {
        venue: "BINANCE",
        symbol: "BTCUSDT",
        price,
        eventAt: at,
      },
    ],
  });
}

function candle(
  durationSeconds: CandleDurationSeconds,
  at: string,
  openPrice: string,
  currentPrice: string,
  dataMode: DataMode = "LIVE",
) {
  const tracker = new CandleTracker({
    durations: [durationSeconds],
    deadbandBps: 1,
  });
  const window = getUtcAlignedWindow(at, durationSeconds);
  tracker.updatePrice(openPrice, window.start, dataMode, durationSeconds);
  return tracker.updatePrice(currentPrice, at, dataMode, durationSeconds);
}

function artifact(
  signalType: SignalType,
  status: ModelArtifact["status"] = "APPROVED",
): ModelArtifact {
  return {
    artifactId: `artifact-${signalType}`,
    version: "1.0.0",
    signalType,
    status,
    approvedAt: status === "APPROVED" ? "2026-07-01T00:00:00.000Z" : null,
    calibrationVersion: "cal-1",
    calibrationValidUntil: "2027-01-01T00:00:00.000Z",
    featureSchemaVersion: "features-1",
    trainedThrough: "2026-06-30T00:00:00.000Z",
  };
}

function forecast(
  signalType: SignalType,
  at: string,
  predictedCloseRelation: PredictedCloseRelation,
  overrides: Partial<CalibratedForecast> = {},
): CalibratedForecast {
  return {
    id: `forecast-${signalType}-${at}-${predictedCloseRelation}`,
    signalType,
    artifactId: `artifact-${signalType}`,
    generatedAt: at,
    predictedCloseRelation,
    probability: 0.9,
    calibrated: true,
    calibrationVersion: "cal-1",
    outOfDistribution: false,
    evidence: [
      {
        kind: "PRICE_ACTION",
        label: "Replay fixture",
        value: "qualified",
        direction: "SUPPORTS",
      },
    ],
    ...overrides,
  };
}

function requireSignal(decision: ReturnType<SignalEngine["evaluate"]>): Signal {
  if (decision.kind !== "SIGNAL") {
    throw new Error(`Expected signal, got ${decision.reason}`);
  }
  return decision.signal;
}

describe("UTC-aligned windows and candle tracking", () => {
  it("uses half-open five-minute UTC windows", () => {
    const beforeBoundary = getUtcAlignedWindow("2026-07-31T12:04:59.999Z", 300);
    const onBoundary = getUtcAlignedWindow("2026-07-31T12:05:00.000Z", 300);

    assert.equal(beforeBoundary.start, "2026-07-31T12:00:00.000Z");
    assert.equal(beforeBoundary.end, "2026-07-31T12:05:00.000Z");
    assert.equal(onBoundary.start, "2026-07-31T12:05:00.000Z");
  });

  it("resets the opening price exactly at a five-minute boundary", () => {
    const tracker = new CandleTracker({ durations: [300] });
    const first = tracker.updatePrice(
      "60000",
      "2026-07-31T12:04:59.999Z",
      "SIMULATION",
      300,
    );
    const next = tracker.updatePrice(
      "60125",
      "2026-07-31T12:05:00.000Z",
      "SIMULATION",
      300,
    );

    assert.equal(first.openPrice, "60000");
    assert.equal(next.openPrice, "60125");
    assert.equal(next.sampleCount, 1);
    assert.equal(next.windowStart, "2026-07-31T12:05:00.000Z");
  });
});

describe("venue composite safety gates", () => {
  it("normalizes Binance BTCUSDT through the USDT/USD reference", () => {
    const at = time(10);
    const result = buildCompositeSnapshot({
      observedAt: at,
      dataMode: "LIVE",
      usdtUsdRate: "0.999",
      quotes: [
        {
          venue: "COINBASE",
          symbol: "BTC-USD",
          price: "59950",
          eventAt: at,
        },
        {
          venue: "KRAKEN",
          symbol: "XBT/USD",
          price: "59960",
          eventAt: at,
        },
        {
          venue: "BINANCE",
          symbol: "BTCUSDT",
          price: "60000",
          eventAt: at,
        },
      ],
    });
    const binance = result.venues.find((quote) => quote.venue === "BINANCE");

    assert.equal(binance?.normalizedPrice, "59940");
    assert.equal(binance?.eligible, true);
    assert.equal(result.compositePrice, "59950");
  });

  it("excludes a depegged Binance quote while retaining a two-venue quorum", () => {
    const at = time(10);
    const result = buildCompositeSnapshot({
      observedAt: at,
      dataMode: "LIVE",
      usdtUsdRate: "0.98",
      quotes: [
        {
          venue: "COINBASE",
          symbol: "BTC-USD",
          price: "60000",
          eventAt: at,
        },
        {
          venue: "KRAKEN",
          symbol: "XBT/USD",
          price: "60010",
          eventAt: at,
        },
        {
          venue: "BINANCE",
          symbol: "BTCUSDT",
          price: "61200",
          eventAt: at,
        },
      ],
    });
    const binance = result.venues.find((quote) => quote.venue === "BINANCE");

    assert.equal(result.eligibleVenueCount, 2);
    assert.equal(result.compositePrice, "60005");
    assert.equal(binance?.eligible, false);
    assert.equal(binance?.normalizedPrice, null);
    assert.ok(result.healthFlags.some((flag) => flag.code === "USDT_DEPEG"));
  });

  it("withholds the composite when stale feeds break quorum", () => {
    const observedAt = time(10);
    const staleAt = time(4);
    const result = buildCompositeSnapshot({
      observedAt,
      dataMode: "LIVE",
      usdtUsdRate: "1",
      quotes: [
        {
          venue: "COINBASE",
          symbol: "BTC-USD",
          price: "60000",
          eventAt: observedAt,
        },
        {
          venue: "KRAKEN",
          symbol: "XBT/USD",
          price: "60000",
          eventAt: staleAt,
        },
        {
          venue: "BINANCE",
          symbol: "BTCUSDT",
          price: "60000",
          eventAt: staleAt,
        },
      ],
    });

    assert.equal(result.eligibleVenueCount, 1);
    assert.equal(result.compositePrice, null);
    assert.equal(result.health, "UNAVAILABLE");
    assert.ok(result.healthFlags.some((flag) => flag.code === "QUORUM_NOT_MET"));
  });
});

describe("five-minute reversal semantics", () => {
  it("signals below-open close while current price is still above the open", () => {
    const at = time(30);
    const type = "FIVE_MINUTE_REVERSAL";
    const decision = new SignalEngine().evaluate({
      snapshot: snapshot(at, "60100"),
      candle: candle(300, at, "60000", "60100"),
      forecast: forecast(type, at, "BELOW_OPEN"),
      artifact: artifact(type),
    });
    const signal = requireSignal(decision);

    assert.equal(signal.observedPosition, "ABOVE_OPEN");
    assert.equal(signal.predictedCloseRelation, "BELOW_OPEN");
    assert.equal(signal.informationalOnly, true);
  });

  it("supports the exact vice-versa case below open to predicted above open", () => {
    const at = time(40);
    const type = "FIVE_MINUTE_REVERSAL";
    const decision = new SignalEngine().evaluate({
      snapshot: snapshot(at, "59900"),
      candle: candle(300, at, "60000", "59900"),
      forecast: forecast(type, at, "ABOVE_OPEN"),
      artifact: artifact(type),
    });
    const signal = requireSignal(decision);

    assert.equal(signal.observedPosition, "BELOW_OPEN");
    assert.equal(signal.predictedCloseRelation, "ABOVE_OPEN");
  });

  it("abstains when current position is not opposite the predicted close", () => {
    const at = time(40);
    const type = "FIVE_MINUTE_REVERSAL";
    const decision = new SignalEngine().evaluate({
      snapshot: snapshot(at, "60100"),
      candle: candle(300, at, "60000", "60100"),
      forecast: forecast(type, at, "ABOVE_OPEN"),
      artifact: artifact(type),
    });

    assert.equal(decision.kind, "ABSTAIN");
    if (decision.kind === "ABSTAIN") {
      assert.equal(decision.reason, "CURRENT_POSITION_NOT_OPPOSITE");
    }
  });

  it("deduplicates one alert per type and UTC window", () => {
    const at = time(40);
    const type = "FIVE_MINUTE_REVERSAL";
    const engine = new SignalEngine();
    const input = {
      snapshot: snapshot(at, "60100"),
      candle: candle(300, at, "60000", "60100"),
      forecast: forecast(type, at, "BELOW_OPEN"),
      artifact: artifact(type),
    } as const;

    assert.equal(engine.evaluate(input).kind, "SIGNAL");
    const duplicate = engine.evaluate({
      ...input,
      forecast: forecast(type, at, "BELOW_OPEN", {
        id: "second-qualified-forecast",
      }),
    });
    assert.equal(duplicate.kind, "ABSTAIN");
    if (duplicate.kind === "ABSTAIN") {
      assert.equal(duplicate.reason, "DUPLICATE");
    }
  });

  it("treats a small move inside the neutral band as flat", () => {
    const at = time(40);
    const type = "FIVE_MINUTE_REVERSAL";
    const decision = new SignalEngine().evaluate({
      snapshot: snapshot(at, "60000.5"),
      candle: candle(300, at, "60000", "60000.5"),
      forecast: forecast(type, at, "BELOW_OPEN"),
      artifact: artifact(type),
    });

    assert.equal(decision.kind, "ABSTAIN");
    if (decision.kind === "ABSTAIN") {
      assert.equal(decision.reason, "DEAD_BAND");
    }
  });
});

describe("approved signal timing boundaries", () => {
  it("opens 15-minute reversal eligibility at exactly 7:30 remaining", () => {
    const type = "FIFTEEN_MINUTE_REVERSAL";
    const justBefore = time(449.999);
    const boundary = time(450);

    const early = new SignalEngine().evaluate({
      snapshot: snapshot(justBefore, "60100"),
      candle: candle(900, justBefore, "60000", "60100"),
      forecast: forecast(type, justBefore, "BELOW_OPEN"),
      artifact: artifact(type),
    });
    const eligible = new SignalEngine().evaluate({
      snapshot: snapshot(boundary, "60100"),
      candle: candle(900, boundary, "60000", "60100"),
      forecast: forecast(type, boundary, "BELOW_OPEN"),
      artifact: artifact(type),
    });

    assert.equal(early.kind, "ABSTAIN");
    if (early.kind === "ABSTAIN") {
      assert.equal(early.reason, "NOT_IN_SIGNAL_PHASE");
    }
    assert.equal(eligible.kind, "SIGNAL");
  });

  it("keeps the minimum lead-time gate in the final 15-minute phase", () => {
    const at = time(880);
    const type = "FIFTEEN_MINUTE_REVERSAL";
    const decision = new SignalEngine().evaluate({
      snapshot: snapshot(at, "60100"),
      candle: candle(900, at, "60000", "60100"),
      forecast: forecast(type, at, "BELOW_OPEN"),
      artifact: artifact(type),
    });

    assert.equal(decision.kind, "ABSTAIN");
    if (decision.kind === "ABSTAIN") {
      assert.equal(decision.reason, "INSUFFICIENT_LEAD_TIME");
    }
  });

  it("closes early-direction eligibility at exactly 60 seconds", () => {
    const type = "FIVE_MINUTE_EARLY_DIRECTION";
    const within = time(59.999);
    const boundary = time(60);

    const eligible = new SignalEngine().evaluate({
      snapshot: snapshot(within, "60010"),
      candle: candle(300, within, "60000", "60010"),
      forecast: forecast(type, within, "ABOVE_OPEN"),
      artifact: artifact(type),
    });
    const late = new SignalEngine().evaluate({
      snapshot: snapshot(boundary, "60010"),
      candle: candle(300, boundary, "60000", "60010"),
      forecast: forecast(type, boundary, "ABOVE_OPEN"),
      artifact: artifact(type),
    });

    assert.equal(eligible.kind, "SIGNAL");
    assert.equal(late.kind, "ABSTAIN");
    if (late.kind === "ABSTAIN") {
      assert.equal(late.reason, "NOT_IN_SIGNAL_PHASE");
    }
  });
});

describe("abstention and governance policy", () => {
  it("suppresses a qualified forecast during high anomaly risk", () => {
    const at = time(40);
    const type = "FIVE_MINUTE_REVERSAL";
    const metrics = {
      absoluteReturnZScore: 10,
      volumeZScore: 10,
      spreadBps: 100,
      liquidityDropPercent: 100,
      crossVenueDivergenceBps: 200,
      liquidationZScore: 10,
      absoluteOrderBookImbalance: 1,
      cancellationRate: 1,
      stablecoinDeviationBps: 120,
    };
    assert.equal(scoreManipulationRisk(metrics).suppress, true);

    const decision = new SignalEngine().evaluate({
      snapshot: snapshot(at, "60100"),
      candle: candle(300, at, "60000", "60100"),
      forecast: forecast(type, at, "BELOW_OPEN"),
      artifact: artifact(type),
      riskMetrics: metrics,
    });

    assert.equal(decision.kind, "ABSTAIN");
    if (decision.kind === "ABSTAIN") {
      assert.equal(decision.reason, "ANOMALY_RISK");
      assert.match(
        decision.riskAssessment.disclaimer,
        /does not establish manipulative intent/,
      );
    }
  });

  it("suppresses stale snapshots at decision time", () => {
    const quoteAt = time(30);
    const evaluatedAt = time(36);
    const type = "FIVE_MINUTE_REVERSAL";
    const decision = new SignalEngine().evaluate({
      snapshot: snapshot(quoteAt, "60100"),
      candle: candle(300, quoteAt, "60000", "60100"),
      forecast: forecast(type, evaluatedAt, "BELOW_OPEN"),
      artifact: artifact(type),
      evaluatedAt,
    });

    assert.equal(decision.kind, "ABSTAIN");
    if (decision.kind === "ABSTAIN") {
      assert.equal(decision.reason, "SNAPSHOT_STALE");
    }
  });

  it("never emits a live signal from an unapproved model artifact", () => {
    const at = time(40);
    const type = "FIVE_MINUTE_REVERSAL";
    const decision = new SignalEngine().evaluate({
      snapshot: snapshot(at, "60100"),
      candle: candle(300, at, "60000", "60100"),
      forecast: forecast(type, at, "BELOW_OPEN"),
      artifact: artifact(type, "SHADOW"),
    });

    assert.equal(decision.kind, "ABSTAIN");
    if (decision.kind === "ABSTAIN") {
      assert.equal(decision.reason, "MODEL_UNAPPROVED");
    }
  });

  it("permits shadow artifacts only in explicitly marked simulation data", () => {
    const at = time(40);
    const type = "FIVE_MINUTE_REVERSAL";
    const decision = new SignalEngine().evaluate({
      snapshot: snapshot(at, "60100", "SIMULATION"),
      candle: candle(300, at, "60000", "60100", "SIMULATION"),
      forecast: forecast(type, at, "BELOW_OPEN"),
      artifact: artifact(type, "SHADOW"),
    });
    const signal = requireSignal(decision);

    assert.equal(signal.dataMode, "SIMULATION");
    assert.ok(signal.healthFlags.some((flag) => flag.code === "SIMULATION_DATA"));
  });

  it("abstains when the composite has no quorum", () => {
    const at = time(40);
    const type = "FIVE_MINUTE_REVERSAL";
    const unavailable = buildCompositeSnapshot({
      observedAt: at,
      dataMode: "LIVE",
      usdtUsdRate: "1",
      quotes: [
        {
          venue: "COINBASE",
          symbol: "BTC-USD",
          price: "60100",
          eventAt: at,
        },
      ],
    });
    const decision = new SignalEngine().evaluate({
      snapshot: unavailable,
      candle: candle(300, at, "60000", "60100"),
      forecast: forecast(type, at, "BELOW_OPEN"),
      artifact: artifact(type),
    });

    assert.equal(decision.kind, "ABSTAIN");
    if (decision.kind === "ABSTAIN") {
      assert.equal(decision.reason, "MARKET_UNAVAILABLE");
    }
  });
});

describe("outcome scoring", () => {
  function issuedSignal(): Signal {
    const at = time(40);
    const type = "FIVE_MINUTE_REVERSAL";
    return requireSignal(
      new SignalEngine().evaluate({
        snapshot: snapshot(at, "60100"),
        candle: candle(300, at, "60000", "60100"),
        forecast: forecast(type, at, "BELOW_OPEN"),
        artifact: artifact(type),
      }),
    );
  }

  it("keeps outcomes pending before the immutable window end", () => {
    const result = evaluateSignalOutcome(issuedSignal(), {
      evaluatedAt: time(299.999),
      closePrice: "59000",
    });
    assert.equal(result.status, "PENDING");
    assert.equal(result.closePrice, null);
  });

  it("scores correct, incorrect, and flat closes", () => {
    const signal = issuedSignal();
    const correct = evaluateSignalOutcome(signal, {
      evaluatedAt: time(300),
      closePrice: "59900",
    });
    const incorrect = evaluateSignalOutcome(signal, {
      evaluatedAt: time(300),
      closePrice: "60100",
    });
    const flat = evaluateSignalOutcome(signal, {
      evaluatedAt: time(300),
      closePrice: "60000.5",
    });

    assert.equal(correct.status, "CORRECT");
    assert.equal(incorrect.status, "INCORRECT");
    assert.equal(flat.status, "FLAT");
    assert.equal(flat.actualCloseRelation, "AT_OPEN");
  });

  it("voids an outcome when no trustworthy close exists", () => {
    const result = evaluateSignalOutcome(issuedSignal(), {
      evaluatedAt: time(300),
      reliable: false,
      voidReason: "Closing venue quorum failed",
    });
    assert.equal(result.status, "VOID");
    assert.equal(result.reason, "Closing venue quorum failed");
  });
});

describe("deterministic simulation utilities", () => {
  it("replays the same seed to byte-equivalent snapshots", () => {
    const options = {
      startAt: time(0),
      startPrice: "60000",
      tickCount: 5,
      stepMs: 1_000,
      seed: 42,
    } as const;
    const first = generateSimulationSnapshots(options);
    const second = generateSimulationSnapshots(options);

    assert.deepEqual(first, second);
    assert.ok(first.every((item) => item.dataMode === "SIMULATION"));
  });

  it("marks explicit replay prices as simulation data", () => {
    const [result] = replayExplicitPrices([{ at: time(0), price: "60000" }]);
    assert.equal(result?.dataMode, "SIMULATION");
    assert.ok(result?.healthFlags.some((flag) => flag.code === "SIMULATION_DATA"));
  });
});
