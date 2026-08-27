# Model Bundle Verification and Promotion Runbook

## Current hard stop

This repository does not contain an approved model, a production model runtime,
the required prospective evidence, or a database installer for model bundles.
Public signals must remain disabled. The commands in this runbook verify a
future bundle offline; they do not approve, register, promote, deploy, or enable
it.

Do not work around this boundary by editing a draft artifact, directly updating
`model_registry`, inserting synthetic approval records, or enabling signals.

## Separation of duties

One person or key cannot satisfy multiple required roles. The governed approval
set requires distinct identities and Ed25519 keys for:

- `INDEPENDENT_VALIDATOR`: challenges leakage, calibration, target semantics,
  limitations, and the prospective report independently of training;
- `MODEL_OWNER`: attests reproducibility, lineage, feature definitions, and the
  exact frozen artifact;
- `PRODUCT_OWNER`: accepts the target, threshold, coverage, lead-time, audience,
  and user-comprehension policy;
- `SECURITY_REVIEWER`: accepts artifact integrity, key custody, runtime boundary,
  rollback, monitoring, and deployment controls.

The release operator transports already signed material and runs verification.
The operator does not sign on another role's behalf and cannot turn a successful
dry run into production registration with the current tooling.

## Prerequisites

Before constructing an approval bundle for a signal type:

1. Freeze a versioned three-class draft whose target explicitly retains
   `ABOVE_OPEN`, `BELOW_OPEN`, and `AT_OPEN` outcomes.
2. Record the exact dataset, training-code, feature-schema, label-policy,
   calibrator, runtime-policy, and artifact digests.
3. Complete purged chronological evaluation and an untouched holdout without
   changing thresholds after inspection.
4. Run the exact frozen artifact prospectively for at least 12 weeks and at
   least 300 independent alert windows, whichever takes longer.
5. Pass every gate in `docs/model-governance.md`, including baseline-relative
   Brier skill, calibration, both directional classes, precision confidence
   bounds, coverage, lead time, integrity, and latency.
6. Produce the model card, dataset lineage, reproducible experiment,
   independent validation, shadow report, threshold approval, policy document,
   monitoring plan, rollback plan, and canary plan. A general-release bundle
   also requires the completed canary report.
7. Confirm the calibration remains valid through the intended approval and
   canary period. Recalibrating changes the governed artifact and requires a new
   manifest and appropriate revalidation.

The repository now contains an offline Binance-trade training path, historical
V3 three-class candidate/manifest readers, and a gap-aware V4 draft candidate
contract. V4 deliberately has no promotion-bundle contract. These pieces produce
and validate draft research material only. The live causal feature/risk provider, Binance
trade-based outcome evaluator, prospective shadow recorder, governed registrar,
and runtime migration do not exist. Until those components arrive and their
evidence is independently accepted, this prerequisite list cannot pass. V2
remains parseable for historical dry-run compatibility and is not target-parity
evidence for either V3 or V4.

## Bundle and keyring

Use this layout in a controlled staging directory outside the repository:

```text
model-bundle/
  manifest.json
  approvals.json
  artifact/
    candidate.json
  evidence/
    ... exact files referenced by manifest.json ...
```

The trusted public-key ring is a separate JSON file. Never place private keys in
the bundle, repository, container image, environment file, log, or database.
Keep signing keys in the approved hardware/KMS workflow. A signature is created
outside this package over the exact domain-separated bytes returned by
`approvalSigningPayload`; every statement binds the manifest digest, model
identity, signal type, release stage, role, signer key, signing time, and
validity period.

The manifest binds all artifact and evidence paths, byte lengths, and SHA-256
digests. Use portable relative paths only. Do not use symlinks or remote URLs.

## Offline verification

From the repository root:

```powershell
npm run typecheck --workspace @flippars/model-artifact
npm test --workspace @flippars/model-artifact
npm run verify:bundle --workspace @flippars/model-artifact -- `
  --bundle C:\secure-staging\model-bundle `
  --keyring C:\secure-staging\trusted-model-keys.json
```

Success returns JSON containing `"ok":true`, `"dryRun":true`, the exact
manifest and artifact SHA-256 values, and the verified statement IDs. It also
states that no model was registered, promoted, or enabled.

Treat any warning, mismatch, missing role, expired approval, revoked key,
expired calibration, unknown field, failed gate, changed byte length, changed
digest, unsafe path, or symbolic link as a hard failure. Do not add a force or
skip option.

## Registration remains deliberately unavailable

Migration `003_model_governance.sql` adds guarded lifecycle metadata and an
append-only store for already verified approval statements. PostgreSQL stores
raw signatures but does not verify Ed25519 cryptography. The migration itself
does not insert or approve a model.

Do not populate those tables with ad hoc SQL. A later independently reviewed
change must provide an operator-only registrar that:

- consumes the successful verifier result without reparsing weaker schemas;
- uses a dedicated model-administration database role unavailable to the API
  runtime;
- repeats digest, signature, key-validity, revocation, evidence, and gate checks
  inside the registration transaction;
- inserts the exact detached statements before requesting the guarded lifecycle
  transition;
- appends a pseudonymous operator audit event without logging keys, signatures,
  artifact contents, private evidence, or credentials;
- registers shadow first and permits only candidate → shadow → approved →
  retired transitions;
- performs CANARY → GENERAL only from a newly signed general-release manifest;
- sets the GENERAL transition's new `approved_at` after every general approval's
  `signed_at` (and later than the canary approval) while all statements and the
  calibration are still valid;
- defaults to dry run and has no force mode;
- supports retirement and rollback only to another still-valid, independently
  approved bundle.

Until that registrar and the production forecast/risk provider are complete,
offline verification is the terminal repository-side step.

## Canary, enablement, and rollback

Even after a future registrar exists, deploy and verify the exact bundle with
public signal emission disabled. Exercise the kill switch, provider failure,
artifact tamper, stale calibration, database failure, and rollback paths. Then
use the separately approved canary cohort process. Model approval must never
implicitly toggle signal emission.

Immediately retire and kill signal emission for a revoked signer, artifact hash
mismatch, evidence-integrity failure, calibration expiry, drift breach,
unhealthy data, policy mismatch, or unexplained performance degradation. Signal
and outcome history remains immutable during rollback.

## Material that must remain outside source control

- training, calibration, holdout, and prospective datasets;
- draft or approved artifact bytes and model bundles;
- private validation or provider-licensed reports unless explicitly cleared;
- signing keys, KMS exports, Apple/APNs keys, credentials, and environment files.

The repository ignore rules already exclude `data/`, `artifacts/`, `models/`,
private-key formats, and non-example environment files. Public schemas, empty
fixtures, public keys approved for distribution, and synthetic test material
may be committed intentionally after review.
