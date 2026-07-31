import { createHash } from "node:crypto";

import type { SignalType } from "@flippars/contracts";

import { dot, logit, mean, sigmoid } from "./math.js";
import {
  LogisticArtifactSchema,
  TrainingRowSchema,
  type LogisticArtifact,
  type ModelMetrics,
  type TrainingRow,
} from "./schema.js";

export interface TrainingOptions {
  readonly signalType: SignalType;
  readonly version: string;
  readonly createdAt?: string;
  readonly confidenceThreshold?: number;
  readonly trainFraction?: number;
  readonly calibrationFraction?: number;
  readonly learningRate?: number;
  readonly iterations?: number;
  readonly l2?: number;
  readonly calibrationValidityDays?: number;
}

export interface ChronologicalPartitions {
  readonly train: readonly TrainingRow[];
  readonly calibration: readonly TrainingRow[];
  readonly holdout: readonly TrainingRow[];
}

interface Normalization {
  readonly means: readonly number[];
  readonly scales: readonly number[];
}

interface LogisticParameters {
  readonly weights: readonly number[];
  readonly bias: number;
}

export function chronologicalPartitions(
  input: readonly TrainingRow[],
  trainFraction = 0.6,
  calibrationFraction = 0.2,
): ChronologicalPartitions {
  if (
    trainFraction <= 0 ||
    calibrationFraction <= 0 ||
    trainFraction + calibrationFraction >= 1
  ) {
    throw new RangeError("Chronological split fractions are invalid");
  }
  const rows = input
    .map((row) => TrainingRowSchema.parse(row))
    .sort((left, right) => Date.parse(left.decisionAt) - Date.parse(right.decisionAt));
  if (rows.length < 30) {
    throw new RangeError("At least 30 chronological rows are required");
  }

  const calibrationStartIndex = Math.floor(rows.length * trainFraction);
  const holdoutStartIndex = Math.floor(
    rows.length * (trainFraction + calibrationFraction),
  );
  const calibrationStart = Date.parse(rows[calibrationStartIndex]?.decisionAt ?? "");
  const holdoutStart = Date.parse(rows[holdoutStartIndex]?.decisionAt ?? "");

  const train = rows
    .slice(0, calibrationStartIndex)
    .filter((row) => Date.parse(row.windowEnd) < calibrationStart);
  const calibration = rows
    .slice(calibrationStartIndex, holdoutStartIndex)
    .filter((row) => Date.parse(row.windowEnd) < holdoutStart);
  const holdout = rows.slice(holdoutStartIndex);

  if (train.length < 10 || calibration.length < 5 || holdout.length < 5) {
    throw new RangeError("Purged partitions do not contain enough observations");
  }
  return { train, calibration, holdout };
}

