import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect } from "expo-router";
import { AppText } from "../src/components/AppText";
import { BrandMark } from "../src/components/BrandMark";
import { spacing, useAppTheme } from "../src/design/theme";
import { useApp } from "../src/state/AppProvider";

export default function IndexRoute(): React.JSX.Element {
  const { ready, onboardingComplete } = useApp();
  const { colors } = useAppTheme();
  if (!ready) {
    return (
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Preparing Flippars"
        style={[styles.loading, { backgroundColor: colors.background }]}
      >
        <BrandMark size={64} />
        <ActivityIndicator color={colors.primary} />
        <AppText tone="muted">Preparing your private guest session…</AppText>
      </View>
    );
  }
  return <Redirect href={onboardingComplete ? "/(tabs)" : "/onboarding"} />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.lg,
  },
});
