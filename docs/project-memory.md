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

- 2026-10-17: Owner's long warm-up ended `INCOMPLETE` after approximately
  17 minutes with `KRAKEN_DISCONNECTED` (session
  `aff8197c-5c50-40f7-b571-fdf2515f6043`). Its file/witness hashes check; do not
  resume or relabel it. A 5.8-second event-loop sample occurred several minutes
  before the terminal close; no causal link is established. Added a separate
  revision-three collector that permanently retires failed guard feeds while
  preserving uninterrupted target history, with explicit degraded completion
  and unavailable-source metadata. Target/clock/storage failures remain fatal.
  Twenty targeted isolation, integrity, runtime and replay tests pass, including
  the zero-initial-guard-data case. Strict API types/scoped lint pass; prior
  runtime and replay evidence still verifies. Owner full verification and a
  fresh revision-three research capture remain pending. See
  `docs/runbooks/research-isolated-capture.md`.

- 2026-10-17: Owner reported full verification and observed capture/audits
  completing. Session `70d0fd67-ddac-434a-99a2-1db6cf68ae2c` and retained
  `replay-VYnlRE` re-verify: 6,933 trades, 63 decisions/eight outcomes. No
  sufficiently negative clock pairs or Binance event/publication-to-receipt
  differences over one second. Event/receipt range 119.872–416.282 ms; maximum
  event-loop sample 353.894399 ms, longest nominal one-second callback
  1,066.0282 ms. The prior 20-second interruption did not reproduce; its cause
  remains unknown. USDT receipt inactivity remains visible and is not a health
  approval. Proceed to an explicitly User-run 225-minute observed research
  warm-up, reusing unchanged passing code verification. No new build, model
  enablement, or prospective evidence credit is warranted by these findings.

- 2026-10-17: Owner completed the revision-two live smoke and full verification.
  The fresh 4,589-trade session and retained `replay-9BV2gN` verify: 74 scheduled
  decisions/eight outcomes, no sufficiently negative event/receipt clock pairs.
  Found overlapping 20–21-second source data gaps and 22 trades received over
  five seconds after publication. Owner noticed no sleep or network changes;
  cause remains unestablished. Added bounded per-instrument/timing diagnostics
  and a separate runtime-witness wrapper; collector source contracts remain
  unchanged. Sixteen unique targeted quality, capture verification, socket and
  witness tests pass, including a deliberate scheduling stall and an observed
  local capture through verified replay. Strict API typechecking and scoped lint
  pass. Owner full verification and the instrumented live observation subsequently
  completed; the reviewed result is recorded above and in the quality runbook.

- 2026-10-17: Owner reported full verification and population replay completing.
  Retained `replay-ZZllRc` contains 63 decisions/eight outcomes, bound to the
  unchanged original capture. Added a separate 225-minute collector revision
  with strict UTF-8, relative clock consistency, and source-liveness checks.
  Revision-one source files and evidence remain unchanged. Local socket,
  compatibility, liveness and clock-boundary coverage totals thirteen passing
  targeted tests, together with strict API types, scoped lint, formatting and
  repository secret checks. Historical source hashes are unchanged; both the
  original capture and retained replay report re-verify successfully. Windows still reports
  leap indicator 0 and stratum 5; absolute accuracy remains unassessed. Final
  owner full verification and the revised live smoke subsequently passed;
  independent clock/provider health review remains pending.

- 2026-10-17: Owner reported full repository verification passing for bounded
  capture feature/outcome replay, including the iOS export. Added full-population
  research scheduling and immutable external report/manifest evidence. All due
  decisions, abstentions, empty windows, flat labels, and unfinished outcomes
  remain visible. Twelve targeted scheduler/evidence/capture tests, strict API
  typechecking, and scoped lint pass. The unchanged 8,103-trade capture replays
  to 63 scheduled decisions (all insufficient-history abstentions) and eight
  target outcomes with the original source hashes. Operator full verification
  and creation of retained external evidence for this increment are pending.
  These retrospective reports confer no prospective shadow credit or approval.

