import type { RawData } from "ws";
import type { VenueQuote } from "../domain.js";
import { finiteNumber, parseJson, WebSocketMarketFeed } from "./feed.js";

export class KrakenFeed extends WebSocketMarketFeed {
  readonly name = "kraken";
  protected readonly venue = "kraken" as const;
  protected readonly url = "wss://ws.kraken.com/v2";
  private syntheticSequence = 0;

  protected subscriptionMessages(): unknown[] {
    return [
      {
        method: "subscribe",
        params: { channel: "ticker", symbol: ["BTC/USD", "USDT/USD"], snapshot: true },
      },
      {
        method: "subscribe",
        params: { channel: "book", symbol: ["BTC/USD"], depth: 10, snapshot: true },
      },
      {
        method: "subscribe",
        params: { channel: "trade", symbol: ["BTC/USD"], snapshot: false },
      },
    ];
  }

  protected parseMessage(data: RawData, receivedAt: Date): VenueQuote[] {
    const message = parseJson(data) as Record<string, unknown>;
    if (message["channel"] !== "ticker" || !Array.isArray(message["data"])) return [];
    const quotes: VenueQuote[] = [];
    for (const item of message["data"]) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      const symbol = value["symbol"];
      if (symbol !== "BTC/USD" && symbol !== "USDT/USD") continue;
      const last = finiteNumber(value["last"]);
      const bid = finiteNumber(value["bid"]);
      const ask = finiteNumber(value["ask"]);
      if (!last || !bid || !ask) continue;
      quotes.push({
        venue: "kraken",
        instrument: symbol === "BTC/USD" ? "BTC-USD" : "USDT-USD",
        bid,
        ask,
        last,
        sequence: ++this.syntheticSequence,
        eventAt: parseDate(value["timestamp"]) ?? receivedAt,
        receivedAt,
      });
    }
    return quotes;
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
