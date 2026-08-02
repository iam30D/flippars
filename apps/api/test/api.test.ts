import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import {
  GUEST_CREDENTIAL_HEADER,
  GUEST_INSTALLATION_ID_HEADER,
} from "@flippars/contracts";
import { buildApi } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type {
  MarketSnapshot,
  SignalRecord,
  VenueQuote,
  VenueStatus,
} from "../src/domain.js";
import { MarketCoordinator } from "../src/market/coordinator.js";
import type { MarketFeed } from "../src/market/feed.js";
import { MetricsRegistry } from "../src/metrics.js";
import { FakeApnsClient } from "../src/notifications/apns.js";
import { NotificationDispatcher } from "../src/notifications/dispatcher.js";
import { InMemoryRepository } from "../src/repositories/memory.js";
import { OutcomeEvaluator } from "../src/signals/outcomes.js";
import { FakeModelRuntime } from "../src/signals/runtime.js";
import { SafetyController } from "../src/signals/safety.js";
import { SignalWorker } from "../src/signals/worker.js";
import { presentMarketSnapshot } from "../src/transport/presenters.js";

const apps: FastifyInstance[] = [];
const guestCredential = "c".repeat(64);
void afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
});

function config() {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    MARKET_FEEDS: "simulated",
    SIMULATED_FEED_ENABLED: "true",
    MARKET_MIN_HEALTHY_VENUES: "1",
    REQUIRE_MARKET_FOR_READINESS: "false",
    SIGNALS_ENABLED: "false",
    APNS_ENABLED: "false",
  });
}

async function fixture() {
  const repository = new InMemoryRepository();
  const metrics = new MetricsRegistry();
  const market = new MarketCoordinator([], repository, metrics, {
    staleAfterMs: 5_000,
    minimumHealthyVenues: 1,
    retentionDays: 1,
    dataMode: "simulation",
  });
  const safety = new SafetyController(false);
  const app = await buildApi({
    config: config(),
    repository,
    market,
    metrics,
    safety,
    startBackground: false,
    logger: false,
  });
  apps.push(app);
  return { app, repository, market, metrics, safety };
}