- 2026-10-17: Connected verified capture ingestion to bounded research feature
  state and fixed-window outcomes. The file audit no longer retains a full trade
  array or imposes a total 100,000-trade cap; pending-event queues remain bounded.
  It still selects only three terminal decisions and three preceding outcomes.
  Twenty-eight targeted replay, integrity, and numerical tests pass, including
  outcome processing above the old batch limit. Final failure/immutability
  regressions and strict API typechecking pass. The existing 8,103-trade capture
  re-audits successfully with its original file/manifest hashes, the same
  insufficient-lookback abstentions, and retained flat five-minute outcomes.
  No model or alert was enabled. Owner full verification subsequently passed for
  this increment.
  Full-population replay, data/clock health, long-session continuity, durable
  outcomes, and prospective shadow evidence remain release work.

- 2026-10-17: Owner reported full verification passing for the rolling-feature
  increment, including the iOS export. Replaced whole-file capture audit reads
  with a bounded streaming reader and exact second-pass digest binding. The
  audit still retains at most 100,000 trades for batch feature/outcome evaluation;
  long-session replay integration remains pending. Twenty targeted reader and
  feature tests, API typechecking, scoped lint, and changed-file formatting pass.
  Public alerts remain disabled.

- 2026-10-17: Owner completed Windows resync; reported leap indicator 0 and
  stratum 5. A bounded public NTP probe shortly afterward estimated 265–269 ms
  offsets; clock accuracy remains unassessed. Added rolling research feature
  state with fourteen retained candle aggregates, bounded pending events,
  immutable cached decisions, and permanent abstention after source failure.
  Seventeen targeted batch/rolling tests pass; the owner subsequently reported
  full verification passing. Public model serving remains disabled.

- 2026-10-17: Owner reported full repository verification passing after the
  streaming verifier addition. Added research-only causal feature/outcome
  builders and a bounded capture audit. All 24 features match three synthetic
  Python-reference cases; eleven targeted groups, scoped lint, strict API
  typechecking, and repository policy checks pass. The real smoke's decision
  audit abstains for missing lookbacks and retains a flat five-minute outcome. The
  host reports an unsynchronized Windows clock; capture event/receive
  differences require investigation before further prospective validation.
  Full verification of this newest feature increment remains pending.

- 2026-10-17: Owner reported full verification and the first ten-minute market
  capture passing. Added a bounded streaming verifier and checked every record
  of the 15,414,117-byte session: 8,103 Binance trades, 2,356 Coinbase and 2,622
  Kraken data packets; both guard instruments were observed. Capture hashes,
  raw projections, continuity, source bindings, and terminal evidence pass.
  Five verifier test groups (including rehashed semantic corruption and
  truncation), strict API typechecking, scoped lint, and repository policy
  checks pass. Full verification after the verifier addition remains pending.
  Guard health, feature parity, and model readiness remain unestablished.

- 2026-10-17: Owner reported full verification passing for the research and
  diagnostic changes, including the 1,334-module iOS export. Added an isolated,
  bounded public trade/guard recorder with hash-linked external evidence and
  fail-closed continuity checks. Seven targeted recorder tests (including
  localhost socket success/gap scenarios), strict API typechecking, and scoped
  lint pass. Full verification after the recorder changes and operator live
  smoke remain pending; no model is scored or enabled.

- 2026-10-17: Researched official free public feeds, chronological model
  improvement, calibration, CPU challengers, AWS cost boundaries, and EAS
  delivery. Added `docs/model-recovery-research.md` and a bounded V4 evaluation
  diagnostic reader with safety tests. No artifacts or runtime policy changed.

- 2026-10-17: Reviewed the three completed `20260920.1` offline training
  runs. All remain DRAFT and production-ineligible; both reversals have
  negative diagnostic Brier skill and early-direction alert precision misses
  the governed point/lower-bound floors. See
  [training readiness review](training-readiness-review.md). Current full
  repository verification subsequently passed in the operator-reported run,
  including the iOS export. External release gates remain pending; this is
  not a signed native build or physical-device acceptance result.

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
