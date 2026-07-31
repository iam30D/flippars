# Research and Standards Basis

Reviewed 2026-07-31. This document maps design decisions to primary sources. It
does not claim provider endorsement, standards certification, predictive
validity, profitability, or guaranteed delivery.

## Market data interfaces

| Decision                          | Primary-source basis and implementation boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Coinbase Advanced Trade WebSocket | Coinbase documents the public market-data endpoint, channel subscriptions, sequence behavior, and the `ticker`, `level2`, and `market_trades` channels in its [WebSocket overview](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview) and [channel reference](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels). The operational composite currently parses ticker quotes. Subscribing to Level 2 and trade channels is not evidence that those messages are yet processed into features. |
| Kraken Spot WebSocket v2          | Kraken defines separate [ticker](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker), [Level 2 book](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/book), and [trade](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade) channels. The book channel supplies snapshots, updates, and a CRC32 checksum. The operational composite currently parses ticker quotes; book/checksum recovery and trade-feature processing remain release gates.                                                                        |
| Binance Spot WebSocket            | Binance defines the [`<symbol>@bookTicker` stream](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams) as best-bid/ask price and quantity updates with an update ID. `BTCUSDT` is a USDT-quoted market, so treating it as a BTC/USD input requires a separate, fresh USDT/USD reference.                                                                                                                                                                                                                                                             |

The cross-venue median, venue quorum, freshness deadlines, quarantine rules, and
50-basis-point USDT deviation gate are Flippars risk policies. The provider
documentation does not prescribe those values or guarantee feed availability,
latency, continuity, or suitability for forecasting.

## Apple Push Notification service

- Apple specifies ES256 provider tokens and rejects tokens with an `iat` more
  than one hour old in [token-based APNs authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
  The 50-minute provider-token cache is an internal operating choice within that
  limit, not an Apple delivery guarantee.
- Apple documents HTTP/2/TLS transport, `apns-expiration`,
  `apns-collapse-id`, and best-effort delivery in [Sending notification requests
  to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
  APNs acceptance is not proof of delivery to a device, and expiration is honored
  on a best-effort basis.
- Apple states that a user can disable [Time Sensitive notification
  interruptions](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive).
  This interruption level may improve presentation behavior but cannot make
  delivery immediate or certain.

## Forecast evaluation and calibration

| Practice                           | Research basis and limit                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Score probability forecasts        | Brier's original [verification of forecasts expressed in terms of probability](https://journals.ametsoc.org/view/journals/mwre/78/1/1520-0493_1950_078_0001_vofeit_2_0_co_2.xml) supplies the basis for a quadratic probability score. Flippars' conditional baseline and minimum Brier-skill improvement are project choices.                                                                                  |
| Measure and calibrate confidence   | Guo et al.'s original [calibration study](https://proceedings.mlr.press/v70/guo17a.html) supports checking whether stated probabilities match observed frequencies and evaluating calibration methods. It does not establish an ECE threshold for financial signals or demonstrate a cryptocurrency forecasting edge.                                                                                           |
| Preserve chronology in evaluation  | Tashman's original [out-of-sample forecasting review](https://www.sciencedirect.com/science/article/abs/pii/S0169207000000650) examines rolling origins, recalibration, rolling windows, and multiple test periods. Flippars additionally purges target horizons and keeps calibration and final holdout periods separate as project safeguards.                                                                |
| Account for dependent observations | K&uuml;nsch's original [block-bootstrap research](https://projecteuclid.org/journals/annals-of-statistics/volume-17/issue-3/The-Jackknife-and-the-Bootstrap-for-General-Stationary-Observations/10.1214/aos/1176347265.full) provides a resampling basis for stationary dependent observations. Its use still requires justified block length, dependence assumptions, and independent review for this dataset. |

The following are preregistered Flippars release policies, not thresholds
prescribed by the cited research: Brier skill at least 5%; ECE at most 0.03;
sampled-bin error at most 0.05; at least 12 weeks and 300 independent alert
windows; precision at least 75% with a block-bootstrap lower bound of at least
70%; and the coverage, lead-time, integrity, and latency floors. They may be
revised only through a documented prospective protocol, never to rescue a failed
holdout.

No cited source establishes that Flippars can predict a five- or fifteen-minute
Bitcoin close with certainty. Until a frozen candidate passes prospective
validation, production signal emission must remain disabled. An anomaly or
"pump/dump" flag means elevated manipulation-like risk and suppression; it is
not proof of intent or market manipulation.

## Security and risk-management references

- [NIST AI RMF 1.0](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-ai-rmf-10)
  is a voluntary,
  non-sector-specific framework for governing, mapping, measuring, and managing
  AI risk. Using its concepts is not certification or proof that a model is
  trustworthy.
- [NIST Cybersecurity Framework 2.0](https://www.nist.gov/publications/nist-cybersecurity-framework-csf-20)
  provides high-level cybersecurity outcomes and does not prescribe how to
  achieve them. Flippars controls require deployment evidence and testing.
- [OWASP MASVS](https://mas.owasp.org/MASVS/) supplies mobile verification
  categories for storage, cryptography, authentication, networking, platform,
  code, resilience, and privacy. It is used as a test-design baseline, not a
  declaration that the app has passed an assessment.
- The [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x10-api-security-risks/)
  is an awareness baseline for API threats. Its guidance on
  [unsafe consumption of APIs](https://owasp.org/API-Security/editions/2023/en/0xaa-unsafe-consumption-of-apis/)
  supports TLS, validation, bounded processing, and timeouts for exchange data;
  conformance still requires a dedicated security review.

## Release-claim boundary

Framework alignment, passing repository tests, or receiving a provider response
does not by itself establish production readiness. Public release still requires
provider-rights review, jurisdictional legal review, physical-device APNs tests,
prospective model evidence, operational load/failure testing, and an independent
security assessment. Recheck all linked provider documentation and changelogs
before each release because interface contracts can change.
