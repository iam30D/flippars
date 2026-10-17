# `@flippars/signal-core`

Pure TypeScript market aggregation and signal qualification for Flippars. The
package performs no network I/O and never places trades.

## Safety invariants

- Five- and fifteen-minute candles are fixed, half-open UTC windows.
- Coinbase `BTC-USD`, Kraken `XBT/USD`, and normalized Binance `BTCUSDT`
  require fresh quotes and a configurable venue quorum.
- Binance is excluded when the USDT/USD reference breaches its deviation gate.
- Live signals require a currently approved, calibrated model artifact.
- Demo and simulation artifacts can never masquerade as live data.
- Reversal alerts require current price to remain on the opposite side of the
  open from the predicted close.
- Fifteen-minute reversal alerts begin only in the final 10 minutes.
- Early five-minute direction alerts end at 60 seconds.
- One alert is emitted per signal type and UTC window.
- Abnormal-market risk suppresses forecasts; it never alleges intent.

## Main API

```ts
import {
  CandleTracker,
  SignalEngine,
  buildCompositeSnapshot,
  evaluateSignalOutcome,
  type CalibratedForecast,
  type ModelArtifact,
} from "@flippars/signal-core";

const snapshot = buildCompositeSnapshot({
  observedAt: new Date().toISOString(),
  dataMode: "LIVE",
  usdtUsdRate: "1.0000",
  quotes: [
    {
      venue: "COINBASE",
      symbol: "BTC-USD",
      price: "67001.25",
      eventAt: new Date().toISOString(),
    },
    {
      venue: "KRAKEN",
      symbol: "XBT/USD",
      price: "66999.90",
      eventAt: new Date().toISOString(),
    },
  ],
});

const candles = new CandleTracker().update(snapshot);
```

`SignalEngine.evaluate` returns a discriminated `SignalDecision`:

- `{ kind: "SIGNAL", signal, riskAssessment }`
- `{ kind: "ABSTAIN", reason, detail, audit, riskAssessment, ... }`

Abstention is the normal precision-first outcome. Persist emitted signals and
their audit metadata before delivery, then hydrate `SignalDeduplicator` from
that ledger after a process restart.
