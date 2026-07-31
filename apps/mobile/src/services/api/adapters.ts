import {
  CandleStateSchema,
  MarketSnapshotSchema,
  SignalOutcomeSchema,
  SignalSchema,
  WsEnvelopeSchema,
} from "@flippars/contracts";
import type {
  CandleView,
  Direction,
  EvidenceItem,
  MarketView,
  ReportedContext,
  SignalKind,
  SignalOutcome,
  SignalView,
} from "../../domain/models";
import { formatPercent } from "../../domain/format";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const numberValue = (value: unknown, fallback = 0): number => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

const arrayValue = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const SIGNAL_KIND_MAP: Readonly<Record<string, SignalKind>> = {
  FIVE_MINUTE_REVERSAL: "five_minute_reversal",
  FIFTEEN_MINUTE_REVERSAL: "fifteen_minute_reversal",
  FIVE_MINUTE_EARLY_DIRECTION: "five_minute_early_direction",
  five_minute_reversal: "five_minute_reversal",
  fifteen_minute_reversal: "fifteen_minute_reversal",
  five_minute_early_direction: "five_minute_early_direction",
};

const OUTCOME_MAP: Readonly<Record<string, SignalOutcome>> = {
  PENDING: "pending",
  CORRECT: "correct",
  INCORRECT: "incorrect",
  FLAT: "flat",
  VOID: "void",
  pending: "pending",
  correct: "correct",
  incorrect: "incorrect",
  flat: "flat",
  void: "void",
};

export const unwrapData = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return "data" in value ? value.data : value;
};

const signalKind = (value: unknown): SignalKind | null =>
  SIGNAL_KIND_MAP[stringValue(value)] ?? null;

const direction = (value: unknown): Direction | null => {
  if (value === "ABOVE_OPEN" || value === "higher") return "higher";
  if (value === "BELOW_OPEN" || value === "lower") return "lower";
  return null;
};

const outcomeStatus = (value: unknown): SignalOutcome =>
  OUTCOME_MAP[stringValue(value)] ?? "pending";

const position = (value: unknown): SignalView["observedPosition"] => {
  if (value === "ABOVE_OPEN") return "above";
  if (value === "BELOW_OPEN") return "below";
  return "at_open";
};

const evidenceDirectionDetail = (value: unknown): string => {
  if (value === "SUPPORTS") return "Supports the forecast.";
  if (value === "CONTRADICTS")
    return "Contradicts the forecast and is included for balance.";
  return "Neutral observation retained with the decision.";
};

const adaptEvidence = (items: readonly unknown[]): readonly EvidenceItem[] =>
  items.flatMap((item, index) => {
    if (!isRecord(item) || item.kind === "VERIFIED_EVENT") return [];
    return [
      {
        id: `${stringValue(item.kind, "EVIDENCE")}-${index}`,
        label: stringValue(item.label, "Recorded observation"),
        value: stringValue(item.value, "Recorded"),
        detail: `${stringValue(item.kind, "MARKET").replaceAll("_", " ")}. ${evidenceDirectionDetail(item.direction)}`,
      },
    ];
  });

const adaptReportedContext = (
  items: readonly unknown[],
  issuedAt: string,
): readonly ReportedContext[] =>
  items.flatMap((item, index) => {
    if (!isRecord(item) || item.kind !== "VERIFIED_EVENT") return [];
    return [
      {
        id: `VERIFIED_EVENT-${index}`,
        headline: stringValue(item.label, "Verified reported context"),
        source: stringValue(
          item.value,
          "Verified source recorded by the signal engine",
        ),
        observedAt: issuedAt,
      },
    ];
  });

const adaptModelFactors = (signal: JsonRecord): readonly EvidenceItem[] => {
  const model = isRecord(signal.model) ? signal.model : {};
  return [
    {
      id: "confidence-gate",
      label: "Confidence gate",
      value: `${formatPercent(numberValue(signal.confidence))} vs ${formatPercent(numberValue(signal.confidenceThreshold))}`,
      detail:
        "Calibrated probability exceeded the frozen policy threshold at issue time.",
    },
    {
      id: "calibration",
      label: "Calibration version",
      value: stringValue(model.calibrationVersion, "Unknown"),
      detail: "The immutable calibration artifact used for this forecast.",
    },
    {
      id: "lead-time",
      label: "Lead time",
      value: `${numberValue(signal.leadTimeSeconds)} seconds`,
      detail: "Time remaining in the interval when the signal was issued.",
    },
    {
      id: "risk-gate",
      label: "Anomaly risk score",
      value: formatPercent(numberValue(signal.riskScore)),
      detail: `Risk policy classification: ${stringValue(signal.riskLevel, "UNKNOWN").toLowerCase()}.`,
    },
  ];
};

