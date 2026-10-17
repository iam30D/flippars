# Research capture quality and runtime evidence

## Scope

`research:audit-quality` independently verifies an immutable capture, streams it
again, and checks the second file digest/byte count before returning diagnostics.
It never returns a healthy-data verdict, loads a model, or modifies evidence.

```powershell
npm run research:audit-quality -- "C:\Users\HP\Flippars-ml\evidence\capture-v2-73ac0e6f30c948088d8c9be1fde0b1ca\capture-dSAUrg"
if ($LASTEXITCODE -ne 0) { throw "Capture quality audit failed" }
```

The bounded state tracks three sources, five instruments, three fixed timing
histograms, and each timeline's longest inter-data receipt gap. Instrument
inactivity cannot be hidden by another instrument on the same source. Unknown
and control packets cannot refresh data timelines. Initial wait and terminal
silence are measured with monotonic time. No raw trade arrays are retained.

Binance event/publication microseconds are compared using exact integer
differences before conversion to diagnostic milliseconds. Histogram bands and
one-/five-second counters are descriptive bins, not approved model thresholds.
Cross-clock differences are not transport-latency measurements. Quote-change
inactivity can be legitimate; absence of updates does not itself prove a broken
instrument, and aggregate activity does not prove freshness. Guard and absolute
clock verdicts remain `UNASSESSED`, including when every diagnostic looks quiet.

## Reviewed fresh smoke

The owner reported repository verification and the revised ten-minute smoke
completing. Session `a03af32a-a034-43be-92c1-1ef79afc9815` covers
2026-10-17T15:07:11.262Z through 15:17:11.310Z, with 4,589 Binance trades,
2,283 Coinbase packets, and 1,983 Kraken packets. Retained `replay-9BV2gN`
contains 74 scheduled decisions and eight outcomes, with matching integrity.
The ten-minute interval still cannot supply the required feature warm-up.

- File SHA-256: `409f682c083232aab390d86614f4b376d0af94e6892774b806a543f3eaa0b786`.
- Manifest SHA-256: `7376a808f9735f17918c71f4e3bdcc3c57f4f84a6e308c26ad598c5f35d96893`.
- Replay report SHA-256: `3d396f192afe9bb4dd278acecc5a60c75a869178fb8896fd40e657adfa5751f3`.

No Binance receive timestamp was more than 1 ms before its event time. The
receive-minus-event range is 94.809–19,503.087 ms; 171 observations exceed one
second and 22 exceed five seconds. Publication-minus-event ranges from 0.150
to 4.763 ms. The slowest observation was published 0.369 ms after its event and
received 19,502.718 ms after publication. These observations do not identify a
network, operating-system, storage, or application root cause.

Verified trade IDs remain contiguous: receipt silence followed by buffered
arrivals is not evidence that trades were lost. Causal replay must still exclude
those trades from decisions made before their recorded receipt times.

The longest source data gaps overlap around 15:09:25–15:09:46 UTC: Binance
21,219.0921 ms, Coinbase 19,678.5822 ms, Kraken 20,112.3026 ms. The owner reports
the laptop stayed awake and no changes were noticed. That rules out a noticed
manual interruption, not unobserved scheduling or network interruptions.
USDT instrument receipt gaps separately reach approximately 33 seconds despite
ongoing BTC activity; do not loosen production freshness rules or substitute
source activity for per-instrument evidence.

## Observe local collector responsiveness

The existing capture lacks process responsiveness measurements. The separate
`capture:market:observed` wrapper invokes the unchanged revision-two collector
while recording Node's built-in
[event-loop delay](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions)
and monotonic one-second callback intervals in the same process. It requires no
new dependency, installation, administrator access, or paid service.

The witness keeps a fixed histogram and the 32 largest callback intervals,
including their local UTC ranges. It reports unsampled startup/terminal limits
and monitoring overhead. Local timer delays can include scheduling, synchronous
work, storage, or system suspension; the witness does not equate them with CPU
utilization or prove an interruption's cause. A capture with no reproduced gap
does not prove network reliability or production readiness.

