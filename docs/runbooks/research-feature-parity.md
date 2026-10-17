# Research feature and outcome parity

## Implemented scope

`apps/api/src/research/trade-features.ts` constructs diagnostic feature and
outcome records from validated, ordered individual trades. It includes a pure
batch reference and bounded rolling feature state, not an approved serving provider. The standalone
`research:audit-capture` command verifies an immutable capture before reading
its trade projections and binds the second read to the verified file digest.

```powershell
npm run research:audit-capture -- "C:\Users\HP\Flippars-ml\evidence\market-captures\capture-REPLACE_WITH_SESSION"
```

The command streams files up to 1 GiB with bounded 512 KiB lines, strict UTF-8,
and a second-pass digest check before returning results. The file adapter now
feeds bounded feature state and fixed-window outcome accumulators, without a
total-trade-count limit. Each feature queue still has a hard 100,000 pending-event
limit; exhaustion fails closed. The separate batch reference retains its
100,000-trade limit. Longer/live populations still need the reviewed long-session
capture workflow and full-population scheduling. It never loads
a model, reports probabilities, publishes signals, or calls APNs.

## Causal and numerical rules

- Five-/fifteen-minute windows align to UTC epoch and are half-open. The exact
  signal-specific cadence, phase, and lead floors match sampling policy v2.
- Features require a preceding boundary anchor and thirteen contiguous,
  nonempty completed candles. Missing windows, current partials, malformed
  inputs, and trade ID/time regressions cause abstention; no prices are created.
- Exchange event timestamps retain microseconds. Only `eventAt < decisionAt`
  trades may enter the partial candle.
- Only `receivedAt < decisionAt` trades are available. Equality is deliberately
  excluded because capture receive times have millisecond precision and cannot
  establish ordering inside that millisecond. Later packet bodies cannot affect
  an earlier feature calculation. This conservative research availability rule
  does not retroactively claim receive-time parity for historical archives.
- Outcomes require receipt-time availability, a closed target, and observed
  trades on both sides of its boundaries. The open is the first trade at or
  after its start and close is the last trade before its end.
- The current experiment's five-basis-point deadband uses exact integer-scaled
  decimal comparisons. Equality stays `AT_OPEN`; that outcome remains visible.
- The 24 numerical features mirror the current Python definitions, including
  population standard deviation, zero-range location 0.5, and elapsed-rate
  normalization. Prices/quantities cross the input/output boundary as strings;
  numerical feature arithmetic follows the baseline's floating-point approach.
- Stable research IDs bind signal type/window/decision offset. Feature records
  declare target, feature, schedule policy, deadband, cutoff, and included trades.
  `candidateEligible` is the training-time timing/current-relation precheck,
  not final model-direction eligibility or permission to emit a signal.

All outputs remain `productionEligible: false`. Guard health is unassessed;
cross-venue guards are not supplied to the feature builder.

## Synthetic reference evidence

`scripts/write-trade-feature-fixture.py` imports the existing offline pipeline
to create three small synthetic cases, one for each target. It does no fitting,
downloading, or market-data processing. Its output is the reviewed synthetic
fixture `apps/api/test/fixtures/trade-feature-parity.json`, not a trained artifact.
Tests bind the fixture to the exact pipeline SHA-256 and check every feature
with tolerance `1e-10 * max(1, abs(reference))`.

Eleven targeted test groups cover the three Python-reference cases, exact
microsecond cutoffs, same-millisecond/late receipt exclusion, future-body
independence, boundary anchors, missing windows, trade gaps, all signal
schedules, closed outcomes, decimal deadband equality, zero-range candles,
empty windows, and the invariant that available features confer no approval.

Refresh references only after reviewing a pipeline-definition change. Use the
existing approved Python environment with bytecode writing disabled, and inspect
the synthetic diff. The refresh script accepts only its exact repository fixture
path. Do not regenerate evidence to hide a failing holdout or change thresholds.

These cases are numerical regression evidence, not an exhaustive proof over
every possible decimal, regime, provider failure, or runtime. Broader independent
parity review remains mandatory before serving.

## Rolling feature state

`ResearchFeatureStream` shares the batch builder's numerical definitions while
retaining at most fourteen candle aggregates plus a bounded pending-trade queue.
The default queue limit is 100,000 and callers may only lower it. Consumed
trades are discarded from memory after aggregation; source capture evidence
remains immutable outside this state object.

Feed records chronologically and request each scheduled snapshot before
ingesting later receipts. The engine processes only the strict event/receive
prefix available at that cutoff. Known future exchange events wait in the
pending queue. Once state advances, a request for an older, uncached decision
abstains instead of reconstructing it from later information. A repeated latest
snapshot returns a copy of the original result, including after later failures.

Trade ID/time/receipt regressions, invalid inputs, and pending-queue exhaustion
poison future results; there is no silent reset or automatic repair. Start a new
explicit stream and complete its warm-up after an incident. Missing candles
remain gaps and cannot be replaced with carry-forward prices.

Six rolling-state test groups compare against the Python-backed batch cases,
test successive immutable snapshots and future event-time buffering, assert
bounded state over 200 synthetic windows, and challenge continuity, queue
exhaustion, and missing-window behavior. Together with the eleven batch/audit
groups, seventeen targeted tests cover the feature-state foundation.

`ResearchCaptureReplay` now connects verified file ingestion to this state. The
first verification pass identifies the last trade receipt; the second pass
freezes each selected decision before the first receipt at or after its cutoff.
Only after the second file digest matches does the command return a report.
Returned decision copies cannot alter subsequent snapshots. Invalid replay
inputs permanently reject further processing.

