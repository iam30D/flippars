import { EventEmitter } from "node:events";
import type { Venue, VenueQuote, VenueStatus } from "../domain.js";
import type { MarketFeed } from "./feed.js";

/** Local/test-only deterministic-ish market source. It can never be enabled in production. */
export class SimulatedMarketFeed extends EventEmitter implements MarketFeed {
  readonly name = "simulated";
  private timer: NodeJS.Timeout | null = null;
  private lastEvent: Date | null = null;
  private price: number;
  private sequence = 0;

  constructor(
    private readonly staleAfterMs: number,
    initialPrice = 65_000,
  ) {
    super();
    this.price = initialPrice;
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref();
  }

  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return Promise.resolve();
  }

  status(now = new Date()): VenueStatus {
    const lagMs = this.lastEvent ? now.getTime() - this.lastEvent.getTime() : null;
    return {
      venue: "simulated",
      connected: Boolean(this.timer),
      fresh: Boolean(this.timer) && lagMs !== null && lagMs <= this.staleAfterMs,
      lastEventAt: this.lastEvent?.toISOString() ?? null,
      lagMs,
      detail: "SIMULATION DATA — never eligible for production signaling",
    };
  }

  onQuote(listener: (quote: VenueQuote) => void): () => void {
    this.on("quote", listener);
    return () => this.off("quote", listener);
  }

  private tick(): void {
    const now = new Date();
    this.price = Math.max(
      1,
      this.price + Math.sin(this.sequence / 8) * 2 + (Math.random() - 0.5) * 4,
    );
    const usdt = 1 + Math.sin(this.sequence / 100) * 0.0001;
    this.lastEvent = now;
    for (const [venue, multiplier] of [
      ["coinbase", 1],
      ["kraken", 1.00002],
    ] as Array<[Venue, number]>) {
      this.emitQuote(venue, "BTC-USD", this.price * multiplier, now);
    }
    this.emitQuote("coinbase", "USDT-USD", usdt, now);
    this.emitQuote("binance", "BTC-USDT", (this.price / usdt) * 0.99999, now);
  }

  private emitQuote(
    venue: Venue,
    instrument: VenueQuote["instrument"],
    price: number,
    now: Date,
  ): void {
    const spread = instrument === "USDT-USD" ? 0.00002 : 0.5;
    const quote: VenueQuote = {
      venue,
      instrument,
      bid: price - spread / 2,
      ask: price + spread / 2,
      last: price,
      sequence: ++this.sequence,
      eventAt: now,
      receivedAt: now,
    };
    this.emit("quote", quote);
  }
}
