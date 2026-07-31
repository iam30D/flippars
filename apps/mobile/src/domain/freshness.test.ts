import assert from "node:assert/strict";
import test from "node:test";
import { signalFreshness } from "./freshness";

const now = Date.parse("2026-07-31T12:02:00.000Z");

void test("classifies an unexpired, ordered signal as active", () => {
  assert.equal(
    signalFreshness(
      { issuedAt: "2026-07-31T12:01:00.000Z", expiresAt: "2026-07-31T12:05:00.000Z" },
      now,
    ),
    "active",
  );
});

void test("classifies a signal at its expiry as expired", () => {
  assert.equal(
    signalFreshness(
      { issuedAt: "2026-07-31T12:00:00.000Z", expiresAt: "2026-07-31T12:02:00.000Z" },
      now,
    ),
    "expired",
  );
});

void test("rejects malformed or backwards signal windows", () => {
  assert.equal(
    signalFreshness(
      { issuedAt: "invalid", expiresAt: "2026-07-31T12:05:00.000Z" },
      now,
    ),
    "invalid",
  );
  assert.equal(
    signalFreshness(
      { issuedAt: "2026-07-31T12:06:00.000Z", expiresAt: "2026-07-31T12:05:00.000Z" },
      now,
    ),
    "invalid",
  );
});
