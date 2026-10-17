import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ResearchPopulationReplay } from "../src/research/population-replay.js";
import {
  REPLAY_IMPLEMENTATION_MODULES,
  verifyReplayEvidence,
  writeReplayEvidence,
} from "../src/research/population-replay-cli.js";
import {
  buildResearchDecision,
  buildResearchOutcome,
} from "../src/research/trade-features.js";
import type { ResearchTrade } from "../src/research/trade-features.js";

const origin = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (offset: number) => new Date(origin + offset).toISOString();
const trades: ResearchTrade[] = Array.from({ length: 61 }, (_, index) => ({
  tradeId: String(index + 1),
  eventAt: iso(index * 15_000 - (index === 0 ? 1 : 0)).replace("Z", "000Z"),
  receivedAt: iso(index * 15_000),
  price: String(100000 + (index % 7)),
  quantity: "0.01",
  buyerIsMaker: false,
}));

function sample() {
  const replay = new ResearchPopulationReplay(iso(0), iso(900_000));
  for (const trade of trades) replay.ingest(trade);
  return replay;
}

test("population schedules every governed offset once, with batch-equivalent abstentions and outcomes", () => {
  const report = sample().finish();
  assert.equal(report.decisions.length, 105);
  assert.equal(
    report.decisions.filter((item) => item.signalType === "FIVE_MINUTE_EARLY_DIRECTION")
      .length,
    9,
  );
  assert.equal(
    report.decisions.filter((item) => item.signalType === "FIVE_MINUTE_REVERSAL")
      .length,
    57,
  );
  assert.equal(
    report.decisions.filter((item) => item.signalType === "FIFTEEN_MINUTE_REVERSAL")
      .length,
    39,
  );
  assert.equal(new Set(report.decisions.map((item) => item.id)).size, 105);
  assert.equal(report.outcomes.length, 7);
  for (const item of report.decisions)
    assert.deepEqual(item.decision, buildResearchDecision({ ...item, trades }));
  for (const item of report.outcomes)
    assert.deepEqual(
      item.outcome,
      buildResearchOutcome({ ...item, observedThrough: iso(900_000), trades }),
    );
  assert.equal(report.prospectiveEvidenceEligible, false);
  assert.equal(report.modelLoaded, false);
});

test("missing receipts still generate every scheduled abstention, including the terminal cutoff", () => {
  const replay = new ResearchPopulationReplay(iso(1_000), iso(45_000));
  replay.ingest(trades[1]!);
  const report = replay.finish();
  assert.equal(report.decisions.length, 6);
  assert.ok(report.decisions.every((item) => item.decision.status === "ABSTAIN"));
  assert.equal(report.decisions.at(-1)!.decisionAt, iso(45_000));
  assert.ok(report.outcomes.every((item) => item.outcome.status === "ABSTAIN"));
});

test("all targets produce batch-equivalent features after real warm-up, with no synthetic fills", () => {
  const history: ResearchTrade[] = Array.from({ length: 88 }, (_, index) => {
    const offset = Math.floor(index / 2) * 300_000 + (index % 2) * 1_000;
    return {
      ...trades[0]!,
      tradeId: String(index + 1),
      eventAt: iso(offset - (index === 0 ? 1 : 0)).replace("Z", "000Z"),
      receivedAt: iso(offset),
      price: String(100000 + index),
    };
  });
  const replay = new ResearchPopulationReplay(iso(0), iso(12_960_000));
  for (const trade of history) replay.ingest(trade);
  const report = replay.finish();
  for (const signalType of [
    "FIVE_MINUTE_EARLY_DIRECTION",
    "FIVE_MINUTE_REVERSAL",
    "FIFTEEN_MINUTE_REVERSAL",
  ]) {
    const item = [...report.decisions]
      .reverse()
      .find((item) => item.signalType === signalType);
    assert.ok(item);
    assert.equal(item.decision.status, "FEATURES");
    assert.deepEqual(
      item.decision,
      buildResearchDecision({ ...item, trades: history }),
    );
    if (item.decision.status === "FEATURES") assert.equal(item.id, item.decision.id);
  }
});

test("empty target windows remain explicit outcomes in the population", () => {
  const history = [trades[0]!, { ...trades.at(-1)!, tradeId: "2" }];
  const replay = new ResearchPopulationReplay(iso(0), iso(901_000));
  for (const trade of history) replay.ingest(trade);
  const result = replay.finish();
  const target = result.outcomes.find(
    (item) =>
      item.signalType === "FIVE_MINUTE_REVERSAL" && item.windowStart === iso(300_000),
  );
  assert.deepEqual(target?.outcome, {
    status: "ABSTAIN",
    reason: "EMPTY_TARGET_WINDOW",
    productionEligible: false,
  });
});

test("replay permanently rejects gaps and protects finished results", () => {
  const broken = new ResearchPopulationReplay(iso(0), iso(900_000));
  broken.ingest(trades[0]!);
  assert.throws(() => broken.ingest(trades[2]!));
  assert.throws(() => broken.ingest(trades[1]!));
  assert.throws(() => broken.finish());
  const replay = sample();
  const before = replay.finish();
  before.decisions[0]!.id = "changed";
  assert.notEqual(replay.finish().decisions[0]!.id, "changed");
  assert.throws(() => replay.ingest(trades.at(-1)!));
  assert.throws(() => new ResearchPopulationReplay(iso(0), iso(14_400_001)));
  assert.throws(() => new ResearchPopulationReplay(iso(0), iso(0)));
});

test("durable reports are exclusive, source-bound, and reject changed or incomplete evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "flippars-population-"));
  const repository = join(root, "repo");
  // captureParent requires an existing repository path; this synthetic root is
  // separate from the external evidence parent, just as in operator use.
  await mkdir(repository);
  const source = {
    sessionId: "12345678-1234-4234-8234-123456789012",
    fileSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
  try {
    const report = sample().finish();
    const implementation = Object.fromEntries(
      REPLAY_IMPLEMENTATION_MODULES.map((name) => [name, "c".repeat(64)]),
    );
    const first = await writeReplayEvidence(
      root,
      repository,
      report,
      source,
      implementation,
    );
    const second = await writeReplayEvidence(
      root,
      repository,
      report,
      source,
      implementation,
    );
    assert.notEqual(first, second);
    const evidence = await verifyReplayEvidence(first);
    assert.equal(evidence.integrityVerified, true);
    assert.deepEqual(evidence.source, source);
    assert.equal(evidence.decisionCount, 105);
    await writeFile(join(first, "report.json"), "{}\n");
    await assert.rejects(verifyReplayEvidence(first));
    const manifest = JSON.parse(
      await readFile(join(second, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    manifest["decisionCount"] = 104;
    await writeFile(join(second, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(verifyReplayEvidence(second));
    manifest["decisionCount"] = 105;
    manifest["completionState"] = "INCOMPLETE";
    await writeFile(join(second, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(verifyReplayEvidence(second));
    await assert.rejects(
      writeReplayEvidence(repository, repository, report, source, implementation),
    );
    await assert.rejects(writeReplayEvidence(root, repository, report, source, {}));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
