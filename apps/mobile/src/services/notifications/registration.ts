export interface ExistingNotificationRegistration {
  readonly token: string | null;
  readonly status: "granted" | "denied" | "unknown" | "unavailable";
}

export interface NotificationSyncDecision {
  readonly pushToken: string | null;
  readonly notificationsEnabled: boolean;
}

export const notificationSyncDecision = (
  optedIn: boolean,
  registration: ExistingNotificationRegistration,
): NotificationSyncDecision => {
  const enabled =
    optedIn && registration.status === "granted" && registration.token !== null;
  return {
    pushToken: enabled ? registration.token : null,
    notificationsEnabled: enabled,
  };
};