/** Converts the canonical lossless wire signal into display-only numbers at the UI edge. */
export const adaptSignal = (rawValue: unknown): SignalView | null => {
  const unwrapped = unwrapData(rawValue);
  if (!isRecord(unwrapped)) return null;
  const signalRecord = isRecord(unwrapped.signal) ? unwrapped.signal : unwrapped;
  const outcomeRecord = isRecord(unwrapped.outcome) ? unwrapped.outcome : null;
  const parsedSignal = SignalSchema.safeParse(signalRecord);
  if (!parsedSignal.success) return null;
  const contractSignal = parsedSignal.data;
  const parsedOutcome = outcomeRecord
    ? SignalOutcomeSchema.safeParse(outcomeRecord)
    : null;
  if (parsedOutcome && !parsedOutcome.success) return null;
  const contractOutcome = parsedOutcome?.success ? parsedOutcome.data : null;
  const kind = signalKind(contractSignal.type);
  const predictedDirection = direction(contractSignal.predictedCloseRelation);
  if (!kind || !predictedDirection) return null;
  const observedPosition = position(contractSignal.observedPosition);
  if (
    (kind === "five_minute_reversal" || kind === "fifteen_minute_reversal") &&
    ((predictedDirection === "higher" && observedPosition !== "below") ||
      (predictedDirection === "lower" && observedPosition !== "above"))
  )
    return null;
  const issuedAtMs = Date.parse(contractSignal.issuedAt);
  const windowStartMs = Date.parse(contractSignal.windowStart);
  if (kind === "fifteen_minute_reversal" && issuedAtMs < windowStartMs + 450_000)
    return null;
  if (kind === "five_minute_early_direction" && issuedAtMs > windowStartMs + 60_000)
    return null;
  const model = contractSignal.model;
  const audit = contractSignal.audit;
  const evidenceItems = contractSignal.evidence;
  const riskFlags = [
    ...arrayValue(signalRecord.riskFlags)
      .map((flag) =>
        isRecord(flag)
          ? stringValue(flag.message, stringValue(flag.code))
          : stringValue(flag),
      )
      .filter(Boolean),
    ...arrayValue(signalRecord.healthFlags)
      .map((flag) =>
        isRecord(flag)
          ? stringValue(flag.message, stringValue(flag.code))
          : stringValue(flag),
      )
      .filter(Boolean),
  ];
  const resultPriceRaw = contractOutcome?.closePrice;
  const outcomePrice =
    resultPriceRaw === undefined || resultPriceRaw === null
      ? undefined
      : numberValue(resultPriceRaw);
  const issuedAt = contractSignal.issuedAt;
  const base = {
    id: contractSignal.id,
    kind,
    direction: predictedDirection,
    probability: contractSignal.confidence,
    openingPrice: numberValue(contractSignal.openPrice),
    currentPriceAtIssue: numberValue(contractSignal.currentPrice),
    issuedAt,
    expiresAt: contractSignal.expiresAt,
    modelVersion: model.version,
    calibrationVersion: model.calibrationVersion,
    confidenceThreshold: contractSignal.confidenceThreshold,
    leadTimeSeconds: contractSignal.leadTimeSeconds,
    riskLevel: contractSignal.riskLevel.toLowerCase() as SignalView["riskLevel"],
    riskScore: contractSignal.riskScore,
    observedPosition,
    outcome: outcomeStatus(
      contractOutcome?.status ??
        (contractSignal.status === "VOID" ? "VOID" : "PENDING"),
    ),
    observations: adaptEvidence(evidenceItems),
    modelFactors: adaptModelFactors(signalRecord),
    reportedContext: adaptReportedContext(evidenceItems, issuedAt),
    riskFlags,
    dataMode:
      contractSignal.dataMode === "DEMO" || contractSignal.dataMode === "SIMULATION"
        ? ("demo" as const)
        : ("live" as const),
    audit: {
      decisionId: audit.decisionId,
      policyVersion: audit.policyVersion,
      inputSnapshotId: audit.inputSnapshotId,
      evaluatedAt: audit.evaluatedAt,
    },
  };
  if (!base.id || !base.issuedAt || !base.expiresAt || !base.openingPrice) return null;
  return outcomePrice === undefined ? base : { ...base, outcomePrice };
};

