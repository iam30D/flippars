import { useRouter } from "expo-router";
import { Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { AppText } from "../../src/components/AppText";
import { Badge } from "../../src/components/Badge";
import { Button } from "../../src/components/Button";
import { Card } from "../../src/components/Card";
import { DemoBanner } from "../../src/components/HealthBanner";
import { Screen } from "../../src/components/Screen";
import { SectionHeader } from "../../src/components/SectionHeader";
import { SettingToggle, SettingValue } from "../../src/components/SettingRow";
import { radii, spacing, useAppTheme } from "../../src/design/theme";
import { minutesToClock } from "../../src/domain/time";
import {
  SIGNAL_KIND_LABELS,
  type GuestPreferencesView,
  type SignalKind,
} from "../../src/domain/models";
import { useApp } from "../../src/state/AppProvider";

const kinds: readonly SignalKind[] = [
  "five_minute_reversal",
  "fifteen_minute_reversal",
  "five_minute_early_direction",
];

export default function SettingsRoute(): React.JSX.Element {
  const {
    demoMode,
    preferences,
    notificationStatus,
    notificationsOptedIn,
    updatePreferences,
    enableNotifications,
    disableNotifications,
    resetAnonymousData,
  } = useApp();
  const router = useRouter();
  const { colors } = useAppTheme();

  const save = (next: GuestPreferencesView): void => {
    void updatePreferences(next);
  };
  const adjustQuietTime = (key: "startMinutes" | "endMinutes", delta: number): void => {
    save({
      ...preferences,
      quietHours: {
        ...preferences.quietHours,
        [key]: (preferences.quietHours[key] + delta + 1_440) % 1_440,
      },
    });
  };
  const confirmReset = (): void => {
    Alert.alert(
      "Delete and reset anonymous data?",
      "This removes this guest device from Flippars where reachable, clears local settings and history, deletes the secure installation ID, and returns to onboarding. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete and reset",
          style: "destructive",
          onPress: () => {
            void resetAnonymousData()
              .then(() => router.replace("/onboarding"))
              .catch(() => {
                Alert.alert(
                  "Reset could not finish",
                  "Your secure deletion request was kept for retry. Please try again after reconnecting.",
                );
              });
          },
        },
      ],
    );
  };
  return (
    <Screen testID="settings-screen">
      {demoMode ? <DemoBanner /> : null}
      <SectionHeader
        title="Settings"
        description="Preferences belong to this anonymous installation. No account is required."
      />
      <Card style={styles.guest}>
        <View style={styles.row}>
          <AppText variant="heading">Guest access</AppText>
          <Badge label="Full access" symbol="✓" tone="positive" />
        </View>
        <AppText tone="muted">
          All validated features are available without registration or subscription in
          this release.
        </AppText>
      </Card>

      <SectionHeader
        title="Signal alerts"
        description="Turning off a type never removes its historical outcomes."
      />
      <Card style={styles.settingsCard}>
        {kinds.map((kind) => (
          <SettingToggle
            key={kind}
            label={SIGNAL_KIND_LABELS[kind]}
            description={
              kind === "five_minute_reversal"
                ? "Opposite-side close forecast before price crosses the five-minute open."
                : kind === "fifteen_minute_reversal"
                  ? "Only eligible during the final 10 minutes."
                  : "Closing direction forecast during the first 60 seconds."
            }
            value={preferences.enabledSignalKinds[kind]}
            onValueChange={(value) =>
              save({
                ...preferences,
                enabledSignalKinds: {
                  ...preferences.enabledSignalKinds,
                  [kind]: value,
                },
              })
            }
          />
        ))}
      </Card>

      <SectionHeader
        title="Notifications"
        description="Permission is requested only from your direct action."
      />
      <Card style={styles.guest}>
        <View style={styles.row}>
          <AppText weight="700">iOS permission</AppText>
          <Badge
            label={
              notificationsOptedIn && notificationStatus === "granted"
                ? "Enabled"
                : notificationsOptedIn
                  ? "Waiting for iOS"
                  : notificationStatus === "unknown"
                    ? "Not checked"
                    : "Not enabled"
            }
            symbol={
              notificationsOptedIn && notificationStatus === "granted" ? "✓" : "!"
            }
            tone={
              notificationsOptedIn && notificationStatus === "granted"
                ? "positive"
                : "warning"
            }
          />
        </View>
        {!notificationsOptedIn ? (
          <Button
            variant="secondary"
            onPress={() => {
              if (notificationStatus === "denied") void Linking.openSettings();
              else void enableNotifications();
            }}
          >
            {notificationStatus === "denied"
              ? "Open iOS Settings"
              : "Enable signal alerts"}
          </Button>
        ) : (
          <Button
            variant="secondary"
            onPress={() => {
              void disableNotifications();
            }}
          >
            Disable signal alerts
          </Button>
        )}
      </Card>

      <SectionHeader
        title="Quiet hours"
        description="Alerts are suppressed locally and synchronized to the service."
      />
      <Card style={styles.settingsCard}>
        <SettingToggle
          label="Use quiet hours"
          description={`${minutesToClock(preferences.quietHours.startMinutes)} to ${minutesToClock(preferences.quietHours.endMinutes)} local time`}
          value={preferences.quietHours.enabled}
          onValueChange={(enabled) =>
            save({ ...preferences, quietHours: { ...preferences.quietHours, enabled } })
          }
        />
        <SettingValue
          label="Starts"
          description="Adjust in 30-minute steps."
          control={
            <TimeStepper
              value={preferences.quietHours.startMinutes}
              onDecrease={() => adjustQuietTime("startMinutes", -30)}
              onIncrease={() => adjustQuietTime("startMinutes", 30)}
              colors={colors}
            />
          }
        />
        <SettingValue
          label="Ends"
          description="Overnight ranges are supported."
          control={
            <TimeStepper
              value={preferences.quietHours.endMinutes}
              onDecrease={() => adjustQuietTime("endMinutes", -30)}
              onIncrease={() => adjustQuietTime("endMinutes", 30)}
              colors={colors}
            />
          }
        />
      </Card>

      <SectionHeader title="Data usage" />
      <Card style={styles.settingsCard}>
        <SettingToggle
          label="Reduced data"
          description="Refresh demo/backup snapshots less often. Foreground live signals remain connected."
          value={preferences.reducedData}
          onValueChange={(reducedData) => save({ ...preferences, reducedData })}
        />
      </Card>

      <SectionHeader title="Privacy and reset" />
      <Card style={styles.danger}>
        <AppText weight="700">Delete/reset anonymous data</AppText>
        <AppText variant="caption" tone="muted">
          Clears this installation’s preferences, local public-signal cache, onboarding
          state, push association, and secure guest identifier.
        </AppText>
        <Button variant="danger" onPress={confirmReset}>
          Delete and reset
        </Button>
      </Card>
      <Card>
        <AppText variant="caption" tone="muted">
          Flippars is informational only. It does not place trades, connect exchange
          accounts, or hold funds. Version 0.1.0.
        </AppText>
      </Card>
    </Screen>
  );
}

const TimeStepper = ({
  value,
  onDecrease,
  onIncrease,
  colors,
}: {
  readonly value: number;
  readonly onDecrease: () => void;
  readonly onIncrease: () => void;
  readonly colors: ReturnType<typeof useAppTheme>["colors"];
}): React.JSX.Element => (
  <View style={styles.stepper}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="30 minutes earlier"
      onPress={onDecrease}
      style={({ pressed }) => [
        styles.stepButton,
        {
          backgroundColor: colors.surfaceRaised,
          borderColor: colors.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <AppText variant="heading">−</AppText>
    </Pressable>
    <AppText variant="mono" weight="800">
      {minutesToClock(value)}
    </AppText>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="30 minutes later"
      onPress={onIncrease}
      style={({ pressed }) => [
        styles.stepButton,
        {
          backgroundColor: colors.surfaceRaised,
          borderColor: colors.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <AppText variant="heading">+</AppText>
    </Pressable>
  </View>
);

const styles = StyleSheet.create({
  guest: { gap: spacing.sm },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  settingsCard: { paddingVertical: 0 },
  danger: { gap: spacing.sm },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
});
