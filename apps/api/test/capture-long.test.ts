import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { runLongCapture } from "../src/research/capture-session.js";
import { verifyCapture } from "../src/research/capture-verifier.js";
import { replayCapture } from "../src/research/population-replay-cli.js";
import {
  runObservedCapture,
  verifyObservedRuntime,
} from "../src/research/capture-observed-cli.js";

const rawTrade = (id: number) =>
  JSON.stringify({
    e: "trade",
    s: "BTCUSDT",
    t: id,
    E: 1_788_000_000_123_457,
    T: 1_788_000_000_123_456,
    p: "100000.12345678",
    q: "0.001",
    m: false,
  });

async function localCapture(
  mode: "success" | "gap" | "invalid-utf8",
  check: (result: Record<string, unknown>) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "flippars-long-test-"));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.on("connection", (socket, request) => {
    if (request.url?.includes("binance")) {
      if (mode === "invalid-utf8") socket.send(Buffer.from([255]), { binary: false });
      else {
        socket.send(rawTrade(100));
        if (mode === "gap") socket.send(rawTrade(102));
      }
    } else if (request.url?.includes("coinbase"))
      socket.send(
        JSON.stringify({
          type: "ticker",
          product_id: "BTC-USD",
          best_bid: "99999",
          best_ask: "100001",
          price: "100000",
          sequence: 1,
          time: "2026-08-01T00:00:00.123456Z",
        }),
      );
    else
      socket.send(
        '{"channel":"ticker","type":"snapshot","data":[{"symbol":"BTC/USD","bid":99999,"ask":100001}]}',
      );
  });
  try {
    const options = { outputParent: root, seconds: 10, maxMiB: 1 };
    const connect = (url: string) =>
      new WebSocket(`ws://127.0.0.1:${address.port}/${new URL(url).hostname}`);
    const result =
      mode === "success"
        ? await runObservedCapture(options, (settings) =>
            runLongCapture(settings, connect),
          )
        : await runLongCapture(options, connect);
    await check(result);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test("revision-two socket capture verifies and feeds complete research replay", async () => {
  await localCapture("success", async (result) => {
    assert.equal(result["completionState"], "CAPTURED");
    assert.equal(result["schemaVersion"], "flippars.market-capture-manifest/2");
    const root = String(result["root"]);
    const verification = await verifyCapture(root);
    assert.equal(verification["verified"], true);
    const witness = await verifyObservedRuntime(root);
    assert.equal(witness.integrityVerified, true);
    assert.equal(witness.captureCompletionState, "CAPTURED");
    const replay = await replayCapture(root);
    assert.equal(replay.report.tradeCount, 1);
    assert.equal(replay.report.productionEligible, false);
    assert.equal(replay.report.prospectiveEvidenceEligible, false);
    assert.match(
      readFileSync(join(root, "events.jsonl"), "utf8"),
      /collectorRevision/u,
    );
  });
});

test("long capture keeps gaps and malformed UTF-8 incomplete without reconnect", async () => {
  for (const mode of ["gap", "invalid-utf8"] as const)
    await localCapture(mode, async (result) => {
      assert.equal(result["completionState"], "INCOMPLETE");
      await assert.rejects(verifyCapture(String(result["root"])));
    });
});
