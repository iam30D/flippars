# Data Governance

## Source register

Every production source must have an owner and a record of:

- Products, fields, schemas, and provider identifiers
- Event, receipt, and processing-time semantics
- Expected cadence, latency, sequence/checksum behavior, and status endpoint
- Historical coverage, corrections, and first-known-time behavior
- Retention, training, derived-data, display, and redistribution rights
- Geographic restrictions, subprocessors, support, and outage escalation

## Core source policy

| Source           | Reference role        | Current behavior and release gate                                                                                                  |
| ---------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Coinbase BTC-USD | USD spot venue        | Ticker freshness and sequence-regression quarantine are operational; channel-specific gap recovery remains a release gate          |
| Kraken BTC/USD   | USD spot venue        | Ticker freshness and local monotonic ordering are operational; book checksum validation and snapshot recovery remain release gates |
| Binance BTCUSDT  | Stablecoin spot venue | `bookTicker` freshness/update-ID regression and healthy USDT/USD normalization are operational                                     |

Production open, current, and close values use the same versioned composite. A
venue cannot contribute after its freshness deadline, a sequence integrity
failure, or an unresolved clock anomaly.

## Point-in-time requirements

- Features use backward/as-of joins only.
- Corrected macro, on-chain, and news values retain their first-seen version.
- Provider event time never substitutes for locally observed receive time.
- Training cutoffs include feature lookback and target horizon purges.
- Missing intervals and invalid truth data are retained, not silently dropped.
- Dataset manifests identify source versions, time range, hashes, filters, code,
  and target-policy version.

## Classification

- **Restricted:** credentials, APNs tokens, device identifiers, licensed raw
  feeds, non-public model artifacts.
- **Internal:** observations, features, audit data, experiment results,
  operational logs.
- **Public:** documented schemas, aggregated product metrics approved for
  disclosure, published model limitations.

Restricted data must be encrypted, access logged, and separated from product
analytics. Production retention schedules require legal and provider approval.

## Quality controls

- Schema and numeric-range validation
- Duplicate and deterministic-event-ID checks
- Clock offset and receive-lag monitoring
- Sequence/checksum and snapshot reconciliation
- Cross-venue dispersion and stablecoin conversion checks
- Completeness, null, outlier, and revision metrics
- Quarantine rather than speculative repair

Data incidents follow the provider-outage runbook and may append a `VOID`
outcome when the reference truth itself was invalid.

The source and research boundaries behind these controls are recorded in
[research-basis.md](research-basis.md).
