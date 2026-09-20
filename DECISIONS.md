# Architectural Decisions

## ADR-001 — TypeScript monorepo

**Decision:** Use npm workspaces with strict TypeScript for mobile, API,
contracts, and deterministic signal policy.

**Why:** Shared schemas reduce interpretation drift, Node 20 is available on the
Windows development host, and one toolchain improves reproducibility.

**Alternatives:** Python-only backend, separate repositories, native Swift.
Python remains appropriate for offline research adapters, but is not required in
the latency-sensitive policy path.

## ADR-002 — Expo React Native for iPhone

**Decision:** Use stable Expo SDK 56 and cloud macOS builds.

**Why:** It supports the available Node 20 environment and permits productive
Windows development while preserving native notifications and secure storage.

**Alternative:** SwiftUI would require continuous local or remote macOS access.

## ADR-003 — Modular Fastify backend

**Decision:** Start with a modular Fastify application whose ingestion,
orchestration, API, notification, and outcome workers can run independently.

**Why:** It avoids premature distributed-system overhead while preserving scale
boundaries. PostgreSQL is authoritative; in-memory repositories are test-only.

## ADR-004 — Health-screened BTC/USD composite

**Decision:** Combine Coinbase BTC-USD, Kraken XBT/USD, and normalized Binance
BTCUSDT. Binance is excluded when the USDT/USD conversion is unhealthy.

**Why:** Bitcoin has no universal price. Multiple venues reduce isolated
dislocations, while explicit stablecoin normalization avoids silently equating
USDT with USD.

## ADR-005 — Abstention and immutable signals

**Decision:** No signal is a first-class output. Signals are immutable and
outcomes append later.

**Why:** Rewriting forecasts destroys auditability. Forced predictions create
misleading confidence in noisy markets.

## ADR-006 — Guest-first, subscription-ready

**Decision:** Do not require an account in the first release. Store the minimum
anonymous installation and push-delivery data, with deletion controls. Keep an
entitlement boundary for later StoreKit subscriptions.

**Why:** Accounts are not necessary for the initial experience and would add
privacy and support burden.

## ADR-007 — Governed model improvement

**Decision:** Outcomes may train offline challengers, but only independently
validated, approved, shadowed, and canaried artifacts can become champions.

**Why:** Uncontrolled online learning risks poisoning, drift, leakage, and
unreviewed behavioral changes.

## ADR-008 — Version the expanded fifteen-minute reversal phase

**Decision:** Begin `FIFTEEN_MINUTE_REVERSAL` eligibility at `T+300s`, retain
the 30-second minimum lead and full-candle close outcome, and bind all newly
generated candidates to sampling-policy v2 and generator v0.4.0.

**Why:** The final-10-minute definition creates 39 governed decision points per
interval instead of 29. Versioning prevents older `T+450s` evidence from being
silently resumed or presented as compatible, while preserving old artifacts as
immutable historical records.

**Alternatives:** Reinterpreting “last 10 minutes” as a shorter outcome horizon
would change the product target and was rejected. Overwriting v1 datasets or
artifacts was rejected because it would destroy lineage.
