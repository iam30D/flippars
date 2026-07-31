import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { AppText } from "../../src/components/AppText";
import { Badge } from "../../src/components/Badge";
import { BrandMark } from "../../src/components/BrandMark";
import { CandleCard } from "../../src/components/CandleCard";
import { Card } from "../../src/components/Card";
import { DemoBanner, HealthBanner } from "../../src/components/HealthBanner";
import { Screen } from "../../src/components/Screen";
import { SectionHeader } from "../../src/components/SectionHeader";
import { SignalCard } from "../../src/components/SignalCard";
import { spacing } from "../../src/design/theme";
import { formatObservedTime, formatUsd } from "../../src/domain/format";
import {
  SIGNAL_KIND_LABELS,
  type SignalKind,
  type SignalView,
} from "../../src/domain/models";
import { signalFreshness } from "../../src/domain/freshness";
import { useNow } from "../../src/hooks/useNow";
import { strings } from "../../src/i18n/strings";
import { useApp } from "../../src/state/AppProvider";

const kinds: readonly SignalKind[] = [
  "five_minute_reversal",
  "fifteen_minute_reversal",
  "five_minute_early_direction",
];

const activeForKind = (
  signals: readonly SignalView[],
  kind: SignalKind,
  now: number,
): SignalView | null =>
  signals.find(
    (signal) =>
      signal.kind === kind &&
      signal.outcome === "pending" &&
      signalFreshness(signal, now) === "active",
  ) ?? null;

export default function DashboardRoute(): React.JSX.Element {
  const { market, signals, demoMode, refreshing, refresh, errorMessage } = useApp();
  const router = useRouter();
  const now = useNow();
  const activeSignals = kinds.map((kind) => activeForKind(signals, kind, now));
  const abstainingCount = activeSignals.filter((signal) => signal === null).length;
  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      testID="dashboard-screen"
    >
      {demoMode ? <DemoBanner /> : null}
      <View style={styles.header}>
        <View style={styles.brand}>
          <BrandMark size={44} />
          <View>
            <AppText variant="heading">Flippars</AppText>
            <AppText variant="caption" tone="muted">
              BTC/USD SIGNAL DESK
            </AppText>
          </View>
        </View>
        <Badge label="Guest" symbol="◇" tone="neutral" />
      </View>

      <Card
        elevated
        style={styles.priceCard}
        accessibilityLabel={`Bitcoin US dollar composite ${formatUsd(market.compositePrice)}. Observed ${formatObservedTime(market.observedAt)}.`}
      >
        <View style={styles.priceHeader}>
          <View>
            <AppText variant="caption" tone="muted">
              BTC / USD COMPOSITE
            </AppText>
            <AppText variant="display">{formatUsd(market.compositePrice)}</AppText>
          </View>
          <Badge
            label={`${market.venues.length || 0} venues`}
            symbol="◎"
            tone={market.venues.length >= 2 ? "positive" : "warning"}
          />
        </View>
        <AppText variant="caption" tone="muted">
          Observed {formatObservedTime(market.observedAt)} · Coinbase, Kraken, Binance
          quality-screened
        </AppText>
      </Card>

      <HealthBanner health={market.health} message={market.healthMessage} />
      {errorMessage ? (
        <Card>
          <AppText tone="warning">! {errorMessage}</AppText>
        </Card>
      ) : null}

      <SectionHeader
        title="Aligned intervals"
        description="Each opening value resets at its fixed UTC boundary."
      />
      <View style={styles.candles}>
        <CandleCard candle={market.fiveMinute} now={now} />
        <CandleCard candle={market.fifteenMinute} now={now} />
      </View>

      <View style={styles.sectionTitle}>
        <SectionHeader
          title="Qualified signals"
          description="Probability is calibrated, not a promise of the outcome."
        />
        {abstainingCount === kinds.length ? (
          <Badge label="Model abstaining" symbol="—" tone="neutral" />
        ) : null}
      </View>
      {kinds.map((kind, index) => {
        const signal = activeSignals[index] ?? null;
        return (
          <SignalCard
            key={kind}
            kind={kind}
            signal={signal}
            now={now}
            {...(signal
              ? {
                  onPress: () =>
                    router.push({
                      pathname: "/signal/[id]",
                      params: { id: signal.id },
                    }),
                }
              : {})}
          />
        );
      })}
      <Card style={styles.disclaimer}>
        <AppText weight="800">{strings.informationalOnly}</AppText>
        <AppText variant="caption" tone="muted">
          Every forecast can be wrong. Flippars does not connect to an exchange, hold
          funds, initiate trades, or provide personalized advice.
        </AppText>
      </Card>
      <AppText
        variant="caption"
        tone="muted"
        style={styles.srSummary}
        accessibilityLabel={`Dashboard has ${kinds.length - abstainingCount} active signals and ${abstainingCount} abstentions. Signal slots: ${kinds.map((kind) => SIGNAL_KIND_LABELS[kind]).join(", ")}.`}
      >
        Complete dashboard status is available to assistive technologies.
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  priceCard: { gap: spacing.sm, paddingVertical: spacing.lg },
  priceHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  candles: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  sectionTitle: { gap: spacing.sm },
  disclaimer: { gap: spacing.xs },
  srSummary: { height: 1, opacity: 0.01 },
});
