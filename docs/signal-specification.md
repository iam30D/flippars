# Signal Specification

## Current display reference and governed forecast target

The current API and mobile display reference remains a quality-screened
BTC/USD composite:

- Coinbase `BTC-USD`
- Kraken `XBT/USD`
- Binance `BTCUSDT`, multiplied by an independently observed USDT/USD rate

Only fresh venues contribute. A production-quality composite requires three
healthy venues; an explicitly degraded two-venue quorum may display a price but
cannot emit a signal unless the approved policy says otherwise. A stablecoin
deviation or missing conversion removes Binance from the reference calculation.

The additive historical `flippars.multinomial-candidate/3` and gap-aware
`flippars.multinomial-candidate/4` research contracts instead bind
forecast features and outcome truth to Binance Spot `BTCUSDT` public trades.
Coinbase, Kraken, and USDT/USD remain independent health, anomaly, and display
guards; they are not blended into this target. This contract does not relabel
the current `BTC-USD` API, provide a live model, or enable a signal. A future
serving migration must consume the Binance public trade stream for feature and
outcome parity, pass the cross-venue guards, and version any user-visible
instrument change.

## Time and price semantics

- Windows align to the Unix UTC epoch.
- Five-minute boundaries occur at `:00`, `:05`, and so on.
- Fifteen-minute boundaries occur at `:00`, `:15`, `:30`, and `:45`.
- Windows are half-open: `[start, end)`.
- The current live composite continues to use its existing versioned open,
  current, and close methodology until a separately reviewed serving migration.
- V3 research windows order Binance trades by exchange event time and then trade
  ID. `O` is the first trade at or after the inclusive window start; the target
  close is the last trade before the exclusive window end. A candidate cannot
  be evaluated until `O` exists.
- V3 point-in-time features include only trades with
  `eventTime < decisionAt`. Archive data has no trustworthy receipt-time
  equivalent; a future live provider must retain event, receive, and processing
  time separately and apply the same causal event-time cutoff.
- A neutral band prevents immaterial crosses from becoming directions.
- With deadband `d`, `ABOVE_OPEN` requires return `> +d` and `BELOW_OPEN`
  requires return `< -d`. Equality at either boundary remains `AT_OPEN`; flat
  outcomes are retained in training and evaluation.

The governed candidate schedule is stored in the dataset and artifact rather
than inferred from signal type. The initial schedule samples every 15 seconds
and selects at most the first qualified decision per window. Five-minute
reversal offsets are `15..285` with a 15-second lead floor; early-direction
offsets are `15..45` with a 15-second floor; fifteen-minute reversal offsets
are `300..870` with the live policy's 30-second floor. Any schedule change
requires new versioned evidence and evaluation.

## Five-minute reversal

Let `O` be the target's five-minute open and `P(t)` its point-in-time price.

- Bearish eligibility: `P(t)` remains meaningfully above `O`, while the approved
  forecast estimates the close will finish meaningfully below `O`.
- Bullish eligibility: `P(t)` remains meaningfully below `O`, while the approved
  forecast estimates the close will finish meaningfully above `O`.

The signal is evaluated before the configured minimum remaining lead time. The
current price must still be on the original side at emission.

## Fifteen-minute reversal

The same opposite-side definition applies, but eligibility begins at `T+5m00s`
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
The neutral-band width in basis points is bound identically in the dataset,
artifact target, bundle manifest, and future runtime compatibility metadata; it
is an approved model-policy parameter, not a schema constant.
