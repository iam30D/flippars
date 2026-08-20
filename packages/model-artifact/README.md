# `@flippars/model-artifact`

This package defines the offline trust boundary for a future governed Flippars
model bundle. It does not train, sign, register, promote, deploy, load, or run a
production model.

The inner artifact is always `DRAFT`. A bundle can pass offline verification
only when all of the following agree byte-for-byte:

- a strict manifest and three-class close target (`ABOVE_OPEN`, `BELOW_OPEN`,
  and `AT_OPEN`);
- the draft artifact SHA-256, size, identity, feature schema, dataset,
  calibration, and target;
- every required evidence file and its SHA-256;
- the provisional offline and prospective gates in `docs/model-governance.md`;
- distinct Ed25519 statements from the independent validator, model owner,
  product owner, and security reviewer;
- an externally supplied trusted public-key ring whose identities, roles,
  validity periods, and revocation state match those statements.

Signatures cover a domain-separated fixed-field representation returned by
`approvalSigningPayload`. This package intentionally contains no signing
function or private-key input.

The additive V3 candidate/manifest pair also requires exact Binance target and
decision-schedule parity, separately hashed canonical dataset content and full
lineage manifest, chronological model-fit/calibration/evaluation boundaries,
verified upstream archive checksums, and a fit-partition-only raw and normalized
OOD envelope whose missing/non-finite/breach policies all abstain. V2 remains
readable only for existing dry-run evidence; it is not treated as V3-equivalent.
Promotion verification additionally requires schema-3 public-source summary
evidence, fresh official checksum transport, and both acquisition manifest and
archive-index digests; local replay and synthetic lineage remain offline-only.

## Bundle layout

```text
model-bundle/
  manifest.json
  approvals.json
  artifact/
    candidate.json
  evidence/
    ... files referenced by manifest.json ...
```

The trusted keyring is supplied separately and is not part of the signed model
bundle. Bundle paths must be portable relative paths, and the CLI rejects
symbolic links, digest mismatches, size mismatches, expired calibration,
revoked keys, missing evidence, failed governance gates, and incomplete or
non-independent approvals.

## Offline dry-run verification

```powershell
npm run verify:bundle --workspace @flippars/model-artifact -- `
  --bundle C:\secure-staging\flippars-model-bundle `
  --keyring C:\secure-staging\trusted-model-keys.json
```

A successful result includes `"dryRun":true` and explicitly states that no
model was registered, promoted, or enabled. There is no database argument,
signing option, promotion option, or signal-enablement option.

No real model bundle or signing key belongs in this repository. See
`docs/runbooks/model-promotion.md` for the external approval boundary and the
remaining release gates.
