import * as Linking from "expo-linking";
import { Pressable, StyleSheet, View } from "react-native";
import type { EvidenceItem, ReportedContext } from "../domain/models";
import { formatObservedTime } from "../domain/format";
import { radii, spacing, useAppTheme } from "../design/theme";
import { AppText } from "./AppText";
import { Card } from "./Card";
import { SectionHeader } from "./SectionHeader";

export const EvidenceSection = ({
  title,
  description,
  items,
  emptyText,
}: {
  readonly title: string;
  readonly description: string;
  readonly items: readonly EvidenceItem[];
  readonly emptyText: string;
}): React.JSX.Element => (
  <View style={styles.section}>
    <SectionHeader title={title} description={description} />
    {items.length ? (
      items.map((item) => (
        <Card key={item.id} style={styles.item}>
          <View style={styles.row}>
            <AppText weight="700" style={styles.flex}>
              {item.label}
            </AppText>
            <AppText variant="caption" tone="info">
              {item.value}
            </AppText>
          </View>
          <AppText tone="muted">{item.detail}</AppText>
        </Card>
      ))
    ) : (
      <Card>
        <AppText tone="muted">{emptyText}</AppText>
      </Card>
    )}
  </View>
);

export const ReportedContextSection = ({
  items,
}: {
  readonly items: readonly ReportedContext[];
}): React.JSX.Element => {
  const { colors } = useAppTheme();
  return (
    <View style={styles.section}>
      <SectionHeader
        title="Reported context"
        description="Verified reporting attached at issue time. Context is not proof that an event caused the price move."
      />
      {items.length ? (
        items.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole={item.url ? "link" : "text"}
            disabled={!item.url}
            onPress={() => {
              if (item.url?.startsWith("https://")) void Linking.openURL(item.url);
            }}
            style={({ pressed }) => [
              styles.context,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <AppText weight="700">{item.headline}</AppText>
            <AppText variant="caption" tone="muted">
              {item.source} · {formatObservedTime(item.observedAt)}
            </AppText>
            {item.url ? (
              <AppText variant="caption" tone="info">
                Open verified source ↗
              </AppText>
            ) : null}
          </Pressable>
        ))
      ) : (
        <Card>
          <AppText tone="muted">
            No verified event context was attached. That does not imply that no external
            event occurred.
          </AppText>
        </Card>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  item: { gap: spacing.xs },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  flex: { flex: 1 },
  context: {
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
  },
});
