import { createHash } from "node:crypto";

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function parsePositiveDecimal(value: string, label: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`${label} must be a canonical decimal string`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`${label} must be finite and greater than zero`);
  }

  return parsed;
}

export function toDecimalString(value: number, precision = 12): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Decimal value must be finite and greater than zero");
  }

  const fixed = value.toFixed(precision);
  return fixed.replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot calculate the median of an empty collection");
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const upper = sorted[midpoint];
  if (upper === undefined) {
    throw new RangeError("Median calculation failed");
  }

  if (sorted.length % 2 === 1) {
    return upper;
  }

  const lower = sorted[midpoint - 1];
  if (lower === undefined) {
    throw new RangeError("Median calculation failed");
  }
  return (lower + upper) / 2;
}

export function deterministicId(
  prefix: string,
  ...parts: readonly (string | number)[]
): string {
  const digest = createHash("sha256")
    .update(parts.join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

export function requireFinite(
  value: number,
  label: string,
  minimum = Number.NEGATIVE_INFINITY,
): number {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${label} must be finite and at least ${minimum}`);
  }
  return value;
}
