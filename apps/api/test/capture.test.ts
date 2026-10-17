import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import {
  microsecondTimestamp,
  projectPacket,
  TradeContinuity,
} from "../src/research/capture-domain.js";
import { captureParent, runCapture } from "../src/research/capture-cli.js";
import { CaptureWriter } from "../src/research/capture-writer.js";

function trade(id = 100, time = 1_788_000_000_123_456): string {
  return JSON.stringify({
    e: "trade",
    s: "BTCUSDT",
    t: id,
    E: time + 10,
    T: time,
    p: "100000.12345678",
    q: "0.00000001",
    m: true,
  });
}

test("trade normalization preserves exact decimals, IDs, and microseconds", () => {
  const projected = projectPacket("binance", trade());
  assert.equal(projected.trade?.price, "100000.12345678");
  assert.equal(projected.trade?.quantity, "0.00000001");
  assert.equal(projected.trade?.tradeId, "100");
  assert.match(projected.trade?.eventAt ?? "", /\.123456Z$/u);
  assert.equal(projected.eventId, projectPacket("binance", trade()).eventId);
  assert.throws(() => microsecondTimestamp(1_788_000_000_123));
  assert.throws(() => projectPacket("binance", trade(Number.MAX_SAFE_INTEGER + 1)));
  assert.throws(() => projectPacket("binance", trade().replace('"0.00000001"', '"0"')));
});

test("trade gaps, duplicates, out-of-order trades, and wrong units fail closed", () => {
  for (const [nextId, nextTime] of [
    [102, 1_788_000_000_123_457],
    [100, 1_788_000_000_123_457],
    [101, 1_788_000_000_123_455],
  ] as const) {
    const tracker = new TradeContinuity();
    tracker.accept(projectPacket("binance", trade()).trade!);
    assert.throws(() =>
      tracker.accept(projectPacket("binance", trade(nextId, nextTime)).trade!),
    );
    tracker.accept(projectPacket("binance", trade(101)).trade!);
  }
});

test("unknown messages are explicit and malformed known messages fail", () => {
  assert.equal(projectPacket("binance", '{"e":"new-message"}').kind, "UNKNOWN");
  assert.equal(projectPacket("kraken", '{"channel":"heartbeat"}').kind, "CONTROL");
  for (const raw of ["[]", "null", "not json", '{"e":"trade"}']) {
    assert.throws(() => projectPacket("binance", raw));
  }
  assert.throws(() =>
    projectPacket(
      "coinbase",
      '{"type":"error","message":"private diagnostic omitted"}',
    ),
  );
  assert.throws(() => projectPacket("kraken", '{"success":false}'));
  assert.throws(() => projectPacket("binance", '{"e":"serverShutdown"}'));
});

test("hash-linked capture is exclusive, bounded, and never production eligible", () => {
  const root = mkdtempSync(join(tmpdir(), "flippars-capture-test-"));
  try {
    const path = join(root, "events.jsonl");
    const writer = new CaptureWriter(path, 2_048);
    writer.append({ kind: "TRADE", raw: trade() });
    assert.throws(
      () => writer.append({ raw: "x".repeat(2_048) }),
      /CAPTURE_BYTE_LIMIT/u,
    );
    writer.append({ kind: "SESSION_END" });
    const evidence = writer.close();
    assert.deepEqual(evidence, writer.close());
    assert.throws(() => writer.append({}));
    assert.throws(() => new CaptureWriter(path, 2_048));
    const bytes = readFileSync(path);
    assert.equal(evidence.bytes, bytes.length);
    assert.equal(evidence.fileSha256, createHash("sha256").update(bytes).digest("hex"));
    let previous = "0".repeat(64);
    for (const line of bytes.toString().trim().split("\n")) {
      const envelope = JSON.parse(line) as { payload: string; sha256: string };
      assert.equal(
        createHash("sha256").update(envelope.payload).digest("hex"),
        envelope.sha256,
      );
      const payload = JSON.parse(envelope.payload) as {
        previousSha256: string;
        productionEligible: boolean;
        guardVerdict: string;
      };
      assert.equal(payload.previousSha256, previous);
      assert.equal(payload.productionEligible, false);
      assert.equal(payload.guardVerdict, "UNASSESSED");
      previous = envelope.sha256;
    }
    assert.equal(evidence.finalSha256, previous);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output paths reject the repository and sibling-prefix tricks", () => {
  const root = mkdtempSync(join(tmpdir(), "flippars-path-test-"));
  try {
    const repo = join(root, "repo");
    const child = join(repo, "..private");
    mkdirSync(child, { recursive: true });
    assert.throws(() => captureParent(repo, repo));
    assert.throws(() => captureParent(child, repo));
    assert.equal(captureParent(root, repo), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("socket-level trade gap preserves rejection and incomplete evidence without reconnect", async () => {
  const root = mkdtempSync(join(tmpdir(), "flippars-socket-test-"));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.on("connection", (socket) => {
    socket.send(trade());
    socket.send(trade(102));
  });
  try {
    const result = await runCapture(
      { outputParent: root, seconds: 10, maxMiB: 1 },
      () => new WebSocket(`ws://127.0.0.1:${address.port}`),
    );
    assert.equal(result["completionState"], "INCOMPLETE");
    assert.equal(result["failure"], "TRADE_ID_DISCONTINUITY");
    const events = readFileSync(join(String(result["root"]), "events.jsonl"), "utf8");
    assert.match(events, /REJECTED_PACKET/u);
    assert.match(events, /TRADE_ID_DISCONTINUITY/u);
    assert.equal(result["productionEligible"], false);
    assert.ok(readFileSync(join(String(result["root"]), "manifest.json"), "utf8"));
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded local three-source capture completes with unassessed guard inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "flippars-complete-test-"));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.on("connection", (socket, request) => {
    if (request.url?.includes("binance")) socket.send(trade());
    else if (request.url?.includes("coinbase"))
      socket.send(
        JSON.stringify({
          type: "ticker",
          product_id: "BTC-USD",
          best_bid: "99999.1",
          best_ask: "100001.1",
          price: "100000",
          sequence: 1,
          time: "2026-08-01T00:00:00.123456Z",
        }),
      );
    else
      socket.send(
        '{"channel":"ticker","type":"snapshot","data":[{"symbol":"BTC/USD","bid":99999.1234567890123,"ask":100001}]}',
      );
  });
  try {
    const result = await runCapture(
      { outputParent: root, seconds: 10, maxMiB: 1 },
      (url) => new WebSocket(`ws://127.0.0.1:${address.port}/${new URL(url).hostname}`),
    );
    assert.equal(result["completionState"], "CAPTURED");
    assert.equal(result["guardVerdict"], "UNASSESSED");
    assert.deepEqual(result["dataPacketCounts"], {
      binance: 1,
      coinbase: 1,
      kraken: 1,
    });
    const bytes = readFileSync(join(String(result["root"]), "events.jsonl"));
    assert.match(bytes.toString(), /99999\.1234567890123/u);
    assert.equal(
      result["fileSha256"],
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(result["productionEligible"], false);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
