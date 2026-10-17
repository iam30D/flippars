import {
  BINANCE_SPOT_SIGNAL_FEATURE_NAMES,
  BINANCE_SPOT_FEATURE_SCHEMA_VERSION,
  BINANCE_SPOT_TARGET_VERSION,
  SIGNAL_CANDIDATE_SAMPLING_POLICY_VERSION,
  SignalTypeSchema,
} from "@flippars/contracts";
import type { CloseRelationClass, SignalType } from "@flippars/contracts";
import { z } from "zod";

const decimal = z
  .string()
  .max(80)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u)
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0);
const utcMilliseconds = z.string().datetime({ precision: 3 });
export const ResearchTradeSchema = z
  .object({
    tradeId: z.string().regex(/^[1-9]\d{0,39}$/u),
    eventAt: z.string().datetime({ precision: 6 }),
    receivedAt: utcMilliseconds,
    price: decimal,
    quantity: decimal,
    buyerIsMaker: z.boolean(),
  })
  .strict();
export type ResearchTrade = z.infer<typeof ResearchTradeSchema>;
type FeatureName = (typeof BINANCE_SPOT_SIGNAL_FEATURE_NAMES)[number];
type Features = Record<FeatureName, number>;
type Abstention = { status: "ABSTAIN"; reason: string; productionEligible: false };

function abstain(reason: string): Abstention {
  return { status: "ABSTAIN", reason, productionEligible: false };
}

function millis(value: string): number {
  utcMilliseconds.parse(value);
  const timestamp = Date.parse(value);
  if (new Date(timestamp).toISOString() !== value)
    throw new Error("Noncanonical UTC timestamp");
  return timestamp;
}

function micros(value: string): bigint {
  const base = millis(value.slice(0, 23) + "Z");
  return BigInt(base) * 1_000n + BigInt(value.slice(23, 26));
}

function integerDecimal(value: string): { value: bigint; scale: number } {
  const [whole, fraction = ""] = value.split(".");
  return { value: BigInt(whole! + fraction), scale: fraction.length };
}

function alignedPrices(close: string, open: string): [bigint, bigint] {
  const a = integerDecimal(close);
  const b = integerDecimal(open);
  const scale = Math.max(a.scale, b.scale);
  return [
    a.value * 10n ** BigInt(scale - a.scale),
    b.value * 10n ** BigInt(scale - b.scale),
  ];
}

/** Exact governed five-basis-point label, including equality in the flat class. */
export function researchCloseRelation(close: string, open: string): CloseRelationClass {
  decimal.parse(close);
  decimal.parse(open);
  const [a, b] = alignedPrices(close, open);
  const change = (a - b) * 10_000n;
  const threshold = b * 5n;
  return change > threshold
    ? "ABOVE_OPEN"
    : change < -threshold
      ? "BELOW_OPEN"
      : "AT_OPEN";
}

function returnBps(close: string, open: string): number {
  const [a, b] = alignedPrices(close, open);
  return Number((a - b) * 10_000n) / Number(b);
}

interface Candle {
  open: string;
  close: string;
  high: number;
  low: number;
  volume: number;
  buyVolume: number;
  tradeCount: number;
}

function candle(trades: ResearchTrade[]): Candle {
  const first = trades[0]!;
  const result: Candle = {
    open: first.price,
    close: first.price,
    high: Number(first.price),
    low: Number(first.price),
    volume: 0,
    buyVolume: 0,
    tradeCount: 0,
  };
  for (const trade of trades) {
    addTrade(result, trade);
  }
  return result;
}

function addTrade(result: Candle, trade: ResearchTrade): void {
  result.close = trade.price;
  result.high = Math.max(result.high, Number(trade.price));
  result.low = Math.min(result.low, Number(trade.price));
  result.volume += Number(trade.quantity);
  result.buyVolume += trade.buyerIsMaker ? 0 : Number(trade.quantity);
  result.tradeCount++;
}

