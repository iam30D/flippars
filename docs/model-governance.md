# Model Governance

## Principle

Flippars publishes qualified probabilities, not certainty. Each target is
validated and promoted independently. Failure is allowed to result in no
production signal type.

## Lifecycle

1. Register target, dataset, feature, code, and policy versions.
2. Train a transparent baseline and challengers.
3. Run purged chronological walk-forward evaluation.
4. Calibrate on a separate chronological set.
5. Lock thresholds before the untouched holdout.
6. Independently validate conceptual soundness, leakage, calibration, and
   limitations.
7. Run the frozen candidate in prospective shadow mode.
8. Approve, sign, canary, monitor, and retain rollback.

No live process may update weights or promote a candidate automatically.

For historical `flippars.multinomial-candidate/3` and gap-aware
`flippars.multinomial-candidate/4`, the artifact additionally binds the
Binance Spot trade target, signal-specific duration, label deadband, exact
candidate offsets/cadence/lead floor, 24-feature order, full three-class
probabilities, canonical dataset-content and manifest digests, and separate
`modelFitThrough`, `calibrationFitThrough`, and `evaluationThrough` cutoffs.
The cutoffs must be chronological and all partition counts are unique target
windows, not correlated decision rows. The artifact also binds a
`preEvaluationPolicySha256` digest covering fitted state, calibration,
sampling, baseline selection, and the predeclared confidence threshold before
holdout metrics are inspected. `flippars.pre-evaluation-policy/2` encodes
configurable decimal values as canonical strings and hashes recursively sorted
ASCII JSON. It carries exact JSON preimages for target, fitted state, and the
pre-evaluation sampling projection; independent verification must hash each
preimage and compare its parsed value with the artifact/evaluation fields.
Comparing stored digest strings alone is not an acceptable lineage check.

The V3 feature contract combines previous/current-window state with causal
3- and 12-candle returns, completed-window volatility/range, relative
volume/trade activity, and elapsed-normalized current rates. It requires 13
contiguous completed lookback windows and excludes trades at or after the
decision timestamp. Normalization and raw/normalized OOD support bounds are fit
on the model-fit partition only; missing, non-finite, or support-breaching
values abstain.

The repository baseline validates and counts the full canonical JSONL corpus
twice, requires identical byte/count/range audit evidence across the two
passes, partitions on unique complete target windows, and then uses a
deterministic hash-selected,
complete-window sample to bound fitting and diagnostic evaluation resources.
Each selected window has equal aggregate weight. Population/sample counts,
selection digest, class-window counts, and partition label cutoffs are evidence.
The logistic optimizer accumulates a full weighted objective in bounded
batches, computes cross-entropy with stable log-sum-exp, applies regularization
once per objective, and uses a decreasing line search. It records loss plus L2
and infinity gradient norms. Convergence requires either L2 gradient at most
`1e-5`, or 20 consecutive signed objective improvements no greater than `1e-7`
after epoch 25 while infinity gradient is at most `5e-4`. Objective increase,
non-finite state, line-search failure, or the hard epoch budget fails closed.
Calibration chooses the comparison baseline; evaluation
labels cannot change fitted weights, normalization, OOD bounds, temperature,
threshold, optimizer epoch, challenger state, or baseline choice.

Evaluation separates raw scheduled predictive metrics, OOD-healthy Binance
rows, direction-eligible rows, and first-emitted alerts. Dependence-aware
predictive and first-alert intervals use seven-day moving blocks over a
continuous UTC calendar, retain missing dates as explicit zero-observation
days, and report insufficient support rather than optimistic zero-width
intervals. Historical Binance-only data cannot
reconstruct the live cross-venue quorum: production-guarded replay therefore
abstains, while any Binance-conditional replay is labeled diagnostic. Global
temperature scaling is not an emitted-subset calibration claim.
Label and current-relation deadband boundaries use decimal arithmetic; binary
floating-point rounding cannot turn exact boundary equality into a direction.
Seven-day moving-block resamples never wrap the end of the observed calendar
back to its beginning. Walk-forward folds record validation failures and
insufficient support explicitly; zero successful folds cannot be reported as a
silent empty evaluation.

Sampled holdout or walk-forward metrics cannot satisfy promotion gates; a
future promotion-capable pipeline requires approved full-population streaming
policy replay and independently accepted uncertainty/regime coverage.

## Provisional release gates

Before a target can emit public production alerts:

- Brier skill is at least 5% over the strongest conditional baseline with the
  block-bootstrap 95% confidence interval above zero.
- Expected calibration error is no greater than 0.03 and adequately sampled
  probability bins remain within 0.05.
- Both directional classes demonstrate value.
- Shadow operation lasts at least 12 weeks and collects at least 300 independent
  alert windows for that target, whichever takes longer.
- Observed precision is at least 75%, with its block-bootstrap lower bound at
  least 70%.
- The predeclared coverage, lead-time, integrity, and latency floors pass.

These gates are provisional, preregistered product decisions rather than
universal research thresholds or promises of profitability. They may only change
through a new documented experiment - not after inspecting a failed holdout. See
[research-basis.md](research-basis.md) for the research boundary.

## Monitoring and automatic safety

- Feature freshness, missingness, support, and distribution drift.
- Probability calibration, precision, coverage, abstention, and lead time.
- Performance by direction, volatility, liquidity, and anomaly regime.
- Feed gaps, venue quorum, stablecoin health, scoring latency, and APNs handoff.

Integrity failure, out-of-distribution state, anomaly risk, latency breach, or a
sufficiently sampled degradation beyond the approved floor triggers abstention
or the signal kill switch.

## Required artifacts

- Model card and inventory entry
- Dataset and provider lineage sheet
- Reproducible experiment and validation report
- Signed model/calibrator/policy artifacts
- Threshold and exception approval
- Shadow and canary report
- Monitoring and incident history

V2 bundle parsing remains available for historical dry-run compatibility. It
does not acquire V3 target or serving parity by being readable. V3 is also
offline-only while its dataset declares cross-venue guard history unavailable;
the existing API remains fail-closed and no public signal is enabled by an
artifact that merely validates.
