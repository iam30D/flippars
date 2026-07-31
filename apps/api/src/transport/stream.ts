import { randomUUID } from "node:crypto";
import type { DataMode, WsEnvelope } from "@flippars/contracts";
import { CandleTracker } from "@flippars/signal-core";
import type WebSocket from "ws";
import type { MarketCoordinator } from "../market/coordinator.js";
import type { SafetyController } from "../signals/safety.js";
import { presentMarketSnapshot, presentSignal } from "./presenters.js";

interface Client {
  socket: WebSocket;
  sequence: number;
  heartbeat: NodeJS.Timeout;
}

export class StreamHub {
  private readonly clients = new Set<Client>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly candleTracker: CandleTracker;

  constructor(
    private readonly market: MarketCoordinator,
    private readonly safety: SafetyController,
    private readonly dataMode: DataMode,
    private readonly confidenceThreshold: number,
    private readonly deadbandBps: number,
  ) {
    this.candleTracker = new CandleTracker({ deadbandBps });
  }

  start(): void {
    if (this.unsubscribers.length) return;
    this.unsubscribers.push(
      this.market.onSnapshot((snapshot) => {
        const wireSnapshot = presentMarketSnapshot(snapshot, this.dataMode);
        this.broadcast("MARKET_SNAPSHOT", wireSnapshot);
        try {
          for (const candle of this.candleTracker.update(wireSnapshot))
            this.broadcast("CANDLE_STATE", candle);
        } catch {
          this.candleTracker.reset();
          for (const candle of this.candleTracker.update(wireSnapshot))
            this.broadcast("CANDLE_STATE", candle);
        }
      }),
      this.market.onSignal((signal) =>
        this.broadcast(
          "SIGNAL",
          presentSignal(signal, {
            confidenceThreshold: this.confidenceThreshold,
            deadbandBps: this.deadbandBps,
            dataMode: this.dataMode,
          }),
        ),
      ),
      this.market.onOutcome((signal) =>
        this.broadcast(
          "SIGNAL_OUTCOME",
          presentSignal(signal, {
            confidenceThreshold: this.confidenceThreshold,
            deadbandBps: this.deadbandBps,
            dataMode: this.dataMode,
          }).outcome,
        ),
      ),
    );
  }

  add(socket: WebSocket): void {
    const client: Client = {
      socket,
      sequence: 0,
      heartbeat: setInterval(() => {
        this.send(client, "HEARTBEAT", { safety: this.safety.snapshot() });
        if (socket.readyState === 1) socket.ping();
      }, 20_000),
    };
    client.heartbeat.unref();
    this.clients.add(client);
    socket.once("close", () => this.remove(client));
    socket.once("error", () => this.remove(client));
    this.send(client, "HEALTH", {
      market: this.market.health(),
      safety: this.safety.snapshot(),
    });
    const snapshot = this.market.snapshot();
    if (snapshot)
      this.send(
        client,
        "MARKET_SNAPSHOT",
        presentMarketSnapshot(snapshot, this.dataMode),
      );
  }

  stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const client of [...this.clients]) {
      client.socket.close(1001, "server shutdown");
      this.remove(client);
    }
    return Promise.resolve();
  }

  private broadcast(type: WsEnvelope["type"], payload: unknown): void {
    for (const client of this.clients) this.send(client, type, payload);
  }

  private send(client: Client, type: WsEnvelope["type"], payload: unknown): void {
    const socket = client.socket;
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 1_000_000) {
      socket.close(1013, "client is too slow");
      this.remove(client);
      return;
    }
    const envelope: WsEnvelope = {
      id: randomUUID(),
      schemaVersion: "1",
      sequence: client.sequence++,
      type,
      sentAt: new Date().toISOString(),
      dataMode: this.dataMode,
      payload,
    };
    socket.send(JSON.stringify(envelope));
  }

  private remove(client: Client): void {
    clearInterval(client.heartbeat);
    this.clients.delete(client);
  }
}
