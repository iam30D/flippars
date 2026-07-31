import { StyleSheet, View } from "react-native";
import { radii, spacing, useAppTheme } from "../design/theme";
import type { SignalOutcome } from "../domain/models";
import { strings } from "../i18n/strings";
import { AppText } from "./AppText";

type BadgeTone = "positive" | "negative" | "warning" | "info" | "neutral";

export const Badge = ({
  label,
  symbol,
  tone = "neutral",
}: {
  readonly label: string;
  readonly symbol: string;
  readonly tone?: BadgeTone;
}): React.JSX.Element => {
  const { colors } = useAppTheme();
  const foreground = {
    positive: colors.positive,
    negative: colors.negative,
    warning: colors.warning,
    info: colors.info,
    neutral: colors.textMuted,
  }[tone];
  return (
    <View
      accessibilityLabel={`${symbol} ${label}`}
      style={[styles.badge, { borderColor: foreground }]}
    >
      <AppText variant="caption" style={{ color: foreground }}>
        {symbol} {label}
      </AppText>
    </View>
  );
};

export const OutcomeBadge = ({
  outcome,
}: {
  readonly outcome: SignalOutcome;
}): React.JSX.Element => {
  const config = {
    correct: { symbol: "✓", tone: "positive" as const },
    incorrect: { symbol: "×", tone: "negative" as const },
    flat: { symbol: "=", tone: "neutral" as const },
    void: { symbol: "∅", tone: "warning" as const },
    pending: { symbol: "…", tone: "info" as const },
  }[outcome];
  return (
    <Badge
      label={strings.outcomes[outcome]}
      symbol={config.symbol}
      tone={config.tone}
    />
  );
};

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
});
