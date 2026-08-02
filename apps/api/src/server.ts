import { buildApi } from "./app.js";
import { loadConfig } from "./config.js";
import { loadLocalEnvironment } from "./environment.js";
import { BinanceFeed } from "./market/binance.js";
import { CoinbaseFeed } from "./market/coinbase.js";
import { MarketCoordinator } from "./market/coordinator.js";
import type { MarketFeed } from "./market/feed.js";
import { KrakenFeed } from "./market/kraken.js";
import { SimulatedMarketFeed } from "./market/simulated.js";
import { MetricsRegistry } from "./metrics.js";
import {
  FakeApnsClient,
  TokenApnsClient,
  type ApnsClient,
} from "./notifications/apns.js";
import { NotificationDispatcher } from "./notifications/dispatcher.js";
import { InMemoryRepository } from "./repositories/memory.js";
import { PostgresRepository } from "./repositories/postgres.js";
import type { Repository } from "./repositories/repository.js";
import { CoreModelRuntime, DisabledForecastProvider } from "./signals/core-runtime.js";
import { OutcomeEvaluator } from "./signals/outcomes.js";
import { SafetyController } from "./signals/safety.js";
import { SignalWorker } from "./signals/worker.js";

loadLocalEnvironment();
const config = loadConfig();
const metrics = new MetricsRegistry();
const repository = createRepository();
const feeds = createFeeds();
const dataMode = config.market.feeds.includes("simulated") ? "simulation" : "live";
const market = new MarketCoordinator(feeds, repository, metrics, {
  staleAfterMs: config.market.staleAfterMs,
  minimumHealthyVenues: config.market.minimumHealthyVenues,
  maximumUsdtDeviationBps: config.market.maximumUsdtDeviationBps,
  retentionDays: config.market.retentionDays,
  dataMode,
});
const safety = new SafetyController(config.signals.enabled);
const modelRuntime = new CoreModelRuntime(new DisabledForecastProvider(), {
  confidenceThresholds: {
    FIVE_MINUTE_REVERSAL: config.signals.confidenceThreshold,
    FIFTEEN_MINUTE_REVERSAL: config.signals.confidenceThreshold,
    FIVE_MINUTE_EARLY_DIRECTION: config.signals.confidenceThreshold,
  },
  deadbandBps: config.signals.neutralBandBps,
});
const signalWorker = new SignalWorker(
  market,
  repository,
  modelRuntime,
  safety,
  metrics,
  {
    confidenceThreshold: config.signals.confidenceThreshold,
    minimumLeadTimeMs: config.signals.minimumLeadTimeMs,
    dataMode,
  },
);
const outcomeEvaluator = new OutcomeEvaluator(
  repository,
  metrics,
  config.signals.neutralBandBps,
  5_000,
  (signal) => market.emit("outcome", signal),
);
const apns = createApnsClient();
const notificationDispatcher = config.apns.enabled
  ? new NotificationDispatcher(market, repository, apns, metrics)
  : undefined;

const app = await buildApi({
  config,
  repository,
  market,
  metrics,
  safety,
  signalWorker,
  outcomeEvaluator,
  ...(notificationDispatcher ? { notificationDispatcher } : {}),
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  safety.engageKillSwitch(`process shutdown: ${signal}`);
  app.log.info({ signal }, "graceful shutdown started");
  const forceTimer = setTimeout(() => {
    app.log.fatal("graceful shutdown timed out");
    process.exitCode = 1;
  }, 15_000);
  forceTimer.unref();
  try {
    await app.close();
    app.log.info("graceful shutdown completed");
  } finally {
    clearTimeout(forceTimer);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}

process.on("unhandledRejection", (error) => {
  app.log.fatal({ err: error }, "unhandled rejection");
  safety.engageKillSwitch("unhandled rejection");
  void shutdown("unhandledRejection");
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "API failed to start");
  await app.close().catch(() => undefined);
  process.exitCode = 1;
}

function createRepository(): Repository {
  if (!config.databaseUrl) {
    if (config.nodeEnv === "production")
      throw new Error("Production requires PostgreSQL");
    return new InMemoryRepository();
  }
  return new PostgresRepository(
    {
      connectionString: config.databaseUrl,
      ...(config.databaseSsl
        ? {
            ssl: {
              rejectUnauthorized: true,
              ...(config.databaseCaCert ? { ca: config.databaseCaCert } : {}),
            },
          }
        : {}),
    },
    config.deviceTokenEncryptionKey,
  );
}

function createFeeds(): MarketFeed[] {
  const feeds: MarketFeed[] = [];
  for (const name of config.market.feeds) {
    if (name === "coinbase") feeds.push(new CoinbaseFeed(config.market.staleAfterMs));
    else if (name === "kraken") feeds.push(new KrakenFeed(config.market.staleAfterMs));
    else if (name === "binance")
      feeds.push(new BinanceFeed(config.market.staleAfterMs));
    else if (
      name === "simulated" &&
      config.market.simulatedEnabled &&
      config.nodeEnv !== "production"
    ) {
      feeds.push(new SimulatedMarketFeed(config.market.staleAfterMs));
    } else {
      throw new Error(`Unsupported or disabled market feed: ${name}`);
    }
  }
  if (feeds.length === 0)
    throw new Error("At least one market feed must be configured");
  return feeds;
}

function createApnsClient(): ApnsClient {
  if (!config.apns.enabled)
    return new FakeApnsClient({
      accepted: false,
      status: 0,
      reason: "apns_disabled",
      apnsId: null,
    });
  const { teamId, keyId, bundleId, privateKey } = config.apns;
  if (!teamId || !keyId || !bundleId || !privateKey)
    throw new Error("APNs credentials are incomplete");
  return new TokenApnsClient({
    environment: config.apns.environment,
    teamId,
    keyId,
    bundleId,
    privateKey,
  });
}
