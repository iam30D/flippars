import AsyncStorage from "@react-native-async-storage/async-storage";
import type { GuestPreferencesView, MarketView, SignalView } from "../domain/models";

const PREFIX = "@flippars/mobile/v1";

export const storageKeys = {
  onboarding: `${PREFIX}/onboarding-complete`,
  preferences: `${PREFIX}/preferences`,
  signals: `${PREFIX}/signals`,
  market: `${PREFIX}/market`,
} as const;

const readJson = async <T>(key: string): Promise<T | null> => {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    await AsyncStorage.removeItem(key);
    return null;
  }
};

const writeJson = (key: string, value: unknown): Promise<void> =>
  AsyncStorage.setItem(key, JSON.stringify(value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPreferences = (value: unknown): value is GuestPreferencesView => {
  if (
    !isRecord(value) ||
    !isRecord(value.enabledSignalKinds) ||
    !isRecord(value.quietHours)
  )
    return false;
  const enabledSignalKinds = value.enabledSignalKinds;
  const quietHours = value.quietHours;
  return (
    [
      "five_minute_reversal",
      "fifteen_minute_reversal",
      "five_minute_early_direction",
    ].every((kind) => typeof enabledSignalKinds[kind] === "boolean") &&
    typeof quietHours.enabled === "boolean" &&
    isFiniteNumber(quietHours.startMinutes) &&
    isFiniteNumber(quietHours.endMinutes) &&
    typeof value.reducedData === "boolean"
  );
};

const isSignal = (value: unknown): value is SignalView => {
  if (!isRecord(value) || !isRecord(value.audit)) return false;
  const validKind =
    value.kind === "five_minute_reversal" ||
    value.kind === "fifteen_minute_reversal" ||
    value.kind === "five_minute_early_direction";
  const validOutcome =
    value.outcome === "correct" ||
    value.outcome === "incorrect" ||
    value.outcome === "flat" ||
    value.outcome === "void" ||
    value.outcome === "pending";
  return (
    validKind &&
    validOutcome &&
    typeof value.id === "string" &&
    typeof value.issuedAt === "string" &&
    typeof value.expiresAt === "string" &&
    (value.direction === "higher" || value.direction === "lower") &&
    isFiniteNumber(value.probability) &&
    isFiniteNumber(value.openingPrice) &&
    isFiniteNumber(value.currentPriceAtIssue) &&
    typeof value.modelVersion === "string" &&
    typeof value.calibrationVersion === "string" &&
    Array.isArray(value.observations) &&
    Array.isArray(value.modelFactors) &&
    Array.isArray(value.reportedContext) &&
    Array.isArray(value.riskFlags) &&
    typeof value.audit.decisionId === "string" &&
    typeof value.audit.policyVersion === "string" &&
    typeof value.audit.inputSnapshotId === "string"
  );
};

const isCandle = (value: unknown): boolean =>
  isRecord(value) &&
  (value.durationMinutes === 5 || value.durationMinutes === 15) &&
  isFiniteNumber(value.openingPrice) &&
  isFiniteNumber(value.currentPrice) &&
  typeof value.openedAt === "string" &&
  typeof value.closesAt === "string";

const isMarket = (value: unknown): value is MarketView =>
  isRecord(value) &&
  (value.compositePrice === null || isFiniteNumber(value.compositePrice)) &&
  (value.observedAt === null || typeof value.observedAt === "string") &&
  (value.health === "healthy" ||
    value.health === "degraded" ||
    value.health === "offline" ||
    value.health === "connecting") &&
  typeof value.healthMessage === "string" &&
  Array.isArray(value.venues) &&
  (value.fiveMinute === null || isCandle(value.fiveMinute)) &&
  (value.fifteenMinute === null || isCandle(value.fifteenMinute));

export const readOnboardingComplete = async (): Promise<boolean> =>
  (await AsyncStorage.getItem(storageKeys.onboarding)) === "true";

export const writeOnboardingComplete = (): Promise<void> =>
  AsyncStorage.setItem(storageKeys.onboarding, "true");

export const readPreferences = async (): Promise<GuestPreferencesView | null> => {
  const value = await readJson<unknown>(storageKeys.preferences);
  if (isPreferences(value)) return value;
  if (value !== null) await AsyncStorage.removeItem(storageKeys.preferences);
  return null;
};

export const writePreferences = (preferences: GuestPreferencesView): Promise<void> =>
  writeJson(storageKeys.preferences, preferences);

export const readCachedSignals = async (): Promise<readonly SignalView[] | null> => {
  const value = await readJson<unknown>(storageKeys.signals);
  if (!Array.isArray(value)) {
    if (value !== null) await AsyncStorage.removeItem(storageKeys.signals);
    return null;
  }
  return value.filter(isSignal);
};

export const writeCachedSignals = (signals: readonly SignalView[]): Promise<void> =>
  writeJson(storageKeys.signals, signals.slice(0, 500));

export const readCachedMarket = async (): Promise<MarketView | null> => {
  const value = await readJson<unknown>(storageKeys.market);
  if (isMarket(value)) return value;
  if (value !== null) await AsyncStorage.removeItem(storageKeys.market);
  return null;
};

export const writeCachedMarket = (market: MarketView): Promise<void> =>
  writeJson(storageKeys.market, market);

export const clearFlipparsStorage = (): Promise<void> =>
  AsyncStorage.multiRemove(Object.values(storageKeys));
