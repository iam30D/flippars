import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { projectPacket } from "../src/research/capture-domain.js";
import { verifyCapture } from "../src/research/capture-verifier.js";
import { CaptureWriter } from "../src/research/capture-writer.js";
import { auditCaptureDecisions } from "../src/research/capture-decision-audit.js";
import { LONG_CAPTURE_MODULES } from "../src/research/capture-revisions.js";
import { auditCaptureQuality } from "../src/research/capture-quality-audit.js";
import { ISOLATED_CAPTURE_MODULES } from "../src/research/capture-isolation-profile.js";

const endpoints = [
  {
    source: "binance",
    url: "wss://data-stream.binance.vision/ws/btcusdt@trade?timeUnit=MICROSECOND",
  },
  {
    source: "coinbase",
    url: "wss://ws-feed.exchange.coinbase.com",
    subscription: {
      type: "subscribe",
      product_ids: ["BTC-USD", "USDT-USD"],
      channels: ["ticker", "heartbeat"],
    },
  },
  {
    source: "kraken",
    url: "wss://ws.kraken.com/v2",
    subscription: {
      method: "subscribe",
      params: {
        channel: "ticker",
        symbol: ["BTC/USD", "USDT/USD"],
        snapshot: true,
        event_trigger: "bbo",
      },
    },
  },
];
const sessionId = "12345678-1234-4234-8234-123456789012";

