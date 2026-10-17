import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureClockContinuity } from "../src/research/capture-clock.js";
import { LongCaptureSettingsSchema } from "../src/research/capture-revisions.js";

const startedAt = "2026-01-01T00:00:00.000Z";
test("relative capture clock accepts equal stamps and the declared one-second skew boundary", () => {
  const clock = new CaptureClockContinuity(startedAt);
  clock.accept(startedAt, "0");
  clock.accept(startedAt, "0");
  clock.accept("2026-01-01T00:00:02.000Z", "1000000000");
});

test("wall jumps, wall regression, monotonic regression and malformed clocks fail", () => {
  for (const [wall, mono] of [
    ["2026-01-01T00:00:02.002Z", "1000000001"],
    [startedAt, "1000000001"],
    ["2026-01-01T00:00:01.000Z", "1"],
    ["invalid", "1000000000"],
    ["2026-01-01T00:00:01.000Z", "-1"],
  ]) {
    const clock = new CaptureClockContinuity(startedAt);
    clock.accept("2026-01-01T00:00:01.000Z", "1000000000");
    assert.throws(() => clock.accept(wall!, mono!));
  }
});

test("long-session settings allow 225 minutes but retain hard time and storage bounds", () => {
  const input = { outputParent: "external", seconds: 13_500, maxMiB: 1_024 };
  assert.deepEqual(LongCaptureSettingsSchema.parse(input), input);
  for (const extra of [
    { seconds: 13_501 },
    { seconds: 9 },
    { maxMiB: 1_025 },
    { maxMiB: 0 },
  ])
    assert.throws(() => LongCaptureSettingsSchema.parse({ ...input, ...extra }));
});
