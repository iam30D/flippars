import { z } from "zod";

import {
  DataModeSchema,
  HealthFlagSchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  Rfc3339TimestampSchema,
} from "./primitives.js";

export const VenueSchema = z.enum(["COINBASE", "KRAKEN", "BINANCE"]);
export type Venue = z.infer<typeof VenueSchema>;

export const VenueSymbolSchema = z.enum(["BTC-USD", "XBT/USD", "BTCUSDT"]);
export type VenueSymbol = z.infer<typeof VenueSymbolSchema>;

export const VenueQuoteSchema = z
  .object({
    venue: VenueSchema,
    symbol: VenueSymbolSchema,
    rawPrice: PositiveDecimalStringSchema,
    normalizedPrice: PositiveDecimalStringSchema.nullable(),
    eventAt: Rfc3339TimestampSchema,
    receivedAt: Rfc3339TimestampSchema,
    ageMs: z.number().int().nonnegative(),
    fresh: z.boolean(),
    eligible: z.boolean(),
    exclusionReasons: z.array(z.string().min(1).max(160)),
  })
  .strict();
export type VenueQuote = z.infer<typeof VenueQuoteSchema>;

export const MarketHealthSchema = z.enum(["HEALTHY", "DEGRADED", "UNAVAILABLE"]);
export type MarketHealth = z.infer<typeof MarketHealthSchema>;

export const MarketSnapshotSchema = z
  .object({
    id: z.string().min(1).max(128),
    instrument: z.literal("BTC-USD"),
    observedAt: Rfc3339TimestampSchema,
    producedAt: Rfc3339TimestampSchema,
    compositePrice: PositiveDecimalStringSchema.nullable(),
    usdtUsdRate: PositiveDecimalStringSchema.nullable(),
    crossVenueSpreadBps: z.number().nonnegative().nullable(),
    quorum: z.number().int().positive(),
    eligibleVenueCount: z.number().int().nonnegative(),
    venues: z.array(VenueQuoteSchema).max(3),
    health: MarketHealthSchema,
    healthFlags: z.array(HealthFlagSchema),
    dataMode: DataModeSchema,
  })
  .strict();
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const CandleDurationSecondsSchema = z.union([z.literal(300), z.literal(900)]);
export type CandleDurationSeconds = z.infer<typeof CandleDurationSecondsSchema>;

export const CandleIntervalSchema = z.enum(["5m", "15m"]);
export type CandleInterval = z.infer<typeof CandleIntervalSchema>;

export const PricePositionSchema = z.enum(["ABOVE_OPEN", "BELOW_OPEN", "AT_OPEN"]);
export type PricePosition = z.infer<typeof PricePositionSchema>;

export const CandleStateSchema = z
  .object({
    instrument: z.literal("BTC-USD"),
    interval: CandleIntervalSchema,
    durationSeconds: CandleDurationSecondsSchema,
    windowStart: Rfc3339TimestampSchema,
    windowEnd: Rfc3339TimestampSchema,
    openPrice: PositiveDecimalStringSchema,
    currentPrice: PositiveDecimalStringSchema,
    highPrice: PositiveDecimalStringSchema,
    lowPrice: PositiveDecimalStringSchema,
    observedPosition: PricePositionSchema,
    deadbandBps: z.number().nonnegative(),
    sampleCount: z.number().int().positive(),
    lastUpdatedAt: Rfc3339TimestampSchema,
    elapsedSeconds: z.number().nonnegative(),
    remainingSeconds: z.number().nonnegative(),
    complete: z.boolean(),
    dataMode: DataModeSchema,
  })
  .strict();
export type CandleState = z.infer<typeof CandleStateSchema>;

export const MarketPricePointSchema = z
  .object({
    at: Rfc3339TimestampSchema,
    price: PositiveDecimalStringSchema,
    volume: NonNegativeDecimalStringSchema.optional(),
  })
  .strict();
export type MarketPricePoint = z.infer<typeof MarketPricePointSchema>;
