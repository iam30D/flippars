import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type { Venue, VenueQuote, VenueStatus } from "../domain.js";

export interface MarketFeed {
  readonly name: string;
  start(): void;
  stop(): Promise<void>;
  status(now?: Date): VenueStatus;
  onQuote(listener: (quote: VenueQuote) => void): () => void;
}

export abstract class WebSocketMarketFeed extends EventEmitter implements MarketFeed {
  abstract readonly name: string;
  protected abstract readonly venue: Venue;
  protected abstract readonly url: string;
  private socket: WebSocket | null = null;
  private desired = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastEvent: Date | null = null;
  private connected = false;
  private pongReceived = true;
  private statusDetail: string | undefined;
  private readonly lastSequences = new Map<string, number>();

  constructor(protected readonly staleAfterMs: number) {
    super();
  }

  start(): void {
    if (this.desired) return;
    this.desired = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.desired = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 2_000);
      timer.unref();
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close(1000, "shutdown");
    });
  }

  status(now = new Date()): VenueStatus {
    const lagMs = this.lastEvent
      ? Math.max(0, now.getTime() - this.lastEvent.getTime())
      : null;
    return {
      venue: this.venue,
      connected: this.connected,
      fresh: this.connected && lagMs !== null && lagMs <= this.staleAfterMs,
      lastEventAt: this.lastEvent?.toISOString() ?? null,
      lagMs,
      ...(this.statusDetail ? { detail: this.statusDetail } : {}),
    };
  }

  onQuote(listener: (quote: VenueQuote) => void): () => void {
    this.on("quote", listener);
    return () => this.off("quote", listener);
  }

  protected abstract subscriptionMessages(): unknown[];
  protected abstract parseMessage(data: RawData, receivedAt: Date): VenueQuote[];

  private connect(): void {
    if (!this.desired || this.socket) return;
    const socket = new WebSocket(this.url, {
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on("open", () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.statusDetail = undefined;
      this.pongReceived = true;
      for (const message of this.subscriptionMessages())
        socket.send(JSON.stringify(message));
      this.startHeartbeat(socket);
    });
    socket.on("pong", () => {
      this.pongReceived = true;
    });
    socket.on("message", (data) => {
      const receivedAt = new Date();
      try {
        const quotes = this.parseMessage(data, receivedAt);
        for (const quote of quotes) this.acceptQuote(quote);
      } catch (error) {
        this.statusDetail =
          error instanceof Error
            ? `parse error: ${error.message.slice(0, 120)}`
            : "parse error";
      }
    });
    socket.on("error", (error) => {
      this.statusDetail = `socket error: ${error.message.slice(0, 120)}`;
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.connected = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.scheduleReconnect();
    });
  }

  private acceptQuote(quote: VenueQuote): void {
    if (
      ![quote.bid, quote.ask, quote.last].every(
        (value) => Number.isFinite(value) && value > 0,
      ) ||
      quote.ask < quote.bid
    ) {
      this.statusDetail = "invalid quote excluded";
      return;
    }
    const prior = this.lastSequences.get(quote.instrument);
    if (prior !== undefined && quote.sequence <= prior) {
      this.statusDetail = "sequence regression or duplicate excluded";
      return;
    }
    this.lastSequences.set(quote.instrument, quote.sequence);
    this.lastEvent = quote.receivedAt;
    this.emit("quote", quote);
  }

  private startHeartbeat(socket: WebSocket): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.pongReceived) {
        this.statusDetail = "heartbeat timeout";
        socket.terminate();
        return;
      }
      this.pongReceived = false;
      socket.ping();
    }, 15_000);
    this.heartbeatTimer.unref();
  }

  private scheduleReconnect(): void {
    if (!this.desired || this.reconnectTimer) return;
    const exponential = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++);
    const delay = Math.floor(exponential * (0.75 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }
}

export function parseJson(data: RawData): unknown {
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data).toString("utf8");
  return JSON.parse(text) as unknown;
}

export function finiteNumber(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}
