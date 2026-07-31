import type { PropsWithChildren } from "react";
import { StyleSheet, Text, type TextProps, type TextStyle } from "react-native";
import { useAppTheme } from "../design/theme";

type Variant = "display" | "title" | "heading" | "body" | "caption" | "mono";
type Tone = "default" | "muted" | "positive" | "negative" | "warning" | "info";

interface AppTextProps extends TextProps {
  readonly variant?: Variant;
  readonly tone?: Tone;
  readonly weight?: TextStyle["fontWeight"];
}

export const AppText = ({
  children,
  variant = "body",
  tone = "default",
  weight,
  style,
  ...props
}: PropsWithChildren<AppTextProps>): React.JSX.Element => {
  const { colors } = useAppTheme();
  const toneColor = {
    default: colors.text,
    muted: colors.textMuted,
    positive: colors.positive,
    negative: colors.negative,
    warning: colors.warning,
    info: colors.info,
  }[tone];
  return (
    <Text
      {...props}
      allowFontScaling
      maxFontSizeMultiplier={2.2}
      style={[
        styles.base,
        styles[variant],
        { color: toneColor },
        weight ? { fontWeight: weight } : null,
        style,
      ]}
    >
      {children}
    </Text>
  );
};

const styles = StyleSheet.create({
  base: { lineHeight: 22 },
  display: { fontSize: 34, lineHeight: 40, fontWeight: "800", letterSpacing: -1 },
  title: { fontSize: 25, lineHeight: 31, fontWeight: "800", letterSpacing: -0.4 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "400" },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: "600", letterSpacing: 0.2 },
  mono: { fontSize: 13, lineHeight: 19, fontVariant: ["tabular-nums"] },
});
