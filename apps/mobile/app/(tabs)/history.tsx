import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { AppText } from "../../src/components/AppText";
import { Badge } from "../../src/components/Badge";
import { Button } from "../../src/components/Button";
import { Card } from "../../src/components/Card";
import { DemoBanner } from "../../src/components/HealthBanner";
import { Screen } from "../../src/components/Screen";
import { SectionHeader } from "../../src/components/SectionHeader";
import { SignalCard } from "../../src/components/SignalCard";
import { spacing } from "../../src/design/theme";
import type { SignalOutcome } from "../../src/domain/models";
import { useNow } from "../../src/hooks/useNow";
import { useApp } from "../../src/state/AppProvider";

const outcomeConfig: ReadonlyArray<{
  readonly outcome: SignalOutcome;
  readonly symbol: string;
  readonly tone: "positive" | "negative" | "neutral" | "warning" | "info";
}> = [
  { outcome: "correct", symbol: "✓", tone: "positive" },
  { outcome: "incorrect", symbol: "×", tone: "negative" },
  { outcome: "flat", symbol: "=", tone: "neutral" },
  { outcome: "void", symbol: "∅", tone: "warning" },
  { outcome: "pending", symbol: "…", tone: "info" },
];

export default function HistoryRoute(): React.JSX.Element {
  const {
    signals,
    demoMode,
    historyCursor,
    historyLoading,
    loadMoreHistory,
    refreshing,
    refresh,
  } = useApp();
  const router = useRouter();
  const now = useNow();
  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      testID="history-screen"
    >
      {demoMode ? <DemoBanner /> : null}
      <SectionHeader
        title="Complete signal history"
        description="Every issued signal is retained here, including incorrect, flat, void, pending, and correct results. No cherry-picking."
      />
      <View style={styles.summary} accessibilityRole="summary">
        {outcomeConfig.map(({ outcome, symbol, tone }) => (
          <Badge
            key={outcome}
            label={`${signals.filter((signal) => signal.outcome === outcome).length} ${outcome}`}
            symbol={symbol}
            tone={tone}
          />
        ))}
      </View>
      <Card style={styles.method}>
        <AppText weight="700">Outcome rules are fixed before scoring</AppText>
        <AppText variant="caption" tone="muted">
          Flat outcomes fall inside the approved deadband. Void outcomes remain visible
          and require an explicit data-quality reason.
        </AppText>
      </Card>
      {signals.length ? (
        signals.map((signal) => (
          <SignalCard
            key={signal.id}
            kind={signal.kind}
            signal={signal}
            now={now}
            onPress={() =>
              router.push({ pathname: "/signal/[id]", params: { id: signal.id } })
            }
          />
        ))
      ) : (
        <Card style={styles.empty}>
          <AppText variant="heading">No signals issued yet</AppText>
          <AppText tone="muted">
            History begins only when a forecast passes every release gate. Abstentions
            are expected.
          </AppText>
        </Card>
      )}
      {historyCursor ? (
        <Button
          loading={historyLoading}
          variant="secondary"
          onPress={() => {
            void loadMoreHistory();
          }}
        >
          Load older signals
        </Button>
      ) : signals.length ? (
        <AppText variant="caption" tone="muted" style={styles.end}>
          End of retained history
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  method: { gap: spacing.xs },
  empty: { alignItems: "center", gap: spacing.xs, paddingVertical: spacing.xl },
  end: { textAlign: "center" },
});