function values(
  history: Candle[],
  current: Candle,
  elapsed: number,
  duration: number,
): Features {
  const previous = history[12]!;
  const twelve = history.slice(1);
  const returns = twelve.map((item) => returnBps(item.close, item.open));
  const mean = (items: number[]): number =>
    items.reduce((a, b) => a + b, 0) / items.length;
  const meanReturn = mean(returns);
  const meanVolume = mean(twelve.map((item) => item.volume));
  const meanTrades = mean(twelve.map((item) => item.tradeCount));
  const range = (item: Candle): number =>
    ((item.high - item.low) / Number(item.open)) * 10_000;
  const location = (item: Candle): number =>
    item.high === item.low
      ? 0.5
      : (Number(item.close) - item.low) / (item.high - item.low);
  const volumeRate = current.volume / elapsed;
  const tradeRate = current.tradeCount / elapsed;
  const result: Features = {
    previous_return_bps: returnBps(previous.close, previous.open),
    previous_range_bps: range(previous),
    previous_volume_log1p: Math.log1p(previous.volume),
    previous_trade_count_log1p: Math.log1p(previous.tradeCount),
    previous_buy_ratio: previous.buyVolume / previous.volume,
    previous_close_location: location(previous),
    current_return_from_open_bps: returnBps(current.close, current.open),
    current_range_bps: range(current),
    current_volume_log1p: Math.log1p(current.volume),
    current_trade_count_log1p: Math.log1p(current.tradeCount),
    current_buy_ratio: current.buyVolume / current.volume,
    current_close_location: location(current),
    elapsed_ratio: elapsed / duration,
    remaining_ratio: (duration - elapsed) / duration,
    return_3_candle_bps: returnBps(previous.close, history[9]!.close),
    return_12_candle_bps: returnBps(previous.close, history[0]!.close),
    realized_volatility_12: Math.sqrt(
      mean(returns.map((item) => (item - meanReturn) ** 2)),
    ),
    mean_range_12_bps: mean(twelve.map(range)),
    previous_volume_relative_12: previous.volume / Math.max(meanVolume, 1e-12),
    previous_trade_count_relative_12: previous.tradeCount / Math.max(meanTrades, 1e-12),
    current_volume_rate_log1p: Math.log1p(volumeRate),
    current_trade_rate_log1p: Math.log1p(tradeRate),
    current_volume_rate_relative_12:
      volumeRate / Math.max(meanVolume / duration, 1e-12),
    current_trade_rate_relative_12: tradeRate / Math.max(meanTrades / duration, 1e-12),
  };
  if (
    Object.keys(result).join() !== BINANCE_SPOT_SIGNAL_FEATURE_NAMES.join() ||
    !Object.values(result).every(Number.isFinite)
  )
    throw new Error("Invalid features");
  return result;
}

/** Batch diagnostic only: requires a verified capture, not a serving provider. */
function visibleTrades(input: unknown, cutoff: string): ResearchTrade[] {
  const parsed = z
    .array(z.object({ receivedAt: utcMilliseconds }).passthrough())
    .max(100_000)
    .parse(input);
  const cutoffMs = millis(cutoff);
  // Millisecond receive times cannot establish ordering inside the decision millisecond.
  const available = parsed
    .filter((trade) => millis(trade.receivedAt) < cutoffMs)
    .map((trade) => ResearchTradeSchema.parse(trade));
  let previous: ResearchTrade | undefined;
  for (const trade of available) {
    micros(trade.eventAt);
    if (
      previous &&
      (BigInt(trade.tradeId) !== BigInt(previous.tradeId) + 1n ||
        micros(trade.eventAt) < micros(previous.eventAt) ||
        trade.receivedAt < previous.receivedAt)
    )
      throw new Error("Trade integrity failure");
    previous = trade;
  }
  return available;
}

function window(
  signalType: SignalType,
  windowStart: string,
): { start: bigint; duration: number } {
  SignalTypeSchema.parse(signalType);
  const duration = signalType === "FIFTEEN_MINUTE_REVERSAL" ? 900 : 300;
  const startMs = millis(windowStart);
  if (startMs % (duration * 1_000) !== 0) throw new Error("Unaligned window");
  return { start: BigInt(startMs) * 1_000n, duration };
}

