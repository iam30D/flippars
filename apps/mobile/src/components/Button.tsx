import type { PropsWithChildren } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { radii, spacing, useAppTheme } from "../design/theme";
import { AppText } from "./AppText";

interface ButtonProps {
  readonly onPress: () => void;
  readonly variant?: "primary" | "secondary" | "danger" | "ghost";
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly accessibilityHint?: string;
}

export const Button = ({
  children,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  accessibilityHint,
}: PropsWithChildren<ButtonProps>): React.JSX.Element => {
  const { colors } = useAppTheme();
  const backgroundColor =
    variant === "primary"
      ? colors.primary
      : variant === "danger"
        ? colors.negative
        : variant === "ghost"
          ? "transparent"
          : colors.surfaceRaised;
  const textColor =
    variant === "primary"
      ? colors.primaryText
      : variant === "danger"
        ? colors.background
        : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor,
          borderColor: colors.border,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <View style={styles.row}>
        {loading ? <ActivityIndicator color={textColor} /> : null}
        <AppText weight="700" style={{ color: textColor }}>
          {children}
        </AppText>
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    minHeight: 50,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
});
