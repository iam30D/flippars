import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  BINANCE_SPOT_FEATURE_SCHEMA_VERSION,
  BINANCE_SPOT_SIGNAL_FEATURE_NAMES,
  BINANCE_SPOT_TARGET_VERSION,
  BinanceSpotFeatureVectorSchema,
  BinanceSpotForecastTargetSchema,
  CloseRelationProbabilitiesSchema,
  DatasetManifestSummarySchema,
  DatasetManifestSummaryV3Schema,
  DatasetManifestSummaryV4Schema,
  GuestCredentialSchema,
  MarketSnapshotSchema,
  PRE_EVALUATION_POLICY_CANONICALIZATION,
  PRE_EVALUATION_POLICY_SCHEMA_VERSION,
  PositiveDecimalStringSchema,
  PreEvaluationPolicySchema,
  Rfc3339TimestampSchema,
  SignalSchema,
  canonicalPreEvaluationPolicyJson,
  createPaginatedResponseSchema,
  createWsEnvelopeSchema,
  parseCanonicalJsonObjectPreimage,
} from "./index.js";

const fiveMinuteSchedule = {
  schemaVersion: "flippars.candidate-decision-schedule/1",
  kind: "FIXED_CADENCE",
  firstDecisionOffsetSeconds: 15,
  lastDecisionOffsetSeconds: 285,
  cadenceSeconds: 15,
  phaseStartSeconds: 0,
  phaseEndExclusiveSeconds: 300,
  minimumLeadTimeSeconds: 15,
  selectionPolicy: "FIRST_QUALIFIED_PER_WINDOW",
} as const;

const fiveMinuteTarget = {
  kind: "BINANCE_SPOT_CANDLE_CLOSE_RELATION",
  targetVersion: BINANCE_SPOT_TARGET_VERSION,
  decisionPolicyVersion: "flippars-signal-candidate-sampling/2",
  crossVenueGuardPolicyVersion: "btc-usd-cross-venue-health/1",
  signalType: "FIVE_MINUTE_REVERSAL",
  venue: "BINANCE",
  marketType: "SPOT",
  symbol: "BTCUSDT",
  quoteAsset: "USDT",
  input: "TRADE",
  timeBasis: "EVENT_TIME",
  tradeOrdering: "EVENT_TIME_THEN_TRADE_ID",
  windowAlignment: "UTC_EPOCH",
  windowBounds: "HALF_OPEN",
  durationSeconds: 300,
  openDefinition: "FIRST_TRADE_AT_OR_AFTER_WINDOW_START",
  closeDefinition: "LAST_TRADE_BEFORE_WINDOW_END",
  targetPriceNormalization: "NONE",
  classOrder: ["ABOVE_OPEN", "BELOW_OPEN", "AT_OPEN"],
  deadbandBps: 5,
  labelPolicyVersion: BINANCE_SPOT_TARGET_VERSION,
  candidateSchedule: fiveMinuteSchedule,
} as const;

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