export function buildResearchDecision(input: {
  signalType: SignalType;
  windowStart: string;
  decisionAt: string;
  trades: unknown;
}):
  | Abstention
  | {
      status: "FEATURES";
      schemaVersion: "flippars.research-decision/1";
      productionEligible: false;
      crossVenueGuardAvailability: "UNAVAILABLE";
      availabilityCutoff: "RECEIVED_AT_LT_DECISION_AT_AND_EVENT_TIME_LT_DECISION_AT";
      id: string;
      signalType: SignalType;
      windowStart: string;
      windowEnd: string;
      decisionAt: string;
      decisionOffsetSeconds: number;
      targetVersion: typeof BINANCE_SPOT_TARGET_VERSION;
      featureSchemaVersion: typeof BINANCE_SPOT_FEATURE_SCHEMA_VERSION;
      decisionPolicyVersion: typeof SIGNAL_CANDIDATE_SAMPLING_POLICY_VERSION;
      deadbandBps: 5;
      values: Features;
      currentRelation: CloseRelationClass;
      candidateEligible: boolean;
      firstIncludedTradeId: string;
      lastIncludedTradeId: string;
    } {
  try {
    const { start, duration } = window(input.signalType, input.windowStart);
    const decision = BigInt(millis(input.decisionAt)) * 1_000n;
    const elapsed = Number(decision - start) / 1_000_000;
    const first = input.signalType === "FIFTEEN_MINUTE_REVERSAL" ? 300 : 15;
    const last =
      input.signalType === "FIFTEEN_MINUTE_REVERSAL"
        ? 870
        : input.signalType === "FIVE_MINUTE_EARLY_DIRECTION"
          ? 45
          : 285;
    if (elapsed < first || elapsed > last || (elapsed - first) % 15 !== 0)
      return abstain("UNSCHEDULED_DECISION");
    const available = visibleTrades(input.trades, input.decisionAt).filter(
      (trade) => micros(trade.eventAt) < decision,
    );
    const oldest = start - BigInt(13 * duration) * 1_000_000n;
    if (!available.some((trade) => micros(trade.eventAt) < oldest))
      return abstain("INSUFFICIENT_BOUNDARY_ANCHOR");
    const buckets: ResearchTrade[][] = Array.from({ length: 14 }, () => []);
    for (const trade of available) {
      const offset = micros(trade.eventAt) - oldest;
      if (offset < 0n) continue;
      const index = Number(offset / (BigInt(duration) * 1_000_000n));
      if (index < 14) buckets[index]!.push(trade);
    }
    if (buckets.slice(0, 13).some((bucket) => bucket.length === 0))
      return abstain("GAPPED_OR_INSUFFICIENT_LOOKBACK");
    const partial = buckets[13]!;
    if (!partial.length) return abstain("NO_CURRENT_WINDOW_TRADES");
    const current = candle(partial);
    return decisionFromCandles(
      input,
      buckets.slice(0, 13).map(candle),
      current,
      partial[0]!.tradeId,
      partial.at(-1)!.tradeId,
    );
  } catch {
    return abstain("INVALID_OR_DISCONTINUOUS_INPUT");
  }
}

function decisionFromCandles(
  input: { signalType: SignalType; windowStart: string; decisionAt: string },
  history: Candle[],
  current: Candle,
  firstTradeId: string,
  lastTradeId: string,
): Extract<ReturnType<typeof buildResearchDecision>, { status: "FEATURES" }> {
  const { start, duration } = window(input.signalType, input.windowStart);
  const elapsed = (millis(input.decisionAt) - Number(start / 1_000n)) / 1_000;
  const relation = researchCloseRelation(current.close, current.open);
  return {
    schemaVersion: "flippars.research-decision/1",
    status: "FEATURES",
    productionEligible: false,
    crossVenueGuardAvailability: "UNAVAILABLE",
    availabilityCutoff: "RECEIVED_AT_LT_DECISION_AT_AND_EVENT_TIME_LT_DECISION_AT",
    id: `research:BTCUSDT:${input.signalType}:${input.windowStart}:${elapsed}`,
    signalType: input.signalType,
    windowStart: input.windowStart,
    windowEnd: new Date(Number(start / 1_000n) + duration * 1_000).toISOString(),
    decisionAt: input.decisionAt,
    decisionOffsetSeconds: elapsed,
    targetVersion: BINANCE_SPOT_TARGET_VERSION,
    featureSchemaVersion: BINANCE_SPOT_FEATURE_SCHEMA_VERSION,
    decisionPolicyVersion: SIGNAL_CANDIDATE_SAMPLING_POLICY_VERSION,
    deadbandBps: 5,
    values: values(history, current, elapsed, duration),
    currentRelation: relation,
    candidateEligible:
      input.signalType === "FIVE_MINUTE_EARLY_DIRECTION" || relation !== "AT_OPEN",
    firstIncludedTradeId: firstTradeId,
    lastIncludedTradeId: lastTradeId,
  };
}

