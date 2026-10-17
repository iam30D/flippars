import assert from "node:assert/strict";
import { test } from "node:test";
import { ResearchCaptureQuality } from "../src/research/capture-quality-audit.js";

const base = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(base + ms).toISOString();
function record(kind: string, ms: number, extras: Record<string, unknown> = {}) {
  return {
    kind,
    receivedAt: iso(ms),
    receivedMonotonicNs: String(BigInt(ms) * 1_000_000n),
    ...extras,
  };
}
function start() {
  const audit = new ResearchCaptureQuality();
  audit.ingest(record("SESSION_START", 0));
  return audit;
}
function trade(received: number, event: string, published = event) {
  return record("TRADE", received, {
    source: "binance",
    trade: { eventAt: event, publishedAt: published },
  });
}
function ticker(received: number, instrument: string) {
  return record("GUARD_INPUT", received, {
    source: "coinbase",
    raw: JSON.stringify({ type: "ticker", product_id: instrument }),
  });
}

test("quality differences preserve exact microseconds and diagnostic boundary equality", () => {
  const audit = start();
  audit.ingest(
    trade(5_000, "2026-01-01T00:00:00.000000Z", "2026-01-01T00:00:00.000500Z"),
  );
  audit.ingest(trade(5_001, "2026-01-01T00:00:00.000999Z"));
  audit.ingest(trade(5_002, "2026-01-01T00:00:05.003001Z"));
  audit.ingest(record("SESSION_END", 6_000));
  const report = audit.finish();
  assert.equal(report.receiptMinusEvent.count, 3);
  assert.equal(report.receiptMinusEvent.maximumMs, 5_000.001);
  assert.equal(report.receiptMinusEvent.minimumMs, -1.001);
  assert.equal(report.receiptMinusEvent.overFiveSecondsCount, 1);
  assert.equal(report.receiptMinusEvent.moreThanOneMsNegativeCount, 1);
  assert.equal(report.publicationMinusEvent.maximumMs, 0.5);
  assert.equal(report.guardVerdict, "UNASSESSED");
  assert.equal(report.clockVerdict, "UNASSESSED");
  assert.equal(report.productionEligible, false);
});

test("source activity cannot hide a silent or missing instrument", () => {
  const audit = start();
  audit.ingest(ticker(1_000, "BTC-USD"));
  for (let at = 2_000; at <= 20_000; at += 1_000) audit.ingest(ticker(at, "USDT-USD"));
  audit.ingest(ticker(21_000, "BTC-USD"));
  audit.ingest(record("SESSION_END", 22_000));
  const report = audit.finish();
  assert.equal(report.sources["coinbase"]!.maximumDataGapMs, 1_000);
  assert.equal(report.instruments["coinbase:BTC-USD"]!.maximumDataGapMs, 20_000);
  assert.equal(report.instruments["coinbase:BTC-USD"]!.initialDataWaitMs, 1_000);
  assert.equal(report.instruments["coinbase:BTC-USD"]!.terminalDataSilenceMs, 1_000);
  assert.equal(report.instruments["kraken:BTC/USD"]!.count, 0);
  assert.equal(report.instruments["kraken:BTC/USD"]!.terminalDataSilenceMs, null);
  report.instruments["coinbase:BTC-USD"]!.longestGap!.from = "mutated";
  assert.equal(
    audit.finish().instruments["coinbase:BTC-USD"]!.longestGap!.from,
    iso(1_000),
  );
});

test("unknown/control packets cannot refresh data timelines and duplicate symbols count once", () => {
  const audit = start();
  audit.ingest(record("UNKNOWN", 1_000, { source: "binance" }));
  audit.ingest(record("CONTROL", 2_000, { source: "kraken" }));
  audit.ingest(
    record("GUARD_INPUT", 3_000, {
      source: "kraken",
      raw: JSON.stringify({
        channel: "ticker",
        data: [{ symbol: "BTC/USD" }, { symbol: "BTC/USD" }],
      }),
    }),
  );
  audit.ingest(record("SESSION_END", 4_000));
  const report = audit.finish();
  assert.equal(report.sources["binance"]!.count, 0);
  assert.equal(report.sources["kraken"]!.count, 1);
  assert.equal(report.instruments["kraken:BTC/USD"]!.count, 1);
});

test("invalid payloads and clock/session regressions permanently prevent quality reports", () => {
  for (const bad of [
    record("SESSION_START", 1_000),
    ticker(0, "OTHER"),
    record("TRADE", 1_000, { source: "coinbase", trade: {} }),
    record("CONTROL", 1_000, { receivedMonotonicNs: "-1" }),
  ]) {
    const audit = start();
    assert.throws(() => audit.ingest(bad));
    assert.throws(() => audit.ingest(record("SESSION_END", 2_000)));
    assert.throws(() => audit.finish());
  }
  const audit = start();
  assert.throws(() => audit.finish());
  audit.ingest(ticker(1_000, "BTC-USD"));
  assert.throws(() => audit.ingest(ticker(999, "USDT-USD")));
  assert.throws(() => audit.finish());
});
