# Product Requirements

## Objective

Give a guest user a transparent, near-real-time view of BTC/USD and notify them
only when a validated forecast policy qualifies one of three precisely defined
candle outcomes.

## Primary user journey

1. Read plain-language uncertainty and no-trading disclosures.
2. Continue without an account.
3. See composite price, venue/data health, aligned candle opens, deltas, and
   countdowns.
4. Enable selected alert types and quiet hours.
5. Receive a non-stale qualified signal.
6. Inspect its evidence, probability, reference market, model version, and
   expiry.
7. Later see the immutable outcome and aggregate track record.
8. Delete/reset the anonymous installation data at any time.

## Functional acceptance criteria

### Market view

- Shows the composite and participating venues.
- Distinguishes live, delayed, degraded, offline, and demo data.
- Never reuses stale values without a visible status.

### Signals

- Implements the three contracts in `docs/signal-specification.md`.
- Sends at most one alert per signal type and window.
- Expires alerts at candle close and suppresses late delivery.
- Shows “No qualified signal” rather than implying a hidden forecast.
- Records pending, correct, incorrect, flat, and void outcomes.

### Explanations

- Lists measured observations and their timestamps.
- Labels model contributions as associations.
- Labels reported events and provides provenance when enabled.
- Uses “no verified catalyst” instead of inventing a reason.

### Guest privacy

- No login is required.
- No location, contacts, wallet, exchange keys, or portfolio are collected.
- Anonymous device and preference records can be removed.

## Edge cases

- Exact open/close equality or a move inside the neutral band is flat.
- Missing open, insufficient venue quorum, clock skew, stale data, abnormal
  stablecoin conversion, or high anomaly risk suppresses the signal.
- Reconnects recover through a sequenced REST snapshot before live streaming.
- Provider and APNs retries are idempotent and bounded by signal expiry.
- Corrections append a void decision; they never rewrite the original forecast.

## Non-functional acceptance criteria

- Strict API validation and versioned contracts.
- WCAG 2.2 AA target and native iOS accessibility behavior.
- Dark/light appearance, localization-ready strings, and local time display.
- Structured logs, metrics, traces/correlation IDs, readiness, and kill switch.
- Encrypted transport, least privilege, secret isolation, and data minimization.
- Unit, integration, contract, failure, and deterministic replay coverage.
