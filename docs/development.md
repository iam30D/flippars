# Development and Operations

## Environment

Use Node 20.19+ in the Node 20 release line. Expo SDK 56 is intentionally pinned
for compatibility. Use `npm ci` so CI and local development share the lockfile.

## Database

Start PostgreSQL with the root Compose file or point `DATABASE_URL` at an
isolated development database. Apply migrations through the API workspace
before starting live ingestion. Compose includes a one-shot migration service
and starts the API only after it succeeds.

## Modes

- `MARKET_FEEDS=coinbase,kraken,binance`: real provider adapters; signal
  emission still requires approved model.
- Shadow policy: qualifies and records candidates but never sends user alerts.
- `MARKET_FEEDS=simulated` with `SIMULATED_FEED_ENABLED=true`: deterministic
  synthetic data, visibly marked as demo/test.

Never set demo mode in a public build. Production startup rejects unsafe
combinations of environment and simulation settings.

## Windows and iOS

The TypeScript source, API, tests, and Expo development server run on Windows.
EAS supplies macOS workers for signed iOS builds. Production notification,
background, and deep-link behavior must be verified on a physical iPhone and in
TestFlight.

## Deployment

The API is packaged as a non-root container. `deploy/k8s` provides probes,
resources, autoscaling, disruption budget, and a secret-free baseline intended
for a managed Kubernetes environment with managed PostgreSQL.

Before release:

1. Populate secrets through the platform secret manager.
2. Run migrations as a controlled job.
3. Verify readiness with signals disabled.
4. Enable shadow operation.
5. Promote only the approved model and release cohort.
6. Exercise kill switch and rollback.
