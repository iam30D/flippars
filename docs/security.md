# Security and Privacy

## Protected assets

- Provider credentials, APNs signing key, database credentials
- Anonymous installation and APNs device identifiers
- Model artifacts, thresholds, audit records, and provider data
- Service availability and signal integrity

## Primary threats

- Feed spoofing, sequence gaps, stale replay, and data poisoning
- Stablecoin or isolated-venue dislocation
- Duplicate, delayed, conflicting, or forged alerts
- APNs token leakage and notification flooding
- API abuse, denial of service, injection, and dependency compromise
- Model theft, unauthorized promotion, and insider policy changes
- News/social prompt injection if contextual services are later enabled

## Controls

- TLS at every external boundary and encrypted managed storage
- Schema validation, bounded messages, rate limits, and idempotency keys
- Quorum, freshness, sequence, stablecoin, anomaly, and kill-switch gates
- Secret manager/KMS, rotation, workload identity, and least privilege
- Redacted structured logs and PII-separated retention
- Signed artifacts, review requirements, SBOM/scans, and deployment approvals
- Backup restore, incident response, and rollback drills
- Anonymous guest design with in-app deletion/reset

## Data minimization

The guest release does not collect names, email addresses, location, contacts,
wallets, exchange credentials, portfolios, or trading activity. It stores only
an opaque installation identifier, device push token, preferences, entitlement
state when introduced, and privacy-preserving diagnostics.

Production policy must define retention and deletion periods before launch.
