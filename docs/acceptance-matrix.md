# Acceptance Matrix

| User requirement                   | Implementation evidence                                       | Release evidence                       |
| ---------------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| Five-minute opposite-side reversal | Signal-core boundary and vice-versa tests                     | Target-specific shadow report          |
| Fifteen-minute final-half reversal | UTC eligibility tests at 7:30 boundary                        | Target-specific shadow report          |
| Five-minute first-minute direction | 0–60 second eligibility tests                                 | Target-specific shadow report          |
| Only qualified signals             | Approval, calibration, health, anomaly, and dedupe gates      | Calibration/coverage report            |
| Pump/dump protection               | Anomaly risk and suppression policy                           | Held-out/red-team incident set         |
| Reasons for movement               | Evidence layers and cautious language                         | Content/legal comprehension review     |
| Low-latency notification handoff   | Expiring APNs handoff and foreground stream                   | Physical-device latency report         |
| Self-improvement                   | Outcome, challenger, registry, shadow, canary workflow        | Independent promotion approval         |
| Guest access                       | Anonymous installation and deletion flows                     | Privacy/App Store review               |
| Later subscriptions                | Isolated entitlement boundary                                 | StoreKit and account migration release |
| iPhone from Windows                | Expo app and EAS build configuration                          | Signed TestFlight physical-device run  |
| Global quality                     | Security, accessibility, localization, observability baseline | Per-country and external audits        |
