# Flippars Engineering Guide

## Mission

Build an auditable, abstention-first Bitcoin information product. Correctness,
data lineage, user comprehension, and safe silence take priority over alert
volume. No component may place trades or accept exchange credentials.

## Domain ownership

- Product: signal definitions, user comprehension, acceptance criteria.
- Architecture: boundaries, contracts, failure modes, and ADRs.
- Mobile: guest experience, accessibility, offline recovery, notifications.
- API: validation, persistence, streaming, privacy, and APNs.
- Data: venue adapters, event time, quality, replay, and lineage.
- Quantitative/AI: labels, calibration, abstention, evaluation, and drift.
- Security/privacy: threat model, secrets, least privilege, retention.
- QA/performance: deterministic replay, contracts, load/fault testing.
- DevOps: reproducible builds, migrations, observability, rollback.
- Documentation/review: decisions, limitations, runbooks, independent challenge.

## Non-negotiable product rules

1. `FIVE_MINUTE_REVERSAL` is evaluated while current price is still on the
   opposite side of the predicted close relative to the five-minute open.
2. `FIFTEEN_MINUTE_REVERSAL` is only eligible in the final half of its interval.
3. `FIVE_MINUTE_EARLY_DIRECTION` is only eligible in the first 60 seconds.
4. At most one signal of each type is emitted per aligned interval.
5. Flat/deadband outcomes are not silently removed.
6. Production emission requires an approved model artifact and healthy data.
7. Stale, gapped, anomalous, out-of-distribution, or insufficient-quorum data
   must cause abstention.
8. Confidence is a calibrated estimate, never certainty or a profit guarantee.
9. Explanations distinguish measured observations, model associations, and
   externally reported context. They do not claim causality.
10. Online self-modification and automatic model promotion are forbidden.

## Coding standards

- TypeScript strict mode; no unchecked `any`.
- ESM modules, explicit public exports, and versioned schemas.
- Decimal strings cross API boundaries; timestamps are UTC RFC3339.
- Pure domain logic stays separate from I/O.
- Validate every external payload; assume providers add message types.
- Use deterministic IDs and idempotent writes for events and notifications.
- Redact tokens, device identifiers, headers, and personal data from logs.
- Tests accompany boundary rules, failure behavior, and regressions.
- Record deliberate deferrals in `TECH_DEBT.md`; never hide them as TODOs.

## Command execution ownership

Before running any shell command, classify it as **Codex-run** or **User-run** based on scope, runtime, resource use, output size, risk, and environment impact.

## Codex-run

Run automatically when the command is:

- Fast, usually under 1–2 minutes.
- Low CPU, memory, disk, and network use.
- Read-only or easily reversible.
- Small in scope and unlikely to produce large output.
- Useful for immediate diagnosis or verification.

Examples: `git status`, `git diff`, limited `git log`, `Get-ChildItem`, `Test-Path`, version/config checks, targeted tests, targeted linting, process/port checks, and package inspection.

## User-run

Do not run automatically when the command is:

- Long-running or resource-intensive.
- Download/install/upgrade related.
- A full build, full lint, or large test suite.
- A database migration, model download/training, large data job, Docker build/pull, production mobile build, large recursive operation, or admin-level operation.
- Destructive, risky, environment-changing, or likely to generate large logs.

Use judgment by actual scope, not command name. A small targeted test may be Codex-run; a full test suite should be User-run.

## Manual Handoff

When a User-run command is required:

1. Stop before executing it.
2. Briefly explain why it is needed.
3. Give me **one complete, paste-once PowerShell block**.
4. Include the working directory inside the block using:

```powershell
Set-Location -LiteralPath "C:\FULL\PATH\TO\PROJECT"
```

5. Combine all safe commands for that operation into the same block.
6. Show useful progress and explicit failures.
7. Wait for my result before continuing.
8. After I provide the result, inspect it and resume from the exact stopping point.

Preferred structure:

```powershell
$ErrorActionPreference = "Stop"

Set-Location -LiteralPath "C:\FULL\PATH\TO\PROJECT"

Write-Host "Running <operation>..." -ForegroundColor Cyan

<COMMANDS>

if ($LASTEXITCODE -ne 0) {
    throw "<Operation> failed with exit code $LASTEXITCODE"
}

Write-Host "<Operation> completed successfully." -ForegroundColor Green
```

Adapt error handling when using native PowerShell commands.

## Multi-Agent Efficiency

- Do not let multiple agents repeat the same command.
- Assign one agent to each execution/verification task.
- Reuse existing build/test/lint results instead of rerunning expensive commands.
- Reviewer agents should inspect results unless rerunning is necessary.
- Keep logs concise and load only relevant errors/output into context.

Optimize for **correctness, development speed, low unnecessary model usage, and low machine-resource usage**.

Codex should handle small, fast commands itself and hand off expensive, lengthy, risky, installation-heavy, download-heavy, or resource-intensive commands to me as one-shot PowerShell blocks.

## Never commit or push

- Real environment files (`.env`, `.env.local`, `.env.production`, or any other
  `.env.*`) or secret-manager exports. Only reviewed templates named
  `.env.example` or `.env.production.example` may be tracked.
- Database passwords/URLs, APNs `.p8` keys, Apple certificates, provisioning
  profiles, EAS/Expo access tokens, device push tokens, encryption keys, or
  credential files such as `credentials.json`.
- Generated/local Expo and native state: `.expo/`, `.eas/`, `expo-env.d.ts`,
  generated `ios/` or `android/` directories, simulator/device registrations,
  or locally downloaded signing material.
- Dependencies and generated output: `node_modules/`, `dist/`, `coverage/`,
  logs, caches, temporary files, or local database volumes/backups.
- Proprietary/raw datasets, replay captures, trained model binaries, unsigned or
  signed production artifacts, and local `data/`, `models/`, or `artifacts/`
  content. Only small, synthetic, explicitly reviewed test fixtures are allowed.
- The Binance collector and model-training implementation (`apps/model-training/`
  and `scripts/setup-model-environment.ps1`) may be staged, committed, and
  pushed only after explicit owner approval. Provider permits must be recorded
  before production release; keep all private data, contracts, credentials, and
  generated artifacts in the separate training workspace described by that
  package.

Before every commit and push, inspect staged paths and run the repository secret
check. If a sensitive file was staged, unstage it and rotate any exposed secret;
deleting it from the latest commit is not sufficient once it has been pushed.

## Folder conventions

- `apps/` contains independently deployable applications.
- `packages/` contains side-effect-free shared libraries.
- `packages/model-lab` may create draft challengers but cannot approve or deploy
  them.
- `docs/` is authoritative for product and operating decisions.
- `deploy/` contains secret-free deployment manifests.
- Database migrations are append-only after release.

## Review workflow

1. Map changes to an acceptance criterion and architecture impact.
2. Review data leakage, timing, privacy, security, accessibility, and failure
   behavior.
3. Run format, lint, typecheck, unit/integration tests, and builds.
4. Independently challenge model or policy changes.
5. Update project memory, decisions, technical debt, and runbooks.
6. Promote through shadow, canary, and rollback-capable stages.

## Quality gates

- No open Critical or High security findings.
- Deterministic candle-boundary and replay tests pass.
- API schemas and mobile consumers remain contract-compatible.
- Guest deletion/reset behavior is verified.
- Degraded providers suppress signals without taking the API offline.
- Accessibility checks cover VoiceOver labels, Dynamic Type, contrast, focus,
  non-color cues, and reduced motion.
- Public alerts remain disabled until the model gates in
  `docs/model-governance.md` pass.
