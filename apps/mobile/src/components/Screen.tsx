import type { PropsWithChildren, ReactNode } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { spacing, useAppTheme } from "../design/theme";

interface ScreenProps {
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly footer?: ReactNode;
  readonly testID?: string;
}

export const Screen = ({
  children,
  refreshing = false,
  onRefresh,
  footer,
  testID,
}: PropsWithChildren<ScreenProps>): React.JSX.Element => {
  const { colors } = useAppTheme();
  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.safe, { backgroundColor: colors.background }]}
      testID={testID}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        {...(onRefresh
          ? {
              refreshControl: (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={colors.primary}
                />
              ),
            }
          : {})}
        contentContainerStyle={styles.content}
      >
        {children}
      </ScrollView>
      {footer ? (
        <View
          style={[
            styles.footer,
            { backgroundColor: colors.background, borderColor: colors.border },
          ]}
        >
          {footer}
        </View>
      ) : null}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: 112,
    gap: spacing.md,
  },
  footer: { padding: spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
});