`runtime-witness.json` is exclusively created and synced inside the new capture
directory. Its exact serialized payload is hash-bound, with capture session,
completion state, file/manifest digests, and two observer implementation module
digests. Source and observer implementation bindings remain separate: the
original three/seven collector module contracts are unchanged. Incomplete
captures remain incomplete even if a witness is retained. A thrown startup or
hard process failure can leave no witness; do not claim responsiveness coverage
without it.

The separate integrity check is:

```powershell
npm run capture:market:observed -- --verify "C:\FULL\PATH\TO\CAPTURE"
if ($LASTEXITCODE -ne 0) { throw "Runtime witness verification failed" }
```

It verifies bounded files, UTF-8/schema, payload digest, and capture-manifest
binding. It does not replace `capture:verify`, authenticate an author, establish
data health, or sign model evidence. A person who can replace every evidence
file can replace self-recorded hashes.

## Next operator observation

### Completed instrumented smoke

The owner reported full verification and observed collection/audits completing.
Session `70d0fd67-ddac-434a-99a2-1db6cf68ae2c` contains 6,933 Binance trades,
2,688 Coinbase data packets, and 3,791 Kraken data packets. Source, runtime
witness, and retained `replay-VYnlRE` integrity re-verify; the report retains
63 scheduled decisions and eight target outcomes.

- Capture SHA-256: `b70740f907679c65f88dee4172db1a1d40f4cbfebf69e9d81e58059240b13312`.
- Manifest SHA-256: `f72fa7b7af7194fae58490649a85b5fcc05a349bb3f3510f6dde10229ac76b79`.
- Runtime witness SHA-256: `46f90dc90cf334ad99c9d54878c705654cf2c5bd8bc81dafba36c2592f516cae`.
- Replay report SHA-256: `f9857171c293746fd4fe75e75ae52083e2190685268c7d5ba87b50af9ae5532f`.

Receive-minus-event ranges from 119.872 to 416.282 ms, with no observations
over one second or more than 1 ms before the event. Receive-minus-publication
ranges from 119.611 to 416.027 ms. The longest source data gaps are Binance
4,973.098 ms, Coinbase 3,512.6474 ms, and Kraken 5,120.0206 ms. These are
diagnostic receipt observations, not measured network latency or production
freshness approvals.

The event-loop monitor observed 18,782 samples, a maximum of 353.894399 ms,
and p99 of 77.922303 ms. Of 595 nominal one-second callback intervals, the
longest was 1,066.0282 ms; the terminal unsampled tail was 325.5157 ms.
No comparable 20-second interruption was recorded in this session. This does
not retrospectively establish the cause of the earlier interruption.
USDT receipt gaps still reach 23,329.9751 ms (Coinbase) and 38,239.3545 ms
(Kraken), reinforcing that ticker inactivity and per-instrument health need
an independently reviewed contract.

This is sufficient to attempt the longer **research** warm-up using the same
unchanged collector and observer. It is not a healthy-data sign-off, model
approval, or prospective shadow evidence. Reuse the passing repository
verification; another mobile export provides no additional timing evidence.

### If another diagnostic smoke is needed

Run full verification before the new live wrapper smoke. Use a new exclusive
external parent and `capture:market:observed -- --output-parent <parent>
--seconds 600 --max-mib 256`. After completion run `capture:verify`,
`research:audit-quality`, and witness verification against the one new session.
Preserve summaries and files for correlation before committing 225 minutes to
warm-up. Avoid unrelated heavy work during collection; do not change the host's
power, time-source, VPN, or network settings automatically.

The next release work is still measured absolute clock accuracy, a reviewed
per-instrument guard contract, stable long-session evidence, and prospective
recording of a frozen candidate that passes the model gates. No public signal
or prospective validation credit is produced here.
