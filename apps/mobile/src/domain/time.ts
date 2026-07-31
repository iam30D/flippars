export interface CountdownParts {
  readonly expired: boolean;
  readonly totalSeconds: number;
  readonly minutes: number;
  readonly seconds: number;
}

export const countdownTo = (
  targetIso: string,
  nowMs: number = Date.now(),
): CountdownParts => {
  const targetMs = Date.parse(targetIso);
  if (!Number.isFinite(targetMs)) {
    return { expired: true, totalSeconds: 0, minutes: 0, seconds: 0 };
  }
  const totalSeconds = Math.max(0, Math.ceil((targetMs - nowMs) / 1_000));
  return {
    expired: totalSeconds === 0,
    totalSeconds,
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  };
};

export const formatCountdown = (parts: CountdownParts): string => {
  if (parts.expired) return "Closed";
  return `${String(parts.minutes).padStart(2, "0")}:${String(parts.seconds).padStart(2, "0")}`;
};

export const isIsoFresh = (expiresAt: string, nowMs: number = Date.now()): boolean => {
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
};

export const minutesToClock = (minutes: number): string => {
  const normalized = ((minutes % 1_440) + 1_440) % 1_440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};
