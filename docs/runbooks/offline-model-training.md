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
model-specific test suites, fits a synthetic smoke model, and replays the
bounded March 23–25, 2023 real-archive gap diagnostic. It downloads or installs
nothing and uses the existing CPython 3.11 `final-env-v4` only as a pre-commit
test runtime; that older environment is not accepted as new training evidence.
Paste the whole block once:

```powershell
& {
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$smokeFailure = $null
$diagnosticFailure = $null
try {
Set-Location -LiteralPath "C:\Users\HP\Downloads\Flippars"

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$pythonPath = "C:\Users\HP\Flippars-ml\final-env-v4\Scripts\python.exe"
$sourceRoot = "C:\Users\HP\Downloads\Flippars\apps\model-training\src"
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
  "Flippars-v4-smoke-$([guid]::NewGuid().ToString('N'))"
$diagnosticRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
  "Flippars-gap-diagnostic-$([guid]::NewGuid().ToString('N'))"

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  throw "Existing model-test Python is missing: $pythonPath"
}

$env:PYTHONPATH = $sourceRoot
$env:PYTHONDONTWRITEBYTECODE = "1"

Write-Host "Running whitespace and full repository verification..." -ForegroundColor Cyan
git diff --check
if ($LASTEXITCODE -ne 0) { throw "Whitespace check failed with exit code $LASTEXITCODE" }
npm run verify
if ($LASTEXITCODE -ne 0) { throw "Repository verification failed with exit code $LASTEXITCODE" }

Write-Host "Running complete model-training Python tests..." -ForegroundColor Cyan
& $pythonPath -m unittest discover `
  -s ".\apps\model-training\tests" `
  -p "test_*.py" `
  -v
if ($LASTEXITCODE -ne 0) { throw "Python tests failed with exit code $LASTEXITCODE" }

Write-Host "Running model-training PowerShell operator tests..." -ForegroundColor Cyan
& .\scripts\test-model-training-scripts.ps1

