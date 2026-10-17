# Longer isolated research capture

## Purpose and compatibility

`capture:market:long` is a separate collector revision for a single continuous
session of up to 13,500 seconds (225 minutes) and 1,024 MiB. This can provide
the 65-minute lookback for five-minute targets and 195-minute lookback for
fifteen-minute targets, plus boundary padding
and a short evaluation tail, if data remains continuous. It is research input,
not a production feed, model prediction service, or prospective shadow ledger.

The original `capture:market` command and its three exact source files remain
unchanged. Historical revision-one captures retain their existing hashes and
one-hour limit. Revision two uses `flippars.market-capture-manifest/2`, binds
seven collector modules, and adds its revision to the session-start record.
The unchanged hash-linked packet envelope remains `flippars.market-capture/1`.
The verifier dispatches by manifest revision and rejects mismatched start
markers, incomplete module bindings, and attempts to relabel revision-two
evidence as revision one. No allowlist of arbitrary historical code hashes is
introduced. Preserve all bound source revisions with evidence; future changes
to these collector modules require an explicit reader compatibility review.

## Additional failure checks

The existing three venues, subscriptions, trade continuity checks, storage
bounds, and no-reconnect policy are preserved. Revision two additionally:

- Rejects malformed UTF-8 rather than replacing bytes during decoding.
- Rejects backwards wall or monotonic time, and absolute divergence greater
  than 1,000 ms between wall-clock elapsed time and monotonic elapsed time
  since session start. Equality is allowed. This is a relative consistency
  limit, not an allowed absolute clock error for model decisions.
- Checks source liveness when processing packets and completing duration,
  as well as on the watchdog. A delayed timer or suspended computer cannot
  turn a stale final session into successful completion merely by expiring
  the duration timer first.
- Rechecks relative clock consistency in the independent capture reader.
  Complete revision-two evidence cannot contain a source data gap exceeding
  31 monotonic seconds, including startup and the terminal tail. The one-second
  reader allowance accounts for the recorder watchdog cadence. This coarse
  source-liveness test does not assess each instrument, event freshness,
  spreads, stablecoin health, venue quorum, or absolute clock accuracy.

All failures retain incomplete evidence and require a new explicit session.
Do not repair, reconnect, stitch, or silently reset a failed session. Sleep,
clock correction, network instability, or high market volume can prevent
completion. No setting changes or power-management changes happen automatically.

## First live smoke

After full repository verification, first run the new revision for ten minutes
and review clock/data evidence before spending 225 minutes on warm-up. The
operation is User-run under `AGENTS.md`: it makes public network connections
and writes private research evidence outside Git.

```powershell
& {
    $ErrorActionPreference = "Stop"
    Set-Location -LiteralPath "C:\Users\HP\Downloads\Flippars"

    Write-Host "Verifying repository..." -ForegroundColor Cyan
    npm run verify
    if ($LASTEXITCODE -ne 0) { throw "Repository verification failed: $LASTEXITCODE" }

    $evidenceParent = "C:\Users\HP\Flippars-ml\evidence"
    $operationParent = Join-Path $evidenceParent ("capture-v2-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $operationParent | Out-Null

    Write-Host "Recording ten minutes with collector revision two..." -ForegroundColor Cyan
    npm run capture:market:long -- --output-parent $operationParent --seconds 600 --max-mib 256
    if ($LASTEXITCODE -ne 0) { throw "Capture incomplete. Preserve evidence in $operationParent and share the summary." }

    $sessions = @(Get-ChildItem -LiteralPath $operationParent -Directory -Filter "capture-*")
    if ($sessions.Count -ne 1) { throw "Expected exactly one newly created capture session." }
    $sessionPath = $sessions[0].FullName

    Write-Host "Verifying and auditing the fresh capture..." -ForegroundColor Cyan
    npm run capture:verify -- $sessionPath
    if ($LASTEXITCODE -ne 0) { throw "Capture integrity verification failed." }
    npm run research:audit-capture -- $sessionPath
    if ($LASTEXITCODE -ne 0) { throw "Research clock/feature audit failed." }
    npm run research:replay-capture -- $sessionPath $evidenceParent
    if ($LASTEXITCODE -ne 0) { throw "Population replay failed." }

    Write-Host "Revision-two smoke and replay completed. Share the final summaries." -ForegroundColor Green
}
```

Do not interpret a successful audit exit code as a passing clock or provider
health gate. The audit reports diagnostic comparisons of clocks, and still
marks clock/guard verdicts unassessed. Do not rewrite timestamps in old captures
after synchronization. The new smoke must be reviewed before the long run.

## Longer run after smoke review

The first 225-minute attempt ended after 17 minutes when Kraken disconnected.
Use [revision-three failure isolation](research-isolated-capture.md) for the
next target warm-up; keep that revision-two evidence incomplete and preserved.

The first revised smoke exposed coincident 20–21-second receipt gaps. Before
the long run, collect [quality and runtime evidence](research-capture-quality.md)
to investigate responsiveness; a successful coarse watchdog does not establish
healthy inputs.

After reviewing fresh timing evidence and any failures, use the same operation
with `--seconds 13500 --max-mib 1024` and a new exclusive parent. Reuse an
unchanged passing repository verification result. This requires approximately
three hours and 45 minutes, continuous connectivity, and up to 1 GiB of capture
storage plus bounded replay evidence. Capture/replay duration limits are
compatible, with headroom for normal shutdown overhead. A storage cap, provider
incident, or clock discontinuity still makes the session incomplete.

The full-population replay can then show which targets actually have sufficient
history. It cannot make the existing trained candidates pass performance gates,
establish commercial data rights, or replace independent prospective validation.
Segment rotation, cross-session continuity, retention/backup, per-instrument
guards, measured absolute clock health, and signed promotion remain release work.
