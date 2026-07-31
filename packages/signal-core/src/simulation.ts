import type { MarketSnapshot, SignalType } from "@flippars/contracts";

import { buildCompositeSnapshot, type CompositeConfig } from "./composite.js";
import { toDecimalString } from "./math.js";
import { toEpochMilliseconds } from "./windows.js";

export class DeterministicClock {
  #nowMs: number;

  public constructor(startAt: string) {
    this.#nowMs = toEpochMilliseconds(startAt);
  }

  public now(): string {
    return new Date(this.#nowMs).toISOString();
  }

  public advance(milliseconds: number): string {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("Clock advance must be a non-negative finite number");
    }
    this.#nowMs += milliseconds;
    return this.now();
  }
}

/**
 * Mulberry32 PRNG. It is deliberately small and reproducible; it is a replay
 * utility, not a source of cryptographic randomness.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface SimulationGeneratorOptions {
  readonly startAt: string;
  readonly startPrice: string;
  readonly tickCount: number;
  readonly stepMs: number;
  readonly seed: number;
  readonly driftBpsPerTick?: number;
  readonly volatilityBps?: number;
  readonly venueNoiseBps?: number;
  readonly usdtUsdRate?: string;
}

export function generateSimulationSnapshots(
  options: SimulationGeneratorOptions,
  compositeConfig?: CompositeConfig,
): readonly MarketSnapshot[] {
  if (!Number.isInteger(options.tickCount) || options.tickCount < 1) {
    throw new RangeError("tickCount must be a positive integer");
  }
  if (!Number.isFinite(options.stepMs) || options.stepMs <= 0) {
    throw new RangeError("stepMs must be greater than zero");
  }

  const random = createSeededRandom(options.seed);
  const startMs = toEpochMilliseconds(options.startAt);
  let center = Number(options.startPrice);
  if (!Number.isFinite(center) || center <= 0) {
    throw new RangeError("startPrice must be positive and finite");
  }

  const driftBps = options.driftBpsPerTick ?? 0;
  const volatilityBps = options.volatilityBps ?? 2;
  const venueNoiseBps = options.venueNoiseBps ?? 0.25;
  const usdtUsdRate = options.usdtUsdRate ?? "1";
  const snapshots: MarketSnapshot[] = [];

  for (let index = 0; index < options.tickCount; index += 1) {
    if (index > 0) {
      const shockBps = (random() * 2 - 1) * volatilityBps;
      center *= 1 + (driftBps + shockBps) / 10_000;
    }

    const at = new Date(startMs + index * options.stepMs).toISOString();
    const noise = (): number => (random() * 2 - 1) * venueNoiseBps;
    const coinbase = center * (1 + noise() / 10_000);
    const kraken = center * (1 + noise() / 10_000);
    const rate = Number(usdtUsdRate);
    const binanceUsd = center * (1 + noise() / 10_000);
    const binanceUsdt = binanceUsd / rate;

    snapshots.push(
      buildCompositeSnapshot(
        {
          observedAt: at,
          producedAt: at,
          dataMode: "SIMULATION",
          usdtUsdRate,
          snapshotId: `simulation-${options.seed}-${index}`,
          quotes: [
            {
              venue: "COINBASE",
              symbol: "BTC-USD",
              price: toDecimalString(coinbase),
              eventAt: at,
              receivedAt: at,
            },
            {
              venue: "KRAKEN",
              symbol: "XBT/USD",
              price: toDecimalString(kraken),
              eventAt: at,
              receivedAt: at,
            },
            {
              venue: "BINANCE",
              symbol: "BTCUSDT",
              price: toDecimalString(binanceUsdt),
              eventAt: at,
              receivedAt: at,
            },
          ],
        },
        compositeConfig,
      ),
    );
  }
  return snapshots;
}

export interface ExplicitSimulationPoint {
  readonly at: string;
  readonly price: string;
  readonly usdtUsdRate?: string;
}

export function replayExplicitPrices(
  points: readonly ExplicitSimulationPoint[],
  compositeConfig?: CompositeConfig,
): readonly MarketSnapshot[] {
  return points.map((point, index) => {
    const rate = point.usdtUsdRate ?? "1";
    const binancePrice = Number(point.price) / Number(rate);
    return buildCompositeSnapshot(
      {
        observedAt: point.at,
        producedAt: point.at,
        dataMode: "SIMULATION",
        snapshotId: `explicit-simulation-${index}`,
        usdtUsdRate: rate,
        quotes: [
          {
            venue: "COINBASE",
            symbol: "BTC-USD",
            price: point.price,
            eventAt: point.at,
          },
          {
            venue: "KRAKEN",
            symbol: "XBT/USD",
            price: point.price,
            eventAt: point.at,
          },
          {
            venue: "BINANCE",
            symbol: "BTCUSDT",
            price: toDecimalString(binancePrice),
            eventAt: point.at,
          },
        ],
      },
      compositeConfig,
    );
  });
}

export function signalTypesForDuration(
  durationSeconds: 300 | 900,
): readonly SignalType[] {
  return durationSeconds === 300
    ? ["FIVE_MINUTE_REVERSAL", "FIVE_MINUTE_EARLY_DIRECTION"]
    : ["FIFTEEN_MINUTE_REVERSAL"];
}