try {
  Write-Host "Running deterministic synthetic model smoke..." -ForegroundColor Cyan
  & $pythonPath -m flippars_model_training smoke --work-root $smokeRoot
  if ($LASTEXITCODE -ne 0) { throw "Python smoke failed with exit code $LASTEXITCODE" }

  Write-Host "Parsing the Python V4 artifact through TypeScript..." -ForegroundColor Cyan
  node .\scripts\verify-python-artifact.mjs `
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
  $expectedSmokePrefix = $tempRoot + [char]92 + 'Flippars-v4-smoke-'
  if (
    (-not $resolvedSmokeRoot.StartsWith(
        $expectedSmokePrefix,
        [System.StringComparison]::OrdinalIgnoreCase
      )) -or
    ($smokeLeaf -notmatch '^Flippars-v4-smoke-[a-f0-9]{32}$')
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

try {
  Write-Host "Running bounded real-archive gap diagnostic..." -ForegroundColor Cyan
  $datasetSnapshotRoot =
    "C:\Users\HP\Flippars-ml\datasets\BTCUSDT-2022-01-01--2026-08-02"
  $sourceArchiveRoot = Join-Path $datasetSnapshotRoot "raw\archives"
  $acquisitionManifestPath = Join-Path $datasetSnapshotRoot `
    "evidence\acquisition-manifest.json"
  $diagnosticArchiveRoot = Join-Path $diagnosticRoot "archives"
  $diagnosticPreparedPath = Join-Path $diagnosticRoot "processed\prepared.jsonl"
  $diagnosticManifestPath = Join-Path $diagnosticRoot `
    "processed\dataset-manifest.json"
  $diagnosticDates = @("2023-03-23", "2023-03-24", "2023-03-25")

  if (Test-Path -LiteralPath $diagnosticRoot) {
    throw "Diagnostic root unexpectedly exists: $diagnosticRoot"
  }
  if (-not (Test-Path -LiteralPath $acquisitionManifestPath -PathType Leaf)) {
    throw "Acquisition evidence is missing: $acquisitionManifestPath"
  }
  New-Item -ItemType Directory -Path $diagnosticArchiveRoot -Force | Out-Null
  foreach ($dateText in $diagnosticDates) {
    foreach ($suffix in @(".zip", ".zip.CHECKSUM")) {
      $name = "BTCUSDT-trades-$dateText$suffix"
      $source = Join-Path $sourceArchiveRoot $name
      $destination = Join-Path $diagnosticArchiveRoot $name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required diagnostic input is missing: $source"
      }
      $sourceItem = Get-Item -LiteralPath $source -Force
      if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Diagnostic input cannot be a reparse point: $source"
      }
      New-Item -ItemType HardLink -Path $destination -Target $source | Out-Null
    }
  }

  & $pythonPath -m flippars_model_training prepare-archives `
    --archive-root $diagnosticArchiveRoot `
    --start "2023-03-23" `
    --end "2023-03-26" `
    --output $diagnosticPreparedPath `
    --manifest-output $diagnosticManifestPath `
    --signal-type "FIVE_MINUTE_EARLY_DIRECTION" `
    --deadband-bps 5 `
    --timeframe-minutes 5 `
    --decision-cadence-seconds 15 `
    --minimum-lead-time-seconds 15
  if ($LASTEXITCODE -ne 0) {
    throw "Real-archive gap preparation failed with exit code $LASTEXITCODE"
  }

  node .\scripts\audit-prepared-model-dataset.mjs `
    --prepared $diagnosticPreparedPath `
    --dataset-manifest $diagnosticManifestPath
  if ($LASTEXITCODE -ne 0) {
    throw "Independent real-archive dataset audit failed with exit code $LASTEXITCODE"
  }

  $manifest = Get-Content -LiteralPath $diagnosticManifestPath -Raw |
    ConvertFrom-Json
  if (($manifest.schemaVersion -ne "flippars.dataset-manifest/3") -or
      ($manifest.source.lineageKind -ne "LOCAL_ARCHIVE_REPLAY") -or
      ([int]$manifest.source.dayCount -ne 3) -or
      ([int]$manifest.gapCount -ne 30) -or
      ([int]$manifest.preparedWindowCount -ne 808) -or
      ([int]$manifest.preparedDecisionRowCount -ne 2424) -or
      ($manifest.startAt -ne "2023-03-23T01:05:15.000Z") -or
      ($manifest.endAt -ne "2023-03-26T00:00:00.000Z")) {
    throw "Real-archive diagnostic manifest has unexpected coverage."
  }

  $invariant = [System.Globalization.CultureInfo]::InvariantCulture
  $gapStart = [datetimeoffset]::Parse(
    "2023-03-24T11:30:00.000Z",
    $invariant,
    [System.Globalization.DateTimeStyles]::RoundtripKind
  )
  $expectedGaps = @(
    0..29 | ForEach-Object {
      $gapStart.AddMinutes(5 * $_).ToString(
        "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
        $invariant
      )
    }
  )
  $actualGaps = @($manifest.gapWindowStarts | ForEach-Object { [string]$_ })
  if (($actualGaps -join [Environment]::NewLine) -cne
      ($expectedGaps -join [Environment]::NewLine)) {
    throw "Real-archive diagnostic did not retain the exact 30-window gap."
  }

  $acquisition = Get-Content -LiteralPath $acquisitionManifestPath -Raw |
    ConvertFrom-Json
  if (([int]$acquisition.schemaVersion -ne 3) -or
      ($acquisition.completionState -ne "COMPLETE") -or
      (-not [bool]$acquisition.freshOfficialTransportEvidence)) {
    throw "Full acquisition evidence is incomplete."
  }
  $reports = @($manifest.source.archives)
  if ($reports.Count -ne 3) {
    throw "Real-archive diagnostic report count is not three."
  }
  for ($index = 0; $index -lt $diagnosticDates.Count; $index++) {
    $dateText = $diagnosticDates[$index]
    $report = $reports[$index]
    $records = @($acquisition.archives | Where-Object { $_.day -eq $dateText })
    if ($records.Count -ne 1) {
      throw "Acquisition evidence does not contain exactly one record for $dateText."
    }
    $record = $records[0]
    if (($report.day -ne $dateText) -or
        ($report.archive -ne $record.archiveName) -or
        ([long]$report.archive_bytes -ne [long]$record.archiveBytes) -or
        (([string]$report.archive_sha256).ToLowerInvariant() -ne
         ([string]$record.archiveSha256).ToLowerInvariant()) -or
        (([string]$report.expected_sha256).ToLowerInvariant() -ne
         ([string]$record.expectedArchiveSha256).ToLowerInvariant()) -or
        ($report.checksum_name -ne $record.checksumName) -or
        ([long]$report.checksum_bytes -ne [long]$record.checksumBytes) -or
        (([string]$report.checksum_sha256).ToLowerInvariant() -ne
         ([string]$record.checksumSha256).ToLowerInvariant()) -or
        ([int]$report.rejected_trade_count -ne 0) -or
        ([int]$report.duplicate_trade_count -ne 0) -or
        ([int]$report.out_of_order_trade_count -ne 0) -or
        ([int]$report.missing_trade_id_count -ne 0)) {
      throw "Diagnostic archive integrity disagrees with evidence for $dateText."
    }
    if ([long]$report.last_trade_id - [long]$report.first_trade_id + 1 -ne
        [long]$report.accepted_trade_count) {
      throw "Diagnostic archive trade IDs are incomplete for $dateText."
    }
    if (($index -gt 0) -and
        ([long]$report.first_trade_id -ne
         ([long]$reports[$index - 1].last_trade_id + 1))) {
      throw "Diagnostic cross-day trade IDs are not consecutive at $dateText."
    }
  }
  if (([string]$reports[1].archive_sha256).ToLowerInvariant() -ne
      "bceaa0b664b055318c22e509d33c04d532da143e7de41ca2fc3457100439c587") {
    throw "The 2023-03-24 incident archive digest is unexpected."
  }

  $poisonedWindows = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  foreach ($gapText in $expectedGaps) {
    $gap = [datetimeoffset]::Parse(
      $gapText,
      $invariant,
      [System.Globalization.DateTimeStyles]::RoundtripKind
    )
    for ($lookahead = 0; $lookahead -le 13; $lookahead++) {
      [void]$poisonedWindows.Add(
        $gap.AddMinutes(5 * $lookahead).ToString(
          "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
          $invariant
        )
      )
    }
  }
  $preparedWindows = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
  )
  $observedRows = 0
  foreach ($line in [System.IO.File]::ReadLines($diagnosticPreparedPath)) {
    $row = $line | ConvertFrom-Json
    $window = [string]$row.windowStart
    if ($poisonedWindows.Contains($window)) {
      throw "Prepared diagnostic contains gap-dependent window $window."
    }
    [void]$preparedWindows.Add($window)
    $observedRows++
  }
  if (($observedRows -ne 2424) -or
      ($preparedWindows.Count -ne 808) -or
      (-not $preparedWindows.Contains("2023-03-24T15:05:00.000Z"))) {
    throw "Real-archive diagnostic has an unexpected post-gap boundary."
  }
  Write-Host "Bounded real-archive gap diagnostic passed." -ForegroundColor Green
} catch {
  $diagnosticFailure = $_
} finally {
  try {
    $tempRoot = [System.IO.Path]::GetFullPath(
      [System.IO.Path]::GetTempPath()
    ).TrimEnd([char]92)
    $resolvedDiagnosticRoot = [System.IO.Path]::GetFullPath($diagnosticRoot)
    $diagnosticLeaf = Split-Path -Leaf $resolvedDiagnosticRoot
    $expectedDiagnosticPrefix =
      $tempRoot + [char]92 + "Flippars-gap-diagnostic-"
    if ((-not $resolvedDiagnosticRoot.StartsWith(
          $expectedDiagnosticPrefix,
          [System.StringComparison]::OrdinalIgnoreCase
        )) -or
        ($diagnosticLeaf -notmatch
         "^Flippars-gap-diagnostic-[a-f0-9]{32}$")) {
      throw "Refusing unexpected diagnostic cleanup target: $resolvedDiagnosticRoot"
    }
    if (Test-Path -LiteralPath $resolvedDiagnosticRoot) {
      Remove-Item -LiteralPath $resolvedDiagnosticRoot -Recurse -Force
    }
  } catch {
    if ($null -eq $diagnosticFailure) {
      $diagnosticFailure = $_
    } else {
      Write-Warning ('Diagnostic cleanup also failed: ' + $_.Exception.Message)
    }
  }
}
if ($null -ne $diagnosticFailure) { throw $diagnosticFailure }

Write-Host "Model-training implementation verification completed successfully." -ForegroundColor Green
} catch {
  Write-Host "Model-training implementation verification failed: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
}
```

## User-run block A: frozen environment and public-data acquisition/reuse

This is intentionally a User-run operation: it creates an environment and, only
when immutable dependency or dataset evidence is absent, downloads and hashes
wheels, checksum sidecars, or missing archives. It reuses a complete semantic
lock, wheelhouse, and isolated dataset already under
`C:\Users\HP\Flippars-ml`; it does not recreate immutable evidence or redownload
valid archive bytes. Paste the whole block once in PowerShell after the
implementation commit is clean:

```powershell
& {
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

try {
Set-Location -LiteralPath "C:\Users\HP\Downloads\Flippars"

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
. .\scripts\model-training-guardrails.ps1

$trainingRoot = "C:\Users\HP\Flippars-ml"
$bootstrapEnvironment = "bootstrap-env-v5"
$finalEnvironment = "final-env-v5"
$pythonExecutable = "C:\Users\HP\AppData\Local\Programs\Python\Python311\python.exe"
$dependencyProfile = "GovernedBaseline"
$platformKey = "cp311-win_amd64"
$lockFile = Join-Path $trainingRoot "locks\governed-baseline\$platformKey\requirements.lock.txt"
$semanticLockFile = "$lockFile.manifest.json"
$wheelhouse = Join-Path $trainingRoot "wheelhouse\governed-baseline\$platformKey"
$archiveCache = Join-Path $trainingRoot "data\raw\archives"
$start = "2022-01-01"
$end = "2026-08-02"
$maxFiles = 1700
$datasetRoot = Join-Path $trainingRoot "datasets\BTCUSDT-$start--$end"
$environmentManifest = Join-Path $trainingRoot "$finalEnvironment\environment-manifest.json"
$acquisitionManifest = Join-Path $datasetRoot "evidence\acquisition-manifest.json"
$sourceIntegrity = Join-Path $datasetRoot "evidence\source-integrity.json"

Write-Host "Checking reviewed repository state..." -ForegroundColor Cyan
$status = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw "git status failed with exit code $LASTEXITCODE" }
if ($status.Count -ne 0) {
  throw "The repository must be clean before dependency evidence is created.`n$($status -join [Environment]::NewLine)"
}
npm run repo:check
if ($LASTEXITCODE -ne 0) { throw "Repository check failed with exit code $LASTEXITCODE" }

