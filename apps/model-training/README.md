# Flippars Binance Spot draft training

This package implements the offline research path for Binance Spot `BTCUSDT`.
It consumes public daily trade archives and can produce only immutable
`flippars.multinomial-candidate/3` `DRAFT` artifacts. It never accepts exchange
credentials, places trades, approves a model, enables signals, or promotes an
artifact.

Keep Python environments, raw archives, prepared JSONL, dependency wheels,
evidence, evaluations, and model artifacts in `C:\Users\HP\Flippars-ml` (or
another reviewed workspace outside this repository). Do not commit generated
training material.

## Governed operator path

Use [the offline model-training runbook](../../docs/runbooks/offline-model-training.md).
It provides two paste-once PowerShell blocks:

1. Build a public-PyPI bootstrap environment, create a profile/platform-bound
   semantic wheel lock, install the final environment with `--no-index` and
   `--require-hashes`, and materialize an exact checksum-verified Binance date
   window while online.
2. Revalidate all evidence and run network-free preparation/training from a
   clean reviewed commit.

The final runner calls `prepare-archives` and `train` separately. It never calls
the download-capable `collect` or `all` command.

## CLI boundaries

- `collect` downloads only public daily Binance Spot trade archives and their
  adjacent `.CHECKSUM` files from HTTPS `data.binance.vision`; requested and
  final response URIs must remain on that host.
- `prepare-archives` is network-free. It requires an exact continuous archive
  root, verifies every archive against its adjacent SHA-256 sidecar, streams one
  daily archive at a time, and writes point-in-time signal-specific rows
  atomically. It may claim `PUBLIC_BINANCE_ARCHIVE` lineage only when a strict
  schema-3 acquisition manifest proves fresh HTTPS checksum transport for every
  selected day; otherwise archive replay is labeled `LOCAL_ARCHIVE_REPLAY`.
- `prepare` is a compatibility path for already normalized local archive
  replay. It preserves source checksums, trade IDs, and microsecond event times
  but cannot claim official transport evidence.
- `train` is network-free. It validates the complete canonical JSONL bytes
  twice and requires identical content/count/range audits across both passes,
  partitions unique windows chronologically, selects deterministic bounded
  complete-window samples, fits a fail-closed full-objective
  multinomial-logistic baseline, calibrates it with equal window weight, freezes
  baseline/threshold policy before computing or inspecting holdout outcome
  statistics or metrics, replays first-qualified
  alerts with OOD/data-health abstention, and writes a strict V3 draft plus
  diagnostic evaluation.
- `all` exists for bounded exploration only because it includes acquisition. It
  is forbidden in `FrozenDraft` operations.
- `smoke` creates only synthetic local data for an end-to-end diagnostic.

The V3 target has three outcomes: `ABOVE_OPEN`, `BELOW_OPEN`, and `AT_OPEN`.
Feature rows use 24 ordered finite features, 13 contiguous completed lookback
windows, and only trades with `eventTime < decisionAt`. Five-minute reversal,
five-minute early-direction, and fifteen-minute reversal use their exact
governed 15-second schedules and retain flat/deadband outcomes.
Deadband comparisons use decimal arithmetic, so equality at exactly plus or
minus five basis points remains `AT_OPEN`.

## Model and evaluation status

The multinomial logistic model is a governed, portable baseline, not evidence
that it is the best possible BTC model. The full corpus is integrity-checked,
but fit/calibration/holdout matrices use deterministic complete-window samples
to bound RAM and runtime. Evaluation records population and sample counts,
selection digest, class-window support, calibration-selected baseline,
window-balanced metrics, and seven-day moving-block intervals over a continuous
UTC calendar with explicit missing-day counts. It reports raw scheduled,
in-distribution, direction-eligible, and
first-emitted populations separately. Because historical data cannot prove the
live cross-venue quorum, production-guarded replay abstains; a separately
labeled Binance-conditional replay remains diagnostic only.

The artifact binds a versioned pre-evaluation policy digest. Policy V2 uses
canonical decimal strings, recursively sorted ASCII JSON, and exact JSON
preimages for the target, fitted state, and sampling projection. The
TypeScript verifier hashes those preimages and independently rebinds them to
the artifact and evaluation; matching copied digest strings are insufficient.
Global temperature scaling is not fitted on first-emitted alerts, so the draft
does not claim calibrated user-facing confidence for that population. The
optimizer must converge with finite parameters and a decreasing stable
log-sum-exp objective. It accepts either the strict gradient criterion or the
preregistered sustained plateau with a bounded infinity-norm gradient;
line-search failure, objective increase, non-finite state, or epoch-budget
exhaustion prevents artifact creation.

`requirements.txt` contains only baseline dependencies. Optional LightGBM and
XGBoost exploration uses `requirements-challengers.txt` and a separate
`ChallengerExploration` environment. Challenger output cannot enter the current
artifact/runtime contract without a versioned serving implementation,
independent validation, and governance approval.

The model-artifact verifier deliberately rejects the V3 candidate/manifest pair
as offline-only. Live Binance trade feature parity, receive-time health,
cross-venue quorum history, prospective shadow evidence, drift monitoring,
independent approval, registration, canary, rollback, and user-comprehension
gates remain required before public alerts can be considered.

Publication of this source still requires explicit owner approval. Provider
permits and redistribution decisions must be recorded before production use.
