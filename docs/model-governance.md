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
through a new documented experiment—not after inspecting a failed holdout. See
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
