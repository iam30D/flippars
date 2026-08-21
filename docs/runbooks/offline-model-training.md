# Offline model-training runbook

## Scope

This workflow creates offline `DRAFT` candidates from public Binance Data
Vision Spot `BTCUSDT` daily trade archives. It never requests Binance
credentials, places trades, approves or promotes a model, or enables public
signals. All environments, archives, prepared data, evidence, evaluations, and
artifacts remain under `C:\Users\HP\Flippars-ml`, outside Git.

Run only from a reviewed, committed, clean worktree. Public availability does
not settle provider-permit or redistribution questions; record those decisions
under [data governance](../data-governance.md) before production use.

## Predeclared corpus

The operator blocks use the end-exclusive window `2022-01-01` through
`2026-08-02` (1,674 daily archives). This deliberately emphasizes the market
microstructure relevant to the current app while retaining several bullish,
bearish, volatile, and quieter regimes. It is a baseline decision, not proof
that this is the statistically optimal window. The chronological 60/20/20
split leaves an approximately eleven-month final evaluation era.

Do not silently change dates, deadband, signal schedules, confidence threshold,
or partition policy after inspecting evaluation results. A change creates a new
predeclared experiment and version.

## User-run verification before commit

This is a User-run operation because it builds packages, runs complete
model-specific test suites, and fits a synthetic smoke model. It downloads or
installs nothing and reuses the existing `C:\Users\HP\Flippars-ml\.venv`.
Paste the whole block once:

```powershell
& {
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$smokeFailure = $null
try {
Set-Location -LiteralPath "C:\Users\HP\Downloads\Flippars"

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$pythonPath = "C:\Users\HP\Flippars-ml\.venv\Scripts\python.exe"
$sourceRoot = "C:\Users\HP\Downloads\Flippars\apps\model-training\src"
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
  "Flippars-v3-smoke-$([guid]::NewGuid().ToString('N'))"

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  throw "Existing model-test Python is missing: $pythonPath"
}

$env:PYTHONPATH = $sourceRoot
$env:PYTHONDONTWRITEBYTECODE = "1"

Write-Host "Running repository and whitespace checks..." -ForegroundColor Cyan
npm run repo:check
if ($LASTEXITCODE -ne 0) { throw "Repository check failed with exit code $LASTEXITCODE" }
git diff --check
if ($LASTEXITCODE -ne 0) { throw "Whitespace check failed with exit code $LASTEXITCODE" }

Write-Host "Running repository format, lint, and type checks..." -ForegroundColor Cyan
npm run format:check
if ($LASTEXITCODE -ne 0) { throw "Format check failed with exit code $LASTEXITCODE" }
npm run lint
if ($LASTEXITCODE -ne 0) { throw "Lint failed with exit code $LASTEXITCODE" }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "Typecheck failed with exit code $LASTEXITCODE" }

Write-Host "Running complete model-training Python tests..." -ForegroundColor Cyan
& $pythonPath -m unittest discover `
  -s ".\apps\model-training\tests" `
  -p "test_*.py" `
  -v
if ($LASTEXITCODE -ne 0) { throw "Python tests failed with exit code $LASTEXITCODE" }

Write-Host "Running model-training PowerShell operator tests..." -ForegroundColor Cyan
& .\scripts\test-model-training-scripts.ps1

Write-Host "Building and testing runtime contracts..." -ForegroundColor Cyan
npm test --workspace @flippars/contracts
if ($LASTEXITCODE -ne 0) { throw "Contracts tests failed with exit code $LASTEXITCODE" }
npm test --workspace @flippars/model-artifact
if ($LASTEXITCODE -ne 0) { throw "Model-artifact tests failed with exit code $LASTEXITCODE" }

