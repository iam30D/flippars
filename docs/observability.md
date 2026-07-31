# Observability and Service Objectives

## Correlation

Every request, provider session, market window, signal decision, notification,
and outcome carries stable correlation identifiers. Logs redact authorization,
cookie, APNs token, installation identifier, and provider credential fields.

## Required metrics

### Market integrity

- Feed connection, reconnects, gaps, checksum failures, and receive lag
- Venue freshness/quarantine state and composite quorum
- Cross-venue dispersion and USDT/USD conversion health
- Window/open creation and late-event counts

### Signal safety

- Forecasts, abstentions, and reason codes by target
- Probability, threshold, coverage, lead time, and anomaly score
- Model/calibrator/policy version and kill-switch state
- Outcome precision, calibration, flat/void rate, and regime slices

### Product delivery

- API rate, latency, errors, and WebSocket connections/recovery
- Signal-to-APNs-acceptance time, response classes, retries, and invalid tokens
- Device delivery is reported separately and never inferred from APNs acceptance

### Platform

- Process health, event-loop lag, memory, CPU, database pool/latency/errors
- Migration version, backup age, and restore drill status

## Initial objectives

These are engineering objectives, not guarantees to end users:

- API and valid scoring-window availability: 99.9%
- API latency: p95 below 250 ms under the approved load profile
- Healthy market event to signal decision: p95 below 2 seconds
- Signal decision to APNs provider acceptance: p95 below 1 second
- Duplicate or expired user alert: below 0.1%
- Detected bad-feed test suppression: 100%

Device notification delivery is best effort and excluded from the APNs
acceptance objective.

## Alerts

Page an operator for loss of composite quorum, undetected integrity fixture,
database readiness, signal-policy exceptions, expired alerts, or kill-switch
failure. Ticket degraded individual providers, rising latency, and recoverable
APNs errors. Product/model owners receive calibrated-performance and drift
alerts with minimum-sample safeguards.
