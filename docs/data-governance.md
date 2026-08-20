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

| Source           | Reference role                               | Current behavior and release gate                                                                                                                                  |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Coinbase BTC-USD | USD spot venue                               | Ticker freshness and sequence-regression quarantine are operational; channel-specific gap recovery remains a release gate                                          |
| Kraken BTC/USD   | USD spot venue                               | Ticker freshness and local monotonic ordering are operational; book checksum validation and snapshot recovery remain release gates                                 |
| Binance BTCUSDT  | Stablecoin spot venue and V3 research target | Current `bookTicker` freshness/update-ID regression and USDT/USD normalization support display/guards. V3 training truth uses public Spot trades, not `bookTicker` |

Production open, current, and close values use the same versioned composite. A
venue cannot contribute after its freshness deadline, a sequence integrity
failure, or an unresolved clock anomaly.

That production statement describes the unchanged API/display path. The
additive V3 research target is Binance Spot `BTCUSDT`: windows are UTC-aligned
and half-open, the open is the first trade at or after the window start, and the
close is the last trade before the window end, ordered by exchange event time
then trade ID. Public archive `trades` are the historical source. A future live
provider/outcome evaluator must use the public trade stream for parity;
`bookTicker` or the current composite is not substitute target truth.

## Point-in-time requirements

- Features use backward/as-of joins only.
- Corrected macro, on-chain, and news values retain their first-seen version.
- Online freshness and latency use locally observed receive time; provider event
  time never substitutes for it. Historical public archives lack receive time,
  so V3 training features and labels explicitly use exchange event time and do
  not claim receipt-time parity.
- Binance Spot archive timestamps are required to use milliseconds before
  `2025-01-01` and microseconds from `2025-01-01`, matching the
  [official Binance public-data contract](https://github.com/binance/binance-public-data/blob/master/README.md).
  Values are parsed as exact integers; an archive using the wrong or ambiguous
  unit is rejected.
- V3 feature rows include only trades with `eventTime < decisionAt`; trades at
  the decision timestamp are excluded unless a future, separately versioned
  trade-triggered decision policy defines their causal ordering.
- Training cutoffs include feature lookback and target horizon purges.
- Missing intervals and invalid truth data are retained, not silently dropped.
- Dataset manifests identify source/archive indexes and checksums, time range,
  accepted/rejected/duplicate/gap counts, filters, code, target/deadband/feature
  versions, the candidate schedule, and independent window versus row counts.
- The strict training lineage contract uses
  `flippars.dataset-manifest/2` and derives
  `flippars.dataset-manifest-summary/3`. `PUBLIC_BINANCE_ARCHIVE` requires a
  complete schema-3 acquisition binding with freshly retrieved Binance HTTPS
  checksum transport for every selected day. Unattested archive input is
  `LOCAL_ARCHIVE_REPLAY`, including normalized replay; only generated fixture
  input is `SYNTHETIC_LOCAL`.
- The archive-index digest covers the canonical inventory of archive date/path
  plus upstream checksum. It is distinct from the full dataset-manifest digest;
  V3 accepts only verified upstream archive checksums. Requested and final
  archive/checksum response URIs must remain on HTTPS `data.binance.vision`.
- Canonical prepared-content SHA-256 and full-manifest SHA-256 are separate
  fields. The manifest digest must not be presented as the content digest.
- Training reads strict UTF-8, LF-terminated, canonical JSONL twice and requires
  the exact byte digest, byte count, row count, window count, and temporal range
  to match between passes before fitting. This closes corpus mutation between
  validation and use.
- Fit, calibration, and evaluation sample counts use unique `windowStart`
  values. Decision-row counts are reported separately because repeated
  candidates inside one window are correlated.
- Every accepted training window contains the exact ordered governed decision
  schedule. Missing first, middle, or final decision rows fail closed rather
  than entering a sample described as complete.

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

V3 artifacts additionally carry raw and normalized support bounds derived only
from the model-fit partition. Missing, non-finite, or out-of-envelope features
require abstention. Coinbase, Kraken, composite dispersion, and USDT/USD health
remain safety guards and must not be used to rewrite Binance target labels. The
current public archive pipeline records cross-venue guard history as
`UNAVAILABLE` and `productionEligible:false`; it never substitutes a numeric
zero anomaly score. Joining guard history requires a separately versioned
dataset contract.

Data incidents follow the provider-outage runbook and may append a `VOID`
outcome when the reference truth itself was invalid.

The source and research boundaries behind these controls are recorded in
[research-basis.md](research-basis.md).
