import { Redirect, useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppText } from "../src/components/AppText";
import { BrandMark } from "../src/components/BrandMark";
import { Button } from "../src/components/Button";
import { Card } from "../src/components/Card";
import { ReversalDiagram } from "../src/components/ReversalDiagram";
import { Screen } from "../src/components/Screen";
import { spacing } from "../src/design/theme";
import { useApp } from "../src/state/AppProvider";

export default function OnboardingRoute(): React.JSX.Element {
  const { ready, onboardingComplete, completeOnboarding } = useApp();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  if (ready && onboardingComplete) return <Redirect href="/(tabs)" />;

  const finish = async (notifications: boolean): Promise<void> => {
    setSubmitting(true);
    await completeOnboarding(notifications);
    setSubmitting(false);
    router.replace("/(tabs)");
  };

  return (
    <Screen
      footer={
        <View style={styles.actions}>
          {step > 0 ? (
            <Button variant="ghost" onPress={() => setStep((current) => current - 1)}>
              Back
            </Button>
          ) : null}
          {step < 2 ? (
            <Button onPress={() => setStep((current) => current + 1)}>Continue</Button>
          ) : (
            <>
              <Button
                loading={submitting}
                onPress={() => {
                  void finish(true);
                }}
                accessibilityHint="Requests iOS notification permission, then opens the dashboard"
              >
                Enable signal alerts
              </Button>
              <Button
                disabled={submitting}
                variant="ghost"
                onPress={() => {
                  void finish(false);
                }}
              >
                Not now
              </Button>
            </>
          )}
        </View>
      }
    >
      <View style={styles.brandRow}>
        <BrandMark size={52} />
        <View>
          <AppText variant="heading">Flippars</AppText>
          <AppText variant="caption" tone="muted">
            STEP {step + 1} OF 3
          </AppText>
        </View>
      </View>
      {step === 0 ? (
        <>
          <AppText variant="display">Rare signals. Clear uncertainty.</AppText>
          <AppText tone="muted">
            Flippars watches aligned BTC/USD intervals and alerts only when a calibrated
            forecast passes confidence, data-health, lead-time, and anomaly gates.
          </AppText>
          <Card style={styles.callout}>
            <AppText variant="heading">“No qualified signal” is useful.</AppText>
            <AppText tone="muted">
              Abstaining means the evidence is not strong enough. It is not a missing
              forecast, and notification volume is never the goal.
            </AppText>
          </Card>
          <Card style={styles.callout}>
            <AppText weight="700">Guest-first by design</AppText>
            <AppText tone="muted">
              No registration, subscription, exchange connection, or trading permission
              is required.
            </AppText>
          </Card>
        </>
      ) : null}
      {step === 1 ? (
        <>
          <AppText variant="title">The central reversal signal</AppText>
          <AppText tone="muted">
            Every UTC-aligned five-minute interval gets a new opening price. A signal
            can arrive while price remains on one side of that open, but the qualified
            forecast expects the close on the opposite side.
          </AppText>
          <ReversalDiagram />
          <Card style={styles.callout}>
            <AppText weight="700">Both directions are covered</AppText>
            <AppText tone="muted">
              Above now, forecast below at close — or below now, forecast above at
              close. The alert must be issued before price crosses the opening value.
            </AppText>
          </Card>
        </>
      ) : null}
      {step === 2 ? (
        <>
          <AppText variant="title">Get the signal while it is fresh</AppText>
          <AppText tone="muted">
            If you enable alerts, a notification contains its direction and expiry and
            opens the complete evidence record. Expired notification taps are discarded.
          </AppText>
          <Card style={styles.callout}>
            <AppText variant="heading">You stay in control.</AppText>
            <AppText tone="muted">
              Choose signal types and quiet hours in Settings. iOS permission is
              requested only after you tap “Enable signal alerts” below.
            </AppText>
          </Card>
          <Card style={styles.warning}>
            <AppText weight="800">Informational only · Forecasts can be wrong</AppText>
            <AppText tone="muted">
              Flippars never places trades, connects exchange accounts, holds funds, or
              promises profit. You are responsible for any decision you make.
            </AppText>
          </Card>
        </>
      ) : null}
      <View style={styles.progress} accessibilityLabel={`Step ${step + 1} of 3`}>
        {[0, 1, 2].map((index) => (
          <AppText key={index} tone={index === step ? "positive" : "muted"}>
            {index === step ? "●" : "○"}
          </AppText>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brandRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  callout: { gap: spacing.xs },
  warning: { gap: spacing.xs },
  actions: { gap: spacing.xs },
  progress: { flexDirection: "row", justifyContent: "center", gap: spacing.sm },
});