describe("Binance research contracts", () => {
  it("binds the event-time target and rejects a signal/timeframe mismatch", () => {
    assert.equal(
      BinanceSpotForecastTargetSchema.safeParse(fiveMinuteTarget).success,
      true,
    );
    assert.equal(
      BinanceSpotForecastTargetSchema.safeParse({
        ...fiveMinuteTarget,
        signalType: "FIFTEEN_MINUTE_REVERSAL",
      }).success,
      false,
    );
    assert.equal(
      BinanceSpotForecastTargetSchema.safeParse({
        ...fiveMinuteTarget,
        decisionPolicyVersion: "flippars-signal-candidate-sampling/1",
      }).success,
      false,
    );
  });

  it("binds the 15-minute final-10-minute schedule to the live 30-second lead floor", () => {
    const schedule = {
      ...fiveMinuteSchedule,
      firstDecisionOffsetSeconds: 300,
      lastDecisionOffsetSeconds: 870,
      phaseStartSeconds: 300,
      phaseEndExclusiveSeconds: 900,
      minimumLeadTimeSeconds: 30,
    };
    const target = {
      ...fiveMinuteTarget,
      signalType: "FIFTEEN_MINUTE_REVERSAL",
      durationSeconds: 900,
      candidateSchedule: schedule,
    };
    assert.equal(BinanceSpotForecastTargetSchema.safeParse(target).success, true);
    assert.equal(
      BinanceSpotForecastTargetSchema.safeParse({
        ...target,
        candidateSchedule: {
          ...schedule,
          firstDecisionOffsetSeconds: 450,
          phaseStartSeconds: 450,
        },
      }).success,
      false,
    );
    assert.equal(
      BinanceSpotForecastTargetSchema.safeParse({
        ...target,
        candidateSchedule: {
          ...schedule,
          lastDecisionOffsetSeconds: 885,
          minimumLeadTimeSeconds: 15,
        },
      }).success,
      false,
    );
  });

  it("requires strictly causal point-in-time features and the exact tuple", () => {
    const featureVector = {
      schemaVersion: BINANCE_SPOT_FEATURE_SCHEMA_VERSION,
      targetVersion: BINANCE_SPOT_TARGET_VERSION,
      signalType: "FIVE_MINUTE_REVERSAL",
      decisionAt: "2026-01-01T00:00:15.000Z",
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-01T00:05:00.000Z",
      windowOpenTradeEventAt: "2026-01-01T00:00:00.100Z",
      windowOpenTradeId: "100",
      lastIncludedTradeEventAt: "2026-01-01T00:00:14.900Z",
      lastIncludedTradeId: "200",
      decisionPolicyVersion: "flippars-signal-candidate-sampling/2",
      decisionOffsetSeconds: 15,
      pointInTimeCutoff: "EVENT_TIME_LT_DECISION_AT",
      completedLookbackPolicy: "REQUIRE_13_CONTIGUOUS_COMPLETED_WINDOWS",
      sourceIntegrityHealthy: true,
      crossVenueGuardAvailability: "UNAVAILABLE",
      productionEligible: false,
      zeroRangeCloseLocation: 0.5,
      missingValuePolicy: "ABSTAIN",
      featureNames: BINANCE_SPOT_SIGNAL_FEATURE_NAMES,
      values: {
        previous_return_bps: 1,
        previous_range_bps: 2,
        previous_volume_log1p: 3,
        previous_trade_count_log1p: 4,
        previous_buy_ratio: 0.5,
        previous_close_location: 0.5,
        current_return_from_open_bps: -1,
        current_range_bps: 2,
        current_volume_log1p: 1,
        current_trade_count_log1p: 2,
        current_buy_ratio: 0.4,
        current_close_location: 0.25,
        elapsed_ratio: 0.05,
        remaining_ratio: 0.95,
        return_3_candle_bps: 2,
        return_12_candle_bps: 5,
        realized_volatility_12: 3,
        mean_range_12_bps: 4,
        previous_volume_relative_12: 1.1,
        previous_trade_count_relative_12: 0.9,
        current_volume_rate_log1p: 2,
        current_trade_rate_log1p: 1,
        current_volume_rate_relative_12: 1.2,
        current_trade_rate_relative_12: 0.8,
      },
    } as const;

    assert.equal(BinanceSpotFeatureVectorSchema.safeParse(featureVector).success, true);
    const offCadence = {
      ...featureVector,
      decisionAt: "2026-01-01T00:00:16.000Z",
      decisionOffsetSeconds: 16,
      values: {
        ...featureVector.values,
        elapsed_ratio: 16 / 300,
        remaining_ratio: 1 - 16 / 300,
      },
    };
    const unaligned = {
      ...featureVector,
      windowStart: "2026-01-01T00:00:01.000Z",
      windowEnd: "2026-01-01T00:05:01.000Z",
      decisionAt: "2026-01-01T00:00:16.000Z",
    };
    assert.equal(BinanceSpotFeatureVectorSchema.safeParse(unaligned).success, false);
    const falseRatios = {
      ...featureVector,
      values: { ...featureVector.values, elapsed_ratio: 0.1, remaining_ratio: 0.9 },
    };
    assert.equal(BinanceSpotFeatureVectorSchema.safeParse(falseRatios).success, false);
    const reversedIds = {
      ...featureVector,
      lastIncludedTradeEventAt: featureVector.windowOpenTradeEventAt,
      windowOpenTradeId: "200",
      lastIncludedTradeId: "100",
    };
    assert.equal(BinanceSpotFeatureVectorSchema.safeParse(reversedIds).success, false);
    const paddedId = { ...featureVector, windowOpenTradeId: "0100" };
    assert.equal(BinanceSpotFeatureVectorSchema.safeParse(paddedId).success, false);
    assert.equal(BinanceSpotFeatureVectorSchema.safeParse(offCadence).success, false);
    assert.equal(
      BinanceSpotFeatureVectorSchema.safeParse({
        ...featureVector,
        windowOpenTradeEventAt: featureVector.lastIncludedTradeEventAt,
        windowOpenTradeId: "9007199254740993",
        lastIncludedTradeId: "9007199254740994",
      }).success,
      true,
    );

    const scheduledVector = (
      signalType:
        | typeof featureVector.signalType
        | "FIFTEEN_MINUTE_REVERSAL"
        | "FIVE_MINUTE_EARLY_DIRECTION",
      durationSeconds: 300 | 900,
      offsetSeconds: number,
    ) => ({
      ...featureVector,
      signalType,
      decisionAt: new Date(
        Date.parse(featureVector.windowStart) + offsetSeconds * 1_000,
      ).toISOString(),
      windowEnd: new Date(
        Date.parse(featureVector.windowStart) + durationSeconds * 1_000,
      ).toISOString(),
      decisionOffsetSeconds: offsetSeconds,
      values: {
        ...featureVector.values,
        elapsed_ratio: offsetSeconds / durationSeconds,
        remaining_ratio: 1 - offsetSeconds / durationSeconds,
      },
    });
    for (const offset of [15, 285]) {
      assert.equal(
        BinanceSpotFeatureVectorSchema.safeParse(
          scheduledVector("FIVE_MINUTE_REVERSAL", 300, offset),
        ).success,
        true,
      );
    }
    for (const offset of [0, 14, 286, 300]) {
      assert.equal(
        BinanceSpotFeatureVectorSchema.safeParse(
          scheduledVector("FIVE_MINUTE_REVERSAL", 300, offset),
        ).success,
        false,
      );
    }
    for (const offset of [15, 30, 45]) {
      assert.equal(
        BinanceSpotFeatureVectorSchema.safeParse(
          scheduledVector("FIVE_MINUTE_EARLY_DIRECTION", 300, offset),
        ).success,
        true,
      );
    }
    for (const offset of [0, 60]) {
      assert.equal(
        BinanceSpotFeatureVectorSchema.safeParse(
          scheduledVector("FIVE_MINUTE_EARLY_DIRECTION", 300, offset),
        ).success,
        false,
      );
    }
    for (const offset of [300, 870]) {
      assert.equal(
        BinanceSpotFeatureVectorSchema.safeParse(
          scheduledVector("FIFTEEN_MINUTE_REVERSAL", 900, offset),
        ).success,
        true,
      );
    }
    for (const offset of [285, 885]) {
      assert.equal(
        BinanceSpotFeatureVectorSchema.safeParse(
          scheduledVector("FIFTEEN_MINUTE_REVERSAL", 900, offset),
        ).success,
        false,
      );
    }
    assert.equal(
      BinanceSpotFeatureVectorSchema.safeParse({
        ...featureVector,
        pointInTimeCutoff: "EVENT_TIME_LTE_DECISION_AT",
      }).success,
      false,
    );
  });

  it("keeps the flat class and rejects incomplete probability mass", () => {
    assert.equal(
      CloseRelationProbabilitiesSchema.safeParse({
        ABOVE_OPEN: 0.4,
        BELOW_OPEN: 0.4,
        AT_OPEN: 0.2,
      }).success,
      true,
    );
    assert.equal(
      CloseRelationProbabilitiesSchema.safeParse({
        ABOVE_OPEN: 0.5,
        BELOW_OPEN: 0.5,
        AT_OPEN: 0.5,
      }).success,
      false,
    );
  });

  it("canonicalizes the strict pre-evaluation policy across runtimes", () => {
    const targetJsonPreimage = '{"deadbandBps":5.0,"kind":"TARGET"}';
    const fitStateJsonPreimage = '{"temperature":1.0,"weights":[]}';
    const samplingJsonPreimage = '{"seed":20260814}';
    const policy = {
      schemaVersion: PRE_EVALUATION_POLICY_SCHEMA_VERSION,
      canonicalization: PRE_EVALUATION_POLICY_CANONICALIZATION,
      signalType: "FIVE_MINUTE_EARLY_DIRECTION",
      targetJsonPreimage,
      targetSha256: createHash("sha256")
        .update(targetJsonPreimage, "utf8")
        .digest("hex"),
      featureNames: BINANCE_SPOT_SIGNAL_FEATURE_NAMES,
      fitStateJsonPreimage,
      fitStateSha256: createHash("sha256")
        .update(fitStateJsonPreimage, "utf8")
        .digest("hex"),
      samplingJsonPreimage,
      samplingSha256: createHash("sha256")
        .update(samplingJsonPreimage, "utf8")
        .digest("hex"),
      baselineSelectionPartition: "CALIBRATION",
      selectedBaselineKind: "GLOBAL_TRAIN_CLASS_FREQUENCY",
      confidenceThresholdDecimal: "1",
      deadbandBpsDecimal: "5",
      thresholdSelection: "PREDECLARED_NO_EVALUATION_ACCESS",
      challengerSelection: "NOT_RUN",
      evaluationUse: "REPORT_ONLY_NO_MODEL_OR_POLICY_SELECTION",
    } as const;
    const canonical = canonicalPreEvaluationPolicyJson(policy);
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    assert.equal(
      digest,
      "9d143ddf4831bddd0b7a1f99d0275fe5011657ee8e18087372629671bf673668",
    );
    assert.equal(PreEvaluationPolicySchema.safeParse(policy).success, true);
    assert.equal(
      canonicalPreEvaluationPolicyJson(
        Object.fromEntries(Object.entries(policy).reverse()),
      ),
      canonical,
    );
    assert.notEqual(
      createHash("sha256")
        .update(
          canonicalPreEvaluationPolicyJson({
            ...policy,
            confidenceThresholdDecimal: "0.75",
          }),
          "utf8",
        )
        .digest("hex"),
      digest,
    );
    for (const invalid of [
      { ...policy, confidenceThresholdDecimal: 1 },
      { ...policy, confidenceThresholdDecimal: "1.0" },
      { ...policy, confidenceThresholdDecimal: "0.49999999999999999999" },
      { ...policy, confidenceThresholdDecimal: "1.00000000000000000001" },
      { ...policy, deadbandBpsDecimal: 5 },
      { ...policy, schemaVersion: "flippars.pre-evaluation-policy/1" },
      { ...policy, unexpected: "field" },
    ]) {
      assert.equal(PreEvaluationPolicySchema.safeParse(invalid).success, false);
    }
  });

  it("validates canonical policy preimages without rewriting Python numbers", () => {
    const generated =
      '{"a":[{"a":5.0,"b":-1e-07},true,null],"b":{"a":"value with space","z":1.0}}';
    assert.deepEqual(parseCanonicalJsonObjectPreimage(generated), {
      a: [{ a: 5, b: -1e-7 }, true, null],
      b: { a: "value with space", z: 1 },
    });
    assert.deepEqual(parseCanonicalJsonObjectPreimage('{"a":5}'), { a: 5 });
    assert.deepEqual(parseCanonicalJsonObjectPreimage('{"a":5.0}'), { a: 5 });
    assert.deepEqual(parseCanonicalJsonObjectPreimage('{"a":"\\u00e9"}'), {
      a: String.fromCharCode(0xe9),
    });

    for (const duplicateKnownKey of [
      '{"deadbandBps":4,"deadbandBps":5.0,"kind":"TARGET"}',
      '{"deadbandBps":5.0,"kind":"TARGET","kind":"TAMPERED"}',
    ]) {
      assert.throws(
        () => parseCanonicalJsonObjectPreimage(duplicateKnownKey),
        /strictly ascending/u,
      );
    }

    for (const nonObjectRoot of ["[]", "null", "10", '"value"']) {
      assert.throws(
        () => parseCanonicalJsonObjectPreimage(nonObjectRoot),
        /plain-object root/u,
      );
    }

    for (const nonFinite of [
      '{"a":NaN}',
      '{"a":Infinity}',
      '{"a":-Infinity}',
      '{"a":1e9999}',
    ]) {
      assert.throws(() => parseCanonicalJsonObjectPreimage(nonFinite), TypeError);
    }

    for (const nonCanonical of [
      ' {"a":1}',
      '{"a": 1}',
      '{"a":1 }',
      '{"a":1}\n',
      '{"b":1,"a":2}',
      '{"a":{"b":1,"a":2}}',
      '{"a":"\\/"}',
      '{"\\u0061":1}',
      '{"a":"\\u00E9"}',
      '{"a":1.00}',
      '{"a":1e0}',
      '{"a":1E+00}',
      '{"a":-0}',
    ]) {
      assert.throws(() => parseCanonicalJsonObjectPreimage(nonCanonical), TypeError);
    }

    assert.throws(
      () =>
        parseCanonicalJsonObjectPreimage(
          `{"a":"non-ASCII: ${String.fromCharCode(0xe9)}"}`,
        ),
      /ASCII/u,
    );
  });

  it("orders canonical object keys by Python Unicode code points", () => {
    assert.deepEqual(
      parseCanonicalJsonObjectPreimage('{"\\ud800":0,"\\ue000":1,"\\ud800\\udc00":2}'),
      {
        [String.fromCharCode(0xd800)]: 0,
        [String.fromCharCode(0xe000)]: 1,
        [String.fromCodePoint(0x10000)]: 2,
      },
    );

    for (const nonPythonOrder of [
      '{"\\ud800\\udc00":1,"\\ue000":2}',
      '{"\\ue000":1,"\\ud800":2}',
    ]) {
      assert.throws(
        () => parseCanonicalJsonObjectPreimage(nonPythonOrder),
        /strictly ascending/u,
      );
    }
  });

  it("accepts canonical Python escapes and rejects equivalent aliases", () => {
    assert.deepEqual(
      parseCanonicalJsonObjectPreimage(
        '{"a":"\\b\\f\\n\\r\\t\\"\\\\/\\u0000\\u001f\\u007f"}',
      ),
      { a: '\b\f\n\r\t"\\/\u0000\u001f\u007f' },
    );

    for (const alias of [
      '{"a":"\\/"}',
      '{"a":"\\u0008"}',
      '{"a":"\\u000c"}',
      '{"a":"\\u000a"}',
      '{"a":"\\u000d"}',
      '{"a":"\\u0009"}',
      '{"a":"\\u002f"}',
      '{"a":"\\u005c"}',
      '{"a":"\\u0061"}',
      '{"a":"\\u007F"}',
    ]) {
      assert.throws(
        () => parseCanonicalJsonObjectPreimage(alias),
        /non-canonical JSON string spelling/u,
      );
    }

    assert.throws(
      () => parseCanonicalJsonObjectPreimage(`{"a":"${String.fromCharCode(0x1f)}"}`),
      /unescaped control character/u,
    );
  });

  it("enforces canonical numeric boundaries without rounding integers", () => {
    const parsed = parseCanonicalJsonObjectPreimage(
      '{"a":-9007199254740991,"b":-0.0,"c":1e-05,"d":0.0001,"e":1000000000000000.0,"f":1e+16,"g":9007199254740991}',
    );
    assert.equal(parsed["a"], Number.MIN_SAFE_INTEGER);
    assert.equal(Object.is(parsed["b"], -0), true);
    assert.equal(parsed["c"], 1e-5);
    assert.equal(parsed["d"], 0.0001);
    assert.equal(parsed["e"], 1e15);
    assert.equal(parsed["f"], 1e16);
    assert.equal(parsed["g"], Number.MAX_SAFE_INTEGER);

    for (const nonCanonical of [
      '{"a":1e-5}',
      '{"a":1e-04}',
      '{"a":1e+15}',
      '{"a":10000000000000000.0}',
      '{"a":0.00010}',
      '{"a":-0.00}',
    ]) {
      assert.throws(
        () => parseCanonicalJsonObjectPreimage(nonCanonical),
        /non-canonical JSON number spelling/u,
      );
    }

    for (const unsafeInteger of [
      '{"a":9007199254740992}',
      '{"a":9007199254740993}',
      '{"a":-9007199254740992}',
    ]) {
      assert.throws(
        () => parseCanonicalJsonObjectPreimage(unsafeInteger),
        /integer outside the JavaScript safe-integer range/u,
      );
    }
  });

  it("keeps content and lineage digests separate and counts independent windows", () => {
    const hash = "a".repeat(64);
    const parsed = DatasetManifestSummarySchema.safeParse({
      schemaVersion: "flippars.dataset-manifest-summary/3",
      datasetContentSha256: hash,
      datasetManifestSha256: "b".repeat(64),
      lineageKind: "PUBLIC_BINANCE_ARCHIVE",
      preparedArchiveIndexSha256: "c".repeat(64),
      acquisitionArchiveIndexSha256: "d".repeat(64),
      acquisitionManifestSha256: "f".repeat(64),
      rejectLogSha256: "e".repeat(64),
      source: "BINANCE_DATA_VISION",
      dataKind: "TRADES",
      symbol: "BTCUSDT",
      targetVersion: BINANCE_SPOT_TARGET_VERSION,
      featureSchemaVersion: BINANCE_SPOT_FEATURE_SCHEMA_VERSION,
      deadbandBps: 5,
      candidateSchedule: fiveMinuteSchedule,
      windowCountUnit: "UNIQUE_WINDOW_START",
      sourceIntegrityRequired: true,
      crossVenueGuardAvailability: "UNAVAILABLE",
      productionEligible: false,
      archiveCount: 2,
      archiveChecksumsVerified: true,
      officialTransportEvidenceVerified: true,
      sourceStartDateInclusive: "2026-01-01",
      sourceEndDateExclusive: "2026-01-03",
      sourceDayCount: 2,
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-01-03T00:00:00.000Z",
      acceptedTradeCount: 100,
      rejectedTradeCount: 0,
      gapCount: 0,
      duplicateTradeCount: 0,
      preparedWindowCount: 10,
      preparedDecisionRowCount: 30,
      partitionWindowCounts: { modelFit: 6, calibration: 2, evaluation: 2 },
    });
    assert.equal(parsed.success, true);
    assert.notEqual(hash, parsed.success ? parsed.data.datasetManifestSha256 : hash);
    if (!parsed.success) {
      assert.fail("Expected valid public dataset summary fixture");
    }
    const gappedV3 = { ...parsed.data, gapCount: 30 };
    const gappedV4 = {
      ...parsed.data,
      schemaVersion: "flippars.dataset-manifest-summary/4",
      gapCount: 30,
    };
    assert.equal(DatasetManifestSummarySchema.safeParse(gappedV3).success, false);
    assert.equal(DatasetManifestSummaryV3Schema.safeParse(gappedV3).success, false);
    assert.equal(DatasetManifestSummaryV4Schema.safeParse(gappedV4).success, true);
    assert.equal(
      DatasetManifestSummaryV3Schema.safeParse({
        ...gappedV3,
        lineageKind: "LOCAL_ARCHIVE_REPLAY",
        source: "LOCAL_ARCHIVE_REPLAY",
        archiveChecksumsVerified: false,
        officialTransportEvidenceVerified: false,
        acquisitionArchiveIndexSha256: null,
        acquisitionManifestSha256: null,
      }).success,
      false,
    );
    for (const mutation of [
      {
        archiveCount: 0,
        sourceDayCount: 0,
        sourceStartDateInclusive: null,
        sourceEndDateExclusive: null,
      },
      { acceptedTradeCount: 0 },
      { gapCount: Number.MAX_SAFE_INTEGER + 1 },
      { rejectedTradeCount: 1 },
      { duplicateTradeCount: 1 },
    ]) {
      assert.equal(
        DatasetManifestSummarySchema.safeParse({
          ...parsed.data,
          ...mutation,
        }).success,
        false,
      );
    }
  });
});
