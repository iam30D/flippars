# Architecture

```text
Coinbase ─┐
Kraken ───┼─> adapters -> validation/freshness -> composite/candles
Binance ──┘                                      |
                                                  v
                                  feature + approved forecast
                                                  |
                                                  v
                              uncertainty/anomaly/health policy
                                                  |
                                abstain <----------+----------> signal ledger
                                                                      |
                                            +-------------------------+------+
                                            |                                |
                                      REST/WebSocket                    APNs worker
                                            |                                |
                                            +------------ iPhone ------------+
                                                                      |
                                                              outcome evaluator
                                                                      |
                                                      drift + challenger pipeline
```

## Boundaries

- `packages/contracts` owns wire schemas.
- `packages/signal-core` owns deterministic timing, composite, eligibility,
  abstention, anomaly, and outcome behavior.
- `packages/model-lab` owns chronological draft training, calibration, and
  holdout metrics; it cannot promote an artifact.
- `apps/api` owns providers, persistence, orchestration, transport, and APNs.
- `apps/mobile` owns presentation, local guest state, recovery, and device
  notification behavior.

## Data authority

PostgreSQL is the durable source for devices, preferences, signals, outcomes,
audit events, observations, and model metadata. Provider events use stable
identifiers and idempotent ingestion. Test mode may use an in-memory repository.

## Failure behavior

- One venue failure degrades the composite; policy decides whether display-only
  operation remains safe.
- Sequence gaps quarantine the venue until snapshot recovery.
- Loss of database readiness disables signal emission.
- APNs failure does not erase a signal; retry ends at expiry.
- WebSocket clients recover sequence state through REST.
- An operator kill switch immediately disables new signal emission.

## Scale path

Ingestion, outcome evaluation, notification, and API roles can run as separate
processes from the same codebase. Measured fan-out or retention pressure can
later justify a durable log and analytical store without changing contracts.
