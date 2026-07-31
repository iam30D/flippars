import {
  CandleStateSchema,
  type CandleDurationSeconds,
  type CandleState,
  type DataMode,
  type MarketSnapshot,
} from "@flippars/contracts";

import { parsePositiveDecimal, toDecimalString } from "./math.js";
import { classifyPricePosition } from "./position.js";
import {
  getUtcAlignedWindow,
  getWindowProgress,
  toEpochMilliseconds,
  type UtcWindow,
} from "./windows.js";

interface CandleAccumulator {
  readonly window: UtcWindow;
  readonly open: number;
  current: number;
  high: number;
  low: number;
  sampleCount: number;
  lastUpdatedMs: number;
  readonly dataMode: DataMode;
}

export interface CandleTrackerOptions {
  readonly durations?: readonly CandleDurationSeconds[];
  readonly deadbandBps?: number;
}

export class CandleTracker {
  readonly #durations: readonly CandleDurationSeconds[];
  readonly #deadbandBps: number;
  readonly #current = new Map<CandleDurationSeconds, CandleAccumulator>();

  public constructor(options: CandleTrackerOptions = {}) {
    this.#durations = options.durations ?? [300, 900];
    this.#deadbandBps = options.deadbandBps ?? 1;
    if (this.#deadbandBps < 0 || !Number.isFinite(this.#deadbandBps)) {
      throw new RangeError("deadbandBps must be a non-negative finite number");
    }
  }

  public update(snapshot: MarketSnapshot): readonly CandleState[] {
    const compositePrice = snapshot.compositePrice;
    if (compositePrice === null) {
      return [];
    }

    return this.#durations.map((duration) =>
      this.updatePrice(
        compositePrice,
        snapshot.observedAt,
        snapshot.dataMode,
        duration,
      ),
    );
  }

  public updatePrice(
    price: string,
    at: string,
    dataMode: DataMode,
    durationSeconds: CandleDurationSeconds,
  ): CandleState {
    const numericPrice = parsePositiveDecimal(price, "price");
    const atMs = toEpochMilliseconds(at);
    const window = getUtcAlignedWindow(atMs, durationSeconds);
    const incumbent = this.#current.get(durationSeconds);

    let accumulator: CandleAccumulator;
    if (incumbent === undefined || incumbent.window.startMs !== window.startMs) {
      if (incumbent !== undefined && window.startMs < incumbent.window.startMs) {
        throw new RangeError("Out-of-order tick belongs to an older candle");
      }
      accumulator = {
        window,
        open: numericPrice,
        current: numericPrice,
        high: numericPrice,
        low: numericPrice,
        sampleCount: 1,
        lastUpdatedMs: atMs,
        dataMode,
      };
      this.#current.set(durationSeconds, accumulator);
    } else {
      if (atMs < incumbent.lastUpdatedMs) {
        throw new RangeError("Candle ticks must be monotonic");
      }
      if (incumbent.dataMode !== dataMode) {
        throw new TypeError("Cannot mix live, demo, and simulation candle data");
      }
      incumbent.current = numericPrice;
      incumbent.high = Math.max(incumbent.high, numericPrice);
      incumbent.low = Math.min(incumbent.low, numericPrice);
      incumbent.sampleCount += 1;
      incumbent.lastUpdatedMs = atMs;
      accumulator = incumbent;
    }

    return this.#toState(accumulator, atMs);
  }

  public getCurrent(
    durationSeconds: CandleDurationSeconds,
    at?: string,
  ): CandleState | null {
    const accumulator = this.#current.get(durationSeconds);
    if (accumulator === undefined) {
      return null;
    }
    const atMs = at === undefined ? accumulator.lastUpdatedMs : toEpochMilliseconds(at);
    return this.#toState(accumulator, atMs);
  }

  public reset(): void {
    this.#current.clear();
  }

  #toState(accumulator: CandleAccumulator, atMs: number): CandleState {
    const progress = getWindowProgress(accumulator.window, atMs);
    const openPrice = toDecimalString(accumulator.open);
    const currentPrice = toDecimalString(accumulator.current);
    return CandleStateSchema.parse({
      instrument: "BTC-USD",
      interval: accumulator.window.interval,
      durationSeconds: accumulator.window.durationSeconds,
      windowStart: accumulator.window.start,
      windowEnd: accumulator.window.end,
      openPrice,
      currentPrice,
      highPrice: toDecimalString(accumulator.high),
      lowPrice: toDecimalString(accumulator.low),
      observedPosition: classifyPricePosition(
        currentPrice,
        openPrice,
        this.#deadbandBps,
      ),
      deadbandBps: this.#deadbandBps,
      sampleCount: accumulator.sampleCount,
      lastUpdatedAt: new Date(accumulator.lastUpdatedMs).toISOString(),
      elapsedSeconds: progress.elapsedSeconds,
      remainingSeconds: progress.remainingSeconds,
      complete: progress.complete,
      dataMode: accumulator.dataMode,
    });
  }
}
