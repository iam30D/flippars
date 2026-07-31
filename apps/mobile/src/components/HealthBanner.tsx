import { StyleSheet, View } from "react-native";
import type { DataHealth } from "../domain/models";
import { radii, spacing, useAppTheme } from "../design/theme";
import { strings } from "../i18n/strings";
import { AppText } from "./AppText";

export const HealthBanner = ({
  health,
  message,
}: {
  readonly health: DataHealth;
  readonly message: string;
}): React.JSX.Element => {
  const { colors } = useAppTheme();
  const config = {
    healthy: { symbol: "✓", color: colors.positive },
    degraded: { symbol: "!", color: colors.warning },
    offline: { symbol: "×", color: colors.negative },
    connecting: { symbol: "…", color: colors.info },
  }[health];
  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={`${strings.dataHealth[health]}. ${message}`}
      style={[
        styles.banner,
        { borderColor: config.color, backgroundColor: colors.surface },
      ]}
    >
      <View style={[styles.symbol, { borderColor: config.color }]}>
        <AppText weight="800" style={{ color: config.color }}>
          {config.symbol}
        </AppText>
      </View>
      <View style={styles.copy}>
        <AppText weight="700">{strings.dataHealth[health]}</AppText>
        <AppText tone="muted" variant="caption">
          {message}
        </AppText>
      </View>
    </View>
  );
};

export const DemoBanner = (): React.JSX.Element => {
  const { colors } = useAppTheme();
  return (
    <View
      accessibilityRole="alert"
      style={[styles.demo, { backgroundColor: colors.warning }]}
    >
      <AppText variant="caption" weight="800" style={{ color: colors.background }}>
        DEMO · Simulated values, never live signals
      </AppText>
    </View>
  );
};

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
  },
  symbol: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 2 },
  demo: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    alignItems: "center",
  },
});
