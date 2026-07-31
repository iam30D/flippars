import assert from "node:assert/strict";
import test from "node:test";
import { formatPercent, formatSignedUsd, formatUsd, relativeDelta } from "./format";

void test("formats composite prices consistently as US dollars", () => {
  assert.equal(formatUsd(12_345.678), "$12,345.68");
  assert.equal(formatUsd(null), "Unavailable");
});

void test("formats signed deltas with explicit non-color cues", () => {
  assert.equal(formatSignedUsd(25), "+$25.00");
  assert.equal(formatSignedUsd(-25), "−$25.00");
  assert.equal(formatSignedUsd(0), "±$0.00");
});

void test("clamps probability formatting and calculates relative price delta", () => {
  assert.equal(formatPercent(0.824), "82%");
  assert.equal(formatPercent(2), "100%");
  assert.equal(relativeDelta(100, 101), 0.01);
  assert.equal(relativeDelta(0, 101), 0);
});