/** Chronological research state only. A poisoned stream requires a new warm-up. */
export class ResearchFeatureStream {
  private readonly duration: number;
  private readonly buckets = new Map<
    bigint,
    { value: Candle; firstId: string; lastId: string }
  >();
  private pending: ResearchTrade[] = [];
  private cursor = 0;
  private prior: ResearchTrade | null = null;
  private firstEvent: bigint | null = null;
  private advancedThrough: number | null = null;
  private failure: string | null = null;
  private cached: {
    at: string;
    windowStart: string;
    result: ReturnType<typeof buildResearchDecision>;
  } | null = null;

  constructor(
    private readonly signalType: SignalType,
    private readonly pendingLimit = 100_000,
  ) {
    SignalTypeSchema.parse(signalType);
    if (
      !Number.isSafeInteger(pendingLimit) ||
      pendingLimit < 1 ||
      pendingLimit > 100_000
    )
      throw new Error("Invalid pending-trade limit");
    this.duration = signalType === "FIFTEEN_MINUTE_REVERSAL" ? 900 : 300;
  }

  ingest(input: unknown): void {
    if (this.failure) throw new Error(this.failure);
    try {
      const trade = ResearchTradeSchema.parse(input);
      micros(trade.eventAt);
      if (
        this.prior &&
        (BigInt(trade.tradeId) !== BigInt(this.prior.tradeId) + 1n ||
          micros(trade.eventAt) < micros(this.prior.eventAt) ||
          trade.receivedAt < this.prior.receivedAt)
      ) {
        throw new Error("STREAM_CONTINUITY_FAILURE");
      }
      this.advance(trade.receivedAt);
      if (this.pending.length - this.cursor >= this.pendingLimit)
        throw new Error("PENDING_TRADE_LIMIT");
      this.pending.push(trade);
      this.prior = trade;
    } catch {
      this.failure = "INVALID_OR_DISCONTINUOUS_STREAM";
      this.pending = [];
      this.cursor = 0;
      this.buckets.clear();
      throw new Error(this.failure);
    }
  }

  snapshot(input: {
    windowStart: string;
    decisionAt: string;
  }): ReturnType<typeof buildResearchDecision> {
    if (
      this.cached?.at === input.decisionAt &&
      this.cached.windowStart === input.windowStart
    ) {
      return structuredClone(this.cached.result);
    }
    if (this.failure) return abstain(this.failure);
    try {
      const { start } = window(this.signalType, input.windowStart);
      const elapsed = (millis(input.decisionAt) - Number(start / 1_000n)) / 1_000;
      const first = this.signalType === "FIFTEEN_MINUTE_REVERSAL" ? 300 : 15;
      const last =
        this.signalType === "FIFTEEN_MINUTE_REVERSAL"
          ? 870
          : this.signalType === "FIVE_MINUTE_EARLY_DIRECTION"
            ? 45
            : 285;
      if (elapsed < first || elapsed > last || (elapsed - first) % 15 !== 0)
        return abstain("UNSCHEDULED_DECISION");
      if (
        this.advancedThrough !== null &&
        millis(input.decisionAt) < this.advancedThrough
      )
        return abstain("NON_MONOTONIC_REPLAY");
      this.advance(input.decisionAt);
      const span = BigInt(this.duration) * 1_000_000n;
      const oldest = start - 13n * span;
      let result: ReturnType<typeof buildResearchDecision>;
      if (this.firstEvent === null || this.firstEvent >= oldest)
        result = abstain("INSUFFICIENT_BOUNDARY_ANCHOR");
      else {
        const history: Candle[] = [];
        for (let index = 0; index < 13; index++) {
          const bucket = this.buckets.get(oldest + BigInt(index) * span);
          if (!bucket) break;
          history.push(bucket.value);
        }
        const current = this.buckets.get(start);
        result =
          history.length !== 13
            ? abstain("GAPPED_OR_INSUFFICIENT_LOOKBACK")
            : !current
              ? abstain("NO_CURRENT_WINDOW_TRADES")
              : decisionFromCandles(
                  { ...input, signalType: this.signalType },
                  history,
                  current.value,
                  current.firstId,
                  current.lastId,
                );
      }
      this.cached = {
        at: input.decisionAt,
        windowStart: input.windowStart,
        result: structuredClone(result),
      };
      return result;
    } catch {
      this.failure = "INVALID_OR_DISCONTINUOUS_STREAM";
      return abstain(this.failure);
    }
  }

  statistics(): { retainedCandles: number; pendingTrades: number } {
    return {
      retainedCandles: this.buckets.size,
      pendingTrades: this.pending.length - this.cursor,
    };
  }

