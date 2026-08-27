# `@flippars/contracts`

Runtime-validated contracts shared by the Flippars API, signal engine, and
iPhone client.

## Invariants

- Prices and every other monetary value are canonical decimal strings.
- Dates are offset-aware RFC3339 strings.
- Live, demo, and simulation data are explicitly distinguishable.
- Contract objects are strict; unknown keys fail parsing.
- Signals are informational and never describe an order or exchange action.
- The additive Binance V3 schemas are offline research contracts. They do not
  alter the current `BTC-USD` API or enable model serving.

```ts
import {
  SignalSchema,
  createPaginatedResponseSchema,
  createWsEnvelopeSchema,
} from "@flippars/contracts";

const SignalPageSchema = createPaginatedResponseSchema(SignalSchema);
const SignalEventSchema = createWsEnvelopeSchema(SignalSchema);
```

WebSocket envelopes include a monotonically increasing non-negative
`sequence`. Clients use it to detect gaps and recover through the paginated
HTTP history endpoint; `id` remains an opaque event identifier.

The schemas should be used at every network and persistence boundary. In
trusted internal code, use the inferred TypeScript types exported beside each
schema.

`forecast.ts` binds the governed Binance Spot `BTCUSDT` event-time target,
strictly causal 24-feature order, signal-specific candidate schedule, explicit
three-class probability mass, separate dataset-content/lineage digests, unique
window counts, and unavailable cross-venue history. Unknown fields or silent
two-class/deadband/timeframe substitutions fail validation.

The immutable `flippars.dataset-manifest-summary/3` contract remains gap-free.
The additive `/4` contract permits nonzero gap counts for source-verified
no-trade intervals whose dependent windows were omitted. Both distinguish freshly
attested `PUBLIC_BINANCE_ARCHIVE`, unattested `LOCAL_ARCHIVE_REPLAY`, and
`SYNTHETIC_LOCAL` lineage. Public lineage requires both acquisition digests and
complete official HTTPS checksum-transport evidence.
