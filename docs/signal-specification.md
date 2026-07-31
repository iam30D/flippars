# Signal Specification

## Reference market

The default reference is a quality-screened BTC/USD composite:

- Coinbase `BTC-USD`
- Kraken `XBT/USD`
- Binance `BTCUSDT`, multiplied by an independently observed USDT/USD rate

Only fresh venues contribute. A production-quality composite requires three
healthy venues; an explicitly degraded two-venue quorum may display a price but
cannot emit a signal unless the approved policy says otherwise. A stablecoin
deviation or missing conversion removes Binance from the reference calculation.

## Time and price semantics

- Windows align to the Unix UTC epoch.
- Five-minute boundaries occur at `:00`, `:05`, and so on.
- Fifteen-minute boundaries occur at `:00`, `:15`, `:30`, and `:45`.
- Windows are half-open: `[start, end)`.
- Open, current, and close use the same versioned composite methodology.
- Event time and first-received time are retained.
- A neutral band prevents immaterial crosses from becoming directions.

## Five-minute reversal

Let `O` be the five-minute open and `P(t)` the current composite.

- Bearish eligibility: `P(t)` remains meaningfully above `O`, while the approved
  forecast estimates the close will finish meaningfully below `O`.
- Bullish eligibility: `P(t)` remains meaningfully below `O`, while the approved
  forecast estimates the close will finish meaningfully above `O`.

The signal is evaluated before the configured minimum remaining lead time. The
current price must still be on the original side at emission.

## Fifteen-minute reversal

The same opposite-side definition applies, but eligibility begins at `T+7m30s`
and ends at the configured minimum remaining lead time.

## Five-minute early direction

From the configured earliest observation through `T+60s`, the policy may emit
the first qualified forecast that the five-minute close will end meaningfully
above or below `O`.

## Qualification

All of the following must pass:

- Approved, enabled model and calibrator versions.
- Probability and uncertainty threshold.
- Freshness, sequence, clock, and venue quorum.
- Stablecoin conversion health.
- In-distribution/regime checks.
- Anomaly/manipulation-risk ceiling.
- Minimum excursion and neutral-band rules.
- Signal kill switch, lead time, and deduplication.

## Outcome

- `CORRECT`: close is beyond the predicted side's neutral boundary.
- `INCORRECT`: close is on the opposite directional side.
- `FLAT`: close is within the predeclared neutral band.
- `VOID`: a documented post-event integrity failure invalidates truth data.
- `PENDING`: the window has not finalized.

Every scheduled forecast and abstention is audit data. Evaluation uses the
actual first-threshold-crossing policy, not a retrospectively selected timestamp.
