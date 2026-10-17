import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BINANCE_SPOT_SIGNAL_FEATURE_NAMES,
  SignalTypeSchema,
} from "@flippars/contracts";
import { z } from "zod";
import { auditResearchTrades } from "../src/research/capture-decision-audit.js";

import {
  buildResearchDecision,
  buildResearchOutcome,
  researchCloseRelation,
  ResearchTradeSchema,
} from "../src/research/trade-features.js";

const fixtureSchema = z.object({
  schemaVersion: z.literal("flippars.synthetic-feature-parity/1"),
  scope: z.literal("SYNTHETIC_ONLY"),
  pipelineSha256: z.string(),
  pythonVersion: z.string(),
  numpyVersion: z.string(),
  cases: z
    .array(
      z.object({
        signalType: SignalTypeSchema,
        windowStart: z.string(),
        decisionAt: z.string(),
        observedThrough: z.string(),
        trades: z.array(ResearchTradeSchema),
        expectedFeatures: z.record(z.number().finite()),
        expectedCurrentRelation: z.string(),
        expectedCandidateEligible: z.boolean(),
        expectedLabel: z.string(),
      }),
    )
    .length(3),
});
const fixture = fixtureSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/trade-feature-parity.json", import.meta.url),
      "utf8",
    ),
  ) as unknown,
);

test("reference fixture binds the current Python pipeline and contains synthetic inputs only", () => {
  const pipeline = readFileSync(
    new URL(
      "../../model-training/src/flippars_model_training/pipeline.py",
      import.meta.url,
    ),
  );
  assert.equal(
    createHash("sha256").update(pipeline).digest("hex"),
    fixture.pipelineSha256,
  );
  assert.equal(fixture.scope, "SYNTHETIC_ONLY");
});

test("all 24 features and flat-retaining outcomes match Python for each signal type", () => {
  for (const sample of fixture.cases) {
    const result = buildResearchDecision(sample);
    assert.equal(result.status, "FEATURES");
    assert.deepEqual(Object.keys(result.values), [
      ...BINANCE_SPOT_SIGNAL_FEATURE_NAMES,
    ]);
    for (const feature of BINANCE_SPOT_SIGNAL_FEATURE_NAMES) {
      const expected = sample.expectedFeatures[feature]!;
      assert.ok(
        Math.abs(result.values[feature] - expected) <=
          1e-10 * Math.max(1, Math.abs(expected)),
        `${sample.signalType}: ${feature}`,
      );
    }
    assert.equal(result.currentRelation, sample.expectedCurrentRelation);
    assert.equal(result.candidateEligible, sample.expectedCandidateEligible);
    assert.equal(result.productionEligible, false);
    const outcome = buildResearchOutcome(sample);
    assert.equal(outcome.status, "OUTCOME");
    assert.equal(outcome.label, sample.expectedLabel);
    assert.equal(outcome.label, "AT_OPEN");
    assert.equal(outcome.productionEligible, false);
  }
});

test("trades at the decision and later outcomes cannot leak into features", () => {
  const sample = fixture.cases[0]!;
  const before = buildResearchDecision(sample);
  const cutoff = sample.decisionAt.replace(".000Z", ".000000Z");
  const trades = sample.trades.map((trade) =>
    trade.eventAt >= cutoff
      ? { ...trade, price: "999999999.12345", quantity: "999" }
      : trade,
  );
  const lastBefore = sample.trades.find((trade) =>
    trade.eventAt.includes("29.999999Z"),
  )!;
  assert.deepEqual(buildResearchDecision({ ...sample, trades }), before);
  const invalidFuture = trades.map((trade) =>
    trade.receivedAt >= sample.decisionAt
      ? { ...trade, price: "invalid-future-body" }
      : trade,
  );
  assert.deepEqual(buildResearchDecision({ ...sample, trades: invalidFuture }), before);
  if (before.status !== "FEATURES") throw new Error(before.reason);
  assert.equal(before.lastIncludedTradeId, lastBefore.tradeId);
});

test("decision-millisecond and later receipts are excluded; ID gaps abstain", () => {
  const sample = fixture.cases[0]!;
  const trades = structuredClone(sample.trades);
  const late = trades.find((trade) => trade.eventAt.includes("29.999999Z"))!;
  for (const offset of [0, 1]) {
    late.receivedAt = new Date(Date.parse(sample.decisionAt) + offset).toISOString();
    const result = buildResearchDecision({ ...sample, trades });
    assert.equal(result.status, "FEATURES");
    assert.notEqual(result.lastIncludedTradeId, late.tradeId);
  }
  trades.splice(5, 1);
  assert.equal(buildResearchDecision({ ...sample, trades }).status, "ABSTAIN");
});

