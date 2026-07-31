# Flippars Engineering Guide

## Mission

Build an auditable, abstention-first Bitcoin information product. Correctness,
data lineage, user comprehension, and safe silence take priority over alert
volume. No component may place trades or accept exchange credentials.

## Domain ownership

- Product: signal definitions, user comprehension, acceptance criteria.
- Architecture: boundaries, contracts, failure modes, and ADRs.
- Mobile: guest experience, accessibility, offline recovery, notifications.
- API: validation, persistence, streaming, privacy, and APNs.
- Data: venue adapters, event time, quality, replay, and lineage.
- Quantitative/AI: labels, calibration, abstention, evaluation, and drift.
- Security/privacy: threat model, secrets, least privilege, retention.
- QA/performance: deterministic replay, contracts, load/fault testing.
- DevOps: reproducible builds, migrations, observability, rollback.
- Documentation/review: decisions, limitations, runbooks, independent challenge.

## Non-negotiable product rules

1. `FIVE_MINUTE_REVERSAL` is evaluated while current price is still on the
   opposite side of the predicted close relative to the five-minute open.
2. `FIFTEEN_MINUTE_REVERSAL` is only eligible in the final half of its interval.
3. `FIVE_MINUTE_EARLY_DIRECTION` is only eligible in the first 60 seconds.
4. At most one signal of each type is emitted per aligned interval.
5. Flat/deadband outcomes are not silently removed.
6. Production emission requires an approved model artifact and healthy data.
7. Stale, gapped, anomalous, out-of-distribution, or insufficient-quorum data
   must cause abstention.
8. Confidence is a calibrated estimate, never certainty or a profit guarantee.
9. Explanations distinguish measured observations, model associations, and
   externally reported context. They do not claim causality.
10. Online self-modification and automatic model promotion are forbidden.

## Coding standards

- TypeScript strict mode; no unchecked `any`.
- ESM modules, explicit public exports, and versioned schemas.
- Decimal strings cross API boundaries; timestamps are UTC RFC3339.
- Pure domain logic stays separate from I/O.
- Validate every external payload; assume providers add message types.
- Use deterministic IDs and idempotent writes for events and notifications.
- Redact tokens, device identifiers, headers, and personal data from logs.
- Tests accompany boundary rules, failure behavior, and regressions.
- Record deliberate deferrals in `TECH_DEBT.md`; never hide them as TODOs.

## Folder conventions

- `apps/` contains independently deployable applications.
- `packages/` contains side-effect-free shared libraries.
- `packages/model-lab` may create draft challengers but cannot approve or deploy
  them.
- `docs/` is authoritative for product and operating decisions.
- `deploy/` contains secret-free deployment manifests.
- Database migrations are append-only after release.

## Review workflow

1. Map changes to an acceptance criterion and architecture impact.
2. Review data leakage, timing, privacy, security, accessibility, and failure
   behavior.
3. Run format, lint, typecheck, unit/integration tests, and builds.
4. Independently challenge model or policy changes.
5. Update project memory, decisions, technical debt, and runbooks.
6. Promote through shadow, canary, and rollback-capable stages.

## Quality gates

- No open Critical or High security findings.
- Deterministic candle-boundary and replay tests pass.
- API schemas and mobile consumers remain contract-compatible.
- Guest deletion/reset behavior is verified.
- Degraded providers suppress signals without taking the API offline.
- Accessibility checks cover VoiceOver labels, Dynamic Type, contrast, focus,
  non-color cues, and reduced motion.
- Public alerts remain disabled until the model gates in
  `docs/model-governance.md` pass.
