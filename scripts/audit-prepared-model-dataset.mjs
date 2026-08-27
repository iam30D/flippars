import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseJsonDocument } from "../packages/model-artifact/dist/verifier.js";

const DAY_MILLISECONDS = 86_400_000;
const MAXIMUM_ROW_BYTES = 2 * 1_048_576;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ROW_KEYS = [
  "schemaVersion",
  "id",
  "signalType",
  "decisionAt",
  "windowStart",
  "windowEnd",
  "durationSeconds",
  "currentRelation",
  "candidateEligible",
  "features",
  "label",
  "deadbandBps",
  "sourceIntegrityHealthy",
  "crossVenueGuardAvailability",
  "productionEligible",
];
const RELATIONS = new Set(["ABOVE_OPEN", "BELOW_OPEN", "AT_OPEN"]);

function assertPlainObject(value, label) {
  assert.ok(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    label + " must be a plain object",
  );
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    label + " keys differ",
  );
}

function timestampMillis(value, label) {
  assert.equal(typeof value, "string", label + " must be a string");
  assert.match(value, TIMESTAMP_PATTERN, label + " must be canonical millisecond-Z");
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), label + " must be a valid timestamp");
  assert.equal(new Date(parsed).toISOString(), value, label + " must round-trip");
  return parsed;
}

function sourceBoundaryMillis(value, label) {
  assert.equal(typeof value, "string", label + " must be a UTC date");
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/u, label + " must be a UTC date");
  const parsed = Date.parse(value + "T00:00:00.000Z");
  assert.ok(Number.isFinite(parsed), label + " must be a valid UTC date");
  assert.equal(
    new Date(parsed).toISOString().slice(0, 10),
    value,
    label + " must be canonical",
  );
  return parsed;
}

function decisionOffsets(manifest) {
  const schedule = manifest.target?.candidateSchedule;
  assertPlainObject(schedule, "dataset candidate schedule");
  const first = schedule.firstDecisionOffsetSeconds;
  const last = schedule.lastDecisionOffsetSeconds;
  const cadence = schedule.cadenceSeconds;
  for (const [value, label] of [
    [first, "first decision offset"],
    [last, "last decision offset"],
    [cadence, "decision cadence"],
  ]) {
    assert.ok(
      Number.isSafeInteger(value) && value >= 0,
      label + " must be a nonnegative safe integer",
    );
  }
  assert.ok(cadence > 0 && first <= last, "dataset decision schedule is invalid");
  const result = [];
  for (let offset = first; offset <= last; offset += cadence) {
    result.push(offset);
  }
  assert.ok(result.length > 0, "dataset decision schedule must not be empty");
  return result;
}

function gapCoverage(manifest, durationMilliseconds, sourceStart, sourceEnd) {
  assert.ok(
    Number.isSafeInteger(manifest.gapCount) && manifest.gapCount >= 0,
    "dataset gapCount must be a nonnegative safe integer",
  );
  assert.ok(Array.isArray(manifest.gapWindowStarts), "dataset gaps must be an array");
  assert.equal(
    manifest.gapWindowStarts.length,
    manifest.gapCount,
    "dataset gap count and list differ",
  );
  const starts = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const [index, value] of manifest.gapWindowStarts.entries()) {
    const parsed = timestampMillis(value, "dataset gap " + index);
    assert.ok(parsed > previous, "dataset gaps must be strictly sorted and unique");
    assert.equal(
      parsed % durationMilliseconds,
      0,
      "dataset gap must align to the target duration",
    );
    assert.ok(
      parsed >= sourceStart && parsed < sourceEnd,
      "dataset gap must fall inside the source range",
    );
    const offsetWithinDay = parsed % DAY_MILLISECONDS;
    assert.ok(
      offsetWithinDay !== 0 &&
        offsetWithinDay + durationMilliseconds !== DAY_MILLISECONDS,
      "dataset gap must not hide an incomplete UTC day edge",
    );
    starts.push(parsed);
    previous = parsed;
  }
  const forbiddenStarts = new Set();
  for (const gap of starts) {
    for (let lookahead = 0; lookahead <= 13; lookahead += 1) {
      forbiddenStarts.add(gap + lookahead * durationMilliseconds);
    }
  }
  return { starts, forbiddenStarts };
}

