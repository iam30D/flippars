import { useColorScheme } from "react-native";

export interface AppColors {
  readonly background: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly text: string;
  readonly textMuted: string;
  readonly border: string;
  readonly primary: string;
  readonly primaryText: string;
  readonly positive: string;
  readonly negative: string;
  readonly warning: string;
  readonly info: string;
  readonly scrim: string;
}

const dark: AppColors = {
  background: "#08101F",
  surface: "#111A2F",
  surfaceRaised: "#18233C",
  text: "#F5F7FC",
  textMuted: "#AAB6CE",
  border: "#2A3854",
  primary: "#65E2B0",
  primaryText: "#052117",
  positive: "#64DFAE",
  negative: "#FF9F91",
  warning: "#FFC477",
  info: "#8EBBFF",
  scrim: "rgba(2, 7, 16, 0.72)",
};

const light: AppColors = {
  background: "#F3F6FB",
  surface: "#FFFFFF",
  surfaceRaised: "#EAF0F9",
  text: "#10192B",
  textMuted: "#52627C",
  border: "#D6DEEA",
  primary: "#087B5A",
  primaryText: "#FFFFFF",
  positive: "#087B5A",
  negative: "#B13B31",
  warning: "#95600B",
  info: "#265EA8",
  scrim: "rgba(14, 25, 43, 0.32)",
};

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;
export const radii = { sm: 10, md: 16, lg: 24, pill: 999 } as const;

export const useAppTheme = (): { colors: AppColors; isDark: boolean } => {
  const isDark = useColorScheme() !== "light";
  return { colors: isDark ? dark : light, isDark };
};
