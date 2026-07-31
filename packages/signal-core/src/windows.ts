import type { CandleDurationSeconds, CandleInterval } from "@flippars/contracts";

export interface UtcWindow {
  readonly interval: CandleInterval;
  readonly durationSeconds: CandleDurationSeconds;
  readonly startMs: number;
  readonly endMs: number;
  readonly start: string;
  readonly end: string;
}

export interface WindowProgress {
  readonly elapsedSeconds: number;
  readonly remainingSeconds: number;
  readonly complete: boolean;
}

export function toEpochMilliseconds(value: string | number | Date): number {
  const milliseconds =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : Date.parse(value);

  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Expected a valid timestamp");
  }

  return milliseconds;
}

export function intervalForDuration(
  durationSeconds: CandleDurationSeconds,
): CandleInterval {
  return durationSeconds === 300 ? "5m" : "15m";
}

/**
 * Produces fixed epoch-aligned windows. Unix epoch alignment is UTC alignment,
 * so local timezone and daylight-saving changes can never shift a candle.
 *
 * Windows are half-open: `[start, end)`. A tick exactly on `end` belongs to the
 * next candle and therefore resets its opening price.
 */
export function getUtcAlignedWindow(
  at: string | number | Date,
  durationSeconds: CandleDurationSeconds,
): UtcWindow {
  const atMs = toEpochMilliseconds(at);
  const durationMs = durationSeconds * 1_000;
  const startMs = Math.floor(atMs / durationMs) * durationMs;
  const endMs = startMs + durationMs;

  return {
    interval: intervalForDuration(durationSeconds),
    durationSeconds,
    startMs,
    endMs,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

export function getWindowProgress(
  window: Pick<UtcWindow, "startMs" | "endMs">,
  at: string | number | Date,
): WindowProgress {
  const atMs = toEpochMilliseconds(at);
  const elapsedMs = Math.max(0, atMs - window.startMs);
  const remainingMs = Math.max(0, window.endMs - atMs);
  return {
    elapsedSeconds: elapsedMs / 1_000,
    remainingSeconds: remainingMs / 1_000,
    complete: atMs >= window.endMs,
  };
}

export function isInsideWindow(
  windowStart: string,
  windowEnd: string,
  at: string | number | Date,
): boolean {
  const atMs = toEpochMilliseconds(at);
  return (
    atMs >= toEpochMilliseconds(windowStart) && atMs < toEpochMilliseconds(windowEnd)
  );
}
