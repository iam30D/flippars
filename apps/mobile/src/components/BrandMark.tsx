import Svg, { Line, Path, Rect } from "react-native-svg";
import { useAppTheme } from "../design/theme";

export const BrandMark = ({
  size = 48,
}: {
  readonly size?: number;
}): React.JSX.Element => {
  const { colors } = useAppTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityLabel="Flippars">
      <Rect width="64" height="64" rx="16" fill={colors.surfaceRaised} />
      <Line
        x1="9"
        y1="32"
        x2="55"
        y2="32"
        stroke={colors.textMuted}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Path
        d="M11 17h16c7 0 9 6 9 15s2 15 17 15"
        fill="none"
        stroke={colors.positive}
        strokeWidth="5"
        strokeLinecap="round"
      />
      <Path
        d="M11 47h12c11 0 12-7 12-15s4-15 18-15"
        fill="none"
        stroke={colors.warning}
        strokeWidth="5"
        strokeLinecap="round"
      />
    </Svg>
  );
};
