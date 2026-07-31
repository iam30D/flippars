import {
  adaptCandle,
  adaptMarket,
  adaptOutcomeUpdate,
  adaptSignal,
  adaptStreamEnvelope,
  type StreamEnvelope,
} from "./adapters";
import { assessSequence, reconnectDelayMs, websocketUrl } from "./recovery";
import type {
  CandleView,
  MarketView,
  SignalOutcome,
  SignalView,
} from "../../domain/models";

export interface StreamCallbacks {
  readonly onConnected: () => void;
  readonly onDisconnected: () => void;
  readonly onMarket: (market: MarketView) => void;
  readonly onCandle: (candle: CandleView) => void;
  readonly onSignal: (signal: SignalView) => void;
  readonly onOutcome: (update: {
    readonly signalId: string;
    readonly outcome: SignalOutcome;
    readonly outcomePrice?: number;
  }) => void;
  readonly onGap: (
    afterSequence: number | null,
    receivedSequence: number,
  ) => Promise<number | null>;
}

export class SignalStream {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lastSequence: number | null = null;
  private stopped = false;
  private messageQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly apiUrl: string,
    private readonly callbacks: StreamCallbacks,
  ) {}

  public start(initialSequence: number | null = null): void {
    this.stopped = false;
    this.lastSequence = initialSequence;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(websocketUrl(this.apiUrl));
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.callbacks.onConnected();
    };
    socket.onmessage = (event) => {
      this.messageQueue = this.messageQueue
        .then(() => this.handleMessage(event.data))
        .catch(() => {
          if (this.socket === socket) socket.close();
        });
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      this.callbacks.onDisconnected();
      if (this.stopped) return;
      const delay = reconnectDelayMs(this.reconnectAttempt++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    } catch {
      return;
    }
    const envelope = adaptStreamEnvelope(parsed);
    if (!envelope) return;
    const decision = assessSequence(this.lastSequence, envelope.sequence);
    if (decision === "duplicate") return;
    if (decision === "gap") {
      this.lastSequence = await this.callbacks.onGap(
        this.lastSequence,
        envelope.sequence,
      );
      if (this.lastSequence !== null && envelope.sequence <= this.lastSequence) return;
    }
    this.applyEnvelope(envelope);
    this.lastSequence = envelope.sequence;
  }

  private applyEnvelope(envelope: StreamEnvelope): void {
    if (envelope.type === "MARKET_SNAPSHOT") {
      this.callbacks.onMarket(adaptMarket(envelope.payload));
      return;
    }
    if (envelope.type === "CANDLE_STATE") {
      const candle = adaptCandle(envelope.payload);
      if (candle) this.callbacks.onCandle(candle);
      return;
    }
    if (envelope.type === "SIGNAL") {
      const signal = adaptSignal(envelope.payload);
      if (signal) this.callbacks.onSignal(signal);
      return;
    }
    if (envelope.type === "SIGNAL_OUTCOME") {
      const update = adaptOutcomeUpdate(envelope.payload);
      if (update) this.callbacks.onOutcome(update);
    }
  }
}
