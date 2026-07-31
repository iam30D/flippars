import { EventEmitter } from "node:events";
import type {
  MarketHealth,
  MarketSnapshot,
  SignalRecord,
  Venue,
  VenueQuote,
  VenueStatus,
} from "../domain.js";
import type { MetricsRegistry } from "../metrics.js";
import type { Repository } from "../repositories/repository.js";
import type { MarketFeed } from "./feed.js";

export interface MarketCoordinatorOptions {
  staleAfterMs: number;
  minimumHealthyVenues: number;
  retentionDays: number;
  dataMode: "live" | "simulation";
  maximumUsdtDeviationBps?: number;
  observationMinIntervalMs?: number;
}

export class MarketCoordinator extends EventEmitter {
  private readonly quotes = new Map<string, VenueQuote>();
  private readonly unsubscribers: Array<() => void> = [];
  private lastSnapshot: MarketSnapshot | null = null;
  private lastPersistedAt = 0;
  private running = false;

  constructor(
    private readonly feeds: MarketFeed[],
    private readonly repository: Repository,
    private readonly metrics: MetricsRegistry,
    private readonly options: MarketCoordinatorOptions,
  ) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const feed of this.feeds) {
      this.unsubscribers.push(feed.onQuote((quote) => void this.onQuote(quote)));
      feed.start();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await Promise.allSettled(this.feeds.map((feed) => feed.stop()));
  }

  snapshot(now = new Date()): MarketSnapshot | null {
    if (this.quotes.size === 0)
      return this.lastSnapshot
        ? { ...this.lastSnapshot, health: this.health(now) }
        : null;
    return this.buildSnapshot(now);
  }

  health(now = new Date()): MarketHealth {
    const stablecoin = this.stablecoinState(now);
    const eligibleVenues = new Set(
      [...this.quotes.values()]
        .filter(
          (quote) =>
            quote.instrument !== "USDT-USD" &&
            now.getTime() - quote.receivedAt.getTime() <= this.options.staleAfterMs,
        )
        .map((quote) => quote.venue),
    );
    if (stablecoin.rate === null || stablecoin.depegged)
      eligibleVenues.delete("binance");
    const healthyVenues = eligibleVenues.size;
    const healthy =
      !stablecoin.depegged && healthyVenues >= this.options.minimumHealthyVenues;
    const reason = stablecoin.depegged
      ? `USDT/USD deviation (${stablecoin.deviationBps.toFixed(2)} bps) exceeds the configured limit; Binance is excluded`
      : healthy
        ? null
        : healthyVenues === 0
          ? "No fresh eligible BTC venue quotes"
          : "Fresh eligible venue quorum not met";
    return {
      healthy,
      degraded: !healthy && healthyVenues > 0,
      reason,
      healthyVenues,
      requiredVenues: this.options.minimumHealthyVenues,
      checkedAt: now.toISOString(),
      venues: this.venueStatuses(now, stablecoin.depegged),
      usdtDepegged: stablecoin.depegged,
      usdtDeviationBps: stablecoin.rate === null ? null : stablecoin.deviationBps,
    };
  }

  onSnapshot(listener: (snapshot: MarketSnapshot) => void): () => void {
    this.on("snapshot", listener);
    return () => this.off("snapshot", listener);
  }

  onSignal(listener: (signal: SignalRecord) => void): () => void {
    this.on("signal", listener);
    return () => this.off("signal", listener);
  }

  onOutcome(listener: (signal: SignalRecord) => void): () => void {
    this.on("outcome", listener);
    return () => this.off("outcome", listener);
  }

  private async onQuote(quote: VenueQuote): Promise<void> {
    if (!this.running) return;
    this.quotes.set(`${quote.venue}:${quote.instrument}`, quote);
    this.metrics.increment("flippars_market_quotes_total", {
      venue: quote.venue,
      instrument: quote.instrument,
    });
    const snapshot = this.buildSnapshot(quote.receivedAt);
    if (!snapshot) return;
    this.lastSnapshot = snapshot;
    this.emit("snapshot", snapshot);
    this.metrics.gauge("flippars_market_composite_price", snapshot.price);
    this.metrics.gauge("flippars_market_healthy", snapshot.health.healthy ? 1 : 0);
    this.metrics.gauge(
      "flippars_usdt_deviation_bps",
      snapshot.health.usdtDeviationBps ?? 0,
    );
    const minInterval = this.options.observationMinIntervalMs ?? 250;
    if (quote.receivedAt.getTime() - this.lastPersistedAt < minInterval) return;
    this.lastPersistedAt = quote.receivedAt.getTime();
    const retainUntil = new Date(
      quote.receivedAt.getTime() + this.options.retentionDays * 86_400_000,
    ).toISOString();
    try {
      await this.repository.insertMarketObservation(snapshot, retainUntil);
    } catch {
      this.metrics.increment("flippars_market_persist_errors_total");
    }
  }

  private buildSnapshot(now: Date): MarketSnapshot | null {
    const fresh = [...this.quotes.values()].filter(
      (quote) =>
        now.getTime() - quote.receivedAt.getTime() <= this.options.staleAfterMs,
    );
    const stablecoin = this.stablecoinState(now);
    const usdtUsd = stablecoin.rate;
    const normalized = fresh
      .filter((quote) => quote.instrument !== "USDT-USD")
      .map((quote) => {
        if (quote.instrument === "BTC-USDT" && usdtUsd === null) return null;
        const multiplier = quote.instrument === "BTC-USDT" ? (usdtUsd ?? 0) : 1;
        const eligible = quote.instrument !== "BTC-USDT" || !stablecoin.depegged;
        return {
          venue: quote.venue,
          rawPrice: quote.last,
          price: quote.last * multiplier,
          bid: quote.bid * multiplier,
          ask: quote.ask * multiplier,
          eligible,
          exclusionReasons: eligible
            ? []
            : ["USDT/USD deviation exceeds the configured limit"],
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const onePerVenue = [
      ...new Map(normalized.map((value) => [value.venue, value])).values(),
    ];
    const eligible = onePerVenue.filter((value) => value.eligible);
    if (eligible.length === 0) return null;
    const health = this.health(now);
    const price = median(eligible.map((value) => value.price));
    const bid = median(eligible.map((value) => value.bid));
    const ask = median(eligible.map((value) => value.ask));
    return {
      symbol: "BTC-USD",
      price,
      bid,
      ask,
      observedAt: now.toISOString(),
      sources: onePerVenue.map((value) => ({
        venue: value.venue,
        rawPrice: value.rawPrice,
        price: value.price,
        weight: value.eligible ? 1 / eligible.length : 0,
        eligible: value.eligible,
        exclusionReasons: value.exclusionReasons,
      })),
      usdtUsd,
      health,
    };
  }

  private venueStatuses(now: Date, usdtDepegged: boolean): VenueStatus[] {
    const venues = new Map<Venue, VenueStatus>();
    for (const quote of this.quotes.values()) {
      if (quote.instrument === "USDT-USD") continue;
      const lagMs = Math.max(0, now.getTime() - quote.receivedAt.getTime());
      venues.set(quote.venue, {
        venue: quote.venue,
        connected: true,
        fresh: lagMs <= this.options.staleAfterMs,
        lastEventAt: quote.receivedAt.toISOString(),
        lagMs,
        ...(quote.venue === "binance" && usdtDepegged
          ? { detail: "excluded because USDT/USD is outside its approved band" }
          : {}),
      });
    }
    for (const feed of this.feeds) {
      const status = feed.status(now);
      if (!venues.has(status.venue)) venues.set(status.venue, status);
    }
    return [...venues.values()];
  }

  private stablecoinState(now: Date): {
    rate: number | null;
    deviationBps: number;
    depegged: boolean;
  } {
    const stablecoinQuotes = [...this.quotes.values()].filter(
      (quote) =>
        quote.instrument === "USDT-USD" &&
        now.getTime() - quote.receivedAt.getTime() <= this.options.staleAfterMs,
    );
    const rate = stablecoinQuotes.length
      ? median(stablecoinQuotes.map((quote) => quote.last))
      : null;
    const deviationBps = rate === null ? 0 : Math.abs(rate - 1) * 10_000;
    return {
      rate,
      deviationBps,
      depegged:
        rate !== null && deviationBps > (this.options.maximumUsdtDeviationBps ?? 50),
    };
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