  private advance(cutoff: string): void {
    const cutoffMs = millis(cutoff);
    if (this.advancedThrough !== null && cutoffMs < this.advancedThrough)
      throw new Error("NON_MONOTONIC_REPLAY");
    const cutoffMicros = BigInt(cutoffMs) * 1_000n;
    const span = BigInt(this.duration) * 1_000_000n;
    const startMs =
      Math.floor(cutoffMs / (this.duration * 1_000)) * this.duration * 1_000;
    const oldest = BigInt(startMs) * 1_000n - 13n * span;
    for (const key of this.buckets.keys()) if (key < oldest) this.buckets.delete(key);
    while (this.cursor < this.pending.length) {
      const trade = this.pending[this.cursor]!;
      const event = micros(trade.eventAt);
      if (trade.receivedAt >= cutoff || event >= cutoffMicros) break;
      this.firstEvent ??= event;
      if (event >= oldest) {
        const key = (event >= 0n ? event / span : (event - span + 1n) / span) * span;
        const bucket = this.buckets.get(key);
        if (bucket) {
          addTrade(bucket.value, trade);
          bucket.lastId = trade.tradeId;
        } else
          this.buckets.set(key, {
            value: candle([trade]),
            firstId: trade.tradeId,
            lastId: trade.tradeId,
          });
      }
      this.cursor++;
    }
    if (this.cursor >= 1_024 || this.cursor >= this.pending.length / 2) {
      this.pending = this.pending.slice(this.cursor);
      this.cursor = 0;
    }
    this.advancedThrough = cutoffMs;
  }
}

/** Bounded accumulator for one fixed, closed target and receipt cutoff. */
export class ResearchOutcomeStream {
  private readonly input: {
    signalType: SignalType;
    windowStart: string;
    observedThrough: string;
  };
  private previous: ResearchTrade | undefined;
  private before = false;
  private after = false;
  private open: string | undefined;
  private close: string | undefined;
  private invalid = false;
  private readonly start: bigint;
  private readonly end: bigint;

  constructor(input: {
    signalType: SignalType;
    windowStart: string;
    observedThrough: string;
  }) {
    this.input = { ...input };
    const target = window(input.signalType, input.windowStart);
    this.start = target.start;
    this.end = target.start + BigInt(target.duration) * 1_000_000n;
    millis(input.observedThrough);
  }

  ingest(input: unknown): void {
    if (this.invalid) return;
    try {
      // Match the batch reference: unavailable receipts cannot affect labels.
      const receipt = z.object({ receivedAt: utcMilliseconds }).parse(input);
      if (millis(receipt.receivedAt) >= millis(this.input.observedThrough)) return;
      const trade = ResearchTradeSchema.parse(input);
      const event = micros(trade.eventAt);
      if (
        this.previous &&
        (BigInt(trade.tradeId) !== BigInt(this.previous.tradeId) + 1n ||
          event < micros(this.previous.eventAt) ||
          trade.receivedAt < this.previous.receivedAt)
      )
        throw new Error("Discontinuous outcome input");
      this.previous = trade;
      if (event < this.start) this.before = true;
      else if (event >= this.end) this.after = true;
      else {
        this.open ??= trade.price;
        this.close = trade.price;
      }
    } catch {
      this.invalid = true;
    }
  }

  snapshot(): ReturnType<typeof buildResearchOutcome> {
    if (BigInt(millis(this.input.observedThrough)) * 1_000n < this.end)
      return abstain("TARGET_NOT_CLOSED");
    if (this.invalid) return abstain("INVALID_OR_DISCONTINUOUS_INPUT");
    if (!this.before || !this.after) return abstain("INSUFFICIENT_BOUNDARY_ANCHORS");
    if (!this.open || !this.close) return abstain("EMPTY_TARGET_WINDOW");
    return outcomeRecord(this.input, this.end, this.open, this.close);
  }
}

/** Bounded target population sharing one validated source prefix. */
export class ResearchOutcomePopulation {
  private readonly targets = new Map<
    bigint,
    { start: string; open?: string; close?: string }
  >();
  private readonly span: bigint;
  private previous: ResearchTrade | undefined;
  private first: bigint | undefined;
  private last: bigint | undefined;
  private invalid = false;

  constructor(
    private readonly signalType: SignalType,
    windowStarts: string[],
    private readonly observedThrough: string,
  ) {
    millis(observedThrough);
    this.span =
      BigInt(signalType === "FIFTEEN_MINUTE_REVERSAL" ? 900 : 300) * 1_000_000n;
    if (windowStarts.length > 64) throw new Error("Outcome population limit exceeded");
    for (const start of windowStarts) {
      const target = window(signalType, start);
      if (this.targets.has(target.start)) throw new Error("Duplicate outcome target");
      this.targets.set(target.start, { start });
    }
  }

