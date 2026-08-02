/* eslint-disable @typescript-eslint/require-await -- the deterministic test repository intentionally implements the async persistence contract synchronously */
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
import {
  defaultPreferences,
  type PutPreferencesInput,
  type Repository,
  type SignalCursor,
  type SignalPage,
  type UpsertDeviceInput,
} from "./repository.js";

export class InMemoryRepository implements Repository {
  readonly devices = new Map<string, DeviceRecord>();
  readonly deviceCredentialHashes = new Map<string, string>();
  readonly preferences = new Map<string, PreferencesRecord>();
  readonly signals = new Map<string, SignalRecord>();
  readonly models = new Map<SignalType, ModelRecord>();
  readonly observations: MarketSnapshot[] = [];
  readonly audits: AuditEvent[] = [];
  readonly notificationClaims = new Set<string>();
  readonly notificationResults: Array<{
    deviceId: string;
    signalId: string;
    status: string;
    apnsId: string | null;
  }> = [];
  available = true;

  async ping(): Promise<boolean> {
    return this.available;
  }

  async upsertDevice(input: UpsertDeviceInput): Promise<DeviceRecord | null> {
    const now = new Date().toISOString();
    const existing = this.devices.get(input.id);
    const existingCredentialHash = this.deviceCredentialHashes.get(input.id);
    if (
      existing &&
      existingCredentialHash &&
      existingCredentialHash !== input.credentialHash
    )
      return null;
    const device: DeviceRecord = {
      id: input.id,
      platform: input.platform,
      pushToken: input.pushToken,
      pushEnvironment: input.pushEnvironment,
      notificationsAuthorized: input.notificationsAuthorized,
      appVersion: input.appVersion,
      locale: input.locale,
      timezone: input.timezone,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.devices.set(input.id, device);
    this.deviceCredentialHashes.set(input.id, input.credentialHash);
    if (!this.preferences.has(input.id))
      this.preferences.set(input.id, defaultPreferences(input.id, now));
    return structuredClone(device);
  }

  async verifyDeviceCredential(id: string, credentialHash: string): Promise<boolean> {
    return (
      this.devices.has(id) && this.deviceCredentialHashes.get(id) === credentialHash
    );
  }

  async deleteDevice(
    id: string,
    credentialHash: string,
  ): Promise<"deleted" | "not_found" | "credential_mismatch"> {
    if (!this.devices.has(id)) return "not_found";
    const stored = this.deviceCredentialHashes.get(id);
    if (stored && stored !== credentialHash) return "credential_mismatch";
    this.preferences.delete(id);
    for (const key of [...this.notificationClaims]) {
      if (key.startsWith(`${id}:`)) this.notificationClaims.delete(key);
    }
    this.devices.delete(id);
    this.deviceCredentialHashes.delete(id);
    return "deleted";
  }

  async putPreferences(input: PutPreferencesInput): Promise<PreferencesRecord> {
    if (!this.devices.has(input.deviceId)) throw new Error("DEVICE_NOT_FOUND");
    const value: PreferencesRecord = {
      ...input,
      signalTypes: [...input.signalTypes],
      updatedAt: new Date().toISOString(),
    };
    this.preferences.set(input.deviceId, value);
    return structuredClone(value);
  }

  async getPreferences(deviceId: string): Promise<PreferencesRecord | null> {
    const value = this.preferences.get(deviceId);
    return value ? structuredClone(value) : null;
  }

  async notificationTargets(signal: SignalRecord) {
    return [...this.devices.values()]
      .map((device) => ({
        device,
        preferences: this.preferences.get(device.id) ?? defaultPreferences(device.id),
      }))
      .filter(
        ({ device, preferences }) =>
          Boolean(device.pushToken) &&
          preferences.notificationsEnabled &&
          preferences.signalTypes.includes(signal.type) &&
          signal.confidence >= preferences.minimumConfidence,
      )
      .map((value) => structuredClone(value));
  }

  async claimNotification(
    deviceId: string,
    signalId: string,
    _expiresAt: string,
  ): Promise<boolean> {
    void _expiresAt;
    const key = `${deviceId}:${signalId}`;
    if (this.notificationClaims.has(key)) return false;
    this.notificationClaims.add(key);
    return true;
  }

  async recordNotificationResult(
    deviceId: string,
    signalId: string,
    status: string,
    apnsId: string | null,
  ): Promise<void> {
    this.notificationResults.push({ deviceId, signalId, status, apnsId });
  }

  async createSignal(
    signal: SignalRecord,
  ): Promise<{ created: boolean; signal: SignalRecord }> {
    const duplicate = [...this.signals.values()].find(
      (value) =>
        value.type === signal.type && value.intervalStart === signal.intervalStart,
    );
    if (duplicate) return { created: false, signal: structuredClone(duplicate) };
    this.signals.set(signal.id, structuredClone(signal));
    return { created: true, signal: structuredClone(signal) };
  }

  async getSignal(id: string): Promise<SignalRecord | null> {
    const value = this.signals.get(id);
    return value ? structuredClone(value) : null;
  }

  async listSignals(input: {
    type?: SignalType;
    limit: number;
    cursor?: SignalCursor;
  }): Promise<SignalPage> {
    const rows = [...this.signals.values()]
      .filter((signal) => !input.type || signal.type === input.type)
      .filter(
        (signal) =>
          !input.cursor ||
          signal.issuedAt < input.cursor.issuedAt ||
          (signal.issuedAt === input.cursor.issuedAt && signal.id < input.cursor.id),
      )
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || b.id.localeCompare(a.id));
    const selected = rows.slice(0, input.limit + 1);
    const hasMore = selected.length > input.limit;
    const items = selected.slice(0, input.limit).map((value) => structuredClone(value));
    const last = hasMore ? items.at(-1) : undefined;
    return {
      items,
      nextCursor: last ? { issuedAt: last.issuedAt, id: last.id } : null,
    };
  }

