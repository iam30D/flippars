# Research market capture

## Scope

The standalone `capture:market` command records Binance individual BTCUSDT
trades and raw Coinbase/Kraken ticker inputs for BTC/USD and USDT/USD research.
It never loads a model, connects to the application database, publishes a
signal, or calls APNs. No exchange credentials are accepted or needed.

Every capture is `RESEARCH_CAPTURE_ONLY`, `productionEligible: false`, with
`guardVerdict: UNASSESSED`. A completed capture is not prospective model
shadow evidence. Feature parity, outcome truth, stablecoin/quorum assessment,
provider permissions, receive-time causality, clock synchronization, and all
model approval gates remain separate work.

Source contracts checked 2026-10-17:
[Binance public streams](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md),
[Coinbase ticker](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels),
[Kraken ticker](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker).
Binance uses the market-data-only host and explicitly requested microseconds.
Coinbase uses its public Exchange endpoint, independently of the current
application's Advanced Trade adapter. Kraken requests best-bid/offer updates.
Public access does not settle commercial retention or redistribution rights.

## Operator smoke

For the separate longer collector and its compatibility/clock contract, see
[revision-two capture](research-long-capture.md). This original command and
its historical source hashes remain unchanged.

This is User-run: it opens external connections for up to ten minutes and writes
up to 256 MiB of research data. No download, install, training, or cloud service
is required. Keep all captures outside Git. The parent must already exist and
resolve outside any Git worktree; each invocation creates a new exclusive
`capture-*` child and never resumes or overwrites an old session.

```powershell
& {
    $ErrorActionPreference = "Stop"
    Set-Location -LiteralPath "C:\Users\HP\Downloads\Flippars"

    Write-Host "Verifying recorder changes..." -ForegroundColor Cyan
    npm run verify
    if ($LASTEXITCODE -ne 0) {
        throw "Repository verification failed with exit code $LASTEXITCODE"
    }

    $captureParent = "C:\Users\HP\Flippars-ml\evidence\market-captures"
    New-Item -ItemType Directory -Path $captureParent -Force | Out-Null
    Write-Host "Recording a bounded ten-minute research session..." -ForegroundColor Cyan
    npm run capture:market -- --output-parent $captureParent --seconds 600 --max-mib 256
    if ($LASTEXITCODE -ne 0) {
        throw "Capture incomplete. Preserve the session and share the terminal summary; do not delete or repair it."
    }

    Write-Host "Research capture completed; no model was enabled." -ForegroundColor Green
}
```

Share the terminal summary and verification result, not the market payload file.
The output identifies the session directory and `CAPTURED` or `INCOMPLETE`.
`CAPTURED` requires the requested duration to finish and at least one data packet
from each source. It does not guarantee both instruments were available, full
candle coverage, fresh event timestamps, quote integrity, or healthy data.

## Evidence format

- `events.jsonl`: each line has an exact JSON `payload` string and SHA-256 of
  that string's UTF-8 bytes. The payload binds the previous line's digest,
  sequential ordinal, session identity, local UTC receive timestamp, monotonic
  elapsed nanoseconds, scope flags, source, and record.
- Packet records retain the original public text payload without reserializing
  numeric tokens. Binance trades additionally preserve decimal strings, exact
  safe-integer IDs, buyer-maker direction, and six-digit fractional UTC event
  and publication timestamps. Unsupported units/unsafe integer IDs fail closed.
- `manifest.json`: terminal status, source packet counts, endpoint/subscription
  settings, capture limits, byte/record counts, file SHA-256, final chain digest,
  and SHA-256 of all three recorder source modules. This is integrity metadata,
  not an independent signature or a provider attestation.

The application callback timestamp is local receive time; monotonic elapsed
time exposes wall-clock ordering anomalies but does not synchronize the host.
The first observed trade has no prior-continuity claim. Subsequent trade IDs
must be consecutive and event times nondecreasing. A new invocation starts new
evidence and never claims continuity with a previous session.

## Failure and recovery

