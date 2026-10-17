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

## ADR-009 — Isolate raw research capture from public signals

**Decision:** Capture public individual trades and unassessed guard inputs in
new, bounded, hash-linked sessions outside Git using a standalone operator
command. Preserve exact trade decimals/microseconds and raw guard packet text.
Stop on discontinuity, malformed known messages, lost data, or storage limits;
do not reconnect, repair, score, approve, or emit from this initial recorder.

**Why:** The quote-based display path cannot establish trade-trained feature
or outcome parity. Recording local receive times and explicit failures starts
an auditable evidence path without presenting unverified data as healthy or
starting the prospective model validation clock prematurely.

**Deferred:** Streaming verification, per-instrument guard assessment,
long-session rotation/retention, causal feature/outcome parity, and the isolated
shadow ledger remain tracked release work. See
`docs/runbooks/research-market-capture.md` and `TECH_DEBT.md`.

## ADR-010 — Exclude ambiguous receipt timestamps in research decisions

**Decision:** The bounded research feature path requires both exchange event
time and recorded local receive time strictly before a scheduled decision.
Exclude packets in the decision's millisecond because the initial recorder
cannot prove their order within that millisecond. Preserve exact microsecond
event ordering and decimal deadband comparisons. Keep all results research-only.

**Why:** Historical event-time availability is not evidence of live receipt-time
availability. The first smoke also exposed an unsynchronized host clock, so
successful capture integrity checks cannot establish healthy causal inputs.

**Limits:** Three synthetic Python-reference cases establish numerical
regressions, not production serving parity. Clock health, streaming state,
broader validation, and all model gates remain required. See
`docs/runbooks/research-feature-parity.md`.

## ADR-011 — Preserve complete retrospective research populations

**Decision:** Replay each governed sampling offset in a verified, bounded capture
and retain every decision and target outcome, including abstentions, flat labels,
empty windows, and unfinished targets. Write immutable external reports with a
source/implementation-bound completion manifest; never overwrite prior evidence.
Reports explicitly remain retrospective, model-free, and production-ineligible.

**Why:** Three selected snapshots cannot establish complete policy coverage.
Removing missing-data decisions or flat outcomes would misstate the population.
Retrospective availability also cannot establish prospective model performance.

**Limits:** File hashes establish integrity rather than trusted authorship.
Long-session continuity, measured clock/data health, independent parity review,
signed lineage, durable prospective predictions, and model approval remain
separate release gates. See `docs/runbooks/research-population-replay.md`.

## ADR-012 — Version longer research capture without rewriting historical collectors

**Decision:** Retain the original collector's three source files and one-hour
contract unchanged. Introduce a separate 225-minute collector with manifest
revision two, a matching session-start marker, exact seven-module binding,
strict UTF-8, and relative clock/source-liveness checks. Reader dispatch is
explicit and does not accept arbitrary historical module hashes.

**Why:** Fifteen-minute features require 195 minutes of contiguous lookback
plus a boundary anchor. Raising a limit in the frozen collector would make
historical evidence unreadable under its exact source-hash contract. A separate
revision preserves that evidence and allows an explicit compatibility review.

**Limits:** Source duplication is deliberate until a reviewed archival migration
exists. Relative clock consistency and coarse source liveness cannot establish
absolute clock accuracy or per-instrument health. Review a fresh short smoke
before committing resources to long sessions. Rotation, repair, reconnect,
cross-session stitching, scoring, and promotion remain absent. See
`docs/runbooks/research-long-capture.md` and `TECH_DEBT.md`.

## ADR-013 — Preserve target history while explicitly retiring failed research guards

**Decision:** A separate capture revision permanently retires a disconnected,
errored, or timed-out guard source, records the outage, and continues the
uninterrupted Binance target stream. Completed sessions with retired/missing
guards are explicitly degraded. Target gaps/disconnects, invalid payloads,
clock failures, and storage failures remain fatal. No reconnect or repair is
introduced, and no model or public signal is enabled.

**Why:** The initial long warm-up stopped after 17 minutes when Kraken closed.
All-or-nothing guard capture prevents studying target feature warm-up despite
continuous target trades. Explicitly unavailable guards preserve honest
abstention and lineage without discarding valid independent target history.

**Limits:** Research-only numerical features are not healthy guarded inputs.
The prior runtime stalls and Kraken close lack an established causal link.
Production recovery/quorum, absolute clock accuracy, independent validation,
and model approval remain separate gates. Earlier collectors and incomplete
evidence stay unchanged. See `docs/runbooks/research-isolated-capture.md`.
