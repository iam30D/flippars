import type { ReactNode } from "react";
import { StyleSheet, Switch, View } from "react-native";
import { spacing, useAppTheme } from "../design/theme";
import { AppText } from "./AppText";

export const SettingToggle = ({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly disabled?: boolean;
}): React.JSX.Element => {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <View style={styles.copy}>
        <AppText weight="700">{label}</AppText>
        <AppText variant="caption" tone="muted">
          {description}
        </AppText>
      </View>
      <Switch
        accessibilityLabel={label}
        accessibilityHint={description}
        accessibilityState={{ checked: value, disabled }}
        disabled={disabled}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={value ? colors.primaryText : colors.textMuted}
      />
    </View>
  );
};

export const SettingValue = ({
  label,
  description,
  control,
}: {
  readonly label: string;
  readonly description: string;
  readonly control: ReactNode;
}): React.JSX.Element => {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.value, { borderColor: colors.border }]}>
      <View style={styles.copy}>
        <AppText weight="700">{label}</AppText>
        <AppText variant="caption" tone="muted">
          {description}
        </AppText>
      </View>
      {control}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  value: {
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  copy: { flex: 1, gap: spacing.xxs },
});