export function trainCandidate(
  rawRows: readonly TrainingRow[],
  options: TrainingOptions,
): LogisticArtifact {
  const threshold = options.confidenceThreshold ?? 0.75;
  if (threshold < 0.5 || threshold > 1) {
    throw new RangeError("confidenceThreshold must be between 0.5 and 1");
  }
  const filtered = rawRows
    .map((row) => TrainingRowSchema.parse(row))
    .filter(
      (row) =>
        row.signalType === options.signalType &&
        row.dataHealthy &&
        row.anomalyRisk < 0.65,
    );
  const featureNames = sharedFeatureNames(filtered);
  const partitions = chronologicalPartitions(
    filtered,
    options.trainFraction,
    options.calibrationFraction,
  );
  const normalization = fitNormalization(partitions.train, featureNames);
  const model = fitLogistic(
    matrix(partitions.train, featureNames, normalization),
    labels(partitions.train),
    options,
  );
  const calibrationProbabilities = matrix(
    partitions.calibration,
    featureNames,
    normalization,
  ).map((features) => sigmoid(dot(model.weights, features) + model.bias));
  const calibration = fitPlatt(
    calibrationProbabilities,
    labels(partitions.calibration),
    options,
  );
  const holdoutProbabilities = matrix(
    partitions.holdout,
    featureNames,
    normalization,
  ).map((features) =>
    sigmoid(
      calibration.slope * logit(sigmoid(dot(model.weights, features) + model.bias)) +
        calibration.intercept,
    ),
  );
  const createdAt = new Date(options.createdAt ?? Date.now()).toISOString();
  const validUntil = new Date(
    Date.parse(createdAt) + (options.calibrationValidityDays ?? 30) * 86_400_000,
  ).toISOString();
  const artifact: LogisticArtifact = {
    schemaVersion: "flippars.logistic-candidate/1",
    artifactId: `candidate:${options.signalType}:${options.version}`,
    version: options.version,
    status: "DRAFT",
    signalType: options.signalType,
    createdAt,
    trainedThrough: partitions.train.at(-1)?.decisionAt ?? createdAt,
    featureNames: [...featureNames],
    normalization: {
      means: [...normalization.means],
      scales: [...normalization.scales],
    },
    model: {
      weights: [...model.weights],
      bias: model.bias,
    },
    calibration: {
      method: "PLATT",
      slope: calibration.slope,
      intercept: calibration.intercept,
      version: `platt:${options.version}`,
      validUntil,
    },
    datasetSha256: datasetHash(filtered),
    holdoutMetrics: evaluateProbabilities(
      holdoutProbabilities,
      labels(partitions.holdout),
      threshold,
    ),
    approval: {
      approvedAt: null,
      approvedBy: null,
    },
  };
  return LogisticArtifactSchema.parse(artifact);
}

export function predictCandidate(
  artifactInput: LogisticArtifact,
  features: Readonly<Record<string, number>>,
): number {
  const artifact = LogisticArtifactSchema.parse(artifactInput);
  const vector = artifact.featureNames.map((name, index) => {
    const value = features[name];
    if (value === undefined || !Number.isFinite(value)) {
      throw new TypeError(`Missing or invalid feature: ${name}`);
    }
    return (
      (value - (artifact.normalization.means[index] ?? 0)) /
      (artifact.normalization.scales[index] ?? 1)
    );
  });
  const uncalibrated = sigmoid(
    dot(artifact.model.weights, vector) + artifact.model.bias,
  );
  return sigmoid(
    artifact.calibration.slope * logit(uncalibrated) + artifact.calibration.intercept,
  );
}

export function evaluateProbabilities(
  probabilities: readonly number[],
  expected: readonly number[],
  threshold: number,
): ModelMetrics {
  if (probabilities.length === 0 || probabilities.length !== expected.length) {
    throw new RangeError("Probability and label arrays must be nonempty and aligned");
  }
  let brier = 0;
  let logLoss = 0;
  let alerts = 0;
  let alertCorrect = 0;
  const binCount = Math.min(10, probabilities.length);
  const bins = Array.from({ length: binCount }, () => ({
    probabilities: [] as number[],
    labels: [] as number[],
  }));
  probabilities.forEach((probability, index) => {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError("Probabilities must be finite and within [0, 1]");
    }
    const label = expected[index] ?? 0;
    brier += (probability - label) ** 2;
    const bounded = Math.min(1 - 1e-9, Math.max(1e-9, probability));
    logLoss += -(label * Math.log(bounded) + (1 - label) * Math.log(1 - bounded));
    if (probability >= threshold) {
      alerts += 1;
      alertCorrect += label;
    }
    const bin = Math.min(binCount - 1, Math.floor(probability * binCount));
    bins[bin]?.probabilities.push(probability);
    bins[bin]?.labels.push(label);
  });
  const expectedCalibrationError = bins.reduce((total, bin) => {
    if (bin.labels.length === 0) return total;
    return (
      total +
      (bin.labels.length / probabilities.length) *
        Math.abs(mean(bin.probabilities) - mean(bin.labels))
    );
  }, 0);
  return {
    sampleCount: probabilities.length,
    positives: expected.reduce((sum, value) => sum + value, 0),
    brierScore: brier / probabilities.length,
    logLoss: logLoss / probabilities.length,
    expectedCalibrationError,
    precisionAtThreshold: alerts === 0 ? 0 : alertCorrect / alerts,
    coverageAtThreshold: alerts / probabilities.length,
    threshold,
  };
}

