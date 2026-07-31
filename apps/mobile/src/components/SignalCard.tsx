import { StyleSheet, View } from "react-native";
import type { SignalKind, SignalView } from "../domain/models";
import { SIGNAL_KIND_LABELS } from "../domain/models";
import { formatObservedTime, formatPercent, formatUsd } from "../domain/format";
import { countdownTo, formatCountdown } from "../domain/time";
import { spacing, useAppTheme } from "../design/theme";
import { strings } from "../i18n/strings";
import { AppText } from "./AppText";
import { Badge, OutcomeBadge } from "./Badge";
import { PressableCard } from "./Card";

interface SignalCardProps {
  readonly kind: SignalKind;
  readonly signal: SignalView | null;
  readonly now: number;
  readonly onPress?: () => void;
}

export const SignalCard = ({
  kind,
  signal,
  now,
  onPress,
}: SignalCardProps): React.JSX.Element => {
  const { colors } = useAppTheme();
  if (!signal) {
    return (
      <PressableCard
        disabled
        accessibilityLabel={`${SIGNAL_KIND_LABELS[kind]}. ${strings.noQualifiedSignal}.`}
        style={styles.card}
      >
        <AppText variant="caption" tone="muted">
          {SIGNAL_KIND_LABELS[kind].toUpperCase()}
        </AppText>
        <View style={styles.noSignalRow}>
          <View style={[styles.emptySymbol, { borderColor: colors.textMuted }]}>
            <AppText tone="muted">—</AppText>
          </View>
          <View style={styles.flex}>
            <AppText variant="heading">{strings.noQualifiedSignal}</AppText>
            <AppText tone="muted" variant="caption">
              No prediction passes every gate right now.
            </AppText>
          </View>
        </View>
      </PressableCard>
    );
  }
  const predictsHigher = signal.direction === "higher";
  const active = signal.outcome === "pending" && Date.parse(signal.expiresAt) > now;
  return (
    <PressableCard
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint="Opens signal evidence and audit details"
      accessibilityLabel={`${SIGNAL_KIND_LABELS[signal.kind]}. Predicts ${signal.direction}. ${formatPercent(signal.probability)} calibrated probability. ${active ? `Expires in ${formatCountdown(countdownTo(signal.expiresAt, now))}` : `Outcome ${signal.outcome}`}.`}
      style={styles.card}
    >
      <View style={styles.header}>
        <AppText variant="caption" tone="muted">
          {SIGNAL_KIND_LABELS[signal.kind].toUpperCase()}
        </AppText>
        {active ? (
          <Badge
            label={`${formatCountdown(countdownTo(signal.expiresAt, now))} left`}
            symbol="◷"
            tone="info"
          />
        ) : (
          <OutcomeBadge outcome={signal.outcome} />
        )}
      </View>
      <View style={styles.signalRow}>
        <View
          style={[
            styles.direction,
            { backgroundColor: predictsHigher ? colors.positive : colors.negative },
          ]}
        >
          <AppText variant="title" weight="800" style={{ color: colors.background }}>
            {predictsHigher ? "↑" : "↓"}
          </AppText>
        </View>
        <View style={styles.flex}>
          <AppText variant="title">Close {signal.direction}</AppText>
          <AppText tone="muted">than {formatUsd(signal.openingPrice)} open</AppText>
        </View>
        <View style={styles.probability}>
          <AppText variant="title">{formatPercent(signal.probability)}</AppText>
          <AppText variant="caption" tone="muted">
            CALIBRATED
          </AppText>
        </View>
      </View>
      {signal.kind === "five_minute_reversal" ||
      signal.kind === "fifteen_minute_reversal" ? (
        <AppText variant="caption" tone="info">
          ↔ Issued before the crossing while price was{" "}
          {signal.observedPosition.replace("_", " ")} the open
        </AppText>
      ) : null}
      <View style={[styles.rule, { backgroundColor: colors.border }]} />
      <View style={styles.metadata}>
        <AppText variant="caption" tone="muted">
          Issued {formatObservedTime(signal.issuedAt)}
        </AppText>
        <AppText variant="caption" tone="muted">
          Model {signal.modelVersion}
        </AppText>
      </View>
      {signal.riskFlags.length ? (
        <Badge
          label={`${signal.riskFlags.length} risk ${signal.riskFlags.length === 1 ? "flag" : "flags"}`}
          symbol="!"
          tone="warning"
        />
      ) : (
        <Badge label="No elevated flags" symbol="✓" tone="positive" />
      )}
    </PressableCard>
  );
};

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  signalRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  direction: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  probability: { alignItems: "flex-end" },
  flex: { flex: 1 },
  rule: { height: StyleSheet.hairlineWidth },
  metadata: {
    flexDirection: "row",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  noSignalRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  emptySymbol: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
