# Full-population research replay

## Purpose and acceptance

`research:replay-capture` evaluates every governed decision time in one verified
capture and records every overlapping target window, including abstentions,
empty windows, flat labels, and unfinished outcomes. This extends the earlier
three-snapshot audit. It neither loads models nor emits public signals.

Acceptance requires exact schedule coverage, causal event/receipt cutoffs,
batch-reference parity after warm-up, immutable evidence outside Git, and failure
on corrupted or incomplete evidence. The shared domain math and API/mobile
contracts are unchanged. All reports explicitly deny production eligibility and
prospective validation credit.

## Operator command

Run full repository verification after an implementation change. Then replay an
existing capture into an existing external evidence parent:

```powershell
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath "C:\Users\HP\Downloads\Flippars"

npm run research:replay-capture -- "C:\Users\HP\Flippars-ml\evidence\market-captures\capture-b5HjNi" "C:\Users\HP\Flippars-ml\evidence"
if ($LASTEXITCODE -ne 0) { throw "Population replay failed" }
```

Each successful run creates a distinct `replay-*` directory containing
`report.json` and `manifest.json`. Preserve incomplete directories for diagnosis;
do not infer completion from the report file alone. To check a retained result:

```powershell
npm run research:replay-capture -- --verify "C:\Users\HP\Flippars-ml\evidence\replay-REPLACE_WITH_RESULT"
if ($LASTEXITCODE -ne 0) { throw "Replay evidence integrity check failed" }
```

The verifier checks bounded files, UTF-8, report digest/bytes, envelope/count
consistency, research flags, and completion metadata. This is an integrity
check, not independent verification of each decision's mathematical semantics,
trusted authorship, or production approval. An attacker who can replace both
files can replace their hashes; signing and independent retention remain future
release work.

## Scheduling and outcome semantics

- The replay interval uses the verified session start and end, including
  scheduled decisions exactly at either endpoint. Outcome windows intersect
  the half-open session interval; unfinished windows remain explicit.
- Five-minute early direction uses offsets 15, 30, and 45 seconds. Five-minute
  reversal uses 15 through 285 seconds every 15 seconds. Fifteen-minute reversal
  uses 300 through 870 seconds every 15 seconds. These research sampling offsets
  follow the existing versioned policy; they do not redefine product eligibility.
- Advance all due snapshots before ingesting a packet whose receive timestamp
  is equal to or later than the decision. Repeated timestamps cannot change an
  already recorded decision. Exchange events must also precede the decision.
- Missing packets do not remove scheduled decisions. Missing warm-up or empty
  candles cause recorded abstentions. Future exchange events wait in the
  existing bounded feature queue.
- Outcome populations share a validated trade prefix and retain only opening
  and closing prices per target plus global boundary evidence. Only receipts
  strictly before the session end enter outcomes. Targets require both boundary
  anchors; empty and unfinished targets are retained as abstentions.
- Record IDs bind target/window/offset. Many candidate decisions can exist for
  one target window. They are not public signals or independent alert windows;
  no one-alert policy is bypassed and no evaluation denominator is fabricated.

## Bounds and evidence

Replay accepts at most four hours per interval, 2,000 scheduled decisions,
64 outcome windows per type, and 32 MiB per report. Input files remain bounded
to 1 GiB with 512 KiB lines. Each feature engine retains fourteen candles and a
100,000 pending-event limit. Limits fail closed; there is no silent truncation.

The original revision-one recorder remains limited to one hour. The separate
[revision-two collector](research-long-capture.md) supports continuous captures
up to 225 minutes with explicit clock/liveness checks and no stitching.
A one-hour capture cannot supply the existing
65-minute lookback for five-minute targets or 195-minute lookback for fifteen-minute
targets. Fresh revision-two evidence must be reviewed before complete feature
populations become available; successful integrity checks do not prove health.

Source integrity is verified first, then a second streamed read must match its
file digest and byte count. The completed report is written with exclusive
creation and file sync. Its completion manifest is written and synced last,
binding report bytes/digest, source session/file/manifest digests, population
counts, and eight implementation module digests checked before and after replay.
New runs never overwrite previous evidence. Filesystem sync and a completion
marker do not replace backup, power-loss testing, signatures, or access controls.

## Remaining release work

The existing ten-minute session was replayed read-only during implementation:
8,103 trades produced 63 scheduled decisions (38 five-minute reversals,
19 fifteen-minute reversals, and six early-direction decisions) and eight target
outcomes. All feature decisions abstained for insufficient history. Source file
and manifest hashes matched the earlier integrity evidence. This smoke supplied
neither new clock/data-health evidence nor prospective model predictions.

Per-instrument data health and measured clock accuracy remain unassessed. Add
reviewed longer capture/segment continuity and independently challenge numerical
parity before introducing a frozen model into prospective shadow recording.
Retrospectively replayed data cannot start or satisfy the prospective validation
period. Model performance, approval, native-device, infrastructure, privacy,
security, and App Store gates remain unchanged.