void describe("health and market routes", () => {
  void test("liveness, readiness, metrics, and canonical market snapshot", async () => {
    const { app, repository } = await fixture();
    const live = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(live.statusCode, 200);
    assert.equal(responseBody(live)["status"], "ok");

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(ready.statusCode, 200);
    assert.equal(record(responseBody(ready)["checks"])["database"], true);

    const unavailable = await app.inject({ method: "GET", url: "/v1/market/snapshot" });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(
      record(responseBody(unavailable)["error"])["code"],
      "MARKET_UNAVAILABLE",
    );

    await repository.insertMarketObservation(
      snapshot(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    const market = await app.inject({ method: "GET", url: "/v1/market/snapshot" });
    assert.equal(market.statusCode, 200);
    const marketBody = responseBody(market);
    assert.equal(marketBody["instrument"], "BTC-USD");
    assert.equal(typeof marketBody["compositePrice"], "string");
    assert.equal(marketBody["dataMode"], "SIMULATION");

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.body, /flippars_http_requests_total/);
  });

  void test("USDT depeg excludes Binance and forces unhealthy degraded mode", async () => {
    const repository = new InMemoryRepository();
    const metrics = new MetricsRegistry();
    const feed = new ManualMarketFeed();
    const market = new MarketCoordinator([feed], repository, metrics, {
      staleAfterMs: 5_000,
      minimumHealthyVenues: 2,
      maximumUsdtDeviationBps: 50,
      retentionDays: 1,
      dataMode: "live",
    });
    const at = new Date("2026-01-01T00:01:00.000Z");
    market.start();
    feed.quote(venueQuote("coinbase", "BTC-USD", 65_000, at, 1));
    feed.quote(venueQuote("kraken", "BTC-USD", 65_010, at, 1));
    feed.quote(venueQuote("coinbase", "USDT-USD", 0.99, at, 2));
    feed.quote(venueQuote("binance", "BTC-USDT", 65_650, at, 1));

    const current = market.snapshot(at);
    assert.ok(current);
    assert.equal(current.health.healthy, false);
    assert.equal(current.health.degraded, true);
    assert.equal(current.health.usdtDepegged, true);
    assert.equal(current.health.healthyVenues, 2);
    assert.match(current.health.reason ?? "", /Binance is excluded/);
    const binance = current.sources.find((source) => source.venue === "binance");
    assert.equal(binance?.eligible, false);
    assert.equal(binance?.weight, 0);

    const wire = presentMarketSnapshot(current, "LIVE", at);
    assert.equal(wire.health, "DEGRADED");
    assert.equal(
      wire.venues.find((venue) => venue.venue === "BINANCE")?.eligible,
      false,
    );
    assert.ok(wire.healthFlags.some((flag) => flag.code === "USDT_DEPEG"));
    await market.stop();
  });
});

void describe("anonymous guest privacy", () => {
  void test("device registration is idempotent and deletion erases device-scoped data", async () => {
    const { app, repository } = await fixture();
    const id = randomUUID();
    const body = {
      platform: "IOS",
      appVersion: "1.0.0",
      locale: "en-NG",
      timeZone: "Africa/Lagos",
      pushToken: "a".repeat(64),
      notificationsAuthorized: true,
      pushEnvironment: "sandbox",
    };
    const first = await app.inject({
      method: "PUT",
      url: `/v1/devices/${id}`,
      headers: guestHeaders(id),
      payload: body,
    });
    const second = await app.inject({
      method: "PUT",
      url: `/v1/devices/${id}`,
      headers: guestHeaders(id),
      payload: { ...body, appVersion: "1.0.1" },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(repository.devices.size, 1);
    assert.notEqual(repository.deviceCredentialHashes.get(id), guestCredential);
    assert.equal(repository.preferences.get(id)?.notificationsEnabled, false);
    assert.equal(responseBody(second)["installationId"], id);

    const preferences = await app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: guestHeaders(id),
      payload: {
        installationId: id,
        enabledSignalTypes: ["FIVE_MINUTE_REVERSAL"],
        notificationsEnabled: true,
        minimumConfidence: 0.8,
        quietHours: {
          enabled: true,
          start: "22:00",
          end: "07:00",
          timeZone: "Africa/Lagos",
        },
        showDemoData: false,
        locale: "en-NG",
      },
    });
    assert.equal(preferences.statusCode, 200);
    assert.deepEqual(responseBody(preferences)["enabledSignalTypes"], [
      "FIVE_MINUTE_REVERSAL",
    ]);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/devices/${id}`,
      headers: guestHeaders(id),
    });
    assert.equal(deleted.statusCode, 204);
    assert.equal(repository.devices.has(id), false);
    assert.equal(repository.preferences.has(id), false);
    assert.equal(
      [...repository.notificationClaims].some((key) => key.startsWith(`${id}:`)),
      false,
    );
  });

  void test("strict request schemas reject unknown fields and inconsistent push state", async () => {
    const { app } = await fixture();
    const id = randomUUID();
    const response = await app.inject({
      method: "PUT",
      url: `/v1/devices/${id}`,
      headers: guestHeaders(id),
      payload: {
        platform: "IOS",
        appVersion: "1",
        locale: "en",
        timeZone: "UTC",
        pushToken: "a".repeat(64),
        notificationsAuthorized: false,
        pushEnvironment: "sandbox",
        accountId: "must-not-be-accepted",
      },
    });
    assert.equal(response.statusCode, 400);
    const error = record(responseBody(response)["error"]);
    assert.equal(error["code"], "VALIDATION_ERROR");
    assert.ok(error["requestId"]);
  });

  void test("guest mutations require matching per-installation proof", async () => {
    const { app, repository } = await fixture();
    const id = randomUUID();
    const body = {
      platform: "IOS",
      appVersion: "1.0.0",
      locale: "en",
      timeZone: "UTC",
      pushToken: null,
      notificationsAuthorized: false,
      pushEnvironment: "sandbox",
    };
    const missing = await app.inject({
      method: "PUT",
      url: `/v1/devices/${id}`,
      payload: body,
    });
    assert.equal(missing.statusCode, 401);

    const registered = await app.inject({
      method: "PUT",
      url: `/v1/devices/${id}`,
      headers: guestHeaders(id),
      payload: body,
    });
    assert.equal(registered.statusCode, 200);

    const wrongCredential = "d".repeat(64);
    const takeover = await app.inject({
      method: "PUT",
      url: `/v1/devices/${id}`,
      headers: guestHeaders(id, wrongCredential),
      payload: { ...body, pushToken: "e".repeat(64), notificationsAuthorized: true },
    });
    assert.equal(takeover.statusCode, 403);
    assert.equal(repository.devices.get(id)?.pushToken, null);

    const preferenceTakeover = await app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: guestHeaders(id, wrongCredential),
      payload: {
        installationId: id,
        enabledSignalTypes: ["FIVE_MINUTE_REVERSAL"],
        notificationsEnabled: true,
        minimumConfidence: 0.75,
        quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" },
        showDemoData: false,
        locale: "en",
      },
    });
    assert.equal(preferenceTakeover.statusCode, 403);

    const wrongDelete = await app.inject({
      method: "DELETE",
      url: `/v1/devices/${id}`,
      headers: guestHeaders(id, wrongCredential),
    });
    assert.equal(wrongDelete.statusCode, 403);
    assert.equal(repository.devices.has(id), true);

    const publicRead = await app.inject({ method: "GET", url: "/v1/signals" });
    assert.equal(publicRead.statusCode, 200);
  });
});

void describe("signal safety and idempotency", () => {
  void test("unhealthy/stale market state suppresses otherwise high-confidence signal", async () => {
    const repository = new InMemoryRepository();
    repository.models.set("five_minute_reversal", {
      id: randomUUID(),
      signalType: "five_minute_reversal",
      version: "test-only",
      artifactUri: "memory:test",
      artifactSha256: "a".repeat(64),
      status: "approved",
      approvedAt: "2025-12-31T00:00:00.000Z",
      minimumConfidence: 0.75,
      metadata: {},
    });
    const metrics = new MetricsRegistry();
    const market = new MarketCoordinator([], repository, metrics, {
      staleAfterMs: 5_000,
      minimumHealthyVenues: 3,
      retentionDays: 1,
      dataMode: "live",
    });
    const worker = new SignalWorker(
      market,
      repository,
      new FakeModelRuntime({
        direction: "lower",
        confidence: 0.99,
        anomalyScore: 0,
        explanation: { summary: "test", evidence: [], limitations: ["test only"] },
      }),
      new SafetyController(true),
      metrics,
      { confidenceThreshold: 0.75, minimumLeadTimeMs: 5_000, dataMode: "live" },
    );
    worker.start();
    market.emit(
      "snapshot",
      snapshot({
        healthy: false,
        degraded: true,
        reason: "stale",
        healthyVenues: 1,
        requiredVenues: 3,
      }),
    );
    await immediate();
    await worker.stop();
    assert.equal(repository.signals.size, 0);
    assert.match(metrics.render(), /reason="market_unhealthy"/);
  });

  void test("outcome evaluation and APNs dispatch are idempotent", async () => {
    const repository = new InMemoryRepository();
    const metrics = new MetricsRegistry();
    const market = new MarketCoordinator([], repository, metrics, {
      staleAfterMs: 5_000,
      minimumHealthyVenues: 1,
      retentionDays: 1,
      dataMode: "live",
    });
    const signal = signalRecord();
    await repository.createSignal(signal);
    await repository.insertMarketObservation(
      snapshot(undefined, signal.intervalEnd, 65_100),
      new Date(Date.now() + 60_000).toISOString(),
    );
    const evaluator = new OutcomeEvaluator(repository, metrics, 1);
    await evaluator.runOnce(new Date(Date.parse(signal.intervalEnd) + 1_000));
    await evaluator.runOnce(new Date(Date.parse(signal.intervalEnd) + 2_000));
    assert.equal((await repository.getSignal(signal.id))?.outcome?.result, "correct");

    const deviceId = randomUUID();
    await repository.upsertDevice({
      id: deviceId,
      credentialHash: "f".repeat(64),
      platform: "ios",
      pushToken: "b".repeat(64),
      pushEnvironment: "sandbox",
      notificationsAuthorized: true,
      appVersion: "1",
      locale: "en",
      timezone: "UTC",
    });
    await repository.putPreferences({
      deviceId,
      notificationsEnabled: true,
      signalTypes: ["five_minute_reversal"],
      minimumConfidence: 0.75,
      quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: "UTC" },
      showDemoData: false,
      locale: "en",
    });
    const apns = new FakeApnsClient();
    const dispatcher = new NotificationDispatcher(market, repository, apns, metrics);
    dispatcher.start();
    const active = {
      ...signal,
      id: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    market.emit("signal", active);
    market.emit("signal", active);
    await immediate();
    await immediate();
    await dispatcher.stop();
    assert.equal(apns.sent.length, 1);
  });

  void test("signal list returns canonical signal plus pending outcome", async () => {
    const { app, repository } = await fixture();
    const signal = signalRecord();
    await repository.createSignal(signal);
    const response = await app.inject({ method: "GET", url: "/v1/signals?limit=10" });
    assert.equal(response.statusCode, 200);
    const body = responseBody(response);
    const items = array(body["items"]);
    const first = record(items[0]);
    assert.equal(record(first["signal"])["type"], "FIVE_MINUTE_REVERSAL");
    assert.equal(record(first["outcome"])["status"], "PENDING");
    assert.equal(body["hasMore"], false);
  });
});

function snapshot(
  health: Partial<MarketSnapshot["health"]> = {
    healthy: true,
    degraded: false,
    reason: null,
    healthyVenues: 3,
    requiredVenues: 3,
  },
  observedAt = "2026-01-01T00:01:00.000Z",
  price = 65_000,
): MarketSnapshot {
  const venues = ["coinbase", "kraken", "binance"] as const;
  return {
    symbol: "BTC-USD",
    price,
    bid: price - 1,
    ask: price + 1,
    observedAt,
    sources: venues.map((venue, index) => ({
      venue,
      price: price + index * 0.1,
      weight: 1 / 3,
    })),
    usdtUsd: 1,
    health: {
      healthy: health.healthy ?? true,
      degraded: health.degraded ?? false,
      reason: health.reason ?? null,
      healthyVenues: health.healthyVenues ?? 3,
      requiredVenues: health.requiredVenues ?? 3,
      checkedAt: observedAt,
      venues: venues.map((venue) => ({
        venue,
        connected: true,
        fresh: health.healthy ?? true,
        lastEventAt: observedAt,
        lagMs: (health.healthy ?? true) ? 0 : 60_000,
      })),
    },
  };
}

function signalRecord(): SignalRecord {
  const intervalStart = "2026-01-01T00:00:00.000Z";
  const intervalEnd = "2026-01-01T00:05:00.000Z";
  return {
    id: randomUUID(),
    type: "five_minute_reversal",
    direction: "higher",
    openPrice: 65_000,
    currentPrice: 64_900,
    confidence: 0.8,
    intervalStart,
    intervalEnd,
    issuedAt: "2026-01-01T00:02:00.000Z",
    expiresAt: intervalEnd,
    modelId: randomUUID(),
    modelVersion: "test-only",
    explanation: {
      summary: "test",
      evidence: [{ label: "flow", value: "positive", direction: "supports" }],
      limitations: ["test"],
    },
    outcome: null,
  };
}

async function immediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class ManualMarketFeed implements MarketFeed {
  readonly name = "manual-test";
  private readonly listeners = new Set<(quote: VenueQuote) => void>();

  start(): void {}
  stop(): Promise<void> {
    return Promise.resolve();
  }
  status(): VenueStatus {
    return {
      venue: "simulated",
      connected: true,
      fresh: true,
      lastEventAt: null,
      lagMs: null,
      detail: "test-only",
    };
  }
  onQuote(listener: (quote: VenueQuote) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  quote(value: VenueQuote): void {
    for (const listener of this.listeners) listener(value);
  }
}

function responseBody(response: { body: string }): Record<string, unknown> {
  return record(JSON.parse(response.body) as unknown);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an object response");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected an array response");
  return value as unknown[];
}

function guestHeaders(
  installationId: string,
  credential = guestCredential,
): Record<string, string> {
  return {
    [GUEST_INSTALLATION_ID_HEADER]: installationId,
    [GUEST_CREDENTIAL_HEADER]: credential,
  };
}

function venueQuote(
  venue: VenueQuote["venue"],
  instrument: VenueQuote["instrument"],
  price: number,
  at: Date,
  sequence: number,
): VenueQuote {
  return {
    venue,
    instrument,
    bid: price - 0.01,
    ask: price + 0.01,
    last: price,
    sequence,
    eventAt: at,
    receivedAt: at,
  };
}
