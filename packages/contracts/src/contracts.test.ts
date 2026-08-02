import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GuestCredentialSchema,
  MarketSnapshotSchema,
  PositiveDecimalStringSchema,
  Rfc3339TimestampSchema,
  SignalSchema,
  createPaginatedResponseSchema,
  createWsEnvelopeSchema,
} from "./index.js";

describe("wire primitives", () => {
  it("accepts only canonical 256-bit guest credentials", () => {
    assert.equal(GuestCredentialSchema.safeParse("a".repeat(64)).success, true);
    assert.equal(GuestCredentialSchema.safeParse("A".repeat(64)).success, false);
    assert.equal(GuestCredentialSchema.safeParse("a".repeat(63)).success, false);
  });

  it("accepts canonical positive decimal strings and rejects JSON numbers", () => {
    assert.equal(PositiveDecimalStringSchema.safeParse("67420.125").success, true);
    assert.equal(PositiveDecimalStringSchema.safeParse("0.0001").success, true);
    assert.equal(PositiveDecimalStringSchema.safeParse(67420.125).success, false);
    assert.equal(PositiveDecimalStringSchema.safeParse("01.2").success, false);
    assert.equal(PositiveDecimalStringSchema.safeParse("0").success, false);
  });

  it("requires an offset-aware RFC3339 timestamp", () => {
    assert.equal(
      Rfc3339TimestampSchema.safeParse("2026-07-31T12:34:56.000Z").success,
      true,
    );
    assert.equal(
      Rfc3339TimestampSchema.safeParse("2026-07-31T13:34:56+01:00").success,
      true,
    );
    assert.equal(
      Rfc3339TimestampSchema.safeParse("2026-07-31T12:34:56").success,
      false,
    );
  });
});

describe("API schemas", () => {
  it("rejects an unavailable market snapshot that smuggles a numeric price", () => {
    const parsed = MarketSnapshotSchema.safeParse({
      id: "snapshot-1",
      instrument: "BTC-USD",
      observedAt: "2026-07-31T12:00:00.000Z",
      producedAt: "2026-07-31T12:00:00.000Z",
      compositePrice: 67000,
      usdtUsdRate: "1",
      crossVenueSpreadBps: null,
      quorum: 2,
      eligibleVenueCount: 0,
      venues: [],
      health: "UNAVAILABLE",
      healthFlags: [],
      dataMode: "LIVE",
    });

    assert.equal(parsed.success, false);
  });

  it("builds typed paginated schemas without weakening item validation", () => {
    const paginatedSignals = createPaginatedResponseSchema(SignalSchema);
    assert.equal(
      paginatedSignals.safeParse({
        items: [{ id: "not-a-signal" }],
        nextCursor: null,
        hasMore: false,
      }).success,
      false,
    );
  });

  it("requires an explicit WebSocket sequence for gap recovery", () => {
    const heartbeat = createWsEnvelopeSchema(MarketSnapshotSchema.pick({ id: true }));
    const envelope = {
      id: "event-1",
      schemaVersion: "1",
      type: "HEARTBEAT",
      sentAt: "2026-07-31T12:00:00.000Z",
      dataMode: "LIVE",
      payload: { id: "snapshot-1" },
    };

    assert.equal(heartbeat.safeParse(envelope).success, false);
    assert.equal(heartbeat.safeParse({ ...envelope, sequence: 42 }).success, true);
  });
});
