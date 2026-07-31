# Technical Debt and External Release Gates

Nothing in this file authorizes bypassing a release gate.

## External dependencies

- Select and license production historical Level-2, derivatives, on-chain, and
  news datasets.
- Complete the prospective shadow period for each signal type; no production
  model artifact is bundled.
- Obtain jurisdiction-specific legal review for financial-promotion,
  subscription, privacy, and App Store wording.
- Supply Apple Developer, APNs, EAS, and App Store Connect credentials through
  the deployment secret manager.
- Complete independent mobile/API penetration testing and remediate findings.
- Choose the production cloud and convert the portable Kubernetes baseline into
  reviewed provider-specific infrastructure.
- Track the moderate `uuid` advisory inherited by Expo's native build tooling;
  npm currently proposes a breaking Expo downgrade rather than a compatible
  remediation. The production high-severity audit gate remains clean.

## Deferred enhancements

- StoreKit subscriptions and Sign in with Apple account migration.
- Licensed geopolitical/news evidence retrieval and guarded summarization.
- Options, on-chain, and derivatives feature packs beyond core adapters.
- Multi-region disaster recovery after traffic and RPO/RTO requirements exist.
- Independent accessibility audit and professional localization.
- SOC 2 operating-evidence collection and ISO 27001 certification work.

## Performance follow-up

- Establish production baselines before selecting a durable event-log platform.
- Load-test WebSocket fan-out and split it from the API when measured demand
  requires it.
- Benchmark native versus JavaScript chart rendering on supported iPhones.
