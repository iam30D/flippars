import {
  GuestDeviceSchema,
  GuestPreferencesSchema,
  CandleStateSchema,
  MarketSnapshotSchema,
  SignalOutcomeSchema,
  SignalSchema,
  type DataMode,
  type CandleState,
  type GuestDevice,
  type GuestPreferences,
  type HealthFlag,
  type MarketSnapshot as WireMarketSnapshot,
  type Signal,
  type SignalOutcome,
} from "@flippars/contracts";
import type {
  Candle,
  DeviceRecord,
  MarketSnapshot,
  PreferencesRecord,
  SignalRecord,
  SignalType,
  Venue,
} from "../domain.js";

export interface SignalView {
  signal: Signal;
  outcome: SignalOutcome;
}

export function presentMarketSnapshot(
  snapshot: MarketSnapshot,
  dataMode: DataMode,
  now = new Date(),
): WireMarketSnapshot {
  const flags: HealthFlag[] = [];
  if (!snapshot.health.healthy) {
    flags.push({
      code: "QUORUM_NOT_MET",
      severity: snapshot.health.degraded ? "WARNING" : "ERROR",
      message: snapshot.health.reason ?? "Market venue quorum is unavailable",
      source: "api.market-coordinator",
      observedAt: snapshot.health.checkedAt,
    });
  }
  if (snapshot.health.usdtDepegged) {
    flags.push({
      code: "USDT_DEPEG",
      severity: "ERROR",
      message:
        snapshot.health.reason ?? "USDT/USD is outside its approved normalization band",
      source: "api.market-coordinator",
      observedAt: snapshot.health.checkedAt,
    });
  }
  for (const status of snapshot.health.venues.filter(
    (venue) => !venue.fresh && venue.venue !== "simulated",
  )) {
    flags.push({
      code: "FEED_STALE",
      severity: "WARNING",
      message: `${status.venue} market data is stale`,
      source: `feed.${status.venue}`,
      observedAt: snapshot.health.checkedAt,
    });
  }
  if (dataMode === "SIMULATION") {
    flags.push({
      code: "SIMULATION_DATA",
      severity: "INFO",
      message: "This snapshot contains simulated local-development data",
      source: "api.market-coordinator",
      observedAt: snapshot.observedAt,
    });
  }
  const prices = snapshot.sources
    .filter((source) => source.eligible !== false)
    .map((source) => source.price);
  const spreadBps =
    prices.length > 1
      ? ((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 10_000
      : 0;
  const venues = snapshot.sources
    .filter((source) => source.venue !== "simulated")
    .slice(0, 3)
    .map((source) => {
      const status = snapshot.health.venues.find(
        (value) => value.venue === source.venue,
      );
      const rawPrice =
        source.rawPrice ??
        (source.venue === "binance" && snapshot.usdtUsd
          ? source.price / snapshot.usdtUsd
          : source.price);
      const eligible =
        (source.eligible ?? true) && (status?.fresh ?? snapshot.health.healthy);
      return {
        venue: wireVenue(source.venue),
        symbol:
          source.venue === "kraken"
            ? ("XBT/USD" as const)
            : source.venue === "binance"
              ? ("BTCUSDT" as const)
              : ("BTC-USD" as const),
        rawPrice: decimal(rawPrice),
        normalizedPrice: decimal(source.price),
        eventAt: status?.lastEventAt ?? snapshot.observedAt,
        receivedAt: status?.lastEventAt ?? snapshot.observedAt,
        ageMs:
          status?.lagMs ?? Math.max(0, now.getTime() - Date.parse(snapshot.observedAt)),
        fresh: status?.fresh ?? snapshot.health.healthy,
        eligible,
        exclusionReasons: [
          ...(source.exclusionReasons ?? []),
          ...(status?.fresh === false ? [status.detail ?? "stale"] : []),
        ],
      };
    });
  if (venues.length === 0)
    throw new Error(
      "A market snapshot must contain at least one real or simulated venue projection",
    );
  return MarketSnapshotSchema.parse({
    id: `snapshot:${snapshot.observedAt}`,
    instrument: "BTC-USD",
    observedAt: snapshot.observedAt,
    producedAt: now.toISOString(),
    compositePrice: decimal(snapshot.price),
    usdtUsdRate: snapshot.usdtUsd === null ? null : decimal(snapshot.usdtUsd),
    crossVenueSpreadBps: spreadBps,
    quorum: snapshot.health.requiredVenues,
    eligibleVenueCount: snapshot.health.healthyVenues,
    venues,
    health: snapshot.health.healthy
      ? "HEALTHY"
      : snapshot.health.degraded
        ? "DEGRADED"
        : "UNAVAILABLE",
    healthFlags: flags,
    dataMode,
  });
}

export function presentSignal(
  record: SignalRecord,
  options: { confidenceThreshold: number; deadbandBps: number; dataMode: DataMode },
): SignalView {
  const status: Signal["status"] = record.outcome
    ? record.outcome.result === "void"
      ? "VOID"
      : "RESOLVED"
    : Date.parse(record.expiresAt) <= Date.now()
      ? "EXPIRED"
      : "ACTIVE";
  const canonical = record.canonical
    ? SignalSchema.parse({ ...record.canonical, status })
    : fallbackSignal(record, status, options);
  const resultMap = {
    correct: "CORRECT",
    incorrect: "INCORRECT",
    flat: "FLAT",
    void: "VOID",
  } as const;
  const relation = canonical.predictedCloseRelation;
  const outcome = SignalOutcomeSchema.parse(
    record.outcome
      ? {
          signalId: record.id,
          status: resultMap[record.outcome.result],
          predictedCloseRelation: relation,
          actualCloseRelation:
            record.outcome.closePrice === null
              ? null
              : position(
                  record.outcome.closePrice,
                  record.openPrice,
                  options.deadbandBps,
                ),
          openPrice: decimal(record.openPrice),
          closePrice:
            record.outcome.closePrice === null
              ? null
              : decimal(record.outcome.closePrice),
          windowEnd: record.intervalEnd,
          resolvedAt: record.outcome.evaluatedAt,
          deadbandBps: options.deadbandBps,
          reason: record.outcome.reason,
          dataMode: canonical.dataMode,
        }
      : {
          signalId: record.id,
          status: "PENDING",
          predictedCloseRelation: relation,
          actualCloseRelation: null,
          openPrice: decimal(record.openPrice),
          closePrice: null,
          windowEnd: record.intervalEnd,
          resolvedAt: null,
          deadbandBps: options.deadbandBps,
          reason: null,
          dataMode: canonical.dataMode,
        },
  );
  return { signal: canonical, outcome };
}

export function presentDevice(device: DeviceRecord): GuestDevice {
  return GuestDeviceSchema.parse({
    installationId: device.id,
    platform: "IOS",
    appVersion: device.appVersion,
    locale: device.locale,
    timeZone: device.timezone,
    pushToken: device.pushToken,
    notificationsAuthorized: device.notificationsAuthorized,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  });
}

export function presentPreferences(preferences: PreferencesRecord): GuestPreferences {
  return GuestPreferencesSchema.parse({
    installationId: preferences.deviceId,
    enabledSignalTypes: preferences.signalTypes.map(toWireSignalType),
    notificationsEnabled: preferences.notificationsEnabled,
    minimumConfidence: preferences.minimumConfidence,
    quietHours: {
      enabled: preferences.quietHours.enabled,
      start: preferences.quietHours.start,
      end: preferences.quietHours.end,
      timeZone: preferences.quietHours.timezone,
    },
    showDemoData: preferences.showDemoData,
    locale: preferences.locale,
    updatedAt: preferences.updatedAt,
  });
}

export function presentCandle(candle: Candle) {
  return {
    ...candle,
    open: decimal(candle.open),
    high: decimal(candle.high),
    low: decimal(candle.low),
    close: decimal(candle.close),
  };
}

export function presentCurrentCandle(
  candle: Candle,
  now: Date,
  dataMode: DataMode,
  deadbandBps: number,
): CandleState {
  const current = candle.close;
  const deltaBps = ((current - candle.open) / candle.open) * 10_000;
  return CandleStateSchema.parse({
    instrument: "BTC-USD",
    interval: candle.interval,
    durationSeconds: candle.interval === "5m" ? 300 : 900,
    windowStart: candle.startAt,
    windowEnd: candle.endAt,
    openPrice: decimal(candle.open),
    currentPrice: decimal(current),
    highPrice: decimal(candle.high),
    lowPrice: decimal(candle.low),
    observedPosition:
      Math.abs(deltaBps) <= deadbandBps
        ? "AT_OPEN"
        : deltaBps > 0
          ? "ABOVE_OPEN"
          : "BELOW_OPEN",
    deadbandBps,
    sampleCount: candle.observations,
    lastUpdatedAt: now.toISOString(),
    elapsedSeconds: Math.max(0, (now.getTime() - Date.parse(candle.startAt)) / 1_000),
    remainingSeconds: Math.max(0, (Date.parse(candle.endAt) - now.getTime()) / 1_000),
    complete: now.getTime() >= Date.parse(candle.endAt),
    dataMode,
  });
}

export function toInternalSignalType(value: Signal["type"]): SignalType {
  return value === "FIVE_MINUTE_REVERSAL"
    ? "five_minute_reversal"
    : value === "FIFTEEN_MINUTE_REVERSAL"
      ? "fifteen_minute_reversal"
      : "five_minute_early_direction";
}

export function toWireSignalType(value: SignalType): Signal["type"] {
  return value === "five_minute_reversal"
    ? "FIVE_MINUTE_REVERSAL"
    : value === "fifteen_minute_reversal"
      ? "FIFTEEN_MINUTE_REVERSAL"
      : "FIVE_MINUTE_EARLY_DIRECTION";
}

function fallbackSignal(
  record: SignalRecord,
  status: Signal["status"],
  options: { confidenceThreshold: number; deadbandBps: number; dataMode: DataMode },
): Signal {
  const observed = position(record.currentPrice, record.openPrice, options.deadbandBps);
  return SignalSchema.parse({
    id: record.id,
    type: toWireSignalType(record.type),
    status,
    instrument: "BTC-USD",
    interval: record.type === "fifteen_minute_reversal" ? "15m" : "5m",
    durationSeconds: record.type === "fifteen_minute_reversal" ? 900 : 300,
    windowStart: record.intervalStart,
    windowEnd: record.intervalEnd,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    openPrice: decimal(record.openPrice),
    currentPrice: decimal(record.currentPrice),
    observedPosition: observed,
    predictedCloseRelation: record.direction === "higher" ? "ABOVE_OPEN" : "BELOW_OPEN",
    confidence: record.confidence,
    confidenceThreshold: options.confidenceThreshold,
    deadbandBps: options.deadbandBps,
    leadTimeSeconds: Math.max(
      0,
      (Date.parse(record.expiresAt) - Date.parse(record.issuedAt)) / 1_000,
    ),
    riskLevel: "LOW",
    riskScore: 0,
    riskFlags: [],
    healthFlags: [],
    evidence: record.explanation.evidence.slice(0, 20).map((evidence) => ({
      kind: "PRICE_ACTION",
      label: evidence.label,
      value: evidence.value,
      direction:
        evidence.direction === "supports"
          ? "SUPPORTS"
          : evidence.direction === "opposes"
            ? "CONTRADICTS"
            : "NEUTRAL",
    })),
    model: {
      artifactId: record.modelId,
      version: record.modelVersion,
      approvalStatus: "APPROVED",
      approvedAt: record.issuedAt,
      calibrationVersion: record.modelVersion,
    },
    audit: {
      decisionId: `decision:${record.id}`,
      engineVersion: "api-adapter/1",
      // This path reconstructs historical rows that predate canonical audit storage.
      // Never relabel those legacy decisions with the current policy version.
      policyVersion: "precision-first/1",
      inputSnapshotId: `snapshot:${record.issuedAt}`,
      forecastId: `forecast:${record.id}`,
      evaluatedAt: record.issuedAt,
      dataMode: options.dataMode,
    },
    dataMode: options.dataMode,
    informationalOnly: true,
  });
}

function position(
  current: number,
  open: number,
  deadbandBps: number,
): "ABOVE_OPEN" | "BELOW_OPEN" | "AT_OPEN" {
  const deltaBps = ((current - open) / open) * 10_000;
  if (Math.abs(deltaBps) <= deadbandBps) return "AT_OPEN";
  return deltaBps > 0 ? "ABOVE_OPEN" : "BELOW_OPEN";
}

function decimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("Price must be a finite positive number");
  return value.toFixed(10).replace(/(?:\.0+|(?:(\.\d*?[1-9])0+))$/, "$1");
}

function wireVenue(venue: Venue): "COINBASE" | "KRAKEN" | "BINANCE" {
  if (venue === "coinbase") return "COINBASE";
  if (venue === "kraken") return "KRAKEN";
  return "BINANCE";
}
