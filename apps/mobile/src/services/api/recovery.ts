export type SequenceDecision = "initial" | "contiguous" | "duplicate" | "gap";

export const assessSequence = (
  lastSequence: number | null,
  incomingSequence: number,
): SequenceDecision => {
  if (!Number.isSafeInteger(incomingSequence) || incomingSequence < 0) return "gap";
  if (lastSequence === null) return "initial";
  if (incomingSequence <= lastSequence) return "duplicate";
  if (incomingSequence === lastSequence + 1) return "contiguous";
  return "gap";
};

export const mergeSignals = <
  T extends { readonly id: string; readonly issuedAt: string },
>(
  current: readonly T[],
  incoming: readonly T[],
): readonly T[] => {
  const byId = new Map(current.map((signal) => [signal.id, signal]));
  for (const signal of incoming) byId.set(signal.id, signal);
  return [...byId.values()].sort((left, right) => {
    const timeDifference = Date.parse(right.issuedAt) - Date.parse(left.issuedAt);
    return Number.isNaN(timeDifference)
      ? right.id.localeCompare(left.id)
      : timeDifference;
  });
};

export const websocketUrl = (apiUrl: string): string => {
  const url = new URL(`${apiUrl.replace(/\/$/, "")}/v1/stream`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

export const reconnectDelayMs = (
  attempt: number,
  randomFraction = Math.random(),
): number => {
  const cappedAttempt = Math.max(0, Math.min(6, attempt));
  const base = Math.min(30_000, 1_000 * 2 ** cappedAttempt);
  const jitter = Math.max(0, Math.min(1, randomFraction)) * 0.25 * base;
  return Math.round(base + jitter);
};
