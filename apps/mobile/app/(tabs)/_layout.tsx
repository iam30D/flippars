import { Redirect, Tabs } from "expo-router";
import { TabIcon } from "../../src/components/TabIcon";
import { useAppTheme } from "../../src/design/theme";
import { useApp } from "../../src/state/AppProvider";

export default function TabsLayout(): React.JSX.Element {
  const { ready, onboardingComplete } = useApp();
  const { colors } = useAppTheme();
  if (ready && !onboardingComplete) return <Redirect href="/onboarding" />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarLabelStyle: { fontSize: 12, fontWeight: "700" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Signals",
          tabBarAccessibilityLabel: "Signals dashboard tab",
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="dashboard" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: "History",
          tabBarAccessibilityLabel: "Complete signal history tab",
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="history" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarAccessibilityLabel: "Settings tab",
          tabBarIcon: ({ color, size }) => (
            <TabIcon name="settings" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
