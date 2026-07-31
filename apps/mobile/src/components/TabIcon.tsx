import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import type { ColorValue } from "react-native";

export const TabIcon = ({
  name,
  color,
  size = 24,
}: {
  readonly name: "dashboard" | "history" | "settings";
  readonly color: ColorValue;
  readonly size?: number;
}): React.JSX.Element => (
  <Svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    accessibilityElementsHidden
  >
    {name === "dashboard" ? (
      <Path
        d="M3 13h4l2.2-6 4.1 11 2.2-6H21"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ) : null}
    {name === "history" ? (
      <>
        <Path
          d="M4 8a9 9 0 1 1-1 5"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <Path
          d="M4 3v5h5M12 7v6l4 2"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ) : null}
    {name === "settings" ? (
      <>
        <Circle cx="12" cy="12" r="3" stroke={color} strokeWidth="2" />
        <Rect
          x="4"
          y="4"
          width="16"
          height="16"
          rx="7"
          stroke={color}
          strokeWidth="2"
        />
        <Line x1="12" y1="1" x2="12" y2="4" stroke={color} strokeWidth="2" />
        <Line x1="12" y1="20" x2="12" y2="23" stroke={color} strokeWidth="2" />
      </>
    ) : null}
  </Svg>
);
