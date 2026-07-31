import {
  SignalOutcomeSchema,
  type Signal,
  type SignalOutcome,
  type SignalStatus,
} from "@flippars/contracts";

import { parsePositiveDecimal, toDecimalString } from "./math.js";
import { classifyPricePosition } from "./position.js";
import { toEpochMilliseconds } from "./windows.js";

export interface SignalOutcomeInput {
  readonly evaluatedAt: string;
  readonly closePrice?: string | null;
  readonly reliable?: boolean;
  readonly voidReason?: string;
}

export function evaluateSignalOutcome(
  signal: Signal,
  input: SignalOutcomeInput,
): SignalOutcome {
  const evaluatedMs = toEpochMilliseconds(input.evaluatedAt);
  const windowEndMs = toEpochMilliseconds(signal.windowEnd);

  if (evaluatedMs < windowEndMs) {
    return SignalOutcomeSchema.parse({
      signalId: signal.id,
      status: "PENDING",
      predictedCloseRelation: signal.predictedCloseRelation,
      actualCloseRelation: null,
      openPrice: signal.openPrice,
      closePrice: null,
      windowEnd: signal.windowEnd,
      resolvedAt: null,
      deadbandBps: signal.deadbandBps,
      reason: "The signal window is still open",
      dataMode: signal.dataMode,
    });
  }

  if (
    input.reliable === false ||
    input.closePrice === undefined ||
    input.closePrice === null
  ) {
    return SignalOutcomeSchema.parse({
      signalId: signal.id,
      status: "VOID",
      predictedCloseRelation: signal.predictedCloseRelation,
      actualCloseRelation: null,
      openPrice: signal.openPrice,
      closePrice: null,
      windowEnd: signal.windowEnd,
      resolvedAt: new Date(evaluatedMs).toISOString(),
      deadbandBps: signal.deadbandBps,
      reason: input.voidReason ?? "A trustworthy closing composite was unavailable",
      dataMode: signal.dataMode,
    });
  }

  const normalizedClose = toDecimalString(
    parsePositiveDecimal(input.closePrice, "closePrice"),
  );
  const actualCloseRelation = classifyPricePosition(
    normalizedClose,
    signal.openPrice,
    signal.deadbandBps,
  );
  const status =
    actualCloseRelation === "AT_OPEN"
      ? "FLAT"
      : actualCloseRelation === signal.predictedCloseRelation
        ? "CORRECT"
        : "INCORRECT";

  return SignalOutcomeSchema.parse({
    signalId: signal.id,
    status,
    predictedCloseRelation: signal.predictedCloseRelation,
    actualCloseRelation,
    openPrice: signal.openPrice,
    closePrice: normalizedClose,
    windowEnd: signal.windowEnd,
    resolvedAt: new Date(evaluatedMs).toISOString(),
    deadbandBps: signal.deadbandBps,
    reason: status === "FLAT" ? "Closing price finished inside the neutral band" : null,
    dataMode: signal.dataMode,
  });
}

export function signalStatusFromOutcome(outcome: SignalOutcome): SignalStatus {
  if (outcome.status === "PENDING") {
    return "ACTIVE";
  }
  if (outcome.status === "VOID") {
    return "VOID";
  }
  return "RESOLVED";
}
