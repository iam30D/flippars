# Release Checklist

## Scope and legal

- [ ] Signal definitions and current policy version are approved.
- [ ] Informational-only boundary is intact; no trade execution or exchange
      credentials exist.
- [ ] Launch territories, legal entity, audience, warnings, privacy notice, and
      App Store classification have counsel approval.
- [ ] Provider and news licences cover use, training, retention, and display.

## Data and model

- [ ] Point-in-time replay and leakage review pass.
- [ ] Venue gaps, stale feeds, stablecoin deviation, and quorum fixtures abstain.
- [ ] Checksum-verified internal no-trade fixtures retain exact gap lineage,
      synthesize nothing, and omit gap and 13-lookback-dependent examples.
- [ ] Missing-ID, corrupt-content, checksum, and incomplete-day-edge fixtures
      quarantine; changed code or policy never reuses old checkpoints.
- [ ] The target-specific offline and prospective gates pass.
- [ ] Independent validation, model card, signed artifacts, approvals, and
      limitations are present.
- [ ] Shadow, canary, kill switch, drift alerts, and rollback were exercised.

## Security and privacy

- [ ] Threat model is current and no Critical/High findings remain.
- [ ] SAST, dependency, secret, container, IaC, and SBOM checks pass.
- [ ] Independent mobile/API penetration test passes.
- [ ] Least privilege, secret rotation, backup restore, and incident exercises
      pass.
- [ ] Guest reset/deletion, retention, privacy labels, and vendor records agree.

## Reliability and performance

- [ ] Load, soak, reconnect, provider outage, database failure, and APNs retry
      tests pass.
- [ ] SLO dashboards, on-call ownership, runbooks, and alert routing are active.
- [ ] Migrations are backwards compatible and rollback is documented.

## Mobile quality

- [ ] Release build tested on supported physical iPhones and TestFlight.
- [ ] VoiceOver, Dynamic Type, contrast, non-color cues, reduced motion, and
      accessible charts pass.
- [ ] Offline recovery, stale push discard, deep links, quiet hours, and
      notification preferences pass.
- [ ] Dark/light appearance, localization, privacy disclosures, support, and App
      Store metadata pass review.

## Rollout

- [ ] Internal cohort, TestFlight, limited geography, and staged production
      gates are defined.
- [ ] Signals begin disabled and are enabled only for approved target/model
      cohorts.
- [ ] Post-release outcome, support, security, and incident reviews are booked.
