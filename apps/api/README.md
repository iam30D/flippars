# Flippars API

Production-oriented Fastify service for guest-first, informational Bitcoin signals. It ingests Coinbase, Kraken, and Binance public market data, builds a health-gated BTC/USD composite, stores an immutable signal/outcome ledger, serves REST and WebSocket clients, and dispatches short-lived APNs notifications.

The API never connects to exchange accounts, holds user credentials, moves funds, or executes trades.

## Safety invariant

Live market ingestion does **not** imply live prediction. Signal emission requires every one of these conditions:

1. `SIGNALS_ENABLED=true` and the runtime kill switch is clear.
2. The snapshot is live (not demo/simulation), fresh, and meets the configured venue quorum.
3. A model registry row is uniquely `approved`, has an approval timestamp, and includes current calibration metadata.
4. A model provider has loaded the referenced artifact and verified its bytes against `artifact_sha256`.
5. The shared `@flippars/signal-core` engine accepts calibration, confidence, timing, lead-time, reversal-position, anomaly-risk, and deduplication gates.
6. The forecast provider supplies all approved abnormal-return, volume, spread, liquidity, cross-venue, liquidation, order-book, cancellation, and stablecoin-risk inputs; a missing input forces abstention.
7. The database accepts the unique `(signal_type, interval_start)` write.

The checked-in provider is `DisabledForecastProvider`, which fails closed. It is intentional: no production prediction is emitted until a separately validated artifact provider is installed. Simulation is forbidden by environment validation when `NODE_ENV=production`.

## Local development

From the repository root:

```powershell
npm install
npm run build --workspace @flippars/contracts
npm run build --workspace @flippars/signal-core
Copy-Item apps/api/.env.example apps/api/.env
npm run migrate --workspace @flippars/api
npm run dev --workspace @flippars/api
```

For a database-free local session, omit `DATABASE_URL`, use
`MARKET_FEEDS=simulated`, set `SIMULATED_FEED_ENABLED=true`,
`MARKET_MIN_HEALTHY_VENUES=1`, and keep
`REQUIRE_MARKET_FOR_READINESS=false`. In-memory storage is non-durable and is
never allowed in production. Live mode retains the three-venue quorum.

Production listens on port `8080` by default. Run migrations as a distinct deployment step; the server does not mutate its schema at startup.

## Routes

| Method | Path                                                | Purpose                                                                |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/health/live`                                      | Process liveness                                                       |
| GET    | `/health/ready`                                     | PostgreSQL, market-quorum, and kill-switch readiness                   |
| GET    | `/metrics`                                          | Prometheus text exposition                                             |
| GET    | `/docs`                                             | OpenAPI UI                                                             |
| GET    | `/v1/market/snapshot`                               | Latest canonical composite snapshot                                    |
| GET    | `/v1/candles?interval=1m\|5m\|15m&from=&to=&limit=` | Composite OHLC history                                                 |
| GET    | `/v1/candles/current`                               | Current canonical 5m and 15m candle states for cold-start/gap recovery |
| GET    | `/v1/signals?type=&cursor=&limit=`                  | Cursor-paginated signal/outcome history                                |
| GET    | `/v1/signals/:id`                                   | One signal plus outcome                                                |
| PUT    | `/v1/devices/:installationId`                       | Idempotently register/refresh an anonymous iOS installation            |
| DELETE | `/v1/devices/:installationId`                       | Erase device, preferences, and delivery metadata                       |
| PUT    | `/v1/preferences`                                   | Replace guest preferences                                              |
| GET/WS | `/v1/stream`                                        | Sequenced market, signal, health, and heartbeat envelopes              |

Signal list/detail items have this shape:

```json
{
  "signal": { "type": "FIVE_MINUTE_REVERSAL", "informationalOnly": true },
  "outcome": { "status": "PENDING" }
}
```

The complete objects conform to `SignalSchema` and `SignalOutcomeSchema` in `@flippars/contracts`. Prices are canonical decimal strings. WebSocket envelopes use schema version `1` and a per-connection monotonic `sequence`; clients should reconnect and refetch REST state after detecting a gap.

Device registration body:

```json
{
  "platform": "IOS",
  "appVersion": "1.0.0",
  "locale": "en-NG",
  "timeZone": "Africa/Lagos",
  "pushToken": null,
  "notificationsAuthorized": false,
  "pushEnvironment": "sandbox"
}
```

Preferences use the canonical guest contract, excluding the server-generated `updatedAt`. The body includes `installationId`, `enabledSignalTypes`, `notificationsEnabled`, `minimumConfidence`, `quietHours`, `showDemoData`, and `locale`.

All request objects reject unknown fields. Errors use:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "...",
    "requestId": "..."
  }
}
```

