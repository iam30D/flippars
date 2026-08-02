import type {
  AuditEvent,
  Candle,
  DeviceRecord,
  MarketSnapshot,
  ModelRecord,
  OutcomeRecord,
  PreferencesRecord,
  SignalRecord,
  SignalType,
} from "../domain.js";

export interface SignalCursor {
  issuedAt: string;
  id: string;
}

export interface SignalPage {
  items: SignalRecord[];
  nextCursor: SignalCursor | null;
}

export interface UpsertDeviceInput {
  id: string;
  credentialHash: string;
  platform: "ios";
  pushToken: string | null;
  pushEnvironment: "sandbox" | "production";
  notificationsAuthorized: boolean;
  appVersion: string;
  locale: string;
  timezone: string;
}

export type DeleteDeviceResult = "deleted" | "not_found" | "credential_mismatch";

export interface PutPreferencesInput {
  deviceId: string;
  notificationsEnabled: boolean;
  signalTypes: SignalType[];
  minimumConfidence: number;
  quietHours: { enabled: boolean; start: string; end: string; timezone: string };
  showDemoData: boolean;
  locale: string;
}

export interface NotificationTarget {
  device: DeviceRecord;
  preferences: PreferencesRecord;
}

export interface Repository {
  ping(): Promise<boolean>;
  upsertDevice(input: UpsertDeviceInput): Promise<DeviceRecord | null>;
  verifyDeviceCredential(id: string, credentialHash: string): Promise<boolean>;
  deleteDevice(id: string, credentialHash: string): Promise<DeleteDeviceResult>;
  putPreferences(input: PutPreferencesInput): Promise<PreferencesRecord>;
  getPreferences(deviceId: string): Promise<PreferencesRecord | null>;
  notificationTargets(signal: SignalRecord): Promise<NotificationTarget[]>;
  claimNotification(
    deviceId: string,
    signalId: string,
    expiresAt: string,
  ): Promise<boolean>;
  recordNotificationResult(
    deviceId: string,
    signalId: string,
    status: string,
    apnsId: string | null,
  ): Promise<void>;
  createSignal(
    signal: SignalRecord,
  ): Promise<{ created: boolean; signal: SignalRecord }>;
  getSignal(id: string): Promise<SignalRecord | null>;
  listSignals(input: {
    type?: SignalType;
    limit: number;
    cursor?: SignalCursor;
  }): Promise<SignalPage>;
  unresolvedSignals(before: string, limit: number): Promise<SignalRecord[]>;
  createOutcome(outcome: OutcomeRecord): Promise<boolean>;
  getApprovedModel(type: SignalType): Promise<ModelRecord | null>;
  insertMarketObservation(snapshot: MarketSnapshot, retainUntil: string): Promise<void>;
  latestMarketSnapshot(): Promise<MarketSnapshot | null>;
  candles(input: {
    interval: "1m" | "5m" | "15m";
    from: string;
    to: string;
    limit: number;
  }): Promise<Candle[]>;
  closePriceAt(at: string, toleranceMs: number): Promise<number | null>;
  audit(event: AuditEvent): Promise<void>;
  close(): Promise<void>;
}

export function defaultPreferences(
  deviceId: string,
  now = new Date().toISOString(),
): PreferencesRecord {
  return {
    deviceId,
    notificationsEnabled: false,
    signalTypes: [
      "five_minute_reversal",
      "fifteen_minute_reversal",
      "five_minute_early_direction",
    ],
    minimumConfidence: 0.75,
    quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: "UTC" },
    showDemoData: false,
    locale: "en",
    updatedAt: now,
  };
}