$lockedDependencyInputs = @(
  (Test-Path -LiteralPath $lockFile -PathType Leaf),
  (Test-Path -LiteralPath $semanticLockFile -PathType Leaf),
  (Test-Path -LiteralPath $wheelhouse -PathType Container)
)
$lockedDependencyInputCount = @(
  $lockedDependencyInputs | Where-Object { $_ }
).Count
if ($lockedDependencyInputCount -notin @(0, 3)) {
  throw "Frozen dependency evidence is partial. Preserve and inspect it; do not overwrite immutable paths."
}
if ($lockedDependencyInputCount -eq 0) {
  Write-Host "Creating online GovernedBaseline bootstrap environment..." -ForegroundColor Cyan
  & .\scripts\setup-model-environment.ps1 `
    -TrainingRoot $trainingRoot `
    -Mode Bootstrap `
    -DependencyProfile $dependencyProfile `
    -EnvironmentName $bootstrapEnvironment `
    -PythonVersion 3.11 `
    -PythonExecutable $pythonExecutable

  Write-Host "Resolving exact wheels and semantic lock evidence..." -ForegroundColor Cyan
  & .\scripts\new-model-training-lock.ps1 `
    -TrainingRoot $trainingRoot `
    -BootstrapEnvironmentName $bootstrapEnvironment `
    -DependencyProfile $dependencyProfile `
    -LockFile $lockFile `
    -Wheelhouse $wheelhouse
} else {
  Write-Host "Reusing complete immutable dependency evidence; no wheel download is needed." -ForegroundColor Green
}

Write-Host "Creating the hash-locked final environment with no package index..." -ForegroundColor Cyan
& .\scripts\setup-model-environment.ps1 `
  -TrainingRoot $trainingRoot `
  -Mode Locked `
  -DependencyProfile $dependencyProfile `
  -EnvironmentName $finalEnvironment `
  -PythonVersion 3.11 `
  -PythonExecutable $pythonExecutable `
  -LockFile $lockFile `
  -Wheelhouse $wheelhouse

if (Test-Path -LiteralPath $datasetRoot -PathType Container) {
  Write-Host "Validating reusable immutable Binance acquisition evidence..." -ForegroundColor Cyan
  foreach ($requiredDatasetEvidence in @($acquisitionManifest, $sourceIntegrity)) {
    if (-not (Test-Path -LiteralPath $requiredDatasetEvidence -PathType Leaf)) {
      throw "The existing immutable dataset is incomplete: $requiredDatasetEvidence"
    }
    $item = Get-Item -LiteralPath $requiredDatasetEvidence -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Dataset evidence cannot be a reparse point: $requiredDatasetEvidence"
    }
  }
  $acquisition = Get-Content -LiteralPath $acquisitionManifest -Raw |
    ConvertFrom-Json
  $sourceIntegrityHash = (
    Get-FileHash -LiteralPath $sourceIntegrity -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if (([int]$acquisition.schemaVersion -ne 3) -or
      ($acquisition.completionState -ne "COMPLETE") -or
      ($acquisition.freshOfficialTransportEvidence -isnot [bool]) -or
      (-not $acquisition.freshOfficialTransportEvidence) -or
      ($acquisition.credentialsUsed -isnot [bool]) -or
      $acquisition.credentialsUsed -or
      ($acquisition.tradingApiUsed -isnot [bool]) -or
      $acquisition.tradingApiUsed -or
      ($acquisition.source.provider -ne "Binance Data Vision") -or
      ($acquisition.source.marketType -ne "SPOT") -or
      ($acquisition.source.symbol -ne "BTCUSDT") -or
      ($acquisition.source.dataKind -ne "DAILY_TRADES") -or
      ($acquisition.window.startInclusive -ne $start) -or
      ($acquisition.window.endExclusive -ne $end) -or
      ([int]$acquisition.window.dayCount -ne 1674) -or
      (@($acquisition.archives).Count -ne 1674) -or
      ((ConvertTo-NormalizedFullPath ([string]$acquisition.archiveRoot)) -ne
       (ConvertTo-NormalizedFullPath (Join-Path $datasetRoot "raw\archives"))) -or
      ((ConvertTo-NormalizedFullPath ([string]$acquisition.isolatedIntegrity.Path)) -ne
       (ConvertTo-NormalizedFullPath $sourceIntegrity)) -or
      (([string]$acquisition.isolatedIntegrity.Sha256).ToLowerInvariant() -ne
       $sourceIntegrityHash)) {
    throw "The existing immutable Binance acquisition evidence is incomplete or incompatible."
  }
  Write-Host "Reusing complete acquisition evidence; no archive download is needed." -ForegroundColor Green
} elseif (Test-Path -LiteralPath $datasetRoot) {
  throw "The immutable dataset path exists but is not a directory: $datasetRoot"
} else {
  Write-Host "Acquiring/reusing and verifying the exact Binance corpus..." -ForegroundColor Cyan
  & .\scripts\get-binance-training-data.ps1 `
    -TrainingRoot $trainingRoot `
    -EnvironmentName $finalEnvironment `
    -ArchiveCache $archiveCache `
    -Start $start `
    -End $end `
    -MaxFiles $maxFiles
}

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

The bootstrap is not governed training evidence and is skipped when the
complete immutable semantic lock and wheelhouse already exist. The final
environment accepts only the exact binary wheels in that lock using
`--no-index`, `--require-hashes`, and `--only-binary=:all:`. Any partial frozen
dependency evidence, changed requirement, wheel, Python ABI/platform,
repository commit, or governed source digest fails closed.

When the immutable dataset is absent, acquisition freshly retrieves and
atomically replaces every selected official checksum sidecar, pins both
requested and final response URIs to HTTPS `data.binance.vision`, and verifies
the selected cache against those bytes. It reuses valid archive bytes and
invokes the download-capable collector only for missing dates. A complete
existing acquisition manifest and its bound source-integrity evidence are
validated and reused without network access. The isolated dataset uses hard
links by default to avoid duplicating tens of gigabytes; scripts never modify
those bytes in place. Use `-CopyArchives` only after confirming capacity when
physical isolation is required.

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
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
. .\scripts\model-training-guardrails.ps1

$trainingRoot = "C:\Users\HP\Flippars-ml"
$repositoryRoot = (Resolve-Path -LiteralPath ".").Path
$trainingRoot = Assert-ExternalTrainingRoot $trainingRoot $repositoryRoot
$finalEnvironment = "final-env-v5"
$start = "2022-01-01"
$end = "2026-08-02"
$confidenceThreshold = 0.75
$validityDays = 120

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
    Version = "btc-spot-early-20260826.1"
  },
  [ordered]@{
    SignalType = "FIVE_MINUTE_REVERSAL"
    Version = "btc-spot-5m-reversal-20260826.1"
  },
  [ordered]@{
    SignalType = "FIFTEEN_MINUTE_REVERSAL"
    Version = "btc-spot-15m-reversal-20260826.1"
  }
)

foreach ($run in $runs) {
  $signalSlug = switch ($run.SignalType) {
    "FIVE_MINUTE_EARLY_DIRECTION" { "five-minute-early-direction" }
    "FIVE_MINUTE_REVERSAL" { "five-minute-reversal" }
    "FIFTEEN_MINUTE_REVERSAL" { "fifteen-minute-reversal" }
    default { throw "Unsupported signal type: $($run.SignalType)" }
  }
  $baseVersion = [string]$run.Version
  $variants = @()
  for ($sequence = 0; $sequence -le 99; $sequence++) {
    $variantVersion = if ($sequence -eq 0) {
      $baseVersion
    } else {
      $baseVersion + (".resume{0:D2}" -f $sequence)
    }
    $variantRunKey = "$signalSlug-$variantVersion"
    $variantProcessedRoot = Join-Path $trainingRoot "data\processed\runs\$variantRunKey"
    $variantArtifactRoot = Join-Path $trainingRoot "artifacts\draft\$variantRunKey"
    $variantEvidenceRoot = Join-Path $trainingRoot "evidence\runs\$variantRunKey"
    $variantRoots = @(
      @($variantProcessedRoot, $variantArtifactRoot, $variantEvidenceRoot) |
        Where-Object { Test-Path -LiteralPath $_ }
    )
    if ($variantRoots.Count -gt 0) {
      $variants += [pscustomobject][ordered]@{
        Sequence = $sequence
        Version = $variantVersion
        RunKey = $variantRunKey
        ProcessedRoot = $variantProcessedRoot
        ArtifactRoot = $variantArtifactRoot
        EvidenceRoot = $variantEvidenceRoot
      }
    }
  }

  $completedVariants = @()
  foreach ($variant in $variants) {
    $runManifestPath = Join-Path $variant.EvidenceRoot "run-manifest.json"
    if (-not (Test-Path -LiteralPath $runManifestPath)) {
      continue
    }
    $preparedPath = Join-Path $variant.ProcessedRoot "prepared.jsonl"
    $datasetManifestPath = Join-Path $variant.ProcessedRoot "dataset-manifest.json"
    $candidatePath = Join-Path $variant.ArtifactRoot "candidate.json"
    $evaluationPath = Join-Path $variant.ArtifactRoot "evaluation.json"
    $commandLogPath = Join-Path $variant.EvidenceRoot "training-command-output.log"
    $crossRuntimeLogPath = Join-Path $variant.EvidenceRoot "cross-runtime-verification.log"
    Write-Host "Verifying COMPLETE evidence for $($variant.RunKey)..." -ForegroundColor Cyan
    [void](Assert-CompletedModelTrainingRun `
      -RunManifestPath $runManifestPath `
      -PreparedPath $preparedPath `
      -DatasetManifestPath $datasetManifestPath `
      -CandidatePath $candidatePath `
      -EvaluationPath $evaluationPath `
      -CommandLogPath $commandLogPath `
      -CrossRuntimeLogPath $crossRuntimeLogPath `
      -ExpectedVersion $variant.Version `
      -ExpectedSignalType $run.SignalType)
    $completedVariants += $variant
  }
  if ($completedVariants.Count -gt 1) {
    throw "Multiple COMPLETE immutable runs exist for $signalSlug and $baseVersion."
  }
  if ($completedVariants.Count -eq 1) {
    $latestSequence = ($variants | Measure-Object -Property Sequence -Maximum).Maximum
    if ([int]$completedVariants[0].Sequence -ne [int]$latestSequence) {
      throw "A partial immutable run exists after COMPLETE evidence for $signalSlug."
    }
    Write-Host "Skipping verified COMPLETE run $($completedVariants[0].RunKey)." -ForegroundColor Green
    continue
  }

  $resumeSelected = $false
  $replacementReason = $null
  if ($variants.Count -eq 0) {
    $selectedVersion = $baseVersion
    Write-Host "Starting fresh run $signalSlug-$selectedVersion..." -ForegroundColor Cyan
  } else {
    $latestVariant = $variants | Sort-Object -Property Sequence | Select-Object -Last 1
    foreach ($existingRoot in @(
      $latestVariant.ProcessedRoot,
      $latestVariant.ArtifactRoot,
      $latestVariant.EvidenceRoot
    )) {
      if (Test-Path -LiteralPath $existingRoot) {
        $existingRootItem = Get-Item -LiteralPath $existingRoot -Force
        if (-not $existingRootItem.PSIsContainer -or
            (($existingRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
          throw "Existing immutable run root is not a real directory: $existingRoot"
        }
      }
    }
    if (Test-Path -LiteralPath $latestVariant.ArtifactRoot) {
      $replacementReason = "the partial run already has an artifact root"
    } elseif (-not (Test-Path -LiteralPath $latestVariant.ProcessedRoot) -or
        -not (Test-Path -LiteralPath $latestVariant.EvidenceRoot)) {
      $replacementReason = "the partial run is missing its processed or evidence root"
    } else {
      Write-Host "Preflighting same-version recovery for $($latestVariant.RunKey)..." `
        -ForegroundColor Cyan
      $resumePreflightParameters = @{
        TrainingRoot = $trainingRoot
        EnvironmentName = $finalEnvironment
        Start = $start
        End = $end
        SignalType = $run.SignalType
        Version = [string]$latestVariant.Version
        ConfidenceThreshold = $confidenceThreshold
        ValidityDays = $validityDays
        Mode = "FrozenDraft"
        Resume = $true
        ResumePreflightOnly = $true
      }
      $resumePreflightOutput = @(
        & .\scripts\invoke-model-training.ps1 @resumePreflightParameters
      )
      if ($resumePreflightOutput.Count -ne 1) {
        throw "Resume preflight returned an unexpected response for $($latestVariant.RunKey)."
      }
      try {
        $resumePreflight = [string]$resumePreflightOutput[0] |
          ConvertFrom-Json -ErrorAction Stop
      } catch {
        throw "Resume preflight returned invalid JSON for $($latestVariant.RunKey)."
      }
      if (($resumePreflight.schemaVersion -cne
           "flippars.model-training-resume-preflight/1") -or
          ($resumePreflight.version -cne [string]$latestVariant.Version) -or
          ($resumePreflight.state -cnotin @("ArchivePreparation", "PreparedDataset")) -or
          ($resumePreflight.disposition -cnotin @("RESUMABLE", "REPLACEMENT_REQUIRED"))) {
        throw "Resume preflight returned an invalid contract for $($latestVariant.RunKey)."
      }
      if ($resumePreflight.disposition -ceq "RESUMABLE") {
        if (-not [string]::IsNullOrWhiteSpace([string]$resumePreflight.reason)) {
          throw "A resumable preflight cannot include a replacement reason."
        }
        $selectedVersion = [string]$latestVariant.Version
        $resumeSelected = $true
        Write-Host "Resuming verified compatible run $($latestVariant.RunKey)..." `
          -ForegroundColor Cyan
      } else {
        if ([string]::IsNullOrWhiteSpace([string]$resumePreflight.reason)) {
          throw "A replacement preflight must explain why same-version resume is unsafe."
        }
        $replacementReason = [string]$resumePreflight.reason
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($replacementReason)) {
      $nextSequence = [int]$latestVariant.Sequence + 1
      if ($nextSequence -gt 99) {
        throw "No unused .resumeNN version remains for $signalSlug and $baseVersion."
      }
      $selectedVersion = $baseVersion + (".resume{0:D2}" -f $nextSequence)
      Write-Warning (
        "Preserving unresumable partial run $($latestVariant.RunKey): " +
        "$replacementReason; starting immutable replacement $signalSlug-$selectedVersion."
      )
    }
  }

  $runKey = "$signalSlug-$selectedVersion"
  $invokeParameters = @{
    TrainingRoot = $trainingRoot
    EnvironmentName = $finalEnvironment
    Start = $start
    End = $end
    SignalType = $run.SignalType
    Version = $selectedVersion
    ConfidenceThreshold = $confidenceThreshold
    ValidityDays = $validityDays
    Mode = "FrozenDraft"
  }
  if ($resumeSelected) {
    $invokeParameters.Resume = $true
  }
  & .\scripts\invoke-model-training.ps1 @invokeParameters
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

Block B is restart-aware. It inspects only the exact base version and its
`.resume01` through `.resume99` namespace. When the artifact root is absent and
both processed/evidence roots exist, it calls the runner's read-only typed
preflight. `RESUMABLE` keeps the exact version; `REPLACEMENT_REQUIRED`
preserves that version and starts the next unused immutable `.resumeNN`
version from epoch zero. An interruption before the first durable daily
checkpoint,
changed code or policy, a partial artifact, and another known incompatible
state therefore cannot trap repeated operator runs on the same version.
Malformed or contradictory state and an invalid preflight response fail
closed. A latest `COMPLETE` run is skipped only after the exact prepared
dataset, dataset manifest, candidate, evaluation, training log, and
cross-runtime verification log are each proven to be a nonempty regular file
whose path, size, and SHA-256 match the run manifest, and their model/dataset
identities agree.

Archive checkpoints remain intact throughout fitting, evaluation, and
cross-runtime verification. Cleanup starts only after the schema-2 `COMPLETE`
run manifest has been atomically published. Cleanup failure is therefore
warning-only: the completed run remains auditable, and any exact leftover
checkpoint directory may be removed by a later reviewed offline cleanup.

### Classify aligned candle gaps before recovery

Do not treat every empty aligned window as a file that should be downloaded
again. Preserve the stopped immutable run and its logs, checkpoints,
acquisition manifest, source-integrity evidence, and archive bytes while the
incident is classified.

A checksum-verified internal no-trade interval may continue through governed
preparation only when the official archive binding is intact, the trades on
both sides have consecutive IDs and ordered event times, and the day edges and
remaining content are valid. The prepared dataset must then:

- Record every exact UTC gap start and the non-zero gap count in lineage.
- Create no synthetic candle, price, volume, trade, feature, or label.
- Omit each gap window and every candidate example whose required 13 completed
  lookback windows intersect a gap.
- Keep every accepted window's complete governed decision schedule.

Missing trade IDs, checksum or content corruption, incomplete day edges, and
unexplained gaps that do not meet all of those conditions remain
source-coverage incidents. Review the cache inventory evidence, explicitly quarantine
only the affected candidate, and reacquire from the approved public source into
a separately reviewed immutable dataset snapshot. The current acquisition
helper keys snapshots only by symbol and date range and cannot create a second
revision; do not mutate the original snapshot while that tracked workflow is
absent. If reacquisition produces the same verified bytes without establishing
valid coverage, preserve both evidence sets, escalate the data incident, and
abstain; never fabricate coverage.

The 2023-03-24 Binance Spot incident is the reference operator example. The
inspected governed evidence bound the official
[`BTCUSDT-trades-2023-03-24.zip`](https://data.binance.vision/data/spot/daily/trades/BTCUSDT/BTCUSDT-trades-2023-03-24.zip)
archive to expected and observed SHA-256
`bceaa0b664b055318c22e509d33c04d532da143e7de41ca2fc3457100439c587`.
It contained 30 empty five-minute windows in the half-open range
`[2023-03-24T11:30:00Z, 2023-03-24T14:00:00Z)`; the adjacent trades were ID `3055468954` at
`2023-03-24T11:27:23.146Z` and consecutive ID `3055468955` at
`2023-03-24T14:00:00.062Z`. Binance separately reported a
[14:00 UTC trading restart](https://www.binance.com/en/support/announcement/813a31506e9f478ea8c1058b425df87a).
That report is consistent external context, not proof of the technical cause of
the observed interval. Classify the archive from its integrity and continuity
evidence, retain the 30 gaps, and synthesize nothing.

An exact interruption with unchanged code, policy, plan, manifests, archive
bytes, and model version may use `-Resume`. A code or policy correction changes
the governed source/plan binding and invalidates old checkpoints. Preserve the
failed run under its original version and launch a new immutable model version;
never copy or rename its checkpoints into the new version.

If a run stops after at least one durable daily archive checkpoint exists, or
after the prepared pair is complete but before fitting, Block B may reuse the
exact version only when the typed preflight returns `RESUMABLE`. The preflight
reuses Python's exact plan, checkpoint-key, chunk, digest, size, chain, gap,
latest-source, next-source, and published-output validators without changing
the stopped run. The runner appends a
durable session marker to the existing command log. Preparation resumes at the
last validated daily archive; fitting restarts from epoch zero and reuses the
complete prepared pair. An interruption before the first durable daily checkpoint
returns `REPLACEMENT_REQUIRED`, because no immutable same-version binding can
be proven. `-Resume` rejects partial artifacts, completed runs, unknown files,
links, and malformed temporary state. Preserve every rejected state for
diagnosis; never rename or copy checkpoints into its replacement version.
`ValidityDays` is an expiry, not evidence that calibration will remain stable
for that duration.

## Optional cleanup after successful replacement

The existing `C:\Users\HP\Flippars-ml\.venv` is an older Python 3.13 exploration
environment and is not accepted by `FrozenDraft`. After block A succeeds and
the schema-2 `final-env-v5` evidence has been inspected, it may be removed in a
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
- The gap-aware V4 candidate has no promotion-bundle contract. Live
  feature/outcome providers,
  prospective shadow evidence, drift/OOD monitoring, independent approvals,
  registration, canary, rollback, and user-comprehension acceptance remain
  mandatory.
- The app continues to abstain when no approved healthy prediction is
  available. No component may place a trade or accept exchange credentials.
