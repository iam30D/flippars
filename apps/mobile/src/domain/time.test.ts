import assert from "node:assert/strict";
import test from "node:test";
import { countdownTo, formatCountdown, isIsoFresh, minutesToClock } from "./time";

void test("countdown rounds partial seconds up so an active interval never displays closed early", () => {
  const target = "2026-07-31T12:05:00.000Z";
  const result = countdownTo(target, Date.parse("2026-07-31T12:04:58.500Z"));
  assert.deepEqual(result, { expired: false, totalSeconds: 2, minutes: 0, seconds: 2 });
  assert.equal(formatCountdown(result), "00:02");
});

void test("countdown clamps past and invalid timestamps to closed", () => {
  assert.equal(
    countdownTo("2026-07-31T12:00:00.000Z", Date.parse("2026-07-31T12:00:01.000Z"))
      .expired,
    true,
  );
  assert.equal(formatCountdown(countdownTo("not-a-date", 0)), "Closed");
});

void test("freshness is strict at the expiry boundary", () => {
  const expiry = "2026-07-31T12:05:00.000Z";
  assert.equal(isIsoFresh(expiry, Date.parse("2026-07-31T12:04:59.999Z")), true);
  assert.equal(isIsoFresh(expiry, Date.parse(expiry)), false);
});

void test("quiet hour clock formatting wraps around midnight", () => {
  assert.equal(minutesToClock(22 * 60 + 30), "22:30");
  assert.equal(minutesToClock(1_440 + 30), "00:30");
  assert.equal(minutesToClock(-30), "23:30");
});
