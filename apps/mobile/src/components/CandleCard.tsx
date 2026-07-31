import { StyleSheet, View } from "react-native";
import type { CandleView } from "../domain/models";
import { spacing, useAppTheme } from "../design/theme";
import {
  formatPercent,
  formatSignedUsd,
  formatUsd,
  relativeDelta,
} from "../domain/format";
import { countdownTo, formatCountdown } from "../domain/time";
import { AppText } from "./AppText";
import { Card } from "./Card";

export const CandleCard = ({
  candle,
  now,
}: {
  readonly candle: CandleView | null;
  readonly now: number;
}): React.JSX.Element => {
  const { colors } = useAppTheme();
  if (!candle) {
    return (
      <Card style={styles.card} accessibilityLabel="Candle unavailable">
        <AppText variant="caption" tone="muted">
          CANDLE UNAVAILABLE
        </AppText>
        <AppText weight="700">Waiting for an aligned opening price</AppText>
      </Card>
    );
  }
  const delta = candle.currentPrice - candle.openingPrice;
  const percent = relativeDelta(candle.openingPrice, candle.currentPrice);
  const up = delta >= 0;
  return (
    <Card
      style={styles.card}
      accessibilityLabel={`${candle.durationMinutes} minute interval. Open ${formatUsd(candle.openingPrice)}. Current ${formatUsd(candle.currentPrice)}. ${up ? "Above" : "Below"} open by ${formatSignedUsd(delta)}. Closes in ${formatCountdown(countdownTo(candle.closesAt, now))}.`}
    >
      <View style={styles.header}>
        <AppText variant="caption" tone="muted">
          {candle.durationMinutes} MINUTE
        </AppText>
        <AppText variant="mono" weight="800">
          {formatCountdown(countdownTo(candle.closesAt, now))}
        </AppText>
      </View>
      <AppText variant="heading">Open {formatUsd(candle.openingPrice)}</AppText>
      <AppText
        variant="caption"
        style={{ color: up ? colors.positive : colors.negative }}
      >
        {up ? "↑ ABOVE OPEN" : "↓ BELOW OPEN"} · {formatSignedUsd(delta)} (
        {formatPercent(Math.abs(percent), 2)})
      </AppText>
    </Card>
  );
};

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: 156, gap: spacing.xs },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.xs,
  },
});
