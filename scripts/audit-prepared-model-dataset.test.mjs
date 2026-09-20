import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BINANCE_SPOT_SIGNAL_FEATURE_NAMES } from "../packages/contracts/dist/index.js";
import { auditPreparedModelDataset } from "./audit-prepared-model-dataset.mjs";

const DURATION_MILLISECONDS = 300_000;
const SOURCE_START = Date.parse("2025-01-01T00:00:00.000Z");
const GAP_INDEX = 20;
const OFFSETS = [15, 30, 45];

function timestamp(windowIndex, offsetSeconds = 0) {
  return new Date(
    SOURCE_START + windowIndex * DURATION_MILLISECONDS + offsetSeconds * 1_000,
  ).toISOString();
}

function featureValues(offsetSeconds, durationSeconds = 300) {
  const values = Object.fromEntries(
    BINANCE_SPOT_SIGNAL_FEATURE_NAMES.map((name) => [name, 0]),
  );
  values.previous_buy_ratio = 0.5;
  values.previous_close_location = 0.5;
  values.current_buy_ratio = 0.5;
  values.current_close_location = 0.5;
  values.elapsed_ratio = offsetSeconds / durationSeconds;
  values.remaining_ratio = 1 - values.elapsed_ratio;
  return values;
}

function fifteenMinuteRow(offsetSeconds) {
  const windowStart = new Date(SOURCE_START).toISOString();
  const windowEnd = new Date(SOURCE_START + 900_000).toISOString();
  const decisionAt = new Date(SOURCE_START + offsetSeconds * 1_000).toISOString();
  const features = featureValues(offsetSeconds, 900);
  features.current_return_from_open_bps = 10;
  return {
    schemaVersion: "flippars.training-dataset/3",
    id: "BTCUSDT:" + windowStart + ":FIFTEEN_MINUTE_REVERSAL:" + offsetSeconds,
    signalType: "FIFTEEN_MINUTE_REVERSAL",
    decisionAt,
    windowStart,
    windowEnd,
    durationSeconds: 900,
    currentRelation: "ABOVE_OPEN",
    candidateEligible: true,
    features,
    label: "ABOVE_OPEN",
    deadbandBps: 5,
    sourceIntegrityHealthy: true,
    crossVenueGuardAvailability: "UNAVAILABLE",
    productionEligible: false,
  };
}

function row(windowIndex, offsetSeconds) {
  const windowStart = timestamp(windowIndex);
  return {
    schemaVersion: "flippars.training-dataset/3",
    id: "BTCUSDT:" + windowStart + ":FIVE_MINUTE_EARLY_DIRECTION:" + offsetSeconds,
    signalType: "FIVE_MINUTE_EARLY_DIRECTION",
    decisionAt: timestamp(windowIndex, offsetSeconds),
    windowStart,
    windowEnd: timestamp(windowIndex + 1),
    durationSeconds: 300,
    currentRelation: "AT_OPEN",
    candidateEligible: true,
    features: featureValues(offsetSeconds),
    label: "AT_OPEN",
    deadbandBps: 5,
    sourceIntegrityHealthy: true,
    crossVenueGuardAvailability: "UNAVAILABLE",
    productionEligible: false,
  };
}

