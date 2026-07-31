export type SignalKind =
  "five_minute_reversal" | "fifteen_minute_reversal" | "five_minute_early_direction";

export type Direction = "higher" | "lower";
export type SignalOutcome = "correct" | "incorrect" | "flat" | "void" | "pending";
export type DataHealth = "healthy" | "degraded" | "offline" | "connecting";

export interface EvidenceItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}

export interface ReportedContext {
  readonly id: string;
  readonly headline: string;
  readonly source: string;
  readonly observedAt: string;
  readonly url?: string;
}

export interface SignalView {
  readonly id: string;
  readonly kind: SignalKind;
  readonly direction: Direction;
  readonly probability: number;
  readonly openingPrice: number;
  readonly currentPriceAtIssue: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly modelVersion: string;
  readonly calibrationVersion: string;
  readonly confidenceThreshold: number;
  readonly leadTimeSeconds: number;
  readonly riskLevel: "low" | "medium" | "high" | "critical";
  readonly riskScore: number;
  readonly observedPosition: "above" | "below" | "at_open";
  readonly outcome: SignalOutcome;
  readonly outcomePrice?: number;
  readonly observations: readonly EvidenceItem[];
  readonly modelFactors: readonly EvidenceItem[];
  readonly reportedContext: readonly ReportedContext[];
  readonly riskFlags: readonly string[];
  readonly dataMode: "live" | "demo";
  readonly audit: {
    readonly decisionId: string;
    readonly policyVersion: string;
    readonly inputSnapshotId: string;
    readonly evaluatedAt: string;
  };
}

export interface CandleView {
  readonly durationMinutes: 5 | 15;
  readonly openingPrice: number;
  readonly currentPrice: number;
  readonly openedAt: string;
  readonly closesAt: string;
}

export interface MarketView {
  readonly compositePrice: number | null;
  readonly observedAt: string | null;
  readonly health: DataHealth;
  readonly healthMessage: string;
  readonly venues: readonly string[];
  readonly fiveMinute: CandleView | null;
  readonly fifteenMinute: CandleView | null;
}

export interface QuietHours {
  readonly enabled: boolean;
  readonly startMinutes: number;
  readonly endMinutes: number;
}

export interface GuestPreferencesView {
  readonly enabledSignalKinds: Readonly<Record<SignalKind, boolean>>;
  readonly quietHours: QuietHours;
  readonly reducedData: boolean;
}

export const DEFAULT_PREFERENCES: GuestPreferencesView = {
  enabledSignalKinds: {
    five_minute_reversal: true,
    fifteen_minute_reversal: true,
    five_minute_early_direction: true,
  },
  quietHours: {
    enabled: false,
    startMinutes: 22 * 60,
    endMinutes: 7 * 60,
  },
  reducedData: false,
};

export const SIGNAL_KIND_LABELS: Readonly<Record<SignalKind, string>> = {
  five_minute_reversal: "5-minute reversal",
  fifteen_minute_reversal: "15-minute reversal",
  five_minute_early_direction: "Early 5-minute direction",
};