try {
  Write-Host "Running deterministic synthetic model smoke..." -ForegroundColor Cyan
  & $pythonPath -m flippars_model_training smoke --work-root $smokeRoot
  if ($LASTEXITCODE -ne 0) { throw "Python smoke failed with exit code $LASTEXITCODE" }

  Write-Host "Parsing the Python V3 artifact through TypeScript..." -ForegroundColor Cyan
  node .\scripts\verify-python-v3-artifact.mjs `
    --artifact (Join-Path $smokeRoot "artifact.json") `
    --dataset-manifest (Join-Path $smokeRoot "manifest.json") `
    --evaluation (Join-Path $smokeRoot "evaluation.json") `
    --pipeline (Join-Path $sourceRoot "flippars_model_training\pipeline.py") `
    --prepared (Join-Path $smokeRoot "prepared.jsonl")
  if ($LASTEXITCODE -ne 0) {
    throw "Python-to-TypeScript runtime verification failed with exit code $LASTEXITCODE"
  }
} catch {
  $smokeFailure = $_
} finally {
  try {
  $tempRoot = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::GetTempPath()
  ).TrimEnd([char]92)
  $resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
  $smokeLeaf = Split-Path -Leaf $resolvedSmokeRoot
  $expectedSmokePrefix = $tempRoot + [char]92 + 'Flippars-v3-smoke-'
  if (
    (-not $resolvedSmokeRoot.StartsWith(
        $expectedSmokePrefix,
        [System.StringComparison]::OrdinalIgnoreCase
      )) -or
    ($smokeLeaf -notmatch '^Flippars-v3-smoke-[a-f0-9]{32}$')
  ) {
    throw "Refusing unexpected smoke cleanup target: $resolvedSmokeRoot"
  }
  if (Test-Path -LiteralPath $resolvedSmokeRoot) {
    Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
  }
  } catch {
    if ($null -eq $smokeFailure) {
      $smokeFailure = $_
    } else {
      Write-Warning ('Smoke cleanup also failed: ' + $_.Exception.Message)
    }
  }
}
if ($null -ne $smokeFailure) { throw $smokeFailure }

Write-Host "Model-training implementation verification completed successfully." -ForegroundColor Green
} catch {
  Write-Host "Model-training implementation verification failed: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
}
```

## User-run block A: online setup and public-data acquisition

This is intentionally a User-run operation: it installs dependencies, downloads
and hashes wheels/checksum sidecars or missing archives, and may run for hours.
It reuses verified files already in `C:\Users\HP\Flippars-ml\data\raw\archives`
and does not redownload a valid archive. Paste the whole block once in
PowerShell after the implementation commit is clean:

```powershell
& {
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

try {
Set-Location -LiteralPath "C:\Users\HP\Downloads\Flippars"

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$trainingRoot = "C:\Users\HP\Flippars-ml"
$bootstrapEnvironment = "bootstrap-env-v4"
$finalEnvironment = "final-env-v4"
$dependencyProfile = "GovernedBaseline"
$platformKey = "cp311-win_amd64"
$lockFile = Join-Path $trainingRoot "locks\governed-baseline\$platformKey\requirements.lock.txt"
$wheelhouse = Join-Path $trainingRoot "wheelhouse\governed-baseline\$platformKey"
$archiveCache = Join-Path $trainingRoot "data\raw\archives"
$start = "2022-01-01"
$end = "2026-08-02"
$maxFiles = 1700

Write-Host "Checking reviewed repository state..." -ForegroundColor Cyan
$status = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw "git status failed with exit code $LASTEXITCODE" }
if ($status.Count -ne 0) {
  throw "The repository must be clean before dependency evidence is created.`n$($status -join [Environment]::NewLine)"
}
npm run repo:check
if ($LASTEXITCODE -ne 0) { throw "Repository check failed with exit code $LASTEXITCODE" }

Write-Host "Creating online GovernedBaseline bootstrap environment..." -ForegroundColor Cyan
& .\scripts\setup-model-environment.ps1 `
  -TrainingRoot $trainingRoot `
  -Mode Bootstrap `
  -DependencyProfile $dependencyProfile `
  -EnvironmentName $bootstrapEnvironment `
  -PythonVersion 3.11

Write-Host "Resolving exact wheels and semantic lock evidence..." -ForegroundColor Cyan
& .\scripts\new-model-training-lock.ps1 `
  -TrainingRoot $trainingRoot `
  -BootstrapEnvironmentName $bootstrapEnvironment `
  -DependencyProfile $dependencyProfile `
  -LockFile $lockFile `
  -Wheelhouse $wheelhouse

