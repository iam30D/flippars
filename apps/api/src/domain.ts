import type { Signal } from "@flippars/contracts";

export const signalTypes = [
  "five_minute_reversal",
  "fifteen_minute_reversal",
  "five_minute_early_direction",
] as const;

export type SignalType = (typeof signalTypes)[number];
export type Direction = "higher" | "lower";
export type Venue = "coinbase" | "kraken" | "binance" | "simulated";

export interface VenueQuote {
  venue: Venue;
  instrument: "BTC-USD" | "BTC-USDT" | "USDT-USD";
  bid: number;
  ask: number;
  last: number;
  sequence: number;
  eventAt: Date;
  receivedAt: Date;
}

export interface VenueStatus {
  venue: Venue;
  connected: boolean;
  fresh: boolean;
  lastEventAt: string | null;
  lagMs: number | null;
  detail?: string;
}

export interface MarketHealth {
  healthy: boolean;
  degraded: boolean;
  reason: string | null;
  healthyVenues: number;
  requiredVenues: number;
  checkedAt: string;
  venues: VenueStatus[];
  usdtDepegged?: boolean;
  usdtDeviationBps?: number | null;
}

export interface MarketSnapshot {
  symbol: "BTC-USD";
  price: number;
  bid: number;
  ask: number;
  observedAt: string;
  sources: Array<{
    venue: Venue;
    price: number;
    weight: number;
    rawPrice?: number;
    eligible?: boolean;
    exclusionReasons?: string[];
  }>;
  usdtUsd: number | null;
  health: MarketHealth;
}

export interface Candle {
  startAt: string;
  endAt: string;
  interval: "1m" | "5m" | "15m";
  open: number;
  high: number;
  low: number;
  close: number;
  observations: number;
}

export interface SignalExplanation {
  summary: string;
  evidence: Array<{
    label: string;
    value: string;
    direction: "supports" | "opposes" | "neutral";
  }>;
  limitations: string[];
}

export interface SignalRecord {
  id: string;
  type: SignalType;
  direction: Direction;
  openPrice: number;
  currentPrice: number;
  confidence: number;
  intervalStart: string;
  intervalEnd: string;
  issuedAt: string;
  expiresAt: string;
  modelId: string;
  modelVersion: string;
  explanation: SignalExplanation;
  outcome: OutcomeRecord | null;
  canonical?: Signal;
}

export interface OutcomeRecord {
  signalId: string;
  result: "correct" | "incorrect" | "flat" | "void";
  closePrice: number | null;
  evaluatedAt: string;
  reason: string;
}

export interface DeviceRecord {
  id: string;
  platform: "ios";
  pushToken: string | null;
  pushEnvironment: "sandbox" | "production";
  notificationsAuthorized: boolean;
  appVersion: string;
  locale: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface PreferencesRecord {
  deviceId: string;
  notificationsEnabled: boolean;
  signalTypes: SignalType[];
  minimumConfidence: number;
  quietHours: { enabled: boolean; start: string; end: string; timezone: string };
  showDemoData: boolean;
  locale: string;
  updatedAt: string;
}

export interface ModelRecord {
  id: string;
  signalType: SignalType;
  version: string;
  artifactUri: string;
  artifactSha256: string;
  status: "candidate" | "shadow" | "approved" | "retired";
  approvedAt: string | null;
  minimumConfidence: number;
  metadata: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  action: string;
  subjectType: string;
  subjectId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
  retainUntil: string;
}