function sharedFeatureNames(rows: readonly TrainingRow[]): readonly string[] {
  if (rows.length === 0) {
    throw new RangeError("No healthy rows match the requested signal type");
  }
  const names = Object.keys(rows[0]?.features ?? {}).sort();
  if (names.length === 0) {
    throw new RangeError("At least one feature is required");
  }
  for (const row of rows) {
    const candidate = Object.keys(row.features).sort();
    if (candidate.join("\u0000") !== names.join("\u0000")) {
      throw new TypeError("All training rows must use the same feature schema");
    }
  }
  return names;
}

function labels(rows: readonly TrainingRow[]): readonly number[] {
  return rows.map((row) => (row.correct ? 1 : 0));
}

function matrix(
  rows: readonly TrainingRow[],
  names: readonly string[],
  normalization: Normalization,
): readonly (readonly number[])[] {
  return rows.map((row) =>
    names.map(
      (name, index) =>
        ((row.features[name] ?? 0) - (normalization.means[index] ?? 0)) /
        (normalization.scales[index] ?? 1),
    ),
  );
}

function fitNormalization(
  rows: readonly TrainingRow[],
  names: readonly string[],
): Normalization {
  const means = names.map((name) => mean(rows.map((row) => row.features[name] ?? 0)));
  const scales = names.map((name, index) => {
    const center = means[index] ?? 0;
    const variance = mean(rows.map((row) => ((row.features[name] ?? 0) - center) ** 2));
    return Math.max(Math.sqrt(variance), 1e-9);
  });
  return { means, scales };
}

function fitLogistic(
  features: readonly (readonly number[])[],
  expected: readonly number[],
  options: TrainingOptions,
): LogisticParameters {
  const dimensions = features[0]?.length ?? 0;
  const weights = Array.from({ length: dimensions }, () => 0);
  let bias = 0;
  const rate = options.learningRate ?? 0.05;
  const iterations = options.iterations ?? 1_500;
  const l2 = options.l2 ?? 0.001;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const weightGradients = Array.from({ length: dimensions }, () => 0);
    let biasGradient = 0;
    features.forEach((row, rowIndex) => {
      const error = sigmoid(dot(weights, row) + bias) - (expected[rowIndex] ?? 0);
      biasGradient += error;
      row.forEach((value, index) => {
        weightGradients[index] = (weightGradients[index] ?? 0) + error * value;
      });
    });
    weights.forEach((weight, index) => {
      weights[index] =
        weight - rate * ((weightGradients[index] ?? 0) / features.length + l2 * weight);
    });
    bias -= rate * (biasGradient / features.length);
  }
  return { weights, bias };
}

function fitPlatt(
  probabilities: readonly number[],
  expected: readonly number[],
  options: TrainingOptions,
): { readonly slope: number; readonly intercept: number } {
  let slope = 1;
  let intercept = 0;
  const rate = (options.learningRate ?? 0.05) * 0.25;
  const iterations = Math.max(500, Math.floor((options.iterations ?? 1_500) / 2));
  const scores = probabilities.map(logit);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let slopeGradient = 0;
    let interceptGradient = 0;
    scores.forEach((score, index) => {
      const error = sigmoid(slope * score + intercept) - (expected[index] ?? 0);
      slopeGradient += error * score;
      interceptGradient += error;
    });
    slope -= rate * (slopeGradient / scores.length);
    intercept -= rate * (interceptGradient / scores.length);
  }
  return { slope, intercept };
}

function datasetHash(rows: readonly TrainingRow[]): string {
  const canonical = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => JSON.stringify(row))
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}
