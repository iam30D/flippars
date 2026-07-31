import assert from "node:assert/strict";
import test from "node:test";
import {
  assessSequence,
  mergeSignals,
  reconnectDelayMs,
  websocketUrl,
} from "./recovery";

void test("sequence assessment accepts initial/contiguous events and rejects duplicates", () => {
  assert.equal(assessSequence(null, 10), "initial");
  assert.equal(assessSequence(10, 11), "contiguous");
  assert.equal(assessSequence(10, 10), "duplicate");
  assert.equal(assessSequence(10, 9), "duplicate");
  assert.equal(assessSequence(10, 13), "gap");
  assert.equal(assessSequence(10, -1), "gap");
});

void test("REST recovery merge de-duplicates by ID, accepts resolved replacements, and remains newest-first", () => {
  const current = [
    { id: "one", issuedAt: "2026-07-31T12:00:00.000Z", state: "pending" },
  ];
  const incoming = [
    { id: "one", issuedAt: "2026-07-31T12:00:00.000Z", state: "correct" },
    { id: "two", issuedAt: "2026-07-31T12:05:00.000Z", state: "pending" },
  ];
  assert.deepEqual(mergeSignals(current, incoming), [incoming[1], incoming[0]]);
});

void test("builds a secure public stream URL without exposing the guest identifier", () => {
  assert.equal(
    websocketUrl("https://api.flippars.example"),
    "wss://api.flippars.example/v1/stream",
  );
  assert.equal(websocketUrl("http://localhost:3000"), "ws://localhost:3000/v1/stream");
  assert.equal(
    websocketUrl("https://api.flippars.example/base"),
    "wss://api.flippars.example/base/v1/stream",
  );
});

void test("reconnect backoff is bounded and deterministic with injected jitter", () => {
  assert.equal(reconnectDelayMs(0, 0), 1_000);
  assert.equal(reconnectDelayMs(2, 1), 5_000);
  assert.equal(reconnectDelayMs(99, 0), 30_000);
});
