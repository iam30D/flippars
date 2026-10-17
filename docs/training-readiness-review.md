# Offline training readiness review

Reviewed 2026-10-17 against repository commit
`1006a16b6961ae8bb734aeb41b2dbc35cb908637`.

## Decision

All three latest `20260920.1` runs report `COMPLETE`, converged fitting, V4
DRAFT candidates, and `productionEligible: false`. Training completion is not
production approval. Public signals must remain disabled.

## Observed diagnostic results

These are sampled Binance-conditional holdout diagnostics, not production or
prospective performance. Brier skill compares against the baseline selected on
calibration before evaluation; ECE is for all scheduled holdout rows.

| Target                      | Completed (UTC) | Brier skill | ECE    | Conditional alerts | Conditional precision |
| --------------------------- | --------------- | ----------- | ------ | ------------------ | --------------------- |
| Five-minute early direction | 2026-09-29      | 6.75%       | 0.0283 | 239                | 74.06%                |
| Five-minute reversal        | 2026-10-03      | -0.45%      | 0.0537 | 0                  | Unavailable           |
| Fifteen-minute reversal     | 2026-10-07      | -3.16%      | 0.0315 | 0                  | Unavailable           |

Early-direction precision has a reported dependence-aware 95% interval of
68.33%–78.97%. Its point estimate is below the governed 75% floor and its
lower bound is below 70%. Positive diagnostic Brier skill alone cannot pass
the production gate. Both reversal candidates underperform their selected
baselines and provide no emitted-alert evidence at the frozen threshold.
Do not adjust thresholds against this inspected holdout or discard flat labels.

All production-guarded replays emit zero alerts because cross-venue guard
history is unavailable. Global temperature calibration does not establish
emitted-subset confidence calibration.

## Evidence inspected and limits

Source evidence remains outside Git under `C:\Users\HP\Flippars-ml`:
`evidence/runs/<run-key>/run-manifest.json` and
`artifacts/draft/<run-key>/{candidate,evaluation}.json`.

The review checked recorded output byte lengths and SHA-256 values for the
small evidence files, including candidate, evaluation, dataset manifest,
environment, acquisition/source-integrity evidence, and command/verifier logs.
The retained cross-runtime logs report successful schema, digest, prepared
dataset audit, pre-evaluation policy, acquisition evidence, and production
abstention checks. The multi-GB prepared corpora were not rehashed or replayed
in this review; those successes are retained run evidence, not fresh execution.
The recorded training commit matches the inspected repository HEAD.

## Remaining release work

1. Repository verification passed in the operator's reported run on
   2026-10-17, including the iOS Hermes export (1,334 modules). This establishes
   the repository verification gate, not a signed native build, physical-device
   acceptance, deployed infrastructure, or model approval. Retain the full
   operator log with release evidence; only its successful tail was supplied
   in chat.
2. Preserve these candidates and their frozen experiment evidence. Any revised
   model, feature, threshold, or policy requires a new predeclared experiment
   and an appropriate untouched evaluation design.
3. Implement and independently review live causal feature/risk and target
   outcome providers, full-population policy replay, and a prospective shadow
   recorder. V4 currently has no promotion-bundle contract.
4. Collect target-specific prospective evidence for at least 12 weeks and
   300 independent alert windows, whichever takes longer; complete independent
   validation, signing, operator registration, canary, monitoring, and rollback.
5. Complete external provider permissions, legal, security, infrastructure,
   physical-iPhone/accessibility, APNs, and App Store gates in the release
   checklist. A guest release with signals disabled remains a separate scope
   whose non-model release gates still require evidence.

The governing criteria remain [model governance](model-governance.md),
[model promotion](runbooks/model-promotion.md), and the
[release checklist](release-checklist.md).
