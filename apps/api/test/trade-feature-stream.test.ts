import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SignalTypeSchema } from "@flippars/contracts";
import { z } from "zod";

import {
  buildResearchDecision,
  ResearchFeatureStream,
  ResearchTradeSchema,
} from "../src/research/trade-features.js";
import type { ResearchTrade } from "../src/research/trade-features.js";

const fixture = z
  .object({
    cases: z.array(
      z.object({
        signalType: SignalTypeSchema,
        windowStart: z.string(),
        decisionAt: z.string(),
        trades: z.array(ResearchTradeSchema),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/trade-feature-parity.json", import.meta.url),
        "utf8",
      ),
    ) as unknown,
  );

test("rolling research state matches batch/Python-reference decisions for all targets", () => {
  for (const sample of fixture.cases) {
    const stream = new ResearchFeatureStream(sample.signalType);
    for (const trade of sample.trades) {
      if (trade.receivedAt >= sample.decisionAt) break;
      stream.ingest(trade);
    }
    assert.deepEqual(stream.snapshot(sample), buildResearchDecision(sample));
    assert.ok(stream.statistics().retainedCandles <= 14);
  }
});

test("chronological snapshots preserve earlier results and ignore future event-time packets", () => {
  const sample = fixture.cases[0]!;
  const stream = new ResearchFeatureStream(sample.signalType);
  let index = 0;
  for (const offset of [15, 30, 45]) {
    const decisionAt = new Date(
      Date.parse(sample.windowStart) + offset * 1_000,
    ).toISOString();
    while (
      index < sample.trades.length &&
      sample.trades[index]!.receivedAt < decisionAt
    ) {
      stream.ingest(sample.trades[index++]!);
    }
    const request = { windowStart: sample.windowStart, decisionAt };
    const result = stream.snapshot(request);
    assert.deepEqual(result, buildResearchDecision({ ...sample, decisionAt }));
    if (result.status === "FEATURES") result.values.previous_return_bps = 123456;
    assert.deepEqual(
      stream.snapshot(request),
      buildResearchDecision({ ...sample, decisionAt }),
    );
  }
  const past = stream.snapshot({
    windowStart: sample.windowStart,
    decisionAt: sample.decisionAt,
  });
  assert.equal(past.status, "ABSTAIN");
  assert.equal(past.reason, "NON_MONOTONIC_REPLAY");
});

test("rolling state stays bounded over 200 windows and warms up without synthetic history", () => {
  const stream = new ResearchFeatureStream("FIVE_MINUTE_EARLY_DIRECTION");
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  let id = 0;
  const trade = (at: number): ResearchTrade => ({
    tradeId: String(++id),
    eventAt: new Date(at).toISOString().replace(".000Z", ".000000Z"),
    receivedAt: new Date(at).toISOString(),
    price: "20040",
    quantity: "0.1",
    buyerIsMaker: id % 2 === 0,
  });
  stream.ingest(trade(base - 1_000));
  for (let window = 0; window < 200; window++) {
    const start = base + window * 300_000;
    stream.ingest(trade(start));
    stream.ingest(trade(start + 14_000));
    const result = stream.snapshot({
      windowStart: new Date(start).toISOString(),
      decisionAt: new Date(start + 30_000).toISOString(),
    });
    assert.equal(result.status, window < 13 ? "ABSTAIN" : "FEATURES");
    assert.equal(result.productionEligible, false);
    assert.ok(stream.statistics().retainedCandles <= 14);
    assert.ok(stream.statistics().pendingTrades <= 2);
  }
});

test("a trade-ID failure poisons future snapshots without rewriting a cached decision", () => {
  const sample = fixture.cases[0]!;
  const stream = new ResearchFeatureStream(sample.signalType);
  const visible = sample.trades.filter((trade) => trade.receivedAt < sample.decisionAt);
  for (const trade of visible) stream.ingest(trade);
  const before = stream.snapshot(sample);
  const last = visible.at(-1)!;
  assert.throws(() =>
    stream.ingest({
      ...last,
      tradeId: String(BigInt(last.tradeId) + 2n),
      receivedAt: sample.decisionAt,
    }),
  );
  assert.deepEqual(stream.snapshot(sample), before);
  const next = stream.snapshot({
    windowStart: sample.windowStart,
    decisionAt: new Date(Date.parse(sample.decisionAt) + 15_000).toISOString(),
  });
  assert.equal(next.status, "ABSTAIN");
  assert.equal(next.reason, "INVALID_OR_DISCONTINUOUS_STREAM");
  assert.throws(() =>
    stream.ingest({ ...last, tradeId: String(BigInt(last.tradeId) + 1n) }),
  );
});

test("a known future exchange event waits until its event-time cutoff", () => {
  const sample = fixture.cases[0]!;
  const stream = new ResearchFeatureStream(sample.signalType);
  const trades = structuredClone(sample.trades);
  const future = trades.find(
    (trade) => trade.eventAt === sample.decisionAt.replace(".000Z", ".000000Z"),
  )!;
  future.receivedAt = new Date(Date.parse(sample.decisionAt) - 1).toISOString();
  for (const trade of trades) {
    if (trade.receivedAt >= sample.decisionAt) break;
    stream.ingest(trade);
  }
  assert.deepEqual(
    stream.snapshot(sample),
    buildResearchDecision({ ...sample, trades }),
  );
  assert.ok(stream.statistics().pendingTrades >= 1);
});

test("pending limits and missing windows fail closed without unbounded state", () => {
  assert.throws(
    () => new ResearchFeatureStream("FIVE_MINUTE_EARLY_DIRECTION", 100_001),
  );
  const limited = new ResearchFeatureStream("FIVE_MINUTE_EARLY_DIRECTION", 2);
  const future: ResearchTrade = {
    tradeId: "1",
    eventAt: "2026-01-01T00:01:00.000000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    price: "20040",
    quantity: "0.1",
    buyerIsMaker: true,
  };
  limited.ingest(future);
  limited.ingest({ ...future, tradeId: "2" });
  assert.throws(() => limited.ingest({ ...future, tradeId: "3" }));
  assert.equal(limited.statistics().pendingTrades, 0);
  assert.equal(
    limited.snapshot({
      windowStart: "2026-01-01T00:00:00.000Z",
      decisionAt: "2026-01-01T00:00:30.000Z",
    }).status,
    "ABSTAIN",
  );

  const sample = fixture.cases[0]!;
  const stream = new ResearchFeatureStream(sample.signalType);
  const gapStart = Date.parse(sample.windowStart) - 5 * 300_000;
  const trades = sample.trades
    .filter(
      (trade) =>
        Date.parse(trade.eventAt) < gapStart ||
        Date.parse(trade.eventAt) >= gapStart + 300_000,
    )
    .map((trade, index) => ({ ...trade, tradeId: String(index + 1) }));
  for (const trade of trades) {
    if (trade.receivedAt >= sample.decisionAt) break;
    stream.ingest(trade);
  }
  const result = stream.snapshot(sample);
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "GAPPED_OR_INSUFFICIENT_LOOKBACK");
});