  ingest(input: unknown): void {
    if (this.invalid) return;
    try {
      const receipt = z.object({ receivedAt: utcMilliseconds }).parse(input);
      if (millis(receipt.receivedAt) >= millis(this.observedThrough)) return;
      const trade = ResearchTradeSchema.parse(input);
      const event = micros(trade.eventAt);
      if (
        this.previous &&
        (BigInt(trade.tradeId) !== BigInt(this.previous.tradeId) + 1n ||
          event < micros(this.previous.eventAt) ||
          trade.receivedAt < this.previous.receivedAt)
      )
        throw new Error("Outcome population continuity failure");
      this.previous = trade;
      this.first ??= event;
      this.last = event;
      const key =
        (event >= 0n ? event / this.span : (event - this.span + 1n) / this.span) *
        this.span;
      const target = this.targets.get(key);
      if (target) {
        target.open ??= trade.price;
        target.close = trade.price;
      }
    } catch {
      this.invalid = true;
    }
  }

  snapshot() {
    return [...this.targets.entries()].map(([start, target]) => {
      const end = start + this.span;
      const input = {
        signalType: this.signalType,
        windowStart: target.start,
        observedThrough: this.observedThrough,
      };
      const outcome =
        BigInt(millis(this.observedThrough)) * 1_000n < end
          ? abstain("TARGET_NOT_CLOSED")
          : this.invalid
            ? abstain("INVALID_OR_DISCONTINUOUS_INPUT")
            : this.first === undefined ||
                this.last === undefined ||
                this.first >= start ||
                this.last < end
              ? abstain("INSUFFICIENT_BOUNDARY_ANCHORS")
              : !target.open || !target.close
                ? abstain("EMPTY_TARGET_WINDOW")
                : outcomeRecord(input, end, target.open, target.close);
      return { signalType: this.signalType, windowStart: target.start, outcome };
    });
  }
}

function outcomeRecord(
  input: {
    signalType: SignalType;
    windowStart: string;
    observedThrough: string;
  },
  end: bigint,
  openPrice: string,
  closePrice: string,
) {
  return {
    schemaVersion: "flippars.research-outcome/1" as const,
    status: "OUTCOME" as const,
    productionEligible: false as const,
    label: researchCloseRelation(closePrice, openPrice),
    openPrice,
    closePrice,
    id: `research-outcome:BTCUSDT:${input.signalType}:${input.windowStart}`,
    signalType: input.signalType,
    windowStart: input.windowStart,
    windowEnd: new Date(Number(end / 1_000n)).toISOString(),
    observedThrough: input.observedThrough,
    deadbandBps: 5 as const,
  };
}

export function buildResearchOutcome(input: {
  signalType: SignalType;
  windowStart: string;
  observedThrough: string;
  trades: unknown;
}):
  | Abstention
  | {
      status: "OUTCOME";
      schemaVersion: "flippars.research-outcome/1";
      productionEligible: false;
      label: CloseRelationClass;
      openPrice: string;
      closePrice: string;
      id: string;
      signalType: SignalType;
      windowStart: string;
      windowEnd: string;
      observedThrough: string;
      deadbandBps: 5;
    } {
  try {
    const { start, duration } = window(input.signalType, input.windowStart);
    const end = start + BigInt(duration) * 1_000_000n;
    if (BigInt(millis(input.observedThrough)) * 1_000n < end)
      return abstain("TARGET_NOT_CLOSED");
    const available = visibleTrades(input.trades, input.observedThrough);
    if (
      !available.some((trade) => micros(trade.eventAt) < start) ||
      !available.some((trade) => micros(trade.eventAt) >= end)
    )
      return abstain("INSUFFICIENT_BOUNDARY_ANCHORS");
    const target = available.filter(
      (trade) => micros(trade.eventAt) >= start && micros(trade.eventAt) < end,
    );
    if (!target.length) return abstain("EMPTY_TARGET_WINDOW");
    const openPrice = target[0]!.price;
    const closePrice = target.at(-1)!.price;
    return outcomeRecord(input, end, openPrice, closePrice);
  } catch {
    return abstain("INVALID_OR_DISCONTINUOUS_INPUT");
  }
}
