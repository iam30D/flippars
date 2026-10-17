import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditResearchTrades,
  ResearchCaptureReplay,
} from "../src/research/capture-decision-audit.js";
import {
  buildResearchOutcome,
  ResearchOutcomeStream,
} from "../src/research/trade-features.js";
import type { ResearchTrade } from "../src/research/trade-features.js";

const start = Date.parse("2026-01-01T00:00:00.000Z");
function trade(index: number, offset: number, price = "100000"): ResearchTrade {
  const stamp = new Date(start + offset).toISOString();
  return {
    tradeId: String(index + 1),
    eventAt: stamp.replace("Z", "000Z"),
    receivedAt: stamp,
    price,
    quantity: "0.01",
    buyerIsMaker: index % 2 === 0,
  };
}

test("capture replay matches batch decisions/outcomes across schedules and target boundaries", () => {
  const trades = Array.from({ length: 1_001 }, (_, index) =>
    trade(index, index * 15_000, String(100000 + (index % 47))),
  );
  for (const count of [901, 902, 920, 921, 959, 960, 961, 1_001]) {
    const sample = trades.slice(0, count);
    const replay = new ResearchCaptureReplay(sample.at(-1)!.receivedAt);
    for (const item of sample) replay.ingest(item);
    assert.deepEqual(replay.snapshot(), auditResearchTrades(sample));
  }
});

test("replay freezes earlier decisions before equal and later receipts", () => {
  const trades = Array.from({ length: 1_011 }, (_, index) =>
    trade(index, index * 15_000),
  );
  const cutoff = start + 1_000 * 15_000 + 45_000;
  // The last early-direction decision is at 04:10:45; later price changes
  // remain available to outcomes but cannot rewrite that feature snapshot.
  for (let index = 1_003; index < trades.length; index++)
    trades[index]!.price = "200000";
  const replay = new ResearchCaptureReplay(trades.at(-1)!.receivedAt);
  for (const item of trades) replay.ingest(item);
  assert.ok(cutoff < Date.parse(trades.at(-1)!.receivedAt));
  assert.deepEqual(replay.snapshot(), auditResearchTrades(trades));
  const copy = replay.snapshot();
  (copy["decisions"] as Array<{ decision: { status: string } }>)[0]!.decision.status =
    "MUTATED";
  assert.deepEqual(replay.snapshot(), auditResearchTrades(trades));
});

test("fixed-window outcomes match exact labels, receipt exclusion and failure behavior", () => {
  const input = {
    signalType: "FIVE_MINUTE_REVERSAL" as const,
    windowStart: new Date(start + 300_000).toISOString(),
    observedThrough: new Date(start + 601_000).toISOString(),
  };
  const base = [
    trade(0, 299_000),
    trade(1, 300_000),
    trade(2, 599_000, "100050"),
    trade(3, 600_000),
    trade(4, 601_000, "999999"),
  ];
  const cases = [
    base,
    base.map((item, index) => (index === 2 ? { ...item, price: "100051" } : item)),
    base.map((item, index) => (index === 2 ? { ...item, price: "99949" } : item)),
    base.slice(1),
    base.slice(0, 3),
    base.filter((_, index) => index !== 2),
    [base[0]!, { ...base[1]!, tradeId: "9" }, ...base.slice(2)],
    [base[0]!, base[3]!, base[4]!].map((item, index) => ({
      ...item,
      tradeId: String(index + 1),
    })),
  ];
  for (const trades of cases) {
    const stream = new ResearchOutcomeStream(input);
    for (const item of trades) stream.ingest(item);
    assert.deepEqual(stream.snapshot(), buildResearchOutcome({ ...input, trades }));
  }
});

test("outcome state accepts more than the reference batch limit without retaining history", () => {
  const input = {
    signalType: "FIVE_MINUTE_REVERSAL" as const,
    windowStart: new Date(start + 300_000).toISOString(),
    observedThrough: new Date(start + 601_000).toISOString(),
  };
  const stream = new ResearchOutcomeStream(input);
  stream.ingest(trade(0, 299_000));
  for (let index = 1; index <= 100_001; index++)
    stream.ingest(trade(index, 300_000 + index));
  stream.ingest(trade(100_002, 600_000));
  const result = stream.snapshot();
  assert.equal(result.status, "OUTCOME");
  if (result.status === "OUTCOME") assert.equal(result.label, "AT_OPEN");
});

test("replay rejects missing terminal receipts and receipt regression", () => {
  const replay = new ResearchCaptureReplay(trade(2, 2_000).receivedAt);
  replay.ingest(trade(0, 1_000));
  assert.throws(() => replay.snapshot());
  assert.throws(() => replay.ingest(trade(1, 0)));
  assert.throws(() => replay.ingest(trade(1, 3_000)));
  assert.throws(() => replay.ingest(trade(1, 2_000)));
  assert.throws(() => replay.snapshot());
});
