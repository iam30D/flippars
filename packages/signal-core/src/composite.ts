import {
  MarketSnapshotSchema,
  type DataMode,
  type HealthFlag,
  type MarketSnapshot,
  type Venue,
  type VenueQuote,
  type VenueSymbol,
} from "@flippars/contracts";

import {
  deterministicId,
  median,
  parsePositiveDecimal,
  toDecimalString,
} from "./math.js";
import { toEpochMilliseconds } from "./windows.js";

const EXPECTED_SYMBOLS: Readonly<Record<Venue, VenueSymbol>> = {
  COINBASE: "BTC-USD",
  KRAKEN: "XBT/USD",
  BINANCE: "BTCUSDT",
};

export interface RawVenueQuote {
  readonly venue: Venue;
  readonly symbol: VenueSymbol;
  readonly price: string;
  readonly eventAt: string;
  readonly receivedAt?: string;
}

export interface CompositeSnapshotInput {
  readonly quotes: readonly RawVenueQuote[];
  readonly observedAt: string;
  readonly producedAt?: string;
  readonly usdtUsdRate?: string | null;
  readonly dataMode: DataMode;
  readonly snapshotId?: string;
}

export interface CompositeConfig {
  readonly freshnessMs: number;
  readonly allowedFutureClockSkewMs: number;
  readonly quorum: number;
  readonly maxUsdtDeviationBps: number;
  readonly maxCrossVenueSpreadBps: number;
}

export const DEFAULT_COMPOSITE_CONFIG: Readonly<CompositeConfig> = {
  freshnessMs: 5_000,
  allowedFutureClockSkewMs: 1_000,
  quorum: 2,
  maxUsdtDeviationBps: 50,
  maxCrossVenueSpreadBps: 100,
};

function createHealthFlag(
  flag: Omit<HealthFlag, "observedAt">,
  observedAt: string,
): HealthFlag {
  return { ...flag, observedAt };
}

function latestQuotePerVenue(
  quotes: readonly RawVenueQuote[],
): readonly RawVenueQuote[] {
  const latest = new Map<Venue, RawVenueQuote>();
  for (const quote of quotes) {
    const incumbent = latest.get(quote.venue);
    if (
      incumbent === undefined ||
      toEpochMilliseconds(quote.eventAt) > toEpochMilliseconds(incumbent.eventAt)
    ) {
      latest.set(quote.venue, quote);
    }
  }
  return [...latest.values()].sort((left, right) =>
    left.venue.localeCompare(right.venue),
  );
}

