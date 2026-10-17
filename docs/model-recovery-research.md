# Model recovery and app delivery research

Research checked 2026-10-17. This is an implementation proposal, not approval
of a new experiment, provider licence, model, or deployment. The owner has AWS,
Apple, and EAS accounts; region, credits, domain, and deployed resources have
not been verified. Existing frozen candidates remain immutable.

## What the completed experiment tells us

See [the evidence review](training-readiness-review.md). The research question
is whether causal information improves the exact product targets beyond a
strong conditional baseline, while preserving meaningful calibrated coverage.
Training convergence answers only whether the chosen optimizer finished.

The reversal models are especially weak in the population the product needs.
The five-minute reversal replay records 27,768 signal-rule-ineligible decisions,
17,994 flat predictions, 14,219 OOD exclusions, and only two eligible decisions
below the confidence threshold. The fifteen-minute replay records 33,090,
8,371, 18,356, and 165 respectively. Neither emits at the frozen 0.75 threshold.
These are visited decision counts, not mutually exclusive rates over windows;
replay stops visiting a window after its first alert.

Inference: a classifier rewarded mainly for predicting ordinary continuation
can perform acceptably on scheduled rows yet have little reversal utility.
This does not prove a useful reversal edge exists or that conditional training
will create one. The negative baseline-relative Brier skill is additional
evidence against deploying these candidates.

Early direction offers the most promising next investigation: 239 conditional
alerts across 20,000 holdout windows (1.195% window coverage), with 69/89 correct
above-open alerts and 108/150 correct below-open alerts. This is diagnostic
evidence, not 239 prospective independent observations. The direction imbalance,
precision shortfall, OOD loss, and emitted-subset calibration require study.

## Free resources that fit this repository

| Resource                                         | Concrete use                                                         | Boundary                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Existing verified Binance archives               | Reuse local corpus for development and historical diagnostic replay  | Preserve checksums, gaps, and consumed-holdout status; no new download is needed for initial analysis |
| Binance public individual trade stream           | Match historical trade-based feature and outcome definitions         | Quotes and aggregate trades cannot silently substitute for individual trades                          |
| Coinbase public market feed                      | BTC/USD and relevant stablecoin quotes, receive-time health evidence | Channel-specific sequence/recovery semantics; no private account keys                                 |
| Kraken public trade/book feeds                   | Independent market health and prospective context                    | Validate snapshots, batches, precision, and book checksum when maintaining L2                         |
| NumPy and scikit-learn                           | CPU baselines, chronological experiments, calibration diagnostics    | Freeze dependencies and fit transforms only on training partitions                                    |
| LightGBM CPU                                     | Small nonlinear challenger with explicit resource caps               | New research artifact/runtime contract; not a drop-in V4 serving replacement                          |
| Existing Node test runner and synthetic fixtures | Verify policy, malformed inputs, parity, and replay determinism      | A passing unit test cannot replace market evidence                                                    |
| EAS free plan                                    | Limited cloud native builds from Windows                             | Quotas and queue delays apply; account plan must be checked                                           |
| AWS account credits/free eligibility             | Potentially offset a small initial deployment                        | Account-specific and temporary; not a promise of free continuous hosting                              |

