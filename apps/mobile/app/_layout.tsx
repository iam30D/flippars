import * as Notifications from "expo-notifications";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppProvider } from "../src/state/AppProvider";
import { extractFreshSignalId } from "../src/services/notifications";
import { useAppTheme } from "../src/design/theme";
import { useReducedMotion } from "../src/hooks/useReducedMotion";

const NotificationObserver = (): null => {
  const router = useRouter();
  useEffect(() => {
    const openResponse = (response: Notifications.NotificationResponse): void => {
      const signalId = extractFreshSignalId(response);
      if (signalId) router.push({ pathname: "/signal/[id]", params: { id: signalId } });
    };
    const subscription =
      Notifications.addNotificationResponseReceivedListener(openResponse);
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) openResponse(response);
      void Notifications.clearLastNotificationResponseAsync();
    });
    return () => subscription.remove();
  }, [router]);
  return null;
};

const RootNavigator = (): React.JSX.Element => {
  const { colors, isDark } = useAppTheme();
  const reducedMotion = useReducedMotion();
  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <NotificationObserver />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: reducedMotion ? "none" : "fade",
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="signal/[id]" options={{ presentation: "card" }} />
      </Stack>
    </>
  );
};

export default function RootLayout(): React.JSX.Element {
  return (
    <AppProvider>
      <RootNavigator />
    </AppProvider>
  );
}