export function buildCompositeSnapshot(
  input: CompositeSnapshotInput,
  config: CompositeConfig = DEFAULT_COMPOSITE_CONFIG,
): MarketSnapshot {
  if (config.quorum < 1 || config.quorum > 3 || !Number.isInteger(config.quorum)) {
    throw new RangeError("Composite quorum must be an integer from 1 to 3");
  }

  const observedMs = toEpochMilliseconds(input.observedAt);
  const producedAt = input.producedAt ?? input.observedAt;
  const healthFlags: HealthFlag[] = [];
  const venueQuotes: VenueQuote[] = [];
  const normalizedEligiblePrices: number[] = [];

  let usdtUsdRate: number | null = null;
  let usdtDeviationBps: number | null = null;
  if (input.usdtUsdRate !== undefined && input.usdtUsdRate !== null) {
    usdtUsdRate = parsePositiveDecimal(input.usdtUsdRate, "usdtUsdRate");
    usdtDeviationBps = Math.abs(usdtUsdRate - 1) * 10_000;
    if (usdtDeviationBps > config.maxUsdtDeviationBps) {
      healthFlags.push(
        createHealthFlag(
          {
            code: "USDT_DEPEG",
            severity: "ERROR",
            message: `USDT/USD deviation ${usdtDeviationBps.toFixed(2)} bps exceeds ${config.maxUsdtDeviationBps} bps`,
            source: "composite",
          },
          input.observedAt,
        ),
      );
    }
  }

  for (const quote of latestQuotePerVenue(input.quotes)) {
    const rawPrice = parsePositiveDecimal(quote.price, `${quote.venue} price`);
    const eventMs = toEpochMilliseconds(quote.eventAt);
    const ageMs = Math.max(0, observedMs - eventMs);
    const exclusionReasons: string[] = [];
    const expectedSymbol = EXPECTED_SYMBOLS[quote.venue];

    if (quote.symbol !== expectedSymbol) {
      exclusionReasons.push(
        `Unexpected symbol ${quote.symbol}; expected ${expectedSymbol}`,
      );
    }
    if (eventMs - observedMs > config.allowedFutureClockSkewMs) {
      exclusionReasons.push("Event timestamp is too far in the future");
      healthFlags.push(
        createHealthFlag(
          {
            code: "CLOCK_SKEW",
            severity: "ERROR",
            message: `${quote.venue} event clock is ahead of the evaluator`,
            source: quote.venue,
          },
          input.observedAt,
        ),
      );
    } else if (observedMs - eventMs > config.freshnessMs) {
      exclusionReasons.push(`Quote age ${ageMs} ms exceeds ${config.freshnessMs} ms`);
      healthFlags.push(
        createHealthFlag(
          {
            code: "FEED_STALE",
            severity: "ERROR",
            message: `${quote.venue} quote is stale`,
            source: quote.venue,
          },
          input.observedAt,
        ),
      );
    }

    let normalizedPrice: number | null = rawPrice;
    if (quote.venue === "BINANCE") {
      if (usdtUsdRate === null) {
        normalizedPrice = null;
        exclusionReasons.push("USDT/USD reference rate is unavailable");
      } else if (
        usdtDeviationBps !== null &&
        usdtDeviationBps > config.maxUsdtDeviationBps
      ) {
        normalizedPrice = null;
        exclusionReasons.push("USDT/USD deviation gate failed");
      } else {
        normalizedPrice = rawPrice * usdtUsdRate;
      }
    }

    const eligible = exclusionReasons.length === 0 && normalizedPrice !== null;
    if (eligible && normalizedPrice !== null) {
      normalizedEligiblePrices.push(normalizedPrice);
    }

    venueQuotes.push({
      venue: quote.venue,
      symbol: quote.symbol,
      rawPrice: toDecimalString(rawPrice),
      normalizedPrice:
        normalizedPrice === null ? null : toDecimalString(normalizedPrice),
      eventAt: new Date(eventMs).toISOString(),
      receivedAt: new Date(
        toEpochMilliseconds(quote.receivedAt ?? quote.eventAt),
      ).toISOString(),
      ageMs,
      fresh:
        observedMs - eventMs <= config.freshnessMs &&
        eventMs - observedMs <= config.allowedFutureClockSkewMs,
      eligible,
      exclusionReasons,
    });
  }

  const eligibleVenueCount = normalizedEligiblePrices.length;
  if (eligibleVenueCount < config.quorum) {
    healthFlags.push(
      createHealthFlag(
        {
          code: "QUORUM_NOT_MET",
          severity: "CRITICAL",
          message: `Only ${eligibleVenueCount} eligible venues; ${config.quorum} required`,
          source: "composite",
        },
        input.observedAt,
      ),
    );
  }

  let crossVenueSpreadBps: number | null = null;
  if (normalizedEligiblePrices.length >= 2) {
    const lowest = Math.min(...normalizedEligiblePrices);
    const highest = Math.max(...normalizedEligiblePrices);
    const center = median(normalizedEligiblePrices);
    crossVenueSpreadBps = ((highest - lowest) / center) * 10_000;
    if (crossVenueSpreadBps > config.maxCrossVenueSpreadBps) {
      healthFlags.push(
        createHealthFlag(
          {
            code: "CROSS_VENUE_DIVERGENCE",
            severity: "ERROR",
            message: `Cross-venue spread ${crossVenueSpreadBps.toFixed(2)} bps exceeds ${config.maxCrossVenueSpreadBps} bps`,
            source: "composite",
          },
          input.observedAt,
        ),
      );
    }
  }

  if (input.dataMode === "DEMO") {
    healthFlags.push(
      createHealthFlag(
        {
          code: "DEMO_DATA",
          severity: "INFO",
          message: "Snapshot contains explicitly marked demonstration data",
          source: "composite",
        },
        input.observedAt,
      ),
    );
  } else if (input.dataMode === "SIMULATION") {
    healthFlags.push(
      createHealthFlag(
        {
          code: "SIMULATION_DATA",
          severity: "INFO",
          message: "Snapshot contains explicitly marked simulation data",
          source: "composite",
        },
        input.observedAt,
      ),
    );
  }

  const quorumMet = eligibleVenueCount >= config.quorum;
  const hasErrorFlag = healthFlags.some(
    (flag) => flag.severity === "ERROR" || flag.severity === "CRITICAL",
  );
  const snapshot: MarketSnapshot = {
    id:
      input.snapshotId ??
      deterministicId(
        "snapshot",
        input.observedAt,
        input.dataMode,
        ...venueQuotes.map(
          (quote) => `${quote.venue}:${quote.normalizedPrice ?? "ineligible"}`,
        ),
      ),
    instrument: "BTC-USD",
    observedAt: new Date(observedMs).toISOString(),
    producedAt: new Date(toEpochMilliseconds(producedAt)).toISOString(),
    compositePrice: quorumMet
      ? toDecimalString(median(normalizedEligiblePrices))
      : null,
    usdtUsdRate: usdtUsdRate === null ? null : toDecimalString(usdtUsdRate),
    crossVenueSpreadBps,
    quorum: config.quorum,
    eligibleVenueCount,
    venues: venueQuotes,
    health: !quorumMet
      ? "UNAVAILABLE"
      : hasErrorFlag || eligibleVenueCount < 3
        ? "DEGRADED"
        : "HEALTHY",
    healthFlags,
    dataMode: input.dataMode,
  };

  return MarketSnapshotSchema.parse(snapshot);
}