Coinbase documents a public unauthenticated market endpoint and explicitly
warns that dropped/out-of-order messages can occur. Binance documents trade
streams and its public-data project documents archive timestamp units. Kraken
documents batched public trades and book-integrity checking. Use the providers'
official contracts rather than scraping pages or using undocumented endpoints:
[Coinbase](https://docs.cdp.coinbase.com/exchange/websocket-feed/overview),
[Binance streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams),
[Binance archives](https://github.com/binance/binance-public-data),
[Kraken trades](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade),
[Kraken book](https://docs-legacy.kraken.com/api/docs/websocket-v2/book/).

Endpoint access does not itself establish permission for commercial training,
retention, or redistribution. Record actual terms and owner decisions under
[data governance](data-governance.md). Do not add exchange credentials.

## Next model experiment design

1. Keep the inspected holdout as consumed research evidence. Freeze a new
   experiment manifest before new evaluation: targets, available data cutoffs,
   candidate list, transforms, sampling, resource limits, calibration method,
   coverage floors, threshold policy, and rejection rules. A later unseen era
   can provide a new final evaluation after point-in-time acquisition and
   sufficient support; do not repeatedly retune against this holdout.
2. Preserve the three-class target and exact schedules. Group every decision
   in a candle into the same chronological partition. Purge overlapping
   feature lookbacks and label horizons. Preserve flat/deadband labels and
   all gap exclusions. Compare candidates to the same strong relation/phase
   baseline on the exact evaluated population.
3. First audit eligibility on training/calibration: decision offset, current
   relation, volatility, class frequency, and maximum opposite-direction
   probability. Test whether rare reversals have any support at useful lead
   times. Publish failures instead of lowering the production floors.
4. Compare a small preregistered set: current logistic baseline, regularized
   logistic interactions (relation/elapsed phase/return/volatility), and one
   bounded CPU tree challenger. Test model capacity before considering GPUs
   or sequence networks. Do not run an unrestricted hyperparameter search.
5. Investigate relation/phase conditioning using information known at decision
   time. Selecting rows based on the model's own predicted reversal or on
   future labels would bias evaluation. A conditional expert must still
   produce a normalized three-class distribution and have explicit routing,
   population, calibration, and runtime contracts.
6. Fit calibration on a separate chronological population, then replay the
   frozen first-qualified-alert policy on another validation block. Report
   reliability by predicted class, phase, regime, and emitted subset with
   support counts. Avoid fitting a calibrator on final holdout alerts or
   treating global ECE as evidence of alert calibration.
7. Diagnose OOD exclusions by feature and phase on development data. Check
   joint support and drift, not just a single marginal breach total. Do not
   widen boxes after inspecting the holdout to manufacture coverage; a new
   envelope is a new governed policy with its own validation.
8. Implement bounded full-population streaming policy replay, retaining
   first-alert-per-window semantics, calendar gaps, directional support,
   uncertainty, latency, and abstention reasons. Sampled metrics remain
   diagnostic. Distinguish retrospective event-time replay from evidence
   that was actually available at live receive time.

Scikit-learn explains why time-ordered splits and preprocessing isolation
matter, and why calibration requires data separate from fitting:
[time-series splitting](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html),
[leakage](https://scikit-learn.org/stable/common_pitfalls),
[calibration](https://scikit-learn.org/stable/modules/calibration.html).
Its generic splitter is not a substitute for this repo's grouped candle and
lookback/horizon purge requirements. LightGBM documents CPU determinism,
thread limits, and histogram settings; pin the actual installed version and
record compiler/runtime details:
[parameters](https://lightgbm.readthedocs.io/en/stable/Parameters.html).

Temperature scaling is a useful low-complexity benchmark, not proof of
calibration after selection or distribution shift. Research directly supports
testing those limitations rather than assuming calibration transfers:
[Guo et al.](https://arxiv.org/abs/1706.04599),
[Ovadia et al.](https://arxiv.org/abs/1906.02530).
Repeated model selection against backtests can overfit the evaluation itself:
[Bailey et al.](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).
These studies motivate methodology; they do not establish Bitcoin predictability.

## Missing live path and implementation order

The current API's market quotes and composite are useful for the information
app, but are not the Binance individual-trade target used by the candidates.
`DisabledModelRuntime` correctly returns no prediction. Feeding composite
quotes into the existing trade-trained artifact would create target and
feature mismatch.

Build the following as an isolated research path before public integration:

An initial bounded recorder is now implemented; its scope and operator smoke
are documented in [research market capture](runbooks/research-market-capture.md).
It records unassessed guard inputs and does not yet supply a verified live
feature pipeline or prospective model shadow evidence.

1. **Trade and guard recorder:** versioned validated events with exact decimal
   strings, trade IDs, exchange event time, local receive time, connection/session
   identity, provenance, health transitions, and explicit reconnect/gap records.
   Keep the stream outside Git, use bounded disk/retention controls, and do not
   collect personal/device data. No provider terms or health status is inferred
   from a successful connection.
2. **Causal feature/outcome parity:** one deterministic definition shared or
   independently cross-checked against Python. Test exact trade ordering,
   microsecond boundaries, current-window partials, thirteen completed lookback
   candles, missing-window recovery, deadband equality, and minimum lead times.
   Raw/aggregate trades, ticker prices, and composite prices are distinct inputs.
3. **Research scorer and shadow ledger:** exact hash-bound frozen candidates,
   readiness validation, all three probabilities, OOD and guard reasons, and
   idempotent decisions/outcomes. Every record states diagnostic/shadow scope;
   it must not enter the public signal/APNs ledger. A failure causes abstention.
4. **Prospective evaluation and serving contract:** frozen predeclared policy,
   append-only prospective evidence, full-population reports, independent
   validation, and a separately reviewed V4 successor serving/bundle contract.
   Do not mutate historical V4 DRAFTs to make them look approved.
5. **Controlled production:** operator-only registrar with separate authority,
   signed evidence, canary, rollback, kill switch, and monitoring. Keep the
   existing public model provider disabled until all gates actually pass.

The twelve-week/300-window minimum begins with valid prospective operation,
not the date historical training ended. A recorder alone is not a shadow
deployment of a parity-validated frozen candidate.

## AWS, Apple, and EAS delivery

Ship and validate the guest information app while model research proceeds.
Use existing PostgreSQL contracts and an always-on process for outbound market
WebSockets; do not redesign around request-only compute merely to chase a free
quota. Start with one explicitly managed writer for any research recorder.
Existing public deployment manifests are a portable baseline, not provisioned
AWS infrastructure or a completed multi-replica signal design.

Before selecting EC2, Lightsail, ECS, or managed PostgreSQL, inventory the
account's region, credits, existing resources, expected storage, backups,
connection uptime, and total monthly cost. Choose a small measured deployment
instead of Kubernetes by default. TLS, restore tests, secrets, alarms, and
operational ownership remain required. Do not provision billable resources
under a claim that they are free.

AWS distinguishes account-specific Free Tier/credit eligibility and documents
cost monitoring; budget alerts are monitoring, not a universal hard spending
cap: [Free Tier](https://aws.amazon.com/free/free-tier-faqs/),
[AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html).
Expo documents limited free-plan services and cloud signing/build workflows:
[plans](https://docs.expo.dev/billing/plans/),
[EAS Build](https://docs.expo.dev/build/introduction/).
An account and JavaScript export do not establish production signing, APNs
delivery, or physical-iPhone acceptance. Follow the existing
[production guide](production-setup.md) after environment/domain decisions.

## Added diagnostic tool and validation

`node scripts/review-model-evaluation.mjs <evaluation.json>` reads at most
2 MB of V4 DRAFT evaluation JSON, validates a diagnostic field projection,
rejects contradictory precision/count evidence, and reports the exact input
SHA-256, conditional coverage/precision, abstention counts, and missing gates.
It never approves, rewrites, registers, trains, or enables a model. It is not
a substitute for the existing full lineage/cross-runtime verifier.

Targeted tests cover malformed evidence, unavailable precision, and the
critical invariant that passing diagnostic point checks cannot confer approval.
The tool was also run successfully on all three completed evaluations.

No dependency installation, dataset download, retraining, cloud provisioning,
or production enablement was performed for this research. Remaining live
pipeline work is tracked in `TECH_DEBT.md` and remains release-blocking.
