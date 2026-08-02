import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadConfig } from "../src/config.js";

const productionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://flippars:secret@database.example.com:5432/flippars",
  DATABASE_SSL: "true",
  DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(32),
  MARKET_FEEDS: "coinbase,kraken,binance",
  SIMULATED_FEED_ENABLED: "false",
  SIGNALS_ENABLED: "false",
  APNS_ENABLED: "false",
} satisfies NodeJS.ProcessEnv;

void describe("production environment safety", () => {
  void test("accepts the fail-closed guest release configuration", () => {
    const config = loadConfig(productionEnvironment);
    assert.equal(config.nodeEnv, "production");
    assert.equal(config.signals.enabled, false);
    assert.equal(config.signals.provider, "disabled");
  });

  void test("requires a stable device-token encryption key in production", () => {
    const { DEVICE_TOKEN_ENCRYPTION_KEY: _ignored, ...missingKey } =
      productionEnvironment;
    void _ignored;
    assert.throws(() => loadConfig(missingKey), /DEVICE_TOKEN_ENCRYPTION_KEY/u);
    assert.throws(
      () =>
        loadConfig({
          ...productionEnvironment,
          DEVICE_TOKEN_ENCRYPTION_KEY: "REPLACE_WITH_A_REAL_SECRET_THAT_IS_LONG_ENOUGH",
        }),
      /DEVICE_TOKEN_ENCRYPTION_KEY/u,
    );
  });

  void test("rejects the production database template URL", () => {
    assert.throws(
      () =>
        loadConfig({
          ...productionEnvironment,
          DATABASE_URL: "postgresql://USER:PASSWORD@DATABASE_HOST:5432/flippars",
        }),
      /DATABASE_URL/u,
    );
  });

  void test("rejects public signals while only the disabled provider is bundled", () => {
    assert.throws(
      () => loadConfig({ ...productionEnvironment, SIGNALS_ENABLED: "true" }),
      /no validated production model provider/u,
    );
  });

  void test("requires production APNs routing for a production deployment", () => {
    assert.throws(
      () =>
        loadConfig({
          ...productionEnvironment,
          APNS_ENABLED: "true",
          APNS_ENVIRONMENT: "sandbox",
          APNS_TEAM_ID: "TEAM123456",
          APNS_KEY_ID: "KEY1234567",
          APNS_BUNDLE_ID: "com.flippars.mobile",
          APNS_PRIVATE_KEY: "private-key",
        }),
      /APNS_ENVIRONMENT/u,
    );
  });

  void test("rejects unknown and duplicate market feeds", () => {
    assert.throws(
      () => loadConfig({ ...productionEnvironment, MARKET_FEEDS: "coinbase,unknown" }),
      /unsupported feed/u,
    );
    assert.throws(
      () => loadConfig({ ...productionEnvironment, MARKET_FEEDS: "kraken,kraken" }),
      /duplicate feeds/u,
    );
    assert.throws(
      () =>
        loadConfig({
          ...productionEnvironment,
          MARKET_FEEDS: "coinbase,kraken",
          MARKET_MIN_HEALTHY_VENUES: "3",
        }),
      /cannot exceed/u,
    );
  });

  void test("normalizes an escaped database CA certificate", () => {
    const config = loadConfig({
      ...productionEnvironment,
      DATABASE_CA_CERT: "line-one\\nline-two",
    });
    assert.equal(config.databaseCaCert, "line-one\nline-two");
  });
});