function expectedCoverage(
  manifest,
  gapStarts,
  offsets,
  durationMilliseconds,
  sourceStart,
  sourceEnd,
) {
  const totalWindows = (sourceEnd - sourceStart) / durationMilliseconds;
  assert.ok(
    Number.isSafeInteger(totalWindows) && totalWindows > 13,
    "dataset source range does not contain enough aligned windows",
  );
  const poisoned = new Set();
  for (const gap of gapStarts) {
    const gapIndex = (gap - sourceStart) / durationMilliseconds;
    assert.ok(Number.isSafeInteger(gapIndex), "dataset gap index is not aligned");
    const first = Math.max(13, gapIndex);
    const last = Math.min(totalWindows - 1, gapIndex + 13);
    for (let index = first; index <= last; index += 1) {
      poisoned.add(index);
    }
  }
  const eligible = [];
  for (let index = 13; index < totalWindows; index += 1) {
    if (!poisoned.has(index)) {
      eligible.push(index);
    }
  }
  assert.ok(eligible.length > 0, "dataset gaps leave no eligible windows");
  const expectedStart = new Date(
    sourceStart + eligible[0] * durationMilliseconds + offsets[0] * 1_000,
  ).toISOString();
  const expectedEnd = new Date(
    sourceStart + (eligible.at(-1) + 1) * durationMilliseconds,
  ).toISOString();
  const fitEnd = Math.floor(eligible.length * 0.6);
  const calibrationEnd = Math.floor(eligible.length * 0.8);
  const partitions = {
    modelFit: fitEnd,
    calibration: calibrationEnd - fitEnd,
    evaluation: eligible.length - calibrationEnd,
  };
  assert.equal(
    manifest.preparedWindowCount,
    eligible.length,
    "prepared window count does not match gap-adjusted source coverage",
  );
  assert.equal(
    manifest.preparedDecisionRowCount,
    eligible.length * offsets.length,
    "prepared row count does not match gap-adjusted decision coverage",
  );
  assert.equal(
    manifest.startAt,
    expectedStart,
    "dataset startAt does not match the first gap-adjusted decision",
  );
  assert.equal(
    manifest.endAt,
    expectedEnd,
    "dataset endAt does not match the last gap-adjusted window",
  );
  assert.deepEqual(
    manifest.partitionWindowCounts,
    partitions,
    "dataset partitions do not match the deterministic chronological split",
  );
}

function expectedRelation(returnBps, deadbandBps) {
  if (returnBps > deadbandBps) {
    return "ABOVE_OPEN";
  }
  if (returnBps < -deadbandBps) {
    return "BELOW_OPEN";
  }
  return "AT_OPEN";
}

function expectedEligibility(signalType, relation, offset) {
  if (signalType === "FIVE_MINUTE_EARLY_DIRECTION") {
    return offset < 60;
  }
  if (signalType === "FIFTEEN_MINUTE_REVERSAL" && offset < 450) {
    return false;
  }
  return relation !== "AT_OPEN";
}

