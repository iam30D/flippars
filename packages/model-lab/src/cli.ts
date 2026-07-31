#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import type { SignalType } from "@flippars/contracts";

import { TrainingRowSchema } from "./schema.js";
import { trainCandidate } from "./training.js";

interface Arguments {
  readonly input: string;
  readonly output: string;
  readonly signalType: SignalType;
  readonly version: string;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const input = await readFile(resolve(options.input), "utf8");
  const rows = input
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return TrainingRowSchema.parse(JSON.parse(line) as unknown);
      } catch (error) {
        throw new Error(`Invalid JSONL training row ${index + 1}`, {
          cause: error,
        });
      }
    });
  const artifact = trainCandidate(rows, {
    signalType: options.signalType,
    version: options.version,
  });
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({
      artifactId: artifact.artifactId,
      status: artifact.status,
      trainedThrough: artifact.trainedThrough,
      holdoutMetrics: artifact.holdoutMetrics,
      output,
    })}\n`,
  );
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      usage();
    }
    parsed.set(key.slice(2), value);
  }
  const input = parsed.get("input");
  const output = parsed.get("output");
  const version = parsed.get("version");
  const signalType = parsed.get("signal-type");
  if (!input || !output || !version || !isSignalType(signalType)) {
    usage();
  }
  return { input, output, version, signalType };
}

function isSignalType(value: string | undefined): value is SignalType {
  return (
    value === "FIVE_MINUTE_REVERSAL" ||
    value === "FIFTEEN_MINUTE_REVERSAL" ||
    value === "FIVE_MINUTE_EARLY_DIRECTION"
  );
}

function usage(): never {
  process.stderr.write(
    "Usage: flippars-model-lab --input rows.jsonl --output candidate.json --signal-type FIVE_MINUTE_REVERSAL --version 2026.07.1\n",
  );
  process.exit(2);
}

await main();