test("missing lookback candles are retained as abstention even with contiguous IDs", () => {
  const sample = fixture.cases[0]!;
  const start = Date.parse(sample.windowStart) - 5 * 300_000;
  const trades = sample.trades
    .filter(
      (trade) =>
        Date.parse(trade.eventAt) < start ||
        Date.parse(trade.eventAt) >= start + 300_000,
    )
    .map((trade, index) => ({ ...trade, tradeId: String(index + 1) }));
  const result = buildResearchDecision({ ...sample, trades });
  assert.equal(result.status, "ABSTAIN");
  if (result.status === "ABSTAIN")
    assert.equal(result.reason, "GAPPED_OR_INSUFFICIENT_LOOKBACK");
  const noAnchor = sample.trades.slice(1);
  assert.equal(
    buildResearchDecision({ ...sample, trades: noAnchor }).status,
    "ABSTAIN",
  );
});

test("governed phase, cadence, alignment, and lead floors remain strict", () => {
  for (const sample of fixture.cases) {
    const offsets =
      sample.signalType === "FIVE_MINUTE_EARLY_DIRECTION"
        ? [0, 16, 60]
        : sample.signalType === "FIVE_MINUTE_REVERSAL"
          ? [0, 16, 300]
          : [285, 299, 885];
    for (const offset of offsets) {
      const decisionAt = new Date(
        Date.parse(sample.windowStart) + offset * 1_000,
      ).toISOString();
      assert.equal(buildResearchDecision({ ...sample, decisionAt }).status, "ABSTAIN");
    }
    assert.equal(
      buildResearchDecision({
        ...sample,
        windowStart: new Date(Date.parse(sample.windowStart) + 1).toISOString(),
      }).status,
      "ABSTAIN",
    );
  }
});

test("outcomes require both boundary anchors and closed targets", () => {
  const sample = fixture.cases[0]!;
  assert.equal(
    buildResearchOutcome({ ...sample, observedThrough: sample.decisionAt }).status,
    "ABSTAIN",
  );
  assert.equal(
    buildResearchOutcome({ ...sample, trades: sample.trades.slice(0, -1) }).status,
    "ABSTAIN",
  );
});

test("decimal deadband equality remains flat without binary rounding", () => {
  for (const [close, open] of [
    ["100.05", "100"],
    ["99.95", "100"],
    ["20050.02", "20040"],
    ["20029.98", "20040"],
  ]) {
    assert.equal(researchCloseRelation(close!, open!), "AT_OPEN");
  }
  assert.equal(researchCloseRelation("100.05000000000000000001", "100"), "ABOVE_OPEN");
  assert.equal(researchCloseRelation("99.94999999999999999999", "100"), "BELOW_OPEN");
});

test("capture decision audit remains research-only even when features are available", () => {
  const report = auditResearchTrades(fixture.cases[0]!.trades.slice(0, -1));
  assert.equal(report["modelLoaded"], false);
  assert.equal(report["productionEligible"], false);
  assert.equal(report["guardVerdict"], "UNASSESSED");
  const rows = z
    .array(
      z.object({
        decision: z.object({
          status: z.string(),
          productionEligible: z.literal(false),
        }),
      }),
    )
    .parse(report["decisions"]);
  assert.ok(rows.some((row) => row.decision.status === "FEATURES"));
});

test("zero-range candles remain finite and flat reversal prechecks stay ineligible", () => {
  for (const sample of fixture.cases) {
    const trades = sample.trades.map((trade) => ({ ...trade, price: "20040" }));
    const result = buildResearchDecision({ ...sample, trades });
    assert.equal(result.status, "FEATURES");
    assert.equal(result.values.previous_close_location, 0.5);
    assert.equal(result.values.current_close_location, 0.5);
    assert.equal(result.values.realized_volatility_12, 0);
    assert.equal(result.currentRelation, "AT_OPEN");
    assert.equal(
      result.candidateEligible,
      sample.signalType === "FIVE_MINUTE_EARLY_DIRECTION",
    );
    assert.ok(Object.values(result.values).every(Number.isFinite));
  }
});

test("empty target windows and absent partials abstain without synthetic prices", () => {
  const sample = fixture.cases[0]!;
  const start = Date.parse(sample.windowStart);
  const end = start + 300_000;
  const trades = sample.trades
    .filter(
      (trade) => Date.parse(trade.eventAt) < start || Date.parse(trade.eventAt) >= end,
    )
    .map((trade, index) => ({ ...trade, tradeId: String(index + 1) }));
  const decision = buildResearchDecision({ ...sample, trades });
  const outcome = buildResearchOutcome({ ...sample, trades });
  assert.equal(decision.status, "ABSTAIN");
  assert.equal(decision.reason, "NO_CURRENT_WINDOW_TRADES");
  assert.equal(outcome.status, "ABSTAIN");
  assert.equal(outcome.reason, "EMPTY_TARGET_WINDOW");
});
