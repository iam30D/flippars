import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { GuestPreferencesView, SignalKind } from "../../domain/models";
import { notificationEligibility } from "./eligibility";

interface NotificationData {
  readonly signalId?: unknown;
  readonly signalKind?: unknown;
  readonly signalType?: unknown;
  readonly expiresAt?: unknown;
}

const isSignalKind = (value: unknown): value is SignalKind =>
  value === "five_minute_reversal" ||
  value === "fifteen_minute_reversal" ||
  value === "five_minute_early_direction";

const wireSignalKind = (value: unknown): SignalKind | null => {
  if (isSignalKind(value)) return value;
  if (value === "FIVE_MINUTE_REVERSAL") return "five_minute_reversal";
  if (value === "FIFTEEN_MINUTE_REVERSAL") return "fifteen_minute_reversal";
  if (value === "FIVE_MINUTE_EARLY_DIRECTION") return "five_minute_early_direction";
  return null;
};

let currentPreferences: GuestPreferencesView | null = null;

export interface ExistingNotificationRegistration {
  readonly token: string | null;
  readonly status: "granted" | "denied" | "unknown" | "unavailable";
}

export const setNotificationPreferences = (preferences: GuestPreferencesView): void => {
  currentPreferences = preferences;
};

Notifications.setNotificationHandler({
  handleNotification: (notification) => {
    const data = notification.request.content.data as NotificationData;
    const signalKind = wireSignalKind(data.signalKind ?? data.signalType);
    const expiresAt = data.expiresAt;
    const eligible =
      currentPreferences && signalKind && typeof expiresAt === "string"
        ? notificationEligibility({ signalKind, expiresAt }, currentPreferences)
            .eligible
        : false;
    return Promise.resolve({
      shouldShowBanner: eligible,
      shouldShowList: eligible,
      shouldPlaySound: eligible,
      shouldSetBadge: false,
    });
  },
});

const nativeIosToken = async (): Promise<string | null> => {
  if (Platform.OS !== "ios") return null;
  const token = await Notifications.getDevicePushTokenAsync();
  if (typeof token.data !== "string") return null;
  const normalized = token.data.replace(/[<>\s]/g, "");
  return /^[A-Fa-f0-9]{32,512}$/.test(normalized) ? normalized : null;
};

export const getExistingNotificationRegistration =
  async (): Promise<ExistingNotificationRegistration> => {
    if (!Device.isDevice) return { token: null, status: "unavailable" };
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted)
      return { token: null, status: current.canAskAgain ? "unknown" : "denied" };
    const token = await nativeIosToken();
    return { token, status: token ? "granted" : "unavailable" };
  };

export const requestNotificationToken = async (): Promise<string | null> => {
  if (!Device.isDevice) return null;
  const current = await Notifications.getPermissionsAsync();
  const granted = current.granted
    ? true
    : (
        await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: false, allowSound: true },
        })
      ).granted;
  if (!granted) return null;
  return nativeIosToken();
};

export const clearDeliveredNotifications = (): Promise<void> =>
  Notifications.dismissAllNotificationsAsync();

export const extractFreshSignalId = (
  response: Notifications.NotificationResponse,
  nowMs: number = Date.now(),
): string | null => {
  const data = response.notification.request.content.data as NotificationData;
  if (typeof data.signalId !== "string" || typeof data.expiresAt !== "string")
    return null;
  return Date.parse(data.expiresAt) > nowMs ? data.signalId : null;
};
