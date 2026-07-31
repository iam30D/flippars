import { StyleSheet, View } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import { radii, spacing, useAppTheme } from "../design/theme";
import { AppText } from "./AppText";

export const ReversalDiagram = (): React.JSX.Element => {
  const { colors } = useAppTheme();
  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <Svg
        width="100%"
        height={152}
        viewBox="0 0 340 152"
        accessibilityLabel="Example: price is still above the five-minute open when a forecast predicts it will close below the open"
      >
        <Line
          x1="22"
          y1="76"
          x2="318"
          y2="76"
          stroke={colors.textMuted}
          strokeWidth="2"
          strokeDasharray="5 5"
        />
        <SvgText x="23" y="68" fill={colors.textMuted} fontSize="11">
          5m open resets
        </SvgText>
        <Path
          d="M24 76 C70 35 105 36 150 54"
          fill="none"
          stroke={colors.info}
          strokeWidth="5"
          strokeLinecap="round"
        />
        <Circle cx="150" cy="54" r="7" fill={colors.warning} />
        <SvgText x="112" y="34" fill={colors.text} fontSize="11">
          signal now
        </SvgText>
        <Path
          d="M150 54 C208 55 240 92 314 109"
          fill="none"
          stroke={colors.negative}
          strokeWidth="5"
          strokeDasharray="8 6"
          strokeLinecap="round"
        />
        <SvgText x="255" y="130" fill={colors.negative} fontSize="11">
          predicted close
        </SvgText>
      </Svg>
      <AppText variant="caption" tone="muted">
        The inverse applies while price is below the open and the forecast expects a
        close above it.
      </AppText>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.sm,
    gap: spacing.xs,
  },
});