Invalid known payloads, trade gaps/duplicates/regressions, provider rejection,
shutdown/disconnection, thirty seconds without a data packet from a source,
disk cap, and write/sync failures stop the session. Unknown message types are
retained explicitly and cannot refresh the data watchdog. Control/heartbeat
packets also cannot substitute for data. Error strings from providers or socket
headers are never printed. Rejected public packet text is retained in private
capture evidence when the disk budget permits.

Writes are synchronous with a one-second sync cadence and a final sync. A hard
process/power/disk failure can leave a partial last line or no terminal manifest;
such a session is incomplete and must be quarantined. A storage write failure
cannot publish a successful file digest. Do not treat the record chain as a
signature or assume it prevents an operator from rewriting the entire file.

The recorder intentionally does not reconnect or backfill. Preserve the
failure, classify it, and use a new session only after resolving the cause.
Do not disable TLS, change public endpoints to proxies, use authenticated APIs,
renumber trades, or manufacture missing packets to make the smoke pass.

The byte cap applies to `events.jsonl`; the small terminal manifest is additional.
Per-message payloads are capped at 64 KiB, duration at one hour, and file budget
at 1 GiB. Captures accumulate across invocations: the operator owns total disk
usage and reviewed retention; no automatic deletion is provided. Windows ACLs
on the external parent determine access; POSIX mode bits do not enforce them.

The ten-minute smoke and one-hour duration cap cannot provide the full thirteen
completed lookback candles required by the current five-/fifteen-minute models.
Resource-reviewed segment rotation, continuity across segments, and longer
collection are required before building those feature populations. Do not
manufacture warm-up candles or claim a ready model from this smoke.

## Next implementation

The read-only `capture:verify` command now streams a completed capture:

```powershell
npm run capture:verify -- "C:\Users\HP\Flippars-ml\evidence\market-captures\capture-REPLACE_WITH_SESSION"
```

It validates the versioned manifest, supported endpoint contract, collector
source hashes, every record hash/previous link/ordinal, raw packet projection,
trade continuity, local timestamp ordering, requested duration, terminal record,
file hash/byte length, and per-source data counts. It uses bounded lines and
reports observed instruments without claiming guard health. Incomplete or
changed captures, symlinks at the root/files, and truncated tails fail closed.
The verifier waits for its stream handle to close even after a rejected line.

The three recorded collector source hashes must match the collector modules
beside the verifier. Keep the exact source revision with the evidence. A later
collector change requires an explicitly reviewed compatibility workflow; do
not rewrite historical manifests or add a bypass flag. This v1 reader is an
integrity check for local research, not an independent provider signature or a
defence against an operator rewriting every artifact. Run it against immutable,
quarantined session files and do not concurrently modify them.

### First live smoke evidence

The owner's 2026-10-17 ten-minute smoke completed, and local full-file streaming
verification subsequently passed for session
`5b9040b4-4a37-4bb2-adfe-7a55c5af6af3`:

| Evidence                       | Observed                                                           |
| ------------------------------ | ------------------------------------------------------------------ |
| Records / bytes                | 14,882 / 15,414,117                                                |
| Binance individual trades      | 8,103                                                              |
| Coinbase / Kraken data packets | 2,356 / 2,622                                                      |
| Instruments                    | Binance BTCUSDT; Coinbase and Kraken BTC/USD and USDT/USD          |
| File SHA-256                   | `4dc3ee4351d41f16e8b3eab6fab0a1e77c6722c233e714fa2198f223cb1b6506` |
| Manifest SHA-256               | `66afbf74c1914b91ae9dd56e9c127a9deadd0f1c97bb93b9fe3abc39cb22af73` |

The operator reported repository verification passing before that smoke and
again after the streaming verifier addition. This evidence establishes research capture
integrity and endpoint access at capture time, not production model readiness.

An initial bounded numerical feature/outcome builder now passes synthetic
Python-reference comparisons. Its real-capture audit also identified clock
differences requiring investigation; see [feature parity](research-feature-parity.md).
Next implement longer verified capture segments, streaming feature state, and
explicit clock/per-instrument guard health.
The public API remains on the disabled model provider until independently
accepted model and serving evidence exists.
