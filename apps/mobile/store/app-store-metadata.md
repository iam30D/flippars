# App Store metadata draft

## Name

Flippars

## Subtitle

Measured Bitcoin signals

## Promotional text

See rare, calibrated BTC/USD interval signals with their evidence, expiry, data health, and complete outcomes.

## Description

Flippars provides informational Bitcoin market signals for aligned five- and fifteen-minute intervals. Each qualifying signal shows its calibrated probability, evidence, risk flags, model version, issue time, expiry, and eventual outcome. The model can abstain when confidence or data quality is insufficient.

Flippars does not connect to exchanges, place trades, hold funds, or provide personalized financial advice. Markets are volatile and every forecast can be wrong.

## Privacy summary

The guest-first release requires no account. An anonymous installation identifier is stored in the device keychain to synchronize notification preferences. See `PRIVACY.md` for the implementation-facing data inventory. Final App Privacy answers require legal and data-provider review before submission.

## Review notes

- Demo mode is build-time gated and visibly labels every simulated value.
- Production builds must set `EXPO_PUBLIC_DEMO_MODE=false` and a valid `EXPO_PUBLIC_API_URL`.
- Notifications deep-link only to unexpired informational signals.
