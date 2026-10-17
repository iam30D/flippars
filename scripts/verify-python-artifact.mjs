import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PreEvaluationPolicySchema,
  canonicalPreEvaluationPolicyJson,
  parseCanonicalJsonObjectPreimage,
} from "../packages/contracts/dist/index.js";
import { DraftBinanceMultinomialArtifactV4Schema } from "../packages/model-artifact/dist/schema.js";
import { parseJsonDocument } from "../packages/model-artifact/dist/verifier.js";
import { auditPreparedModelDataset } from "./audit-prepared-model-dataset.mjs";

const requiredArguments = new Set([
  "--artifact",
  "--dataset-manifest",
  "--evaluation",
  "--pipeline",
  "--prepared",
]);
const optionalArguments = new Set(["--acquisition-manifest"]);
const allowedArguments = new Set([...requiredArguments, ...optionalArguments]);

function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!allowedArguments.has(name) || value === undefined || result.has(name)) {
      throw new TypeError(`Invalid or duplicate argument: ${name ?? "<missing>"}`);
    }
    result.set(name, resolve(value));
  }
  if ([...requiredArguments].some((name) => !result.has(name))) {
    throw new TypeError(`Required arguments: ${[...requiredArguments].join(", ")}`);
  }
  return result;
}

function readJson(path, label) {
  const bytes = readFileSync(path);
  return { bytes, value: parseJsonDocument(bytes, label) };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function assertPlainObject(value, label) {
  assert.ok(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be a plain object`,
  );
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys differ`);
}

const datasetManifestKeys = [
  "schemaVersion",
  "datasetSchemaVersion",
  "createdAt",
  "symbol",
  "source",
  "target",
  "featureSchemaVersion",
  "featureNames",
  "sampling",
  "guard",
  "startAt",
  "endAt",
  "acceptedTradeCount",
  "rejectedTradeCount",
  "gapCount",
  "gapWindowStarts",
  "duplicateTradeCount",
  "preparedDecisionRowCount",
  "preparedWindowCount",
  "windowCountUnit",
  "partitionWindowCounts",
  "preparedDatasetSha256",
  "options",
  "generator",
];

const datasetSourceKeys = [
  "lineageKind",
  "venue",
  "marketType",
  "input",
  "timeBasis",
  "startDateInclusive",
  "endDateExclusive",
  "dayCount",
  "acquisitionEvidence",
  "archives",
];

const archiveReportKeys = [
  "archive",
  "symbol",
  "day",
  "archive_sha256",
  "expected_sha256",
  "member",
  "archive_bytes",
  "checksum_name",
  "checksum_bytes",
  "checksum_sha256",
  "accepted_trade_count",
  "rejected_trade_count",
  "duplicate_trade_count",
  "out_of_order_trade_count",
  "first_event_at",
  "last_event_at",
  "normalized_file",
  "normalized_sha256",
  "first_trade_id",
  "last_trade_id",
  "missing_trade_id_count",
  "missing_trade_id_ranges",
];

const canonicalMillisecondUtcTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function validateGapLineage(manifest) {
  assert.ok(
    Number.isSafeInteger(manifest.gapCount) && manifest.gapCount >= 0,
    "dataset manifest gapCount must be a nonnegative safe integer",
  );
  assert.ok(
    Array.isArray(manifest.gapWindowStarts),
    "dataset manifest gapWindowStarts must be an array",
  );
  assert.equal(
    manifest.gapWindowStarts.length,
    manifest.gapCount,
    "dataset manifest gapWindowStarts length must equal gapCount",
  );

  const durationSeconds = manifest.target?.durationSeconds;
  assert.ok(
    Number.isSafeInteger(durationSeconds) && durationSeconds > 0,
    "dataset manifest target durationSeconds must be a positive safe integer",
  );
  const durationMillis = durationSeconds * 1_000;
  const dayMillis = 86_400_000;
  assert.equal(
    dayMillis % durationMillis,
    0,
    "dataset manifest target durationSeconds must divide one UTC day",
  );
  const sourceStartMillis = Date.parse(
    `${manifest.source?.startDateInclusive}T00:00:00.000Z`,
  );
  const sourceEndMillis = Date.parse(
    `${manifest.source?.endDateExclusive}T00:00:00.000Z`,
  );
  if (manifest.gapWindowStarts.length > 0) {
    assert.ok(
      Number.isFinite(sourceStartMillis) &&
        Number.isFinite(sourceEndMillis) &&
        sourceStartMillis < sourceEndMillis,
      "dataset manifest gap source date range must be valid",
    );
  }

  let previousGapMillis = Number.NEGATIVE_INFINITY;
  for (const [index, gapStart] of manifest.gapWindowStarts.entries()) {
    assert.equal(
      typeof gapStart,
      "string",
      `dataset gap ${index} must be a timestamp string`,
    );
    assert.match(
      gapStart,
      canonicalMillisecondUtcTimestampPattern,
      `dataset gap ${index} must be a canonical millisecond-Z timestamp`,
    );
    const gapMillis = Date.parse(gapStart);
    assert.equal(
      new Date(gapMillis).toISOString(),
      gapStart,
      `dataset gap ${index} must round-trip as a canonical timestamp`,
    );
    assert.ok(
      gapMillis > previousGapMillis,
      "dataset manifest gapWindowStarts must be strictly sorted and unique",
    );
    assert.equal(
      gapMillis % durationMillis,
      0,
      `dataset gap ${index} must align to target durationSeconds`,
    );
    assert.ok(
      gapMillis >= sourceStartMillis && gapMillis < sourceEndMillis,
      `dataset gap ${index} must fall within the source date range`,
    );
    const offsetWithinDay = gapMillis % dayMillis;
    assert.ok(
      offsetWithinDay !== 0 && offsetWithinDay + durationMillis !== dayMillis,
      `dataset gap ${index} must not hide an incomplete UTC day edge`,
    );
    previousGapMillis = gapMillis;
  }
}

function deriveDatasetManifestSummary(manifest, contentSha256, manifestSha256) {
  assertExactKeys(manifest, datasetManifestKeys, "dataset manifest");
  assert.equal(manifest.schemaVersion, "flippars.dataset-manifest/3");
  assert.equal(manifest.datasetSchemaVersion, "flippars.training-dataset/3");
  assert.equal(manifest.symbol, "BTCUSDT");
  assert.deepEqual(manifest.target, artifact.target);
  assert.deepEqual(manifest.featureNames, artifact.featureNames);
  assert.deepEqual(manifest.guard, {
    crossVenueGuardAvailability: "UNAVAILABLE",
    productionEligible: false,
    sourceIntegrityRequired: true,
  });
  assertExactKeys(manifest.source, datasetSourceKeys, "dataset source");
  validateGapLineage(manifest);
  assert.ok(
    Array.isArray(manifest.source.archives),
    "dataset archives must be an array",
  );
  assert.equal(manifest.source.dayCount, manifest.source.archives.length);
  for (const [index, archive] of manifest.source.archives.entries()) {
    assertExactKeys(archive, archiveReportKeys, `dataset archive ${index}`);
  }
  const preparedArchiveIndex = manifest.source.archives.map((archive) => ({
    day: archive.day,
    archiveName: archive.archive,
    archiveBytes: archive.archive_bytes,
    archiveSha256: archive.archive_sha256,
    checksumName: archive.checksum_name,
    checksumBytes: archive.checksum_bytes,
    checksumSha256: archive.checksum_sha256,
    expectedArchiveSha256: archive.expected_sha256,
    member: archive.member,
    acceptedTradeCount: archive.accepted_trade_count,
    firstEventAt: archive.first_event_at,
    lastEventAt: archive.last_event_at,
    firstTradeId: archive.first_trade_id,
    lastTradeId: archive.last_trade_id,
  }));
  const rejectLog = manifest.source.archives.map((archive) => ({
    archive: archive.archive,
    rejectedTradeCount: archive.rejected_trade_count,
  }));
  const sources = {
    PUBLIC_BINANCE_ARCHIVE: "BINANCE_DATA_VISION",
    LOCAL_ARCHIVE_REPLAY: "LOCAL_ARCHIVE_REPLAY",
    SYNTHETIC_LOCAL: "SYNTHETIC_LOCAL",
  };
  const source = sources[manifest.source.lineageKind];
  assert.ok(source !== undefined, "dataset lineage kind is unsupported");
  const isPublic = manifest.source.lineageKind === "PUBLIC_BINANCE_ARCHIVE";
  const acquisition = manifest.source.acquisitionEvidence;
  if (isPublic) {
    assertExactKeys(
      acquisition,
      [
        "schemaVersion",
        "acquisitionManifestSha256",
        "acquisitionArchiveIndexSha256",
        "completedAt",
        "freshOfficialTransportEvidence",
        "archives",
      ],
      "embedded acquisition evidence",
    );
    assert.equal(acquisition.freshOfficialTransportEvidence, true);
    assert.equal(acquisition.archives.length, manifest.source.archives.length);
    const acquisitionFields = [
      "day",
      "archiveName",
      "archiveBytes",
      "archiveSha256",
      "checksumName",
      "checksumBytes",
      "checksumSha256",
      "expectedArchiveSha256",
      "archiveSourceUri",
      "requestedChecksumUri",
      "finalChecksumUri",
      "checksumRetrievedAt",
    ];
    const acquisitionIndex = acquisition.archives.map((record, index) => {
      assertExactKeys(record, acquisitionFields, `acquisition archive ${index}`);
      const report = manifest.source.archives[index];
      const archiveUri = `https://data.binance.vision/data/spot/daily/trades/BTCUSDT/${report.archive}`;
      assert.deepEqual(
        {
          day: record.day,
          archiveName: record.archiveName,
          archiveBytes: record.archiveBytes,
          archiveSha256: record.archiveSha256,
          checksumName: record.checksumName,
          checksumBytes: record.checksumBytes,
          checksumSha256: record.checksumSha256,
          expectedArchiveSha256: record.expectedArchiveSha256,
          archiveSourceUri: record.archiveSourceUri,
          requestedChecksumUri: record.requestedChecksumUri,
          finalChecksumUri: record.finalChecksumUri,
        },
        {
          day: report.day,
          archiveName: report.archive,
          archiveBytes: report.archive_bytes,
          archiveSha256: report.archive_sha256,
          checksumName: report.checksum_name,
          checksumBytes: report.checksum_bytes,
          checksumSha256: report.checksum_sha256,
          expectedArchiveSha256: report.expected_sha256,
          archiveSourceUri: archiveUri,
          requestedChecksumUri: `${archiveUri}.CHECKSUM`,
          finalChecksumUri: `${archiveUri}.CHECKSUM`,
        },
        `acquisition archive ${index} is not bound to the prepared report`,
      );
      return Object.fromEntries(acquisitionFields.map((name) => [name, record[name]]));
    });
    assert.equal(
      sha256Json(acquisitionIndex),
      acquisition.acquisitionArchiveIndexSha256,
      "embedded acquisition archive-index digest is invalid",
    );
  } else {
    assert.equal(
      acquisition,
      null,
      "non-public lineage cannot claim acquisition evidence",
    );
  }
  return {
    schemaVersion: "flippars.dataset-manifest-summary/4",
    datasetContentSha256: contentSha256,
    datasetManifestSha256: manifestSha256,
    symbol: "BTCUSDT",
    lineageKind: manifest.source.lineageKind,
    source,
    dataKind: "TRADES",
    targetVersion: "binance-spot-trade-close-relation/1",
    featureSchemaVersion: "binance-spot-signal-features/1",
    deadbandBps: manifest.target.deadbandBps,
    startAt: manifest.startAt,
    endAt: manifest.endAt,
    archiveCount: manifest.source.archives.length,
    archiveChecksumsVerified: isPublic,
    officialTransportEvidenceVerified: isPublic,
    preparedArchiveIndexSha256: sha256Json(preparedArchiveIndex),
    acquisitionArchiveIndexSha256: isPublic
      ? acquisition.acquisitionArchiveIndexSha256
      : null,
    acquisitionManifestSha256: isPublic ? acquisition.acquisitionManifestSha256 : null,
    rejectLogSha256: sha256Json(rejectLog),
    crossVenueGuardAvailability: "UNAVAILABLE",
    productionEligible: false,
    acceptedTradeCount: manifest.acceptedTradeCount,
    rejectedTradeCount: manifest.rejectedTradeCount,
    gapCount: manifest.gapCount,
    duplicateTradeCount: manifest.duplicateTradeCount,
    preparedDecisionRowCount: manifest.preparedDecisionRowCount,
    preparedWindowCount: manifest.preparedWindowCount,
    windowCountUnit: manifest.windowCountUnit,
    sourceIntegrityRequired: true,
    sourceStartDateInclusive: manifest.source.startDateInclusive,
    sourceEndDateExclusive: manifest.source.endDateExclusive,
    sourceDayCount: manifest.source.dayCount,
    partitionWindowCounts: manifest.partitionWindowCounts,
    candidateSchedule: manifest.target.candidateSchedule,
  };
}

function parsePolicyPreimage(text, label) {
  try {
    return parseCanonicalJsonObjectPreimage(text);
  } catch (error) {
    throw new TypeError(`${label} preimage is not canonical JSON`, { cause: error });
  }
}

const samplingPolicyFields = [
  "method",
  "seed",
  "corpusRowCount",
  "corpusWindowCount",
  "corpusPartitionWindowCounts",
  "corpusPartitionRowCounts",
  "sampledWindowLimits",
  "sampledWindowCounts",
  "sampledRowCounts",
  "sampledWindowSelectionSha256",
  "partitionStarts",
  "partitionEnds",
  "oodFitScope",
  "evaluationScope",
];

const argumentsByName = parseArguments(process.argv.slice(2));
const artifactDocument = readJson(argumentsByName.get("--artifact"), "artifact");
const manifestDocument = readJson(
  argumentsByName.get("--dataset-manifest"),
  "dataset manifest",
);
const evaluationDocument = readJson(argumentsByName.get("--evaluation"), "evaluation");
const artifact = DraftBinanceMultinomialArtifactV4Schema.parse(artifactDocument.value);
const datasetManifest = manifestDocument.value;
const evaluation = evaluationDocument.value;
const preEvaluationPolicy = PreEvaluationPolicySchema.parse(
  evaluation.preEvaluationPolicy,
);
const acquisitionManifestPath = argumentsByName.get("--acquisition-manifest");
const targetPreimage = parsePolicyPreimage(
  preEvaluationPolicy.targetJsonPreimage,
  "target",
);
const fitStatePreimage = parsePolicyPreimage(
  preEvaluationPolicy.fitStateJsonPreimage,
  "fit state",
);
const samplingPreimage = parsePolicyPreimage(
  preEvaluationPolicy.samplingJsonPreimage,
  "sampling",
);

const preparedAudit = await auditPreparedModelDataset(
  argumentsByName.get("--prepared"),
  datasetManifest,
);
assert.equal(
  preparedAudit.sha256,
  artifact.datasetContentSha256,
  "prepared dataset digest does not match the Python artifact",
);
assert.equal(
  sha256(manifestDocument.bytes),
  artifact.datasetManifestSha256,
  "dataset-manifest digest does not match the Python artifact",
);
assert.equal(
  await sha256File(argumentsByName.get("--pipeline")),
  artifact.trainingCodeSha256,
  "pipeline digest does not match the Python artifact",
);
assert.equal(datasetManifest.preparedDatasetSha256, artifact.datasetContentSha256);
assert.deepEqual(
  artifact.datasetManifest,
  deriveDatasetManifestSummary(
    datasetManifest,
    artifact.datasetContentSha256,
    artifact.datasetManifestSha256,
  ),
  "artifact dataset summary is not derived from the full dataset manifest",
);
if (artifact.datasetManifest.lineageKind === "PUBLIC_BINANCE_ARCHIVE") {
  assert.ok(
    acquisitionManifestPath !== undefined,
    "public Binance lineage requires the external acquisition manifest",
  );
  const acquisitionDocument = readJson(acquisitionManifestPath, "acquisition manifest");
  assert.equal(
    sha256(acquisitionDocument.bytes),
    artifact.datasetManifest.acquisitionManifestSha256,
    "external acquisition-manifest digest does not match the artifact",
  );
  assertExactKeys(
    acquisitionDocument.value,
    [
      "schemaVersion",
      "completionState",
      "completedAt",
      "freshOfficialTransportEvidence",
      "source",
      "window",
      "materialization",
      "archiveRoot",
      "archives",
      "acquisitionArchiveIndexSha256",
      "cacheInventoryBefore",
      "cacheInventoryAfter",
      "isolatedIntegrity",
      "credentialsUsed",
      "tradingApiUsed",
    ],
    "external acquisition manifest",
  );
  assert.equal(acquisitionDocument.value.schemaVersion, 3);
  assert.equal(acquisitionDocument.value.completionState, "COMPLETE");
  assert.equal(acquisitionDocument.value.freshOfficialTransportEvidence, true);
  assert.equal(acquisitionDocument.value.credentialsUsed, false);
  assert.equal(acquisitionDocument.value.tradingApiUsed, false);
  assert.equal(
    acquisitionDocument.value.acquisitionArchiveIndexSha256,
    artifact.datasetManifest.acquisitionArchiveIndexSha256,
  );
  assert.deepEqual(
    acquisitionDocument.value.archives,
    datasetManifest.source.acquisitionEvidence.archives,
  );
} else {
  assert.equal(
    acquisitionManifestPath,
    undefined,
    "non-public lineage must not receive official acquisition evidence",
  );
}
assert.equal(evaluation.datasetSha256, artifact.datasetContentSha256);
assert.equal(evaluation.datasetManifestSha256, artifact.datasetManifestSha256);
assert.equal(evaluation.preEvaluationPolicySha256, artifact.preEvaluationPolicySha256);
assert.equal(evaluation.sampling.corpusPassAudit.passesMatched, true);
assert.equal(evaluation.sampling.corpusPassAudit.sha256, artifact.datasetContentSha256);
assert.equal(evaluation.sampling.corpusPassAudit.byteCount, preparedAudit.byteCount);
assert.equal(
  evaluation.sampling.corpusPassAudit.decisionRowCount,
  preparedAudit.decisionRowCount,
);
assert.equal(
  evaluation.sampling.corpusPassAudit.windowCount,
  preparedAudit.windowCount,
);
assert.equal(
  evaluation.sampling.corpusPassAudit.firstDecisionAt,
  preparedAudit.firstDecisionAt,
);
assert.equal(
  evaluation.sampling.corpusPassAudit.lastWindowEnd,
  preparedAudit.lastWindowEnd,
);
assert.equal(
  sha256(Buffer.from(canonicalPreEvaluationPolicyJson(preEvaluationPolicy), "utf8")),
  artifact.preEvaluationPolicySha256,
  "pre-evaluation policy digest does not match the canonical policy encoding",
);
assert.equal(preEvaluationPolicy.signalType, artifact.signalType);
assert.deepEqual(preEvaluationPolicy.featureNames, artifact.featureNames);
assert.equal(
  Number(preEvaluationPolicy.deadbandBpsDecimal),
  artifact.target.deadbandBps,
);
assert.equal(
  Number(preEvaluationPolicy.deadbandBpsDecimal),
  evaluation.thresholdPolicy.deadbandBps,
);
assert.equal(
  Number(preEvaluationPolicy.confidenceThresholdDecimal),
  evaluation.thresholdPolicy.confidenceThreshold,
);
assert.equal(
  preEvaluationPolicy.baselineSelectionPartition,
  evaluation.baselines.selectionPartition,
);
assert.equal(
  preEvaluationPolicy.selectedBaselineKind,
  evaluation.baselines.selectedKindBeforeEvaluation,
);

for (const [name, preimage] of [
  ["target", preEvaluationPolicy.targetJsonPreimage],
  ["fit state", preEvaluationPolicy.fitStateJsonPreimage],
  ["sampling", preEvaluationPolicy.samplingJsonPreimage],
]) {
  const expectedDigest =
    name === "target"
      ? preEvaluationPolicy.targetSha256
      : name === "fit state"
        ? preEvaluationPolicy.fitStateSha256
        : preEvaluationPolicy.samplingSha256;
  assert.equal(
    sha256(Buffer.from(preimage, "utf8")),
    expectedDigest,
    `${name} preimage digest does not match the pre-evaluation policy`,
  );
}

assert.deepEqual(targetPreimage, artifact.target);
assert.deepEqual(fitStatePreimage, {
  normalization: artifact.normalization,
  weights: artifact.model.weights,
  biases: artifact.model.biases,
  temperature: artifact.calibration.temperature,
  ood: artifact.ood,
  fitDiagnostics: evaluation.fitDiagnostics,
});
const samplingProjection = Object.fromEntries(
  samplingPolicyFields.map((name) => {
    assert.ok(
      Object.hasOwn(evaluation.sampling, name),
      `evaluation sampling is missing ${name}`,
    );
    return [name, evaluation.sampling[name]];
  }),
);
assert.deepEqual(samplingPreimage, samplingProjection);
assert.equal(evaluation.schemaVersion, "flippars.model-evaluation/4");
assert.equal(
  evaluation.evaluationScope,
  "BINANCE_CONDITIONAL_DETERMINISTIC_WINDOW_SAMPLE_DIAGNOSTIC_ONLY",
);
assert.equal(evaluation.productionEligible, false);
assert.equal(evaluation.productionGuardedPolicyReplay.alertCount, 0);
assert.ok(
  evaluation.productionGuardedPolicyReplay.abstentionRowCounts
    .CROSS_VENUE_GUARD_UNAVAILABLE > 0,
);
assert.equal(
  evaluation.calibrationByDecisionPopulation
    .userFacingConfidenceCalibrationClaimSupported,
  false,
);

process.stdout.write(
  `${JSON.stringify({
    schema: true,
    digests: true,
    preparedDatasetAudit: true,
    preEvaluationPolicy: true,
    acquisitionEvidence:
      artifact.datasetManifest.lineageKind === "PUBLIC_BINANCE_ARCHIVE",
    productionGuardAbstains: true,
  })}\n`,
);
