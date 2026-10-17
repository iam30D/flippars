import { createHash } from "node:crypto";
import { z } from "zod";

export const CAPTURE_SOURCES = ["binance", "coinbase", "kraken"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

const integer = z.number().int().safe().nonnegative();
const decimal = z
  .string()
  .max(80)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u)
  .refine((value) => /[1-9]/u.test(value));
const object = z.record(z.unknown());
const tradeSchema = z.object({
  e: z.literal("trade"),
  s: z.literal("BTCUSDT"),
  t: integer,
  E: integer,
  T: integer,
  p: decimal,
  q: decimal,
  m: z.boolean(),
});

export interface CapturedTrade {
  eventId: string;
  tradeId: string;
  eventAt: string;
  publishedAt: string;
  price: string;
  quantity: string;
  buyerIsMaker: boolean;
}

export interface PacketProjection {
  kind: "TRADE" | "GUARD_INPUT" | "CONTROL" | "UNKNOWN";
  eventId: string;
  trade: CapturedTrade | null;
}

/** Exact microseconds, with an explicit modern-era unit check. */
export function microsecondTimestamp(value: number): string {
  integer.parse(value);
  if (value < 1_577_836_800_000_000 || value >= 4_102_444_800_000_000) {
    throw new Error("Unsupported microsecond event timestamp");
  }
  const micros = BigInt(value);
  const whole = new Date(Number(micros / 1_000_000n) * 1_000).toISOString();
  return whole.replace(".000Z", `.${String(micros % 1_000_000n).padStart(6, "0")}Z`);
}

/** Raw guard bytes are retained; no quorum, FX, or integrity verdict is inferred. */
export function projectPacket(source: CaptureSource, raw: string): PacketProjection {
  const message = object.parse(JSON.parse(raw) as unknown);
  const eventId = createHash("sha256")
    .update(source + "\n" + raw)
    .digest("hex");
  if (source === "binance") {
    if (message["e"] === "serverShutdown") throw new Error("Provider shutdown");
    if (message["e"] !== "trade") return { kind: "UNKNOWN", eventId, trade: null };
    const trade = tradeSchema.parse(message);
    return {
      kind: "TRADE",
      eventId: `binance:BTCUSDT:trade:${trade.t}`,
      trade: {
        eventId: `binance:BTCUSDT:trade:${trade.t}`,
        tradeId: String(trade.t),
        eventAt: microsecondTimestamp(trade.T),
        publishedAt: microsecondTimestamp(trade.E),
        price: trade.p,
        quantity: trade.q,
        buyerIsMaker: trade.m,
      },
    };
  }
  if (source === "coinbase") {
    if (message["type"] === "error") throw new Error("Provider rejected subscription");
    if (message["type"] === "ticker") {
      z.object({
        product_id: z.enum(["BTC-USD", "USDT-USD"]),
        best_bid: decimal,
        best_ask: decimal,
        price: decimal,
        sequence: integer,
        time: z.string().datetime(),
      }).parse(message);
      return { kind: "GUARD_INPUT", eventId, trade: null };
    }
    return {
      kind: ["subscriptions", "heartbeat"].includes(String(message["type"]))
        ? "CONTROL"
        : "UNKNOWN",
      eventId,
      trade: null,
    };
  }
  if (message["success"] === false) throw new Error("Provider rejected subscription");
  if (message["channel"] === "ticker") {
    z.object({
      type: z.enum(["snapshot", "update"]),
      data: z
        .array(
          z.object({
            symbol: z.enum(["BTC/USD", "USDT/USD"]),
            bid: z.number().finite().positive(),
            ask: z.number().finite().positive(),
          }),
        )
        .min(1)
        .max(2),
    }).parse(message);
    return { kind: "GUARD_INPUT", eventId, trade: null };
  }
  return {
    kind:
      message["channel"] === "heartbeat" || message["method"] === "subscribe"
        ? "CONTROL"
        : "UNKNOWN",
    eventId,
    trade: null,
  };
}

/** Continuity is evidence within a connection; it is never silently repaired. */
export class TradeContinuity {
  private previous: CapturedTrade | null = null;

  accept(trade: CapturedTrade): void {
    const prior = this.previous;
    if (prior) {
      if (BigInt(trade.tradeId) !== BigInt(prior.tradeId) + 1n) {
        throw new Error("TRADE_ID_DISCONTINUITY");
      }
      if (trade.eventAt < prior.eventAt) throw new Error("TRADE_TIME_REGRESSION");
    }
    this.previous = trade;
  }
}
