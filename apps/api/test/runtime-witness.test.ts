import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { z } from "zod";
import { RuntimeWitness } from "../src/research/runtime-witness.js";
import {
  runObservedCapture,
  verifyObservedRuntime,
} from "../src/research/capture-observed-cli.js";

test("runtime witness detects a deliberate local scheduling stall and stops immutably", async () => {
  const witness = new RuntimeWitness();
  try {
    await delay(100);
    // A bounded 120 ms synchronous wait provides real timer-stall evidence.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    await delay(1_050);
  } finally {
    witness.stop();
  }
  const report = witness.stop();
  assert.ok(report.eventLoop.samples > 0);
  assert.ok(report.eventLoop.maximumMs! >= 100);
  assert.ok(report.callbackIntervalsObserved >= 1);
  assert.ok(report.largestCallbackIntervals.length <= 32);
  report.largestCallbackIntervals[0]!.from = "mutated";
  assert.notEqual(witness.stop().largestCallbackIntervals[0]!.from, "mutated");
  assert.equal(report.productionEligible, false);
});

test("observed capture binds runtime evidence to source metadata and refuses overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "flippars-witness-"));
  const fakeCapture = () =>
    Promise.resolve({
      root,
      sessionId: "12345678-1234-4234-8234-123456789012",
      completionState: "INCOMPLETE",
      fileSha256: "a".repeat(64),
    });
  const bytes = Buffer.from(JSON.stringify(await fakeCapture()) + "\n");
  await writeFile(join(root, "manifest.json"), bytes);
  try {
    const result = await runObservedCapture(
      { outputParent: root, seconds: 10, maxMiB: 1 },
      fakeCapture,
    );
    const envelope = z
      .object({ payload: z.string(), sha256: z.string() })
      .parse(JSON.parse(await readFile(result.runtimeWitnessPath, "utf8")) as unknown);
    assert.equal(
      createHash("sha256").update(envelope.payload).digest("hex"),
      envelope.sha256,
    );
    const report = JSON.parse(envelope.payload) as Record<string, unknown>;
    assert.equal(report["captureCompletionState"], "INCOMPLETE");
    assert.equal(
      report["captureManifestSha256"],
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(report["productionEligible"], false);
    assert.equal((await verifyObservedRuntime(root)).integrityVerified, true);
    await assert.rejects(
      runObservedCapture({ outputParent: root, seconds: 10, maxMiB: 1 }, fakeCapture),
    );
    await assert.rejects(
      runObservedCapture({ outputParent: root, seconds: 10, maxMiB: 1 }, () =>
        Promise.reject(new Error("capture failed")),
      ),
    );
    await writeFile(
      join(root, "runtime-witness.json"),
      JSON.stringify({ payload: envelope.payload + " ", sha256: envelope.sha256 }),
    );
    await assert.rejects(verifyObservedRuntime(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
