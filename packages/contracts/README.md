# `@flippars/contracts`

Runtime-validated contracts shared by the Flippars API, signal engine, and
iPhone client.

## Invariants

- Prices and every other monetary value are canonical decimal strings.
- Dates are offset-aware RFC3339 strings.
- Live, demo, and simulation data are explicitly distinguishable.
- Contract objects are strict; unknown keys fail parsing.
- Signals are informational and never describe an order or exchange action.

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
