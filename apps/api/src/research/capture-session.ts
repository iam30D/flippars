import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { captureParent } from "./capture-cli.js";
import { CaptureClockContinuity } from "./capture-clock.js";
import {
  LONG_CAPTURE_MODULES,
  LongCaptureSettingsSchema,
} from "./capture-revisions.js";

import { projectPacket, TradeContinuity } from "./capture-domain.js";
import type { CaptureSource } from "./capture-domain.js";
import { CaptureWriter } from "./capture-writer.js";

const endpoints: ReadonlyArray<{
  source: CaptureSource;
  url: string;
  subscription?: Readonly<Record<string, unknown>>;
}> = [
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

function repositoryRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 8; index++) {
    if (
      existsSync(join(directory, "AGENTS.md")) &&
      existsSync(join(directory, "package.json"))
    ) {
      return realpathSync(directory);
    }
    directory = dirname(directory);
  }
  throw new Error("Repository root not found");
}

export async function runLongCapture(
  options: {
    outputParent: string;
    seconds: number;
    maxMiB: number;
  },
  connect: (url: string) => WebSocket = (url) =>
    new WebSocket(url, {
      handshakeTimeout: 10_000,
      maxPayload: 65_536,
      perMessageDeflate: false,
    }),
): Promise<Record<string, unknown>> {
  const settings = LongCaptureSettingsSchema.parse(options);
  const parent = captureParent(settings.outputParent, repositoryRoot());
  const sourcePath = fileURLToPath(import.meta.url);
  const codeSha256 = Object.fromEntries(
    LONG_CAPTURE_MODULES.map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(join(dirname(sourcePath), name + extname(sourcePath))))
        .digest("hex"),
    ]),
  );
  const root = mkdtempSync(join(parent, "capture-"));
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  const startedMonotonic = process.hrtime.bigint();
  const clock = new CaptureClockContinuity(startedAt);
  const append = (
    value: Readonly<Record<string, unknown>> & {
      receivedAt: string;
      receivedMonotonicNs: string;
    },
  ): void => {
    clock.accept(value.receivedAt, value.receivedMonotonicNs);
    writer.append(value);
  };
  const writer = new CaptureWriter(
    join(root, "events.jsonl"),
    settings.maxMiB * 1_048_576,
  );
  const continuity = new TradeContinuity();
  const sockets: WebSocket[] = [];
  const lastData = new Map<CaptureSource, bigint>();
  const dataCounts = new Map<CaptureSource, number>();
  const livenessFailure = (): string | null => {
    const now = process.hrtime.bigint();
    for (const { source } of endpoints)
      if (now - (lastData.get(source) ?? startedMonotonic) > 30_000_000_000n)
        return `${source.toUpperCase()}_DATA_TIMEOUT`;
    return null;
  };
  let failure: string | null = null;
  let stopping = false;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolveDone) => {
    finish = resolveDone;
  });
  const record = (value: Readonly<Record<string, unknown>>): void => {
    append({
      sessionId,
      receivedAt: new Date().toISOString(),
      receivedMonotonicNs: String(process.hrtime.bigint() - startedMonotonic),
      ...value,
    });
  };
  const stop = (reason: string | null): void => {
    if (stopping) return;
    stopping = true;
    failure = reason ?? livenessFailure();
    try {
      record({ kind: "SESSION_END", reason: failure ?? "DURATION_REACHED" });
    } catch (error) {
      failure ??=
        error instanceof Error && error.message === "CLOCK_DISCONTINUITY"
          ? "CLOCK_DISCONTINUITY"
          : "CAPTURE_WRITE_FAILED";
    }
    for (const socket of sockets) socket.terminate();
    finish();
  };
  const signalStop = (): void => stop("OPERATOR_INTERRUPTED");
  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);
  const durationTimer = setTimeout(() => stop(null), settings.seconds * 1_000);
  const watchdog = setInterval(() => {
    if (stopping) return;
    try {
      for (const { source } of endpoints) {
        const previous = lastData.get(source) ?? startedMonotonic;
        if (process.hrtime.bigint() - previous > 30_000_000_000n) {
          stop(`${source.toUpperCase()}_DATA_TIMEOUT`);
          return;
        }
      }
      writer.sync();
    } catch {
      stop("CAPTURE_SYNC_FAILED");
    }
  }, 1_000);
  const progress = setInterval(() => {
    const elapsed = Math.floor(
      Number(process.hrtime.bigint() - startedMonotonic) / 1_000_000_000,
    );
    process.stdout.write(
      `Research capture: ${elapsed}/${settings.seconds}s; trade packets=${dataCounts.get("binance") ?? 0}; public signals disabled.\n`,
    );
  }, 30_000);

  try {
    record({
      kind: "SESSION_START",
      collectorRevision: "flippars.market-capture-manifest/2",
      endpoints,
      settings,
      scope: "RESEARCH_CAPTURE_ONLY",
    });
    for (const endpoint of endpoints) {
      if (stopping) break;
      const socket = connect(endpoint.url);
      sockets.push(socket);
      socket.on("open", () => {
        if (stopping) return;
        try {
          record({ source: endpoint.source, kind: "CONNECTED" });
          if (endpoint.subscription) socket.send(JSON.stringify(endpoint.subscription));
        } catch {
          stop("CAPTURE_WRITE_FAILED");
        }
      });
      socket.on("message", (bytes, binary) => {
        if (stopping) return;
        const receivedAt = new Date().toISOString();
        const receivedMonotonicNs = String(process.hrtime.bigint() - startedMonotonic);
        const buffer = Array.isArray(bytes)
          ? Buffer.concat(bytes)
          : Buffer.isBuffer(bytes)
            ? bytes
            : Buffer.from(bytes);
        let raw = "";
        try {
          const stale = livenessFailure();
          if (stale) throw new Error(stale);
          raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
          if (binary) throw new Error("Binary packet unsupported");
          const projection = projectPacket(endpoint.source, raw);
          if (projection.trade) continuity.accept(projection.trade);
          append({
            sessionId,
            receivedAt,
            receivedMonotonicNs,
            source: endpoint.source,
            ...projection,
            raw,
          });
          if (projection.kind === "TRADE" || projection.kind === "GUARD_INPUT") {
            lastData.set(endpoint.source, process.hrtime.bigint());
            dataCounts.set(endpoint.source, (dataCounts.get(endpoint.source) ?? 0) + 1);
          }
        } catch (error) {
          const reason =
            error instanceof Error &&
            [
              "TRADE_ID_DISCONTINUITY",
              "TRADE_TIME_REGRESSION",
              "CAPTURE_BYTE_LIMIT",
              "CLOCK_DISCONTINUITY",
              "BINANCE_DATA_TIMEOUT",
              "COINBASE_DATA_TIMEOUT",
              "KRAKEN_DATA_TIMEOUT",
              "Provider shutdown",
              "Provider rejected subscription",
            ].includes(error.message)
              ? error.message
              : "INVALID_PACKET_OR_WRITE_FAILURE";
          try {
            append({
              sessionId,
              source: endpoint.source,
              kind: "REJECTED_PACKET",
              reason,
              receivedAt,
              receivedMonotonicNs,
              raw,
            });
          } catch {
            /* The terminal manifest still identifies an incomplete capture. */
          }
          stop(reason);
        }
      });
      socket.on("error", () =>
        stop(`${endpoint.source.toUpperCase()}_CONNECTION_ERROR`),
      );
      socket.on("close", () => stop(`${endpoint.source.toUpperCase()}_DISCONNECTED`));
    }
    await done;
  } catch {
    stop("CAPTURE_START_FAILED");
  } finally {
    clearTimeout(durationTimer);
    clearInterval(watchdog);
    clearInterval(progress);
    process.removeListener("SIGINT", signalStop);
    process.removeListener("SIGTERM", signalStop);
    for (const socket of sockets) socket.terminate();
  }
  const evidence = writer.close();
  if (endpoints.some(({ source }) => !dataCounts.get(source)))
    failure ??= "REQUIRED_SOURCE_DATA_MISSING";
  const manifest = {
    schemaVersion: "flippars.market-capture-manifest/2",
    sessionId,
    startedAt,
    endedAt: new Date().toISOString(),
    scope: "RESEARCH_CAPTURE_ONLY",
    completionState: failure === null ? "CAPTURED" : "INCOMPLETE",
    failure,
    productionEligible: false,
    guardVerdict: "UNASSESSED",
    settings,
    endpoints,
    dataPacketCounts: Object.fromEntries(dataCounts),
    ...evidence,
    codeSha256,
    limitations: [
      "No model scoring or prospective shadow validation occurred.",
      "Guard inputs are raw observations, not validated quorum or stablecoin health.",
      "No automatic reconnect, backfill, continuity repair, or full interval coverage claim.",
      "Receive time is the local application callback time; wall clock synchronization is not established.",
      "Relative wall/monotonic consistency is bounded to one second; this does not establish absolute clock accuracy.",
    ],
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return { root, ...manifest };
}
