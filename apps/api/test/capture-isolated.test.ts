import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { runIsolatedCapture } from "../src/research/capture-isolated-session.js";
import {
  runObservedCapture,
  verifyObservedRuntime,
} from "../src/research/capture-observed-cli.js";
import { verifyCapture } from "../src/research/capture-verifier.js";
import { replayCapture } from "../src/research/population-replay-cli.js";
import { auditCaptureQuality } from "../src/research/capture-quality-audit.js";

const trade = (id: number) =>
  JSON.stringify({
    e: "trade",
    s: "BTCUSDT",
    t: id,
    E: 1_788_000_000_123_457 + id,
    T: 1_788_000_000_123_456 + id,
    p: "100000",
    q: "0.01",
    m: false,
  });

async function capture(
  mode: "complete" | "guard-close" | "trade-gap" | "binance-close",
  check: (result: Record<string, unknown>) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "flippars-isolation-test-"));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const timers: Array<NodeJS.Timeout> = [];
  server.on("connection", (socket, request) => {
    if (request.url?.includes("binance")) {
      socket.send(trade(100));
      if (mode === "trade-gap") socket.send(trade(102));
      else if (mode === "binance-close") socket.close(1001);
      else
        timers.push(
          setTimeout(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(trade(101));
          }, 500),
        );
    } else if (request.url?.includes("coinbase"))
      socket.send(
        JSON.stringify({
          type: "ticker",
          product_id: "BTC-USD",
          best_bid: "99999",
          best_ask: "100001",
          price: "100000",
          sequence: 1,
          time: "2026-08-01T00:00:00.000000Z",
        }),
      );
    else {
      if (mode === "guard-close") {
        socket.close(1001);
        return;
      }
      socket.send(
        '{"channel":"ticker","type":"snapshot","data":[{"symbol":"BTC/USD","bid":99999,"ask":100001}]}',
      );
    }
  });
  try {
    const result = await runObservedCapture(
      { outputParent: root, seconds: 10, maxMiB: 1 },
      (settings) =>
        runIsolatedCapture(
          settings,
          (url) =>
            new WebSocket(`ws://127.0.0.1:${address.port}/${new URL(url).hostname}`),
        ),
    );
    await check(result);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test("guard disconnection preserves uninterrupted target history and explicit degraded evidence", async () => {
  await capture("guard-close", async (result) => {
    assert.equal(result["completionState"], "CAPTURED_DEGRADED_GUARDS");
    const root = String(result["root"]);
    const verified = await verifyCapture(root);
    assert.deepEqual(verified["unavailableGuards"], ["kraken"]);
    assert.equal((verified["dataPacketCounts"] as Record<string, number>)["kraken"], 0);
    assert.equal(
      (await verifyObservedRuntime(root)).captureCompletionState,
      "CAPTURED_DEGRADED_GUARDS",
    );
    const replay = await replayCapture(root);
    assert.equal(replay.report.tradeCount, 2);
    assert.equal(replay.report.productionEligible, false);
    assert.equal(replay.source.captureCompletionState, "CAPTURED_DEGRADED_GUARDS");
    assert.deepEqual(replay.source.unavailableGuards, ["kraken"]);
    assert.equal((await auditCaptureQuality(root)).sources["binance"]!.count, 2);
  });
});

test("uninterrupted revision-three capture keeps the normal completion state", async () => {
  await capture("complete", async (result) => {
    assert.equal(result["completionState"], "CAPTURED");
    assert.deepEqual(
      (await verifyCapture(String(result["root"])))["unavailableGuards"],
      [],
    );
  });
});

test("target trade gaps and Binance disconnection still make the entire capture incomplete", async () => {
  for (const mode of ["trade-gap", "binance-close"] as const)
    await capture(mode, async (result) => {
      assert.equal(result["completionState"], "INCOMPLETE");
      await assert.rejects(verifyCapture(String(result["root"])));
    });
});
