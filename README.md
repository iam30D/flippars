# Flippars

Flippars is a guest-first iPhone application and near-real-time backend for qualified
Bitcoin market signals. It observes Coinbase, Kraken, and Binance, builds a
health-screened BTC/USD composite, and only emits a directional signal when an
approved model, data-quality checks, uncertainty policy, and anomaly controls all
agree.

Flippars is informational software. It does not connect to exchange accounts,
execute trades, custody assets, or guarantee an outcome.

## Signal contract

The platform supports three independently governed targets:

1. **Five-minute reversal** — while the current composite remains above the
   interval open, forecast a close below the open, or the exact inverse.
2. **Fifteen-minute reversal** — the same opposite-side close target, eligible
   only in the final 7 minutes 30 seconds of the interval.
3. **Five-minute early direction** — during the first 60 seconds, forecast the
   final side of the five-minute close.

Every signal is immutable, expires at its candle close, is limited to one alert
per signal type and interval, and is later scored as correct, incorrect, flat,
void, or pending. Low confidence and degraded data deliberately produce no
signal.

## Repository

```text
apps/api/                 Fastify API, ingestion, orchestration, APNs
apps/mobile/              Expo/React Native iPhone client
packages/contracts/       Versioned API and WebSocket schemas
packages/signal-core/     Deterministic composite, candle, risk, and signal logic
packages/model-artifact/  Signed model-bundle schemas and offline verification
packages/model-lab/       Chronological draft challenger training/calibration
deploy/k8s/               Portable Kubernetes deployment baseline
docs/                     Product, architecture, governance, and operations
```

## Local development

Prerequisites:

- Node.js 20.19 or newer in the Node 20 release line
- npm 10
- PostgreSQL 17, or Docker for the included Compose environment
- An iPhone or Expo development client for notification testing

```powershell
npm ci
Copy-Item apps/api/.env.example apps/api/.env
npm run build
npm test
npm run dev:api
```

In another terminal:

```powershell
npm run dev:mobile
```

The API defaults to deterministic simulation only when explicitly configured.
Simulation output is visibly marked and cannot be mistaken for a production
signal. Live signal emission remains disabled until a signed, approved model
artifact is installed and the production release gates are satisfied.

## Verification

```powershell
npm run verify
npm audit --omit=dev --audit-level=high
```

Start with the beginner-friendly
[iPhone development-build guide](docs/development-build.md), then use the
[guest-first production setup guide](docs/production-setup.md). Additional
engineering details are in [docs/development.md](docs/development.md). Model
promotion and launch controls are documented in
[docs/model-governance.md](docs/model-governance.md).

## Production status

The repository contains the guest-access application, tests, migration path,
observability hooks, and infrastructure baseline. The guest information release
has no login, subscription, entitlement, or paywall. A public financial-signal
release additionally requires licensed provider agreements, a jurisdictional
legal review, APNs/App Store credentials, an independent security assessment,
and prospective model validation. Those are release gates, not code shortcuts;
until then, production signal emission remains disabled.
