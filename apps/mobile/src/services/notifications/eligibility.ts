import type { GuestPreferencesView, SignalKind } from "../../domain/models";
import { isIsoFresh } from "../../domain/time";

export interface NotificationCandidate {
  readonly signalKind: SignalKind;
  readonly expiresAt: string;
}

const isWithinQuietHours = (
  date: Date,
  startMinutes: number,
  endMinutes: number,
): boolean => {
  const current = date.getHours() * 60 + date.getMinutes();
  if (startMinutes === endMinutes) return true;
  return startMinutes < endMinutes
    ? current >= startMinutes && current < endMinutes
    : current >= startMinutes || current < endMinutes;
};

export const notificationEligibility = (
  candidate: NotificationCandidate,
  preferences: GuestPreferencesView,
  now: Date = new Date(),
): {
  readonly eligible: boolean;
  readonly reason: "eligible" | "disabled" | "quiet_hours" | "stale";
} => {
  if (!isIsoFresh(candidate.expiresAt, now.getTime()))
    return { eligible: false, reason: "stale" };
  if (!preferences.enabledSignalKinds[candidate.signalKind])
    return { eligible: false, reason: "disabled" };
  if (
    preferences.quietHours.enabled &&
    isWithinQuietHours(
      now,
      preferences.quietHours.startMinutes,
      preferences.quietHours.endMinutes,
    )
  ) {
    return { eligible: false, reason: "quiet_hours" };
  }
  return { eligible: true, reason: "eligible" };
};