export async function auditPreparedModelDataset(path, manifest) {
  assertPlainObject(manifest, "dataset manifest");
  const durationSeconds = manifest.target?.durationSeconds;
  assert.ok(
    Number.isSafeInteger(durationSeconds) && durationSeconds > 0,
    "target duration must be a positive safe integer",
  );
  const durationMilliseconds = durationSeconds * 1_000;
  assert.equal(
    DAY_MILLISECONDS % durationMilliseconds,
    0,
    "target duration must divide one UTC day",
  );
  const sourceStartValue = manifest.source?.startDateInclusive;
  const sourceEndValue = manifest.source?.endDateExclusive;
  assert.equal(
    sourceStartValue === null,
    sourceEndValue === null,
    "source date boundaries must both be present or both be null",
  );
  const sourceStart =
    sourceStartValue === null
      ? null
      : sourceBoundaryMillis(sourceStartValue, "source start");
  const sourceEnd =
    sourceEndValue === null ? null : sourceBoundaryMillis(sourceEndValue, "source end");
  if (sourceStart !== null && sourceEnd !== null) {
    assert.ok(sourceStart < sourceEnd, "source date range must be positive");
  }
  const offsets = decisionOffsets(manifest);
  let gapStarts = [];
  let forbiddenStarts = new Set();
  if (sourceStart === null || sourceEnd === null) {
    assert.equal(manifest.gapCount, 0, "archive-free datasets cannot declare gaps");
    assert.deepEqual(
      manifest.gapWindowStarts,
      [],
      "archive-free datasets cannot carry gap lineage",
    );
  } else {
    ({ starts: gapStarts, forbiddenStarts } = gapCoverage(
      manifest,
      durationMilliseconds,
      sourceStart,
      sourceEnd,
    ));
    expectedCoverage(
      manifest,
      gapStarts,
      offsets,
      durationMilliseconds,
      sourceStart,
      sourceEnd,
    );
  }

  const digest = createHash("sha256");
  let byteCount = 0;
  let pending = Buffer.alloc(0);
  let lineNumber = 0;
  let decisionRowCount = 0;
  let windowCount = 0;
  let firstDecisionAt = null;
  let lastWindowEnd = null;
  let previousKey = null;
  let currentWindow = null;
  let currentOffsets = [];
  let currentLabel = null;

  const finishWindow = () => {
    if (currentWindow === null) {
      return;
    }
    assert.deepEqual(
      currentOffsets,
      offsets,
      "prepared window " + currentWindow + " has an incomplete decision schedule",
    );
    windowCount += 1;
  };

  const processLine = (line) => {
    lineNumber += 1;
    assert.ok(line.length > 0, "prepared row " + lineNumber + " is empty");
    assert.ok(
      line.length <= MAXIMUM_ROW_BYTES,
      "prepared row " + lineNumber + " is too large",
    );
    assert.notEqual(
      line.at(-1),
      13,
      "prepared row " + lineNumber + " must use LF rather than CRLF",
    );
    const row = parseJsonDocument(line, "prepared row " + lineNumber);
    assertExactKeys(row, ROW_KEYS, "prepared row " + lineNumber);
    assert.equal(row.schemaVersion, "flippars.training-dataset/3");
    assert.equal(row.signalType, manifest.target.signalType);
    assert.equal(row.durationSeconds, durationSeconds);
    assert.equal(row.deadbandBps, manifest.target.deadbandBps);
    assert.equal(row.sourceIntegrityHealthy, true);
    assert.equal(row.crossVenueGuardAvailability, "UNAVAILABLE");
    assert.equal(row.productionEligible, false);
    assert.ok(RELATIONS.has(row.currentRelation), "row relation is unsupported");
    assert.ok(RELATIONS.has(row.label), "row label is unsupported");
    assert.equal(typeof row.candidateEligible, "boolean");

    const windowStart = timestampMillis(
      row.windowStart,
      "prepared row " + lineNumber + " windowStart",
    );
    const windowEnd = timestampMillis(
      row.windowEnd,
      "prepared row " + lineNumber + " windowEnd",
    );
    const decisionAt = timestampMillis(
      row.decisionAt,
      "prepared row " + lineNumber + " decisionAt",
    );
    assert.equal(windowStart % durationMilliseconds, 0, "row window is unaligned");
    assert.equal(
      windowEnd - windowStart,
      durationMilliseconds,
      "row window duration is invalid",
    );
    if (sourceStart !== null && sourceEnd !== null) {
      assert.ok(
        windowStart >= sourceStart && windowEnd <= sourceEnd,
        "row window falls outside the source range",
      );
      const windowIndex = (windowStart - sourceStart) / durationMilliseconds;
      assert.ok(
        Number.isSafeInteger(windowIndex) && windowIndex >= 13,
        "row window lacks the required source lookback",
      );
    }
    assert.ok(
      !forbiddenStarts.has(windowStart),
      "prepared window " + row.windowStart + " depends on a declared source gap",
    );
    const offset = (decisionAt - windowStart) / 1_000;
    assert.ok(Number.isSafeInteger(offset), "row decision offset is not integral");
    assert.ok(offsets.includes(offset), "row decision is outside the schedule");
    assert.equal(
      row.id,
      "BTCUSDT:" + row.windowStart + ":" + row.signalType + ":" + offset,
      "row identity is not canonical",
    );

    assertPlainObject(row.features, "prepared row features");
    assert.deepEqual(
      Object.keys(row.features),
      manifest.featureNames,
      "prepared row feature order differs",
    );
    for (const [name, value] of Object.entries(row.features)) {
      assert.ok(
        typeof value === "number" && Number.isFinite(value),
        "prepared feature " + name + " must be finite",
      );
    }
    const relation = expectedRelation(
      row.features.current_return_from_open_bps,
      row.deadbandBps,
    );
    assert.equal(row.currentRelation, relation, "row current relation is inconsistent");
    assert.equal(
      row.candidateEligible,
      expectedEligibility(row.signalType, relation, offset),
      "row eligibility is inconsistent",
    );
    const elapsed = offset / durationSeconds;
    assert.ok(
      Math.abs(row.features.elapsed_ratio - elapsed) <= 1e-12 &&
        Math.abs(row.features.remaining_ratio - (1 - elapsed)) <= 1e-12,
      "row time-ratio features are inconsistent",
    );

    const key = row.decisionAt + "\u0000" + row.id;
    assert.ok(
      previousKey === null || key > previousKey,
      "prepared rows are not monotonic",
    );
    previousKey = key;
    if (currentWindow !== row.windowStart) {
      if (currentWindow !== null) {
        assert.ok(
          row.windowStart > currentWindow,
          "prepared windows are not monotonic",
        );
      }
      finishWindow();
      currentWindow = row.windowStart;
      currentOffsets = [];
      currentLabel = row.label;
    }
    assert.equal(row.label, currentLabel, "prepared window labels conflict");
    currentOffsets.push(offset);
    firstDecisionAt ??= row.decisionAt;
    lastWindowEnd = row.windowEnd;
    decisionRowCount += 1;
  };

  const stream = createReadStream(path);
  let streamFailure = null;
  try {
    for await (const chunk of stream) {
      try {
        digest.update(chunk);
        byteCount += chunk.length;
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        let newlineIndex = pending.indexOf(10);
        while (newlineIndex >= 0) {
          processLine(pending.subarray(0, newlineIndex));
          pending = pending.subarray(newlineIndex + 1);
          newlineIndex = pending.indexOf(10);
        }
        assert.ok(pending.length <= MAXIMUM_ROW_BYTES, "prepared row is too large");
      } catch (error) {
        streamFailure = error;
        break;
      }
    }
  } catch (error) {
    streamFailure ??= error;
  } finally {
    if (!stream.closed) {
      const closed = once(stream, "close");
      stream.destroy();
      try {
        await closed;
      } catch (error) {
        streamFailure ??= error;
      }
    }
  }
  if (streamFailure !== null) {
    throw streamFailure;
  }
  assert.equal(pending.length, 0, "prepared dataset must end every row with LF");
  finishWindow();
  assert.ok(decisionRowCount > 0 && windowCount > 0, "prepared dataset is empty");
  assert.equal(decisionRowCount, manifest.preparedDecisionRowCount);
  assert.equal(windowCount, manifest.preparedWindowCount);
  assert.equal(firstDecisionAt, manifest.startAt);
  assert.equal(lastWindowEnd, manifest.endAt);
  return {
    sha256: digest.digest("hex"),
    byteCount,
    decisionRowCount,
    windowCount,
    firstDecisionAt,
    lastWindowEnd,
  };
}

function parseCommandLine(values) {
  assert.equal(
    values.length,
    4,
    "usage: audit-prepared-model-dataset.mjs --prepared PATH --dataset-manifest PATH",
  );
  const argumentsByName = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    assert.ok(
      name === "--prepared" || name === "--dataset-manifest",
      "unsupported prepared-audit argument: " + name,
    );
    assert.ok(!argumentsByName.has(name), "duplicate prepared-audit argument: " + name);
    assert.ok(typeof value === "string" && value.length > 0, name + " requires a path");
    argumentsByName.set(name, value);
  }
  assert.ok(argumentsByName.has("--prepared"), "--prepared is required");
  assert.ok(
    argumentsByName.has("--dataset-manifest"),
    "--dataset-manifest is required",
  );
  return argumentsByName;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const argumentsByName = parseCommandLine(process.argv.slice(2));
    const manifestPath = argumentsByName.get("--dataset-manifest");
    const manifest = parseJsonDocument(readFileSync(manifestPath), "dataset manifest");
    const result = await auditPreparedModelDataset(
      argumentsByName.get("--prepared"),
      manifest,
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? (error.stack ?? error.message) : String(error)) + "\n",
    );
    process.exitCode = 1;
  }
}
