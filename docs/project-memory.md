# Project Memory

## Product requirements

- Informational Bitcoin signals only; no trading or exchange-account access.
- Coinbase, Kraken, and Binance contribute to the reference market.
- Five-minute reversal while price remains on the opposite side of the open.
- Fifteen-minute reversal only in the interval's final 10 minutes.
- Five-minute closing direction may trigger during the first 60 seconds.
- One alert per signal type per interval; precision over alert volume.
- Full guest access first; subscriptions and optional accounts later.
- Pump/dump protection is an anomaly-risk guard, not an accusation engine.
- Explanations and complete outcome history are mandatory.
- Improvement uses controlled champion/challenger promotion.

## Current progress

- Product and architecture plan accepted and implemented.
- Contracts, signal core, market ingestion, guest API, APNs pipeline, Expo
  client, PostgreSQL persistence, model lab, observability, and deployment
  baselines are complete.
- Exact five-minute and fifteen-minute reversal semantics, early direction,
  outcome scoring, health gates, anomaly abstention, and immutable signal
  behavior have automated coverage.
- Repository-wide verification is complete: structure/secret checks,
  formatting, strict lint, all workspace type checks, 20 API tests, 24 mobile
  tests, 6 contracts tests, 6 model-artifact tests, 3 model-lab tests, 23
  signal-core tests, and the iOS production export pass.
- Guest mutation proof, explicit notification opt-in, offline deletion
  tombstones, production environment guards, bounded retention, and the
  offline-only model-bundle verifier are implemented. Signals remain disabled.
- Publication to GitHub is pending final credentialed push from the release
  operator.

## Pending release inputs

- Initial public launch country and legal review.
- Licensed data vendors and budget.
- Apple/EAS/APNs production credentials.
- Approved model artifacts after prospective validation.
- Cloud-specific ingress/TLS/secret-manager configuration and an operational
  owner for the Kubernetes baseline.

## Known limitations

- No honest production win rate exists before the shadow validation period.
- No production model provider, registrar, live shadow recorder, or durable
  cross-pod signal fan-out is bundled.
- APNs delivery to a device is best effort; alerts include expiration.
- Public data can identify anomalies but cannot prove manipulative intent.

## Next priorities

1. Complete repository-wide quality gates and publish the initial `main`.
2. Acquire licensed feature data and run the documented shadow-validation
   program.
3. Complete legal, security, physical-iPhone, APNs, and App Store release gates.
4. Promote a model only after independent approval; signals remain fail-closed
   until then.

## Changelog

- 2026-08-02: Completed the guest-first production-readiness implementation,
  governed model-bundle verifier, deployment/retention baseline, beginner
  build/production guides, and full repository verification.
- 2026-07-31: User approved the full implementation plan and repository
  publication.
- 2026-07-31: Implemented the guest-first full stack, deterministic signal
  policy, three-venue market composite, draft-only model laboratory, mobile
  artwork, and production deployment baseline.
- 2026-07-31: Passed the exact CI verification command, production
  high-severity dependency gate, Expo Doctor 21/21 offline, and iOS Hermes
  export.
