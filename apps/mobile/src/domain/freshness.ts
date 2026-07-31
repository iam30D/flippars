import type { SignalView } from "./models";
import { isIsoFresh } from "./time";

export type SignalFreshness = "active" | "expired" | "invalid";

export const signalFreshness = (
  signal: Pick<SignalView, "issuedAt" | "expiresAt">,
  nowMs: number = Date.now(),
): SignalFreshness => {
  const issuedAt = Date.parse(signal.issuedAt);
  const expiresAt = Date.parse(signal.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt >= expiresAt
  )
    return "invalid";
  return isIsoFresh(signal.expiresAt, nowMs) ? "active" : "expired";
};