function fixture() {
  const poisoned = new Set();
  for (let index = GAP_INDEX; index <= GAP_INDEX + 13; index += 1) {
    poisoned.add(index);
  }
  const eligible = [];
  for (let index = 13; index < 288; index += 1) {
    if (!poisoned.has(index)) {
      eligible.push(index);
    }
  }
  const rows = eligible.flatMap((index) => OFFSETS.map((offset) => row(index, offset)));
  const fitEnd = Math.floor(eligible.length * 0.6);
  const calibrationEnd = Math.floor(eligible.length * 0.8);
  const manifest = {
    target: {
      signalType: "FIVE_MINUTE_EARLY_DIRECTION",
      durationSeconds: 300,
      deadbandBps: 5,
      candidateSchedule: {
        firstDecisionOffsetSeconds: 15,
        lastDecisionOffsetSeconds: 45,
        cadenceSeconds: 15,
      },
    },
    source: {
      startDateInclusive: "2025-01-01",
      endDateExclusive: "2025-01-02",
    },
    featureNames: [...BINANCE_SPOT_SIGNAL_FEATURE_NAMES],
    gapCount: 1,
    gapWindowStarts: [timestamp(GAP_INDEX)],
    preparedWindowCount: eligible.length,
    preparedDecisionRowCount: rows.length,
    startAt: timestamp(eligible[0], OFFSETS[0]),
    endAt: timestamp(eligible.at(-1) + 1),
    partitionWindowCounts: {
      modelFit: fitEnd,
      calibration: calibrationEnd - fitEnd,
      evaluation: eligible.length - calibrationEnd,
    },
  };
  return { manifest, rows };
}

function writeRows(path, rows) {
  writeFileSync(path, rows.map((value) => JSON.stringify(value) + "\n").join(""));
}

test("streams a valid gap-abstaining corpus and rejects independent tampering", async () => {
  const root = mkdtempSync(join(tmpdir(), "flippars-prepared-audit-"));
  try {
    const { manifest, rows } = fixture();
    const validPath = join(root, "valid.jsonl");
    writeRows(validPath, rows);
    const audit = await auditPreparedModelDataset(validPath, manifest);
    assert.equal(audit.windowCount, manifest.preparedWindowCount);
    assert.equal(audit.decisionRowCount, manifest.preparedDecisionRowCount);

    const replacementWindow = 34;
    const tamperedRows = rows
      .filter((value) => value.windowStart !== timestamp(replacementWindow))
      .concat(OFFSETS.map((offset) => row(GAP_INDEX, offset)))
      .sort((left, right) =>
        (left.decisionAt + left.id).localeCompare(right.decisionAt + right.id),
      );
    const tamperedPath = join(root, "tampered.jsonl");
    writeRows(tamperedPath, tamperedRows);
    await assert.rejects(
      auditPreparedModelDataset(tamperedPath, manifest),
      /depends on a declared source gap/u,
    );

    await assert.rejects(
      auditPreparedModelDataset(validPath, {
        ...manifest,
        preparedWindowCount: manifest.preparedWindowCount + 1,
      }),
      /gap-adjusted source coverage/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audits every governed final-10-minute decision for a 15-minute reversal", async () => {
  const root = mkdtempSync(join(tmpdir(), "flippars-prepared-audit-15m-"));
  try {
    const offsets = Array.from({ length: 39 }, (_, index) => 300 + index * 15);
    const rows = offsets.map(fifteenMinuteRow);
    const manifest = {
      target: {
        signalType: "FIFTEEN_MINUTE_REVERSAL",
        durationSeconds: 900,
        deadbandBps: 5,
        candidateSchedule: {
          firstDecisionOffsetSeconds: 300,
          lastDecisionOffsetSeconds: 870,
          cadenceSeconds: 15,
        },
      },
      source: { startDateInclusive: null, endDateExclusive: null },
      featureNames: [...BINANCE_SPOT_SIGNAL_FEATURE_NAMES],
      gapCount: 0,
      gapWindowStarts: [],
      preparedWindowCount: 1,
      preparedDecisionRowCount: rows.length,
      startAt: rows[0].decisionAt,
      endAt: rows.at(-1).windowEnd,
      partitionWindowCounts: { modelFit: 0, calibration: 0, evaluation: 1 },
    };
    const validPath = join(root, "valid-15m.jsonl");
    writeRows(validPath, rows);
    const audit = await auditPreparedModelDataset(validPath, manifest);
    assert.equal(audit.decisionRowCount, 39);

    const invalidPath = join(root, "invalid-15m.jsonl");
    writeRows(invalidPath, [
      { ...rows[0], candidateEligible: false },
      ...rows.slice(1),
    ]);
    await assert.rejects(
      auditPreparedModelDataset(invalidPath, manifest),
      /row eligibility is inconsistent/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
