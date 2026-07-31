import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { AppText } from "../../src/components/AppText";
import { Badge, OutcomeBadge } from "../../src/components/Badge";
import { Card } from "../../src/components/Card";
import { DemoBanner } from "../../src/components/HealthBanner";
import {
  EvidenceSection,
  ReportedContextSection,
} from "../../src/components/EvidenceSection";
import { Screen } from "../../src/components/Screen";
import { SectionHeader } from "../../src/components/SectionHeader";
import { SignalCard } from "../../src/components/SignalCard";
import { radii, spacing, useAppTheme } from "../../src/design/theme";
import { formatObservedTime, formatPercent, formatUsd } from "../../src/domain/format";
import { SIGNAL_KIND_LABELS, type SignalView } from "../../src/domain/models";
import { useNow } from "../../src/hooks/useNow";
import { useApp } from "../../src/state/AppProvider";

export default function SignalDetailRoute(): React.JSX.Element {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const { ready, onboardingComplete, demoMode, fetchSignal } = useApp();
  const [signal, setSignal] = useState<SignalView | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const now = useNow();
  const { colors } = useAppTheme();

  useEffect(() => {
    let active = true;
    if (!id) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    void fetchSignal(id).then((value) => {
      if (active) {
        setSignal(value);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [fetchSignal, id]);

  if (ready && !onboardingComplete) return <Redirect href="/onboarding" />;
  return (
    <Screen testID="signal-detail-screen">
      {demoMode ? <DemoBanner /> : null}
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.back,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <AppText variant="heading">‹</AppText>
        </Pressable>
        <View style={styles.flex}>
          <AppText variant="heading">Signal record</AppText>
          <AppText variant="caption" tone="muted">
            IMMUTABLE EVIDENCE & OUTCOME
          </AppText>
        </View>
      </View>
      {loading ? (
        <View accessibilityRole="progressbar" style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
          <AppText tone="muted">Loading complete signal record…</AppText>
        </View>
      ) : !signal ? (
        <Card style={styles.loading}>
          <AppText variant="heading">Signal unavailable</AppText>
          <AppText tone="muted">
            This record may not exist, may have fallen outside server retention, or
            could not be recovered while offline.
          </AppText>
        </Card>
      ) : (
        <>
          <SignalCard kind={signal.kind} signal={signal} now={now} />
          <View style={styles.statusRow}>
            <OutcomeBadge outcome={signal.outcome} />
            <Badge
              label={`${signal.riskLevel} risk · ${formatPercent(signal.riskScore)}`}
              symbol={signal.riskLevel === "low" ? "✓" : "!"}
              tone={signal.riskLevel === "low" ? "positive" : "warning"}
            />
          </View>

          <Card style={styles.summary}>
            <AppText variant="heading">What was forecast</AppText>
            <AppText>
              BTC/USD would close <AppText weight="800">{signal.direction}</AppText>{" "}
              than the interval open of{" "}
              <AppText weight="800">{formatUsd(signal.openingPrice)}</AppText>.
            </AppText>
            <AppText tone="muted">
              At issue, price was {signal.observedPosition.replace("_", " ")} the open
              at {formatUsd(signal.currentPriceAtIssue)}. Confidence{" "}
              {formatPercent(signal.probability)} exceeded the{" "}
              {formatPercent(signal.confidenceThreshold)} policy threshold.
            </AppText>
            {signal.outcomePrice !== undefined ? (
              <AppText weight="700">
                Scored close: {formatUsd(signal.outcomePrice)}
              </AppText>
            ) : (
              <AppText tone="info">Outcome is still pending.</AppText>
            )}
          </Card>

          <EvidenceSection
            title="Market observations"
            description="Measurements available to the engine at issue time. Contradicting evidence remains visible."
            items={signal.observations}
            emptyText="No market observations were attached to this record."
          />
          <EvidenceSection
            title="Model and policy factors"
            description="These explain why the forecast cleared its gates; they are not claims of causation."
            items={signal.modelFactors}
            emptyText="No model factors were attached to this record."
          />
          <ReportedContextSection items={signal.reportedContext} />

          <View style={styles.section}>
            <SectionHeader
              title="Risk and health flags"
              description="Flags are preserved exactly with the decision and can suppress issuance."
            />
            {signal.riskFlags.length ? (
              signal.riskFlags.map((flag, index) => (
                <Card key={`${flag}-${index}`}>
                  <AppText tone="warning">! {flag}</AppText>
                </Card>
              ))
            ) : (
              <Card>
                <AppText tone="positive">
                  ✓ No elevated risk or health flag was attached.
                </AppText>
              </Card>
            )}
          </View>

          <View style={styles.section}>
            <SectionHeader
              title="Timing and audit"
              description="Identifiers make the forecast reproducible without exposing personal data."
            />
            <Card style={styles.audit}>
              <AuditRow label="Signal type" value={SIGNAL_KIND_LABELS[signal.kind]} />
              <AuditRow label="Issued" value={formatObservedTime(signal.issuedAt)} />
              <AuditRow label="Expires" value={formatObservedTime(signal.expiresAt)} />
              <AuditRow label="Lead time" value={`${signal.leadTimeSeconds} seconds`} />
              <AuditRow label="Model" value={signal.modelVersion} />
              <AuditRow label="Calibration" value={signal.calibrationVersion} />
              <AuditRow label="Policy" value={signal.audit.policyVersion} />
              <AuditRow label="Decision ID" value={signal.audit.decisionId} />
              <AuditRow label="Input snapshot" value={signal.audit.inputSnapshotId} />
            </Card>
          </View>
          <Card style={styles.disclaimer}>
            <AppText weight="800">
              Informational forecast — no trade was placed.
            </AppText>
            <AppText variant="caption" tone="muted">
              A high probability is not certainty. Context can be incomplete, price can
              change abruptly, and the outcome can be incorrect.
            </AppText>
          </Card>
        </>
      )}
    </Screen>
  );
}

const AuditRow = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element => (
  <View style={styles.auditRow}>
    <AppText tone="muted" variant="caption">
      {label}
    </AppText>
    <AppText variant="mono" style={styles.auditValue}>
      {value}
    </AppText>
  </View>
);

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  back: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  flex: { flex: 1 },
  loading: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    minHeight: 180,
  },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  summary: { gap: spacing.sm },
  section: { gap: spacing.sm },
  audit: { gap: spacing.sm },
  auditRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  auditValue: { flex: 1, textAlign: "right" },
  disclaimer: { gap: spacing.xs },
});
