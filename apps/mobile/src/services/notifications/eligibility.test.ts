import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PREFERENCES, type GuestPreferencesView } from "../../domain/models";
import { notificationEligibility } from "./eligibility";

const now = new Date("2026-07-31T23:15:00.000Z");
const candidate = {
  signalKind: "five_minute_reversal" as const,
  expiresAt: "2026-07-31T23:20:00.000Z",
};

void test("allows an enabled, fresh signal outside quiet hours", () => {
  assert.deepEqual(notificationEligibility(candidate, DEFAULT_PREFERENCES, now), {
    eligible: true,
    reason: "eligible",
  });
});

void test("discards stale notification candidates", () => {
  assert.deepEqual(
    notificationEligibility(
      { ...candidate, expiresAt: now.toISOString() },
      DEFAULT_PREFERENCES,
      now,
    ),
    { eligible: false, reason: "stale" },
  );
});

void test("respects disabled signal types", () => {
  const preferences: GuestPreferencesView = {
    ...DEFAULT_PREFERENCES,
    enabledSignalKinds: {
      ...DEFAULT_PREFERENCES.enabledSignalKinds,
      five_minute_reversal: false,
    },
  };
  assert.deepEqual(notificationEligibility(candidate, preferences, now), {
    eligible: false,
    reason: "disabled",
  });
});

void test("supports quiet hours that cross midnight", () => {
  const preferences: GuestPreferencesView = {
    ...DEFAULT_PREFERENCES,
    quietHours: { enabled: true, startMinutes: 22 * 60, endMinutes: 7 * 60 },
  };
  assert.deepEqual(notificationEligibility(candidate, preferences, now), {
    eligible: false,
    reason: "quiet_hours",
  });
});