`ResearchOutcomeStream` evaluates one fixed target with a fixed receipt cutoff,
retaining one previous trade, opening/closing prices, and boundary-anchor flags.
It shares exact label construction with the batch reference, preserves flat
labels, and abstains for gaps, missing anchors, or empty targets. It does not
persist outcomes or revise the cutoff after construction.

Replay tests compare complete reports with batch results across target boundaries
and schedules, challenge equal/later receipts and permanent failures, and process
over 100,000 synthetic trades through the outcome accumulator. A synthetic
capture also exercises the verified file-to-replay path. This command still
reports only three selected decisions and three preceding target outcomes;
full-population scheduling, durable outcome persistence, long-session capture,
and the shadow ledger remain separate release work.

## First live capture audit

The previously verified session `5b9040b4-4a37-4bb2-adfe-7a55c5af6af3` was read
without modification. All three selected feature decisions abstain with
`INSUFFICIENT_BOUNDARY_ANCHOR`, as a ten-minute capture cannot supply the
thirteen-candle warm-up. One fully covered five-minute target retains its flat
outcome; the previous fifteen-minute target lacks complete boundary coverage
and abstains. No model was loaded or scored.

After the bounded file-to-replay integration, this same 8,103-trade session was
re-audited successfully. The file and manifest hashes, selected abstentions,
clock diagnostics, and retained outcomes match the earlier batch report. This
confirms the smoke regression; it supplies no additional warm-up or health evidence.

The audit also compares two observed clocks rather than reporting transport
latency. Across 8,103 trades, `receivedAt - eventAt` ranges from -113.608 ms to
968.7 ms, with 6,396 differences below -1 ms. Sub-millisecond negative values
can arise from receive timestamp quantization; these larger discrepancies need
investigation. They do not identify a technical cause by themselves.

A separate read-only host query reported Windows Time running automatically,
but `w32tm /query /status` reported leap indicator `3 (not synchronized)` and
stratum `0`. That establishes a host synchronization issue at query time, not
the exact offset throughout the earlier capture. Preserve the capture as
research evidence and do not label it healthy prospective model evidence.

Clock resynchronization is an administrator-level User-run operation under
`AGENTS.md`. Microsoft documents `w32tm /resync` against the configured time
source and `/query /status` for checking the result:
[Windows Time tools](https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/Windows-Time-Service-Tools-and-Settings).
Do not silently offset recorded timestamps or rewrite the existing session.

The first recovery action uses the already configured time source. Open
PowerShell as Administrator and run this User-run operation:

```powershell
& {
    $ErrorActionPreference = "Stop"
    Set-Location -LiteralPath "C:\Users\HP\Downloads\Flippars"

    Write-Host "Requesting Windows clock resynchronization..." -ForegroundColor Cyan
    w32tm.exe /resync
    if ($LASTEXITCODE -ne 0) {
        throw "Clock resynchronization failed. Share this error before changing time-source settings."
    }

    $clockStatus = w32tm.exe /query /status
    if ($LASTEXITCODE -ne 0) { throw "Clock status query failed." }
    $clockStatus | Select-String -Pattern "Leap Indicator|Stratum|Root Delay|Root Dispersion|Last Successful Sync Time" |
        ForEach-Object { $_.Line }

    $clockText = $clockStatus -join "`n"
    $leap = [regex]::Match($clockText, '(?m)^\s*Leap Indicator:\s*([0-3])\b')
    $stratum = [regex]::Match($clockText, '(?m)^\s*Stratum:\s*(\d+)\b')
    if (-not $leap.Success -or -not $stratum.Success) {
        throw "Clock status format was not recognized. Share the displayed status."
    }
    if ([int]$leap.Groups[1].Value -eq 3 -or
        [int]$stratum.Groups[1].Value -lt 1 -or [int]$stratum.Groups[1].Value -gt 15) {
        throw "Clock synchronization remains unconfirmed. Share the status above."
    }

    Write-Host "Windows reports synchronization. Share the status for review." -ForegroundColor Green
}
```

This checks the English status fields observed on the current host. A successful
resync/status response still does not establish the eventual production clock
accuracy floor; measure that independently. Keep repository verification in the
ordinary development shell rather than running package lifecycle commands as
Administrator.

### Recovery evidence

The owner subsequently reported a successful resync with leap indicator 0,
stratum 5, root delay 0.1159850 s, and root dispersion 8.0350578 s. This clears
the reported unsynchronized service state; it does not establish an accuracy
bound suitable for model decisions.

A bounded, read-only five-sample probe against Microsoft's public time server
shortly after that operation estimated offsets of approximately 264.621–268.515
ms. Those observations include network effects and are not exact local-clock
error measurements. Microsoft documents both offset probing and gradual
clock-rate correction for sufficiently small offsets in the linked tools guide.
Collect fresh clock and market evidence before accepting live guard health;
preserve the original unsynchronized capture unchanged.

## Remaining path

Full-population retrospective scheduling and immutable external reports are now
implemented separately in [the population replay runbook](research-population-replay.md).
The original three-snapshot audit remains available as a reference diagnostic.

Measure clock accuracy and add explicit per-instrument guard assessment.
Implement reviewed longer/rotated capture with verified segment continuity,
and durable prospective model/outcome recording. Then validate full-population
policy replay and an isolated prospective shadow ledger. Existing model
performance/approval gates remain unchanged; the offline candidates still fail
production eligibility.
