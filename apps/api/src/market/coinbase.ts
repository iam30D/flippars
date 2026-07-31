import type { RawData } from "ws";
import type { VenueQuote } from "../domain.js";
import { finiteNumber, parseJson, WebSocketMarketFeed } from "./feed.js";

export class CoinbaseFeed extends WebSocketMarketFeed {
  readonly name = "coinbase";
  protected readonly venue = "coinbase" as const;
  protected readonly url = "wss://advanced-trade-ws.coinbase.com";

  protected subscriptionMessages(): unknown[] {
    return [
      { type: "subscribe", product_ids: ["BTC-USD", "USDT-USD"], channel: "ticker" },
      { type: "subscribe", product_ids: ["BTC-USD"], channel: "level2" },
      { type: "subscribe", product_ids: ["BTC-USD"], channel: "market_trades" },
    ];
  }

  protected parseMessage(data: RawData, receivedAt: Date): VenueQuote[] {
    const message = parseJson(data) as Record<string, unknown>;
    if (message["channel"] !== "ticker") return [];
    const events = Array.isArray(message["events"]) ? message["events"] : [];
    const sequence = finiteNumber(message["sequence_num"]) ?? receivedAt.getTime();
    const eventAt = parseDate(message["timestamp"]) ?? receivedAt;
    const quotes: VenueQuote[] = [];
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const tickers = Array.isArray((event as Record<string, unknown>)["tickers"])
        ? ((event as Record<string, unknown>)["tickers"] as unknown[])
        : [];
      for (const ticker of tickers) {
        if (!ticker || typeof ticker !== "object") continue;
        const value = ticker as Record<string, unknown>;
        const product = value["product_id"];
        if (product !== "BTC-USD" && product !== "USDT-USD") continue;
        const last = finiteNumber(value["price"]);
        const bid = finiteNumber(value["best_bid"]);
        const ask = finiteNumber(value["best_ask"]);
        if (!last || !bid || !ask) continue;
        quotes.push({
          venue: "coinbase",
          instrument: product,
          bid,
          ask,
          last,
          sequence,
          eventAt,
          receivedAt,
        });
      }
    }
    return quotes;
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