  async unresolvedSignals(before: string, limit: number): Promise<SignalRecord[]> {
    return [...this.signals.values()]
      .filter((signal) => !signal.outcome && signal.intervalEnd <= before)
      .sort((a, b) => a.intervalEnd.localeCompare(b.intervalEnd))
      .slice(0, limit)
      .map((value) => structuredClone(value));
  }

  async createOutcome(outcome: OutcomeRecord): Promise<boolean> {
    const signal = this.signals.get(outcome.signalId);
    if (!signal || signal.outcome) return false;
    this.signals.set(signal.id, { ...signal, outcome: structuredClone(outcome) });
    return true;
  }

  async getApprovedModel(type: SignalType): Promise<ModelRecord | null> {
    const value = this.models.get(type);
    return value?.status === "approved" ? structuredClone(value) : null;
  }

  async insertMarketObservation(
    snapshot: MarketSnapshot,
    _retainUntil: string,
  ): Promise<void> {
    void _retainUntil;
    this.observations.push(structuredClone(snapshot));
    if (this.observations.length > 20_000)
      this.observations.splice(0, this.observations.length - 20_000);
  }

  async latestMarketSnapshot(): Promise<MarketSnapshot | null> {
    const value = this.observations.at(-1);
    return value ? structuredClone(value) : null;
  }

  async candles(input: {
    interval: "1m" | "5m" | "15m";
    from: string;
    to: string;
    limit: number;
  }): Promise<Candle[]> {
    const duration = intervalMs(input.interval);
    const grouped = new Map<number, MarketSnapshot[]>();
    for (const observation of this.observations) {
      const time = Date.parse(observation.observedAt);
      if (time < Date.parse(input.from) || time >= Date.parse(input.to)) continue;
      const start = Math.floor(time / duration) * duration;
      const values = grouped.get(start) ?? [];
      values.push(observation);
      grouped.set(start, values);
    }
    return [...grouped.entries()]
      .sort(([a], [b]) => a - b)
      .slice(-input.limit)
      .map(([start, values]) => ({
        startAt: new Date(start).toISOString(),
        endAt: new Date(start + duration).toISOString(),
        interval: input.interval,
        open: values[0]?.price ?? 0,
        high: Math.max(...values.map((value) => value.price)),
        low: Math.min(...values.map((value) => value.price)),
        close: values.at(-1)?.price ?? 0,
        observations: values.length,
      }));
  }

  async closePriceAt(at: string, toleranceMs: number): Promise<number | null> {
    const target = Date.parse(at);
    const best = this.observations
      .map((value) => ({
        value,
        distance: Math.abs(Date.parse(value.observedAt) - target),
      }))
      .filter(({ distance }) => distance <= toleranceMs)
      .sort((a, b) => a.distance - b.distance)[0];
    return best?.value.price ?? null;
  }

  async audit(event: AuditEvent): Promise<void> {
    this.audits.push(structuredClone(event));
  }

  async close(): Promise<void> {}
}

function intervalMs(interval: "1m" | "5m" | "15m"): number {
  return interval === "1m" ? 60_000 : interval === "5m" ? 300_000 : 900_000;
}