Write-Host "Creating the hash-locked final environment with no package index..." -ForegroundColor Cyan
& .\scripts\setup-model-environment.ps1 `
  -TrainingRoot $trainingRoot `
  -Mode Locked `
  -DependencyProfile $dependencyProfile `
  -EnvironmentName $finalEnvironment `
  -PythonVersion 3.11 `
  -LockFile $lockFile `
  -Wheelhouse $wheelhouse

Write-Host "Acquiring/reusing and verifying the exact Binance corpus..." -ForegroundColor Cyan
& .\scripts\get-binance-training-data.ps1 `
  -TrainingRoot $trainingRoot `
  -EnvironmentName $finalEnvironment `
  -ArchiveCache $archiveCache `
  -Start $start `
  -End $end `
  -MaxFiles $maxFiles

$datasetRoot = Join-Path $trainingRoot "datasets\BTCUSDT-$start--$end"
$environmentManifest = Join-Path $trainingRoot "$finalEnvironment\environment-manifest.json"
$acquisitionManifest = Join-Path $datasetRoot "evidence\acquisition-manifest.json"
foreach ($requiredEvidence in @($environmentManifest, $acquisitionManifest)) {
  if (-not (Test-Path -LiteralPath $requiredEvidence -PathType Leaf)) {
    throw "Required evidence was not produced: $requiredEvidence"
  }
}

Write-Host "Online setup and acquisition completed successfully." -ForegroundColor Green
Write-Host "Final environment evidence: $environmentManifest"
Write-Host "Acquisition evidence: $acquisitionManifest"
Write-Warning "Stop outbound access before running block B. No training has run yet."
} catch {
  Write-Host "Online setup and acquisition failed: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
}
```

The bootstrap is not governed training evidence. The final environment accepts
only the exact binary wheels in the semantic lock using `--no-index`,
`--require-hashes`, and `--only-binary=:all:`. Any changed requirement, wheel,
Python ABI/platform, repository commit, or governed source digest fails closed.

Acquisition freshly retrieves and atomically replaces every selected official
checksum sidecar, pins both requested and final response URIs to HTTPS
`data.binance.vision`, and verifies the selected cache against those bytes. It
reuses valid archive bytes and invokes the download-capable collector only for
missing dates. The isolated dataset uses hard links by default to avoid
duplicating tens of gigabytes; scripts never modify those bytes in place. Use
`-CopyArchives` only after confirming capacity when physical isolation is
required.

## User-run block B: network-free preparation and training

This is also a User-run operation: it scans a large corpus, writes prepared
JSONL, and trains three signal-specific candidates. Disable outbound access if
available. The runner itself has no URL or acquisition call. Paste the whole
block once:

```powershell
& {
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

try {
Set-Location -LiteralPath "C:\Users\HP\Downloads\Flippars"

$trainingRoot = "C:\Users\HP\Flippars-ml"
$finalEnvironment = "final-env-v4"
$start = "2022-01-01"
$end = "2026-08-02"
$confidenceThreshold = 0.75
$validityDays = 120

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

Write-Host "Verifying clean reviewed source before offline training..." -ForegroundColor Cyan
$status = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw "git status failed with exit code $LASTEXITCODE" }
if ($status.Count -ne 0) {
  throw "Frozen training requires a clean worktree.`n$($status -join [Environment]::NewLine)"
}
npm run repo:check
if ($LASTEXITCODE -ne 0) { throw "Repository check failed with exit code $LASTEXITCODE" }

Write-Host "Building reviewed cross-runtime verification contracts..." -ForegroundColor Cyan
npm run build --workspace @flippars/contracts
if ($LASTEXITCODE -ne 0) { throw "Contracts build failed with exit code $LASTEXITCODE" }
npm run build --workspace @flippars/model-artifact
if ($LASTEXITCODE -ne 0) { throw "Model-artifact build failed with exit code $LASTEXITCODE" }

$runs = @(
  [ordered]@{
    SignalType = "FIVE_MINUTE_EARLY_DIRECTION"
    Version = "btc-spot-early-20260814.1"
  },
  [ordered]@{
    SignalType = "FIVE_MINUTE_REVERSAL"
    Version = "btc-spot-5m-reversal-20260814.1"
  },
  [ordered]@{
    SignalType = "FIFTEEN_MINUTE_REVERSAL"
    Version = "btc-spot-15m-reversal-20260814.1"
  }
)

