export function sigmoid(value: number): number {
  if (value >= 0) {
    const exponential = Math.exp(-value);
    return 1 / (1 + exponential);
  }
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

export function logit(probability: number): number {
  const bounded = Math.min(1 - 1e-9, Math.max(1e-9, probability));
  return Math.log(bounded / (1 - bounded));
}

export function dot(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new RangeError("Vector dimensions must match");
  }
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot calculate a mean from an empty set");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
