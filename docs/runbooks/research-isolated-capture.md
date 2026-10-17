# Capture with guard-source failure isolation

## Trigger and acceptance

The attempted 225-minute session `aff8197c-5c50-40f7-b571-fdf2515f6043`
ended after approximately 17 minutes and four seconds with
`KRAKEN_DISCONNECTED`. It remains `INCOMPLETE`; do not resume, relabel, or stitch
it into a successful session. The retained file digest is
`9e2db8f6f1c57196ca00f01aaf0da1565ad18c5e4ae3988b48779a72204a3a34`.

Kraken's last data receipt was 2026-10-17T16:20:28.652Z; terminal disconnection
was recorded at 16:20:32.556Z. The runtime witness also reports a 5,783.945215 ms
event-loop maximum and a worst one-second callback interval of 6,690.1219 ms,
at 16:08:29.210Z–16:08:35.900Z. These occurred at different times; they do not
establish a causal link. The older collector did not record a WebSocket close
code, so that detail cannot be recovered retrospectively.

Revision three isolates guard-source availability from continuous Binance
target capture. Acceptance requires continued Binance IDs after a guard drop,
explicit degraded completion and source binding, reader rejection of hidden
outages or data after retirement, unchanged target/clock/storage failure
behavior, and historical-reader compatibility. No product emission, model,
confidence, target, or calibrated threshold changes are authorized by this work.

## Contract

`capture:market:isolated` uses manifest revision three and seven separately
bound collector modules. The original revision-one and revision-two collector
files remain intact. Source subscriptions, maximum 225-minute duration, 1 GiB
storage cap, exact trade timestamps/decimals, relative clock checks, and runtime
witness are preserved.

- A Coinbase/Kraken disconnect, connection error, or source data timeout writes
  one `GUARD_UNAVAILABLE` record. It includes source, UTC/monotonic receipt,
  fixed reason code, and a close code when observed. Provider text, headers,
  credentials, and exception strings are not logged.
- The source is retired for the remainder of the session. No reconnect, late
  packet acceptance, manufactured quote, or continuity repair occurs. A new
  explicit session is needed to attempt that guard again.
- Binance continues if its trade IDs/times and data liveness remain valid.
  Binance disconnect, missing target data, ID/time regression, clock/storage
  failure, invalid known payloads, or operator interruption still make the
  entire session incomplete. Malformed guard payloads remain fatal too.
- Normal duration completion with retired/missing guard data is
  `CAPTURED_DEGRADED_GUARDS`, with the exact unavailable source list. Normal
  completion without recorded/missing guard sources is `CAPTURED`. Neither
  status establishes per-instrument freshness, quorum, clock accuracy,
  anomaly/OOD health, full guard coverage, model approval, or prospectiveness.
- Verification requires Binance source liveness; it preserves the explicit
  guard outage rather than requiring an unavailable guard to keep sending data.
  Retirement is permanent: reconnects and any packet after retirement fail
  verification. Manifest completion/source lists must match records and counts.
- Replay evidence now includes optional source completion and unavailable-guard
  metadata. Historical evidence without those fields still verifies. Research
  decisions remain `productionEligible: false` with `guardVerdict: UNASSESSED`.
  Available mathematical features do not make a signal eligible for emission.

This collector is a diagnostic feature/availability foundation, not a production
recovery service. Production guard reconnection, independently assessed healthy
quorum, and per-decision guard attachment remain separate release work.

## Operator use

Run full repository verification after this revision change. The next warm-up
must be a fresh external session using:

```powershell
npm run capture:market:isolated -- --output-parent "C:\EXISTING\EXTERNAL\PARENT" --seconds 13500 --max-mib 1024
if ($LASTEXITCODE -ne 0) { throw "Target capture incomplete; preserve the session." }
```

The command records runtime evidence automatically and returns zero for either
completed research status. Review the status and unavailable guard list rather
than treating exit zero as healthy data. The terminal summary identifies the
new folder. Run `capture:verify`, `capture:market:observed -- --verify`,
`research:audit-quality`, and `research:replay-capture` against that exact folder.
Keep the machine awake and connected and preserve any incomplete artifacts.

Local socket tests force a guard close, confirm subsequent Binance trades are
retained, and verify degraded replay/witness binding. They also challenge target
gaps/disconnects, normal completion, and rehashed artifacts that hide guard
outages or append data/reconnections after retirement. These tests do not claim
that the original Kraken failure is fixed or that local processing stalls cannot
recur.