export const adaptSignalList = (
  rawValue: unknown,
): {
  readonly signals: readonly SignalView[];
  readonly nextCursor: string | null;
  readonly sequence: number | null;
} => {
  const value = unwrapData(rawValue);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { signals: [], nextCursor: null, sequence: null };
  }
  const record = value;
  const items = Array.isArray(value)
    ? value
    : arrayValue(record.items ?? record.signals);
  return {
    signals: items.map(adaptSignal).filter((item): item is SignalView => item !== null),
    nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : null,
    sequence: Number.isSafeInteger(record.sequence)
      ? numberValue(record.sequence)
      : null,
  };
};

export const adaptCandle = (rawValue: unknown): CandleView | null => {
  const value = unwrapData(rawValue);
  const parsed = CandleStateSchema.safeParse(value);
  if (!parsed.success) return null;
  const candle = parsed.data;
  return {
    durationMinutes: candle.interval === "15m" ? 15 : 5,
    openingPrice: numberValue(candle.openPrice),
    currentPrice: numberValue(candle.currentPrice),
    openedAt: candle.windowStart,
    closesAt: candle.windowEnd,
  };
};

export const adaptMarket = (rawValue: unknown): MarketView => {
  const value = unwrapData(rawValue);
  const root = isRecord(value) ? value : {};
  const snapshot = isRecord(root.snapshot)
    ? root.snapshot
    : isRecord(root.market)
      ? root.market
      : root;
  const parsed = MarketSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    return {
      compositePrice: null,
      observedAt: null,
      health: "offline",
      healthMessage: "The market response failed schema validation.",
      venues: [],
      fiveMinute: null,
      fifteenMinute: null,
    };
  }
  const contract = parsed.data;
  const health =
    contract.health === "HEALTHY"
      ? "healthy"
      : contract.health === "UNAVAILABLE"
        ? "offline"
        : "degraded";
  const compositePrice =
    contract.compositePrice === null ? null : numberValue(contract.compositePrice);
  const candles = isRecord(root.candles) ? root.candles : {};
  const venueRecords = contract.venues;
  const eligibleVenues = venueRecords.flatMap((venue) => {
    if (!isRecord(venue)) return stringValue(venue) ? [stringValue(venue)] : [];
    if (venue.eligible === false) return [];
    const name = venue.venue;
    return name ? [name.slice(0, 1) + name.slice(1).toLowerCase()] : [];
  });
  const healthMessages = contract.healthFlags
    .map((flag) => (isRecord(flag) ? stringValue(flag.message) : ""))
    .filter(Boolean);
  return {
    compositePrice,
    observedAt: contract.observedAt,
    health,
    healthMessage:
      healthMessages[0] ??
      (health === "healthy"
        ? "Coinbase, Kraken and Binance composite meets quorum."
        : "One or more venue quality gates are not currently met."),
    venues: eligibleVenues,
    fiveMinute: adaptCandle(candles.fiveMinute ?? root.fiveMinute),
    fifteenMinute: adaptCandle(candles.fifteenMinute ?? root.fifteenMinute),
  };
};

export interface StreamEnvelope {
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
}

export const adaptStreamEnvelope = (rawValue: unknown): StreamEnvelope | null => {
  const parsed = WsEnvelopeSchema.safeParse(rawValue);
  if (!parsed.success) return null;
  return {
    sequence: parsed.data.sequence,
    type: parsed.data.type,
    payload: parsed.data.payload,
  };
};

export const adaptOutcomeUpdate = (
  rawValue: unknown,
): {
  readonly signalId: string;
  readonly outcome: SignalOutcome;
  readonly outcomePrice?: number;
} | null => {
  const value = unwrapData(rawValue);
  const parsed = SignalOutcomeSchema.safeParse(value);
  if (!parsed.success) return null;
  const outcome = parsed.data;
  const closePrice =
    outcome.closePrice === null ? undefined : numberValue(outcome.closePrice);
  const base = { signalId: outcome.signalId, outcome: outcomeStatus(outcome.status) };
  return closePrice === undefined ? base : { ...base, outcomePrice: closePrice };
};