test("verified capture feeds bounded replay and preserves research-only semantics", async () => {
  const root = fixture();
  try {
    const result = await auditCaptureDecisions(root);
    assert.equal(result["tradeCount"], 1);
    assert.equal(result["observedThrough"], "2026-08-01T00:00:01.000Z");
    assert.equal(result["captureSessionId"], sessionId);
    assert.equal(result["productionEligible"], false);
    assert.equal(result["modelLoaded"], false);
    assert.equal(result["guardVerdict"], "UNASSESSED");
    const quality = await auditCaptureQuality(root);
    assert.equal(quality.sources["binance"]!.count, 1);
    assert.equal(quality.instruments["coinbase:USDT-USD"]!.count, 0);
    assert.equal(quality.captureSessionId, sessionId);
    assert.equal(quality.guardVerdict, "UNASSESSED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(
  mutate: (records: Array<Record<string, unknown>>) => void = () => undefined,
  dataPacketCounts = { binance: 1, coinbase: 1, kraken: 1 },
  revision: 1 | 2 | 3 = 1,
): string {
  const root = mkdtempSync(join(tmpdir(), "flippars-verifier-test-"));
  const settings = { outputParent: tmpdir(), seconds: 10, maxMiB: 1 };
  const rawTrade = JSON.stringify({
    e: "trade",
    s: "BTCUSDT",
    t: 100,
    E: 1_788_000_000_123_457,
    T: 1_788_000_000_123_456,
    p: "100000.12345678",
    q: "0.00000001",
    m: false,
  });
  const rawCoinbase = JSON.stringify({
    type: "ticker",
    product_id: "BTC-USD",
    best_bid: "99999",
    best_ask: "100001",
    price: "100000",
    sequence: 1,
    time: "2026-08-01T00:00:00.000000Z",
  });
  const rawKraken =
    '{"channel":"ticker","type":"snapshot","data":[{"symbol":"USDT/USD","bid":0.99999999999999999,"ask":1.0001}]}';
  const common = {
    sessionId,
    receivedAt: "2026-08-01T00:00:01.000Z",
    receivedMonotonicNs: "1000000000",
  };
  const records: Array<Record<string, unknown>> = [
    {
      ...common,
      kind: "SESSION_START",
      ...(revision !== 1
        ? { collectorRevision: `flippars.market-capture-manifest/${revision}` }
        : {}),
      endpoints,
      settings,
      scope: "RESEARCH_CAPTURE_ONLY",
    },
    ...(["binance", "coinbase", "kraken"] as const).map((source) => ({
      ...common,
      kind: "CONNECTED",
      source,
    })),
    ...(
      [
        ["binance", rawTrade],
        ["coinbase", rawCoinbase],
        ["kraken", rawKraken],
      ] as const
    ).map(([source, raw]) => ({
      ...common,
      source,
      ...projectPacket(source, raw),
      raw,
    })),
    {
      ...common,
      kind: "SESSION_END",
      reason: "DURATION_REACHED",
      receivedAt: "2026-08-01T00:00:10.001Z",
      receivedMonotonicNs: "10001000000",
    },
  ];
  mutate(records);
  const writer = new CaptureWriter(join(root, "events.jsonl"), 1_048_576);
  for (const record of records) writer.append(record);
  const evidence = writer.close();
  const extension = extname(fileURLToPath(import.meta.url));
  const codeSha256 = Object.fromEntries(
    (revision === 3
      ? ISOLATED_CAPTURE_MODULES
      : revision === 2
        ? LONG_CAPTURE_MODULES
        : ["capture-cli", "capture-domain", "capture-writer"]
    ).map((name) => [
      name,
      createHash("sha256")
        .update(
          readFileSync(
            fileURLToPath(
              new URL(`../src/research/${name}${extension}`, import.meta.url),
            ),
          ),
        )
        .digest("hex"),
    ]),
  );
  const unavailableGuards = (["coinbase", "kraken"] as const).filter(
    (name) =>
      records.some(
        (record) => record["kind"] === "GUARD_UNAVAILABLE" && record["source"] === name,
      ) || !dataPacketCounts[name],
  );
  const manifest = {
    schemaVersion: `flippars.market-capture-manifest/${revision}`,
    sessionId,
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:00:10.010Z",
    scope: "RESEARCH_CAPTURE_ONLY",
    completionState:
      revision === 3 && unavailableGuards.length
        ? "CAPTURED_DEGRADED_GUARDS"
        : "CAPTURED",
    ...(revision === 3 ? { unavailableGuards } : {}),
    failure: null,
    productionEligible: false,
    guardVerdict: "UNASSESSED",
    settings,
    endpoints,
    dataPacketCounts,
    ...evidence,
    codeSha256,
    limitations: ["Synthetic research fixture"],
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return root;
}

test("streaming verification recomputes integrity and reports raw instrument coverage", async () => {
  const root = fixture();
  try {
    const result = await verifyCapture(root);
    assert.equal(result["verified"], true);
    assert.equal(result["productionEligible"], false);
    assert.equal(result["guardVerdict"], "UNASSESSED");
    assert.deepEqual(result["observedInstruments"], {
      binance: ["BTCUSDT"],
      coinbase: ["BTC-USD"],
      kraken: ["USDT/USD"],
    });
    assert.equal(result["records"], 8);
    assert.match(String(result["firstTradeAt"]), /\.123456Z$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("valid hashes cannot hide contradictory raw projections, scope, ordering, or duration", async () => {
  const mutations: Array<(records: Array<Record<string, unknown>>) => void> = [
    (records) => {
      records[4]!["trade"] = { price: "99999" };
    },
    (records) => {
      records[4]!["eventId"] = "wrong";
    },
    (records) => {
      records[4]!["sessionId"] = "00000000-0000-4000-8000-000000000000";
    },
    (records) => {
      records[4]!["receivedMonotonicNs"] = "0";
    },
    (records) => {
      records[4]!["receivedAt"] = "2026-07-31T00:00:00.000Z";
    },
    (records) => {
      records[7]!["receivedMonotonicNs"] = "2000000000";
    },
    (records) => {
      records[7]!["reason"] = "OPERATOR_INTERRUPTED";
    },
    (records) => {
      records[0]!["scope"] = "PRODUCTION";
    },
    (records) => {
      records[3]!["source"] = "coinbase";
    },
    (records) => {
      records.push(records[6]!);
    },
  ];
  for (const mutate of mutations) {
    const root = fixture(mutate);
    try {
      await assert.rejects(verifyCapture(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("wrong file evidence, source-code binding, and incomplete sessions fail closed", async () => {
  for (const [key, value] of [
    ["fileSha256", "0".repeat(64)],
    ["finalSha256", "0".repeat(64)],
    ["records", 9],
    ["bytes", 1],
    ["productionEligible", true],
    ["completionState", "INCOMPLETE"],
    ["codeSha256", {}],
    ["dataPacketCounts", { binance: 2, coinbase: 1, kraken: 1 }],
  ] as const) {
    const root = fixture();
    try {
      const path = join(root, "manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      manifest[key] = value;
      writeFileSync(path, JSON.stringify(manifest));
      await assert.rejects(verifyCapture(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("truncation and byte tampering are rejected", async () => {
  for (const change of [
    (bytes: Buffer) => bytes.subarray(0, bytes.length - 1),
    (bytes: Buffer) => Buffer.from(bytes.toString().replace("binance", "b1nance")),
  ]) {
    const root = fixture();
    try {
      const path = join(root, "events.jsonl");
      const changed = change(readFileSync(path));
      writeFileSync(path, changed);
      // Rebinding file metadata must not bypass the chain/semantic checks.
      const manifestPath = join(root, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      manifest["bytes"] = changed.length;
      manifest["fileSha256"] = createHash("sha256").update(changed).digest("hex");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      await assert.rejects(verifyCapture(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a fully rehashed trade-ID gap cannot pass semantic verification", async () => {
  const root = fixture(
    (records) => {
      const prior = records[4]!;
      const packet = JSON.parse(String(prior["raw"])) as Record<string, unknown>;
      packet["t"] = 102;
      const raw = JSON.stringify(packet);
      records.splice(5, 0, { ...prior, ...projectPacket("binance", raw), raw });
    },
    { binance: 2, coinbase: 1, kraken: 1 },
  );
  try {
    await assert.rejects(verifyCapture(root), /TRADE_ID_DISCONTINUITY/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("revision two verifies its separate collector hashes and relative clock contract", async () => {
  const root = fixture(undefined, undefined, 2);
  try {
    const result = await verifyCapture(root);
    assert.equal(result["captureRevision"], "flippars.market-capture-manifest/2");
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const hashes = manifest["codeSha256"] as Record<string, string>;
    manifest["schemaVersion"] = "flippars.market-capture-manifest/1";
    manifest["codeSha256"] = Object.fromEntries(
      ["capture-cli", "capture-domain", "capture-writer"].map((name) => [
        name,
        hashes[name],
      ]),
    );
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyCapture(root), /Invalid session start/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const jumped = fixture(
    (records) => {
      records[0]!["receivedAt"] = "2026-08-01T00:00:03.001Z";
    },
    undefined,
    2,
  );
  try {
    await assert.rejects(verifyCapture(jumped), /CLOCK_DISCONTINUITY/u);
  } finally {
    rmSync(jumped, { recursive: true, force: true });
  }
});

test("revision two rejects a rehashed complete session with a long source-data gap", async () => {
  const root = fixture(
    (records) => {
      records[7]!["receivedAt"] = "2026-08-01T00:00:34.000Z";
      records[7]!["receivedMonotonicNs"] = "34000000000";
    },
    undefined,
    2,
  );
  try {
    const path = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    manifest["endedAt"] = "2026-08-01T00:00:34.010Z";
    writeFileSync(path, JSON.stringify(manifest));
    await assert.rejects(verifyCapture(root), /source liveness discontinuity/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("revision three rejects hidden guard outages, reconnects and post-retirement data", async () => {
  for (const mode of ["hidden", "reconnect", "late-data"] as const) {
    const root = fixture(
      (records) => {
        const prior = records[6]!;
        records.splice(7, 0, {
          sessionId,
          receivedAt: prior["receivedAt"],
          receivedMonotonicNs: prior["receivedMonotonicNs"],
          kind: "GUARD_UNAVAILABLE",
          source: "kraken",
          reason: "DISCONNECTED",
          closeCode: 1001,
        });
        if (mode === "reconnect")
          records.splice(8, 0, {
            sessionId,
            receivedAt: prior["receivedAt"],
            receivedMonotonicNs: prior["receivedMonotonicNs"],
            kind: "CONNECTED",
            source: "kraken",
          });
        if (mode === "late-data") records.splice(8, 0, { ...prior });
      },
      { binance: 1, coinbase: 1, kraken: mode === "late-data" ? 2 : 1 },
      3,
    );
    try {
      if (mode === "hidden") {
        const path = join(root, "manifest.json");
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<
          string,
          unknown
        >;
        manifest["completionState"] = "CAPTURED";
        manifest["unavailableGuards"] = [];
        writeFileSync(path, JSON.stringify(manifest));
      }
      await assert.rejects(verifyCapture(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
