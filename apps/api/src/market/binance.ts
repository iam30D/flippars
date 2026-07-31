import type { RawData } from "ws";
import type { VenueQuote } from "../domain.js";
import { finiteNumber, parseJson, WebSocketMarketFeed } from "./feed.js";

export class BinanceFeed extends WebSocketMarketFeed {
  readonly name = "binance";
  protected readonly venue = "binance" as const;
  protected readonly url =
    "wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker";

  protected subscriptionMessages(): unknown[] {
    return [];
  }

  protected parseMessage(data: RawData, receivedAt: Date): VenueQuote[] {
    const wrapper = parseJson(data) as Record<string, unknown>;
    const message = (wrapper["data"] ?? wrapper) as Record<string, unknown>;
    const bid = finiteNumber(message["b"]);
    const ask = finiteNumber(message["a"]);
    const sequence = finiteNumber(message["u"]);
    if (!bid || !ask || !sequence) return [];
    return [
      {
        venue: "binance",
        instrument: "BTC-USDT",
        bid,
        ask,
        last: (bid + ask) / 2,
        sequence,
        eventAt: typeof message["E"] === "number" ? new Date(message["E"]) : receivedAt,
        receivedAt,
      },
    ];
  }
}
