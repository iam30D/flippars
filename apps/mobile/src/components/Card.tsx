import type { PropsWithChildren } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type ViewProps,
} from "react-native";
import { radii, spacing, useAppTheme } from "../design/theme";

interface CardProps extends ViewProps {
  readonly elevated?: boolean;
}

export const Card = ({
  children,
  elevated = false,
  style,
  ...props
}: PropsWithChildren<CardProps>): React.JSX.Element => {
  const { colors } = useAppTheme();
  return (
    <View
      {...props}
      style={[
        styles.card,
        {
          backgroundColor: elevated ? colors.surfaceRaised : colors.surface,
          borderColor: colors.border,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
};

export const PressableCard = ({
  children,
  style,
  ...props
}: PropsWithChildren<PressableProps>): React.JSX.Element => {
  const { colors } = useAppTheme();
  return (
    <Pressable
      {...props}
      style={({ pressed }) => [
        styles.card,
        styles.pressable,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          opacity: pressed ? 0.72 : 1,
        },
        typeof style === "function" ? style({ pressed, hovered: false }) : style,
      ]}
    >
      {children}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  pressable: { minHeight: 48 },
});