## Market ingestion

- Coinbase Advanced Trade WebSocket: subscribes to BTC-USD and USDT-USD ticker plus BTC-USD Level 2 and trades; the current composite parser consumes ticker quotes only.
- Kraken v2 WebSocket: subscribes to BTC/USD and USDT/USD ticker plus BTC/USD book and trades; the current composite parser consumes ticker quotes only.
- Binance public WebSocket: BTCUSDT book ticker.
- Binance is normalized with a fresh USDT/USD reference; it is excluded when that reference is absent.
- If USDT/USD deviates by more than `MARKET_MAX_USDT_DEVIATION_BPS` (50 bps by default), Binance is excluded and the complete snapshot is marked degraded/unhealthy so signal emission stops.
- Adapters implement heartbeat, reconnect with exponential jitter, freshness state, and sequence-regression rejection.
- The coordinator uses one quote per venue and a median composite. Stale venues remain visible with exclusion metadata but do not satisfy quorum.

The current normalized observation rate is capped at four writes per second. Event-level archival replay data should be captured by a separate, validated pipeline before model validation; this API table is an operational composite store.

## Database and privacy

Migration `001_initial.sql` creates:

- anonymous devices and preferences;
- encrypted push tokens (AES-256-GCM at the repository boundary);
- model registry and single-approved-model constraint;
- operational market observations;
- immutable signals and idempotent outcomes;
- deduplicated APNs deliveries;
- audit records and retention timestamps.

Run a scheduled retention job using `retain_until` for operational observations and delivery records. Signal/audit retention must follow the approved model-risk and legal policy; signals are protected from mutation by a database trigger. Backups require equivalent encryption and deletion controls.

No guest account or personally identifying profile exists. `DELETE /v1/devices/:id` cascades the installation’s preferences and notification-delivery metadata. Audit entries record actions without storing APNs tokens or request bodies.

## APNs

APNs uses ES256 token authentication over HTTP/2. Provider JWTs are cached for 50 minutes. Each push carries:

- an APNs expiration equal to the signal expiration;
- a collapse ID equal to the signal ID;
- one database claim per `(device, signal)`;
- `time-sensitive` interruption level;
- no exchange or trade action.

Set the APNs variables in `.env.example`; `DEVICE_TOKEN_ENCRYPTION_KEY` must be at least 32 characters. Never commit the `.p8` private key. Sandbox and production device tokens are not interchangeable.

## Operations

- Logs are structured and correlation IDs are accepted/returned as `x-request-id`.
- Authorization, cookies, push tokens, and set-cookie values are redacted.
- Rate limits apply globally except probes and metrics.
- Slow WebSocket consumers are disconnected once buffered output exceeds 1 MB.
- `SIGINT`/`SIGTERM` immediately engage the signal kill switch, stop workers and feeds, close APNs and WebSockets, drain Fastify, and close PostgreSQL.
- Readiness fails on database loss, required market-quorum loss, or the kill switch.

Build the image from the monorepo root:

```powershell
docker build -f apps/api/Dockerfile -t flippars-api .
```

## Verification

```powershell
npm run typecheck --workspace @flippars/api
npm test --workspace @flippars/api
```

Tests cover route contracts, correlation/error envelopes, health probes, guest idempotency and privacy deletion, stale-data suppression, outcome idempotency, APNs deduplication, and canonical history responses.