foreach ($run in $runs) {
  Write-Host "Training $($run.SignalType) as $($run.Version)..." -ForegroundColor Cyan
  & .\scripts\invoke-model-training.ps1 `
    -TrainingRoot $trainingRoot `
    -EnvironmentName $finalEnvironment `
    -Start $start `
    -End $end `
    -SignalType $run.SignalType `
    -Version $run.Version `
    -ConfidenceThreshold $confidenceThreshold `
    -ValidityDays $validityDays `
    -Mode FrozenDraft
}

Write-Host "All requested offline DRAFT training runs completed successfully." -ForegroundColor Green
Write-Warning "No candidate was approved, promoted, deployed, or enabled for users."
} catch {
  Write-Host "Offline DRAFT training failed: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
}
```

Preparation verifies each archive SHA-256 before reading it and cross-checks
archive/checksum bytes, hashes, HTTPS transport URIs, and date coverage against
the external schema-3 acquisition evidence. Only that complete binding may be
labeled `PUBLIC_BINANCE_ARCHIVE`; an unattested archive run is explicitly local
replay. Preparation streams one day at a time and publishes a plan-bound,
hash-chained checkpoint only after that day's canonical rows and metadata have
been flushed. A strict same-version resume validates the contiguous checkpoint
prefix, reconstructs feature history from the last completed day, and continues
at the first unused archive. Final JSONL publication replays every checkpoint
through the unchanged dataset writer. Training validates the entire
canonical JSONL corpus twice, requires byte/count/range-identical pass audits,
splits unique windows chronologically, and bounds matrix RAM with deterministic
complete-window samples. Each sampled window must contain
the exact governed decision schedule; uncertainty resampling uses continuous
UTC calendar blocks with missing dates retained explicitly. Progress is printed
periodically. Every completed run also parses the Python artifact through the
reviewed TypeScript schemas and recomputes the versioned pre-evaluation policy,
target, fitted-state, and sampling lineage bindings before writing complete run
evidence. The verifier output is retained and hashed as
`cross-runtime-verification.log` in the external run-evidence directory.

Archive checkpoints remain intact throughout fitting, evaluation, and
cross-runtime verification. Cleanup starts only after the schema-2 `COMPLETE`
run manifest has been atomically published. Cleanup failure is therefore
warning-only: the completed run remains auditable, and any exact leftover
checkpoint directory may be removed by a later reviewed offline cleanup.

If a run stops during archive preparation or after the prepared pair is
complete but before fitting, rerun the exact same invocation with `-Resume`.
The runner appends a durable session marker to the existing command log.
Preparation resumes at the last validated daily archive; fitting restarts from
epoch zero and reuses the complete prepared pair. `-Resume` rejects partial
artifacts, completed runs, changed plans, unknown files, links, and malformed
temporary state. Preserve a rejected state for diagnosis and use a new model
version without `-Resume`; never rename or copy checkpoints into that version.
`ValidityDays` is an expiry, not evidence that calibration will remain stable
for that duration.

## Optional cleanup after successful replacement

The existing `C:\Users\HP\Flippars-ml\.venv` is an older Python 3.13 exploration
environment and is not accepted by `FrozenDraft`. After block A succeeds and
the schema-2 `final-env-v4` evidence has been inspected, it may be removed in a
separate explicit User-run cleanup operation to recover space. Never remove the
archive cache, isolated dataset, wheelhouse, semantic lock, evidence, or draft
artifacts as cleanup.

## What a completed run does not prove

- Multinomial logistic regression is a portable governed baseline, not an
  assertion that no LightGBM/XGBoost/sequence challenger can outperform it.
- Sampled fit and evaluation matrices are diagnostic. They cannot pass
  production model gates without approved full-population policy evidence.
- Binance archive event time does not establish live receive-time parity,
  latency health, multi-venue quorum history, or USDT/USD guard availability.
- The V3 verifier rejects promotion. Live feature/outcome providers,
  prospective shadow evidence, drift/OOD monitoring, independent approvals,
  registration, canary, rollback, and user-comprehension acceptance remain
  mandatory.
- The app continues to abstain when no approved healthy prediction is
  available. No component may place a trade or accept exchange credentials.
