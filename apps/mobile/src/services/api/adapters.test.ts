import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adaptSignal } from "./adapters";

const signalAt = (issuedAt: string, policyVersion: string) => ({
  id: `signal-${policyVersion}-${issuedAt}`,
  type: "FIFTEEN_MINUTE_REVERSAL",
  status: "ACTIVE",
  instrument: "BTC-USD",
  interval: "15m",
  durationSeconds: 900,
  windowStart: "2026-09-19T00:00:00.000Z",
  windowEnd: "2026-09-19T00:15:00.000Z",
  issuedAt,
  expiresAt: "2026-09-19T00:15:00.000Z",
  openPrice: "60000",
  currentPrice: "60100",
  observedPosition: "ABOVE_OPEN",
  predictedCloseRelation: "BELOW_OPEN",
  confidence: 0.8,
  confidenceThreshold: 0.75,
  deadbandBps: 5,
  leadTimeSeconds: 600,
  riskLevel: "LOW",
  riskScore: 0,
  riskFlags: [],
  healthFlags: [],
  evidence: [],
  model: {
    artifactId: "artifact-test",
    version: "test-only",
    approvalStatus: "APPROVED",
    approvedAt: "2026-09-18T00:00:00.000Z",
    calibrationVersion: "test-only",
  },
  audit: {
    decisionId: "decision-test",
    engineVersion: "signal-core/test",
    policyVersion,
    inputSnapshotId: "snapshot-test",
    forecastId: "forecast-test",
    evaluatedAt: issuedAt,
    dataMode: "LIVE",
  },
  dataMode: "LIVE",
  informationalOnly: true,
});

const earlyDirectionAt = (issuedAt: string) => ({
  ...signalAt(issuedAt, "precision-first/2"),
  type: "FIVE_MINUTE_EARLY_DIRECTION",
  interval: "5m",
  durationSeconds: 300,
  windowEnd: "2026-09-19T00:05:00.000Z",
  expiresAt: "2026-09-19T00:05:00.000Z",
  leadTimeSeconds: 240,
});

describe("15-minute reversal adaptation boundaries", () => {
  it("rejects policy v2 before T+300s and accepts exactly T+300s", () => {
    assert.equal(
      adaptSignal(signalAt("2026-09-19T00:04:59.999Z", "precision-first/2")),
      null,
    );
    assert.notEqual(
      adaptSignal(signalAt("2026-09-19T00:05:00.000Z", "precision-first/2")),
      null,
    );
  });

  it("preserves the historical policy v1 T+450s boundary", () => {
    assert.equal(
      adaptSignal(signalAt("2026-09-19T00:07:29.999Z", "precision-first/1")),
      null,
    );
    assert.notEqual(
      adaptSignal(signalAt("2026-09-19T00:07:30.000Z", "precision-first/1")),
      null,
    );
  });
});

describe("five-minute early-direction adaptation boundaries", () => {
  it("accepts before T+60s and rejects exactly T+60s", () => {
    assert.notEqual(adaptSignal(earlyDirectionAt("2026-09-19T00:00:59.999Z")), null);
    assert.equal(adaptSignal(earlyDirectionAt("2026-09-19T00:01:00.000Z")), null);
  });
});
