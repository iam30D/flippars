import { StyleSheet, View } from "react-native";
import { spacing } from "../design/theme";
import { AppText } from "./AppText";

export const SectionHeader = ({
  title,
  description,
}: {
  readonly title: string;
  readonly description?: string;
}): React.JSX.Element => (
  <View style={styles.section}>
    <AppText variant="heading">{title}</AppText>
    {description ? <AppText tone="muted">{description}</AppText> : null}
  </View>
);

const styles = StyleSheet.create({ section: { gap: spacing.xxs } });
