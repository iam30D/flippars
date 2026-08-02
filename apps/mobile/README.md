# Flippars mobile

Guest-first Expo SDK 56 iPhone client for informational BTC/USD signals. The app never connects to an exchange, holds funds, or initiates a trade.

## Product behavior

- Shows the quality-screened Coinbase/Kraken/Binance BTC/USD composite, venue/data health, UTC-aligned five- and fifteen-minute openings, current deltas, and close countdowns.
- Gives a permanent dashboard slot to all three approved signals: five-minute reversal, final-7:30 fifteen-minute reversal, and first-60-seconds five-minute closing direction.
- Treats “No qualified signal” as an explicit model abstention, not an error or a hidden prediction.
- Displays calibrated probability, issue/expiry, direction, model/calibration versions, observations, model/policy factors, verified reported context, risks, audit identifiers, and outcomes.
- Keeps correct, incorrect, flat, void, and pending results together in complete cursor-paginated history.
- Provides guest access without login or subscription. A random installation UUID and independent 256-bit mutation credential are stored in SecureStore; settings and cached public state use namespaced AsyncStorage keys.
- Requests iOS notification permission only after the onboarding value/uncertainty explanation and a direct user tap.
- Discards stale foreground notifications and stale notification deep links.
- Supports system light/dark appearance, Dynamic Type, VoiceOver labels/hints, non-color status symbols, 44-point controls, and reduced-motion system settings (the current UI uses no nonessential motion).

## Runtime modes

Production is the default. Set a real endpoint:

```dotenv
EXPO_PUBLIC_API_URL=https://api.example.com
EXPO_PUBLIC_DEMO_MODE=false
EAS_PROJECT_ID=your-eas-project-id
```

If the API URL is absent or insecure (only HTTPS is accepted outside localhost), the app shows a configuration/offline state and cached data. It does **not** silently substitute mock values.

Demo data runs only when explicitly opted in:

```dotenv
EXPO_PUBLIC_DEMO_MODE=true
```

Every demo screen and signal is visibly marked `DEMO · Simulated values, never live signals`. A production EAS environment must set this variable to `false`.

## Development

From the repository root after workspace dependencies are installed:

```sh
npm run start --workspace @flippars/mobile
npm run typecheck --workspace @flippars/mobile
npm test --workspace @flippars/mobile
```

Expo SDK 56 targets React Native 0.85, React 19.2.8, Node 20.19+, and iOS 16.4+. No native `ios/` directory is committed; EAS generates and signs it on macOS infrastructure.

## API integration

The client uses `EXPO_PUBLIC_API_URL` for:

- `GET /v1/market/snapshot`
- `GET /v1/candles/current`
- `GET /v1/signals?limit=&cursor=`
- `GET /v1/signals/:id`
- `PUT /v1/preferences`
- `PUT /v1/devices/:installationId`
- `DELETE /v1/devices/:installationId`
- `WS /v1/stream` (public market/signal stream; the guest identifier is not placed in the URL)

Only the three guest mutation requests carry `X-Flippars-Installation-ID` and `X-Flippars-Guest-Credential`. Public REST reads and the WebSocket connection carry neither value. Reset queues the old credential in Keychain-backed deletion storage before rotating the active guest session, and later live launches retry any deletion that did not reach the API.

Canonical types and runtime schemas come from `@flippars/contracts`. Wire enums remain uppercase and monetary values remain decimal strings until `services/api/adapters.ts`, the validated display boundary. The stream rejects malformed schema versions/sequences, ignores duplicates, detects gaps, recovers the market snapshot, current aligned candles, and history over REST, applies the held event, and reconnects with bounded exponential jitter. A fresh REST recovery also runs on every successful stream reconnect and app foreground transition.

History items are `{ signal, outcome }`, where outcome begins `PENDING`; outcome stream events update the matching immutable signal record. Cursor pagination is never filtered by outcome.

## Notifications

`expo-notifications` requests permission and obtains the native iOS APNs device token only after an explicit in-app alert opt-in; an existing OS grant alone never uploads or re-associates the token. The API sends directly through APNs. The EAS project must be associated with valid APNs credentials, and the server device association remains anonymous. Signal payload data must include:

```json
{
  "signalId": "signal-id",
  "signalType": "FIVE_MINUTE_REVERSAL",
  "expiresAt": "2026-07-31T12:05:00.000Z"
}
```

The service must also set APNs expiration/collapse behavior; foreground client checks are not a replacement for server-side expiry. Quiet hours and disabled types are enforced both in synchronized preferences and the foreground notification handler.

## Release preparation

- Visually review the committed raster icon/splash artwork described in
  `assets/README.md` before App Store submission. The source SVG is not used as
  an iOS icon because Expo/App Store builds require compliant PNG artwork.
- Replace the placeholder bundle identifier if ownership requires it and attach the real EAS project.
- Validate on physical iPhones with VoiceOver, large accessibility text, light/dark appearance, notification denial/re-enable, network loss, sequence gaps, stale APNs delivery, and guest reset.
- Complete privacy-policy URL, support URL, data-provider attribution, legal review, export compliance, App Privacy answers, and country availability before submission. See `PRIVACY.md` and `store/app-store-metadata.md`.
- Keep the guest release informational. Subscriptions/accounts can be introduced later behind server entitlements without changing signal integrity or historical scoring.

## Tests

Pure unit tests cover interval countdown boundaries, signal/notification staleness, price/probability formatting, disabled types and overnight quiet hours, WebSocket sequence decisions, REST merge behavior, secure WebSocket URL creation, and reconnect backoff. Device notification permission, APNs delivery, deep links, accessibility, and reconnect behavior require the physical-device/EAS test matrix above.
