[CmdletBinding()]
param(
  [string]$TrainingRoot = (Join-Path $env:USERPROFILE 'Flippars-ml'),
  [string]$EnvironmentName = 'final-env',
  [Parameter(Mandatory)][string]$Start,
  [Parameter(Mandatory)][string]$End,
  [Parameter(Mandatory)]
  [ValidateSet(
    'FIVE_MINUTE_REVERSAL',
    'FIFTEEN_MINUTE_REVERSAL',
    'FIVE_MINUTE_EARLY_DIRECTION'
  )]
  [string]$SignalType,
  [Parameter(Mandatory)][string]$Version,
  [ValidateRange(0.5, 1.0)][double]$ConfidenceThreshold = 0.75,
  [ValidateRange(90, 365)][int]$ValidityDays = 120,
  [ValidateSet('Exploration', 'FrozenDraft')]
  [string]$Mode = 'FrozenDraft'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (Test-Path -LiteralPath 'variable:PSNativeCommandUseErrorActionPreference') {
  $PSNativeCommandUseErrorActionPreference = $false
}
$env:PYTHON_BASIC_REPL = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'

. (Join-Path $PSScriptRoot 'model-training-guardrails.ps1')

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$trainingPath = Assert-ExternalTrainingRoot $TrainingRoot $repositoryRoot
$safeEnvironmentName = Assert-SafeEnvironmentName $EnvironmentName
$safeVersion = Assert-SafeModelVersion $Version
$dateRange = Assert-ModelTrainingDateRange $Start $End
$timeframeMinutes = Get-SignalTimeframeMinutes $SignalType
$signalSlug = Get-SignalArtifactSlug $SignalType
$requestedFiles = [int]($dateRange.End - $dateRange.Start).TotalDays
$deadbandBps = 5.0
$decisionCadenceSeconds = 15
$minimumLeadTimeSeconds = if ($SignalType -eq 'FIFTEEN_MINUTE_REVERSAL') { 30 } else { 15 }

$environmentPath = Assert-PathWithinTrainingRoot `
  (Join-Path $trainingPath $safeEnvironmentName) `
  $trainingPath
$pythonPath = Join-Path $environmentPath 'Scripts\python.exe'
$environmentManifestPath = Join-Path $environmentPath 'environment-manifest.json'
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  throw "Training Python environment is missing: $pythonPath"
}
if (-not (Test-Path -LiteralPath $environmentManifestPath -PathType Leaf)) {
  throw "Training environment evidence is missing: $environmentManifestPath"
}

$datasetKey = "BTCUSDT-$Start--$End"
$datasetRoot = Assert-PathWithinTrainingRoot `
  (Join-Path $trainingPath "datasets\$datasetKey") `
  $trainingPath
$rawRoot = Assert-PathWithinTrainingRoot (Join-Path $datasetRoot 'raw') $trainingPath
$archiveRoot = Join-Path $rawRoot 'archives'
$datasetEvidenceRoot = Join-Path $datasetRoot 'evidence'
$acquisitionManifestPath = Join-Path $datasetEvidenceRoot 'acquisition-manifest.json'
$datasetIntegrityPath = Join-Path $datasetEvidenceRoot 'source-integrity.json'
$runKey = "$signalSlug-$safeVersion"
$processedRoot = Assert-PathWithinTrainingRoot `
  (Join-Path $trainingPath "data\processed\runs\$runKey") `
  $trainingPath
$artifactRoot = Assert-PathWithinTrainingRoot `
  (Join-Path $trainingPath "artifacts\draft\$runKey") `
  $trainingPath
$runEvidenceRoot = Assert-PathWithinTrainingRoot `
  (Join-Path $trainingPath "evidence\runs\$runKey") `
  $trainingPath

foreach ($newRoot in @($processedRoot, $artifactRoot, $runEvidenceRoot)) {
  if (Test-Path -LiteralPath $newRoot) {
    throw "Run output already exists; use a new model version instead of overwriting evidence: $newRoot"
  }
}

$preparedPath = Join-Path $processedRoot 'prepared.jsonl'
$datasetManifestPath = Join-Path $processedRoot 'dataset-manifest.json'
$artifactPath = Join-Path $artifactRoot 'candidate.json'
$evaluationPath = Join-Path $artifactRoot 'evaluation.json'
$cliOutputPath = Join-Path $runEvidenceRoot 'training-command-output.log'
$crossRuntimeOutputPath = Join-Path $runEvidenceRoot 'cross-runtime-verification.log'
$runManifestPath = Join-Path $runEvidenceRoot 'run-manifest.json'

Assert-NoTrackedTrainingMaterial $repositoryRoot
& node (Join-Path $repositoryRoot 'scripts\check-repository.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Repository structure and secret check failed.' }
$initialRepositoryStatus = @(Get-RepositoryStatusSnapshot $repositoryRoot)

$environmentManifest = Get-Content -LiteralPath $environmentManifestPath -Raw | ConvertFrom-Json
if ($Mode -eq 'FrozenDraft') {
  if (([int]$environmentManifest.schemaVersion -ne 2) -or
      ($environmentManifest.completionState -ne 'COMPLETE') -or
      ($environmentManifest.mode -ne 'Locked') -or
      ($environmentManifest.dependencyProfile -ne 'GovernedBaseline') -or
      (-not [bool]$environmentManifest.reproducibleOfflineInstall)) {
    throw 'FrozenDraft requires complete schema-2 GovernedBaseline locked-environment evidence.'
  }
  if (-not [bool]$environmentManifest.repositoryWasClean) {
    throw 'The final environment must have been created from a clean repository state.'
  }
  if ($initialRepositoryStatus.Count -ne 0) {
    throw 'FrozenDraft mode requires a clean repository worktree, including untracked source files.'
  }
  if ((ConvertTo-NormalizedFullPath ([string]$environmentManifest.environmentPath)) -ne
      (ConvertTo-NormalizedFullPath $environmentPath)) {
    throw 'Final-environment evidence names a different environment path.'
  }

  $repositoryCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
  if (($LASTEXITCODE -ne 0) -or ($repositoryCommit -ne [string]$environmentManifest.repositoryCommit)) {
    throw 'Current repository commit does not match the final-environment evidence.'
  }
  foreach ($sourceRecord in @($environmentManifest.sourceHashes)) {
    $sourcePath = [string]$sourceRecord.Path
    if (-not (Test-PathWithin $sourcePath $repositoryRoot)) {
      throw "Environment evidence references source outside the repository: $sourcePath"
    }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Environment source file is missing: $sourcePath"
    }
    $currentHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($currentHash -ne ([string]$sourceRecord.Sha256).ToLowerInvariant()) {
      throw "Environment source digest mismatch: $sourcePath"
    }
  }

  if ($null -eq $environmentManifest.lock) {
    throw 'Final-environment evidence does not bind a dependency lock.'
  }
  $recordedLockPath = Assert-PathWithinTrainingRoot `
    ([string]$environmentManifest.lock.Path) `
    $trainingPath
  if (-not (Test-Path -LiteralPath $recordedLockPath -PathType Leaf)) {
    throw "Recorded dependency lock is missing: $recordedLockPath"
  }
  $currentLockHash = (Get-FileHash -LiteralPath $recordedLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($currentLockHash -ne ([string]$environmentManifest.lock.Sha256).ToLowerInvariant()) {
    throw 'Dependency-lock digest no longer matches final-environment evidence.'
  }
  if ($null -eq $environmentManifest.semanticLock) {
    throw 'Final-environment evidence does not bind semantic lock evidence.'
  }
  $recordedSemanticLockPath = Assert-PathWithinTrainingRoot `
    ([string]$environmentManifest.semanticLock.Path) `
    $trainingPath
  $currentSemanticLockHash = (Get-FileHash -LiteralPath $recordedSemanticLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($currentSemanticLockHash -ne ([string]$environmentManifest.semanticLock.Sha256).ToLowerInvariant()) {
    throw 'Semantic-lock digest no longer matches final-environment evidence.'
  }
  $semanticLock = Get-Content -LiteralPath $recordedSemanticLockPath -Raw | ConvertFrom-Json
  if (([int]$semanticLock.schemaVersion -ne 2) -or
      ($semanticLock.completionState -ne 'COMPLETE') -or
      ($semanticLock.dependencyProfile -ne 'GovernedBaseline') -or
      ([string]$semanticLock.wheelIndexSha256 -ne [string]$environmentManifest.wheelhouse.IndexSha256)) {
    throw 'Semantic-lock evidence is incomplete or incompatible with GovernedBaseline.'
  }

  $recordedFreezePath = Assert-PathWithinTrainingRoot `
    ([string]$environmentManifest.freeze.Path) `
    $environmentPath
  $recordedFreezeHash = (Get-FileHash -LiteralPath $recordedFreezePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($recordedFreezeHash -ne ([string]$environmentManifest.freeze.Sha256).ToLowerInvariant()) {
    throw 'Recorded installed-package snapshot has been changed.'
  }
  $recordedFreeze = @(
    Get-Content -LiteralPath $recordedFreezePath | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  )
  $currentFreeze = @(
    & $pythonPath -m pip --isolated freeze --all | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  )
  if (($LASTEXITCODE -ne 0) -or
      (($recordedFreeze -join "`n") -ne ($currentFreeze -join "`n"))) {
    throw 'Installed packages no longer match the final-environment snapshot.'
  }
  $currentPythonCompatibilityJson = & $pythonPath -c 'import json,platform,sys,sysconfig; print(json.dumps({"implementation": platform.python_implementation(), "version": platform.python_version(), "cacheTag": sys.implementation.cache_tag, "platform": sysconfig.get_platform(), "machine": platform.machine()}))'
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to inspect the current Python runtime identity.'
  }
  $currentPythonCompatibility = ($currentPythonCompatibilityJson -join [Environment]::NewLine) |
    ConvertFrom-Json
  foreach ($field in @('implementation', 'version', 'cacheTag', 'platform', 'machine')) {
    if ([string]$currentPythonCompatibility.$field -ne
        [string]$environmentManifest.pythonCompatibility.$field) {
      throw "Python runtime identity field '$field' no longer matches final-environment evidence."
    }
  }
}

if (-not (Test-Path -LiteralPath $acquisitionManifestPath -PathType Leaf)) {
  throw "Dataset acquisition evidence is missing: $acquisitionManifestPath"
}
if (-not (Test-Path -LiteralPath $datasetIntegrityPath -PathType Leaf)) {
  throw "Dataset integrity evidence is missing: $datasetIntegrityPath"
}
$acquisitionManifest = Get-Content -LiteralPath $acquisitionManifestPath -Raw | ConvertFrom-Json
if (([int]$acquisitionManifest.schemaVersion -ne 3) -or
    ($acquisitionManifest.completionState -ne 'COMPLETE') -or
    (-not [bool]$acquisitionManifest.freshOfficialTransportEvidence) -or
    ($acquisitionManifest.source.provider -ne 'Binance Data Vision') -or
    ($acquisitionManifest.source.marketType -ne 'SPOT') -or
    ($acquisitionManifest.source.symbol -ne 'BTCUSDT') -or
    ($acquisitionManifest.source.dataKind -ne 'DAILY_TRADES') -or
    ($acquisitionManifest.window.startInclusive -ne $Start) -or
    ($acquisitionManifest.window.endExclusive -ne $End) -or
    ([int]$acquisitionManifest.window.dayCount -ne $requestedFiles) -or
    (@($acquisitionManifest.archives).Count -ne $requestedFiles) -or
    ([bool]$acquisitionManifest.credentialsUsed) -or
    ([bool]$acquisitionManifest.tradingApiUsed)) {
  throw 'Dataset acquisition evidence is incomplete or incompatible with this BTCUSDT run.'
}
if ((ConvertTo-NormalizedFullPath ([string]$acquisitionManifest.archiveRoot)) -ne
    (ConvertTo-NormalizedFullPath $archiveRoot)) {
  throw 'Acquisition evidence references a different isolated archive root.'
}
$recordedIntegrityPath = Assert-PathWithinTrainingRoot `
  ([string]$acquisitionManifest.isolatedIntegrity.Path) `
  $trainingPath
if ((ConvertTo-NormalizedFullPath $recordedIntegrityPath) -ne
    (ConvertTo-NormalizedFullPath $datasetIntegrityPath)) {
  throw 'Acquisition evidence references a different source-integrity file.'
}
$recordedIntegrityHash = (Get-FileHash -LiteralPath $datasetIntegrityPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($recordedIntegrityHash -ne ([string]$acquisitionManifest.isolatedIntegrity.Sha256).ToLowerInvariant()) {
  throw 'Dataset integrity evidence digest no longer matches acquisition evidence.'
}

& $pythonPath -m pip --isolated check
if ($LASTEXITCODE -ne 0) { throw 'Training environment dependency check failed.' }

New-Item -ItemType Directory -Path $runEvidenceRoot | Out-Null

$sourceRoot = Join-Path $repositoryRoot 'apps\model-training\src'
$previousPythonPath = $env:PYTHONPATH
$env:PYTHONPATH = $sourceRoot
try {
  Write-Host 'Preparing verified archives through the network-free streamed path...'
  $pipelineErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $pythonPath -m flippars_model_training prepare-archives `
      --archive-root $archiveRoot `
      --start $Start `
      --end $End `
      --output $preparedPath `
      --manifest-output $datasetManifestPath `
      --acquisition-manifest $acquisitionManifestPath `
      --signal-type $SignalType `
      --deadband-bps $deadbandBps `
      --timeframe-minutes $timeframeMinutes `
      --decision-cadence-seconds $decisionCadenceSeconds `
      --minimum-lead-time-seconds $minimumLeadTimeSeconds 2>&1 | `
      Tee-Object -FilePath $cliOutputPath -ErrorAction Stop
    $prepareExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $pipelineErrorActionPreference
  }
  if ($prepareExitCode -ne 0) {
    throw "Offline dataset preparation failed with exit code $prepareExitCode."
  }
  $preparedManifest = Get-Content -LiteralPath $datasetManifestPath -Raw | ConvertFrom-Json
  $acquisitionManifestSha256 = (
    Get-FileHash -LiteralPath $acquisitionManifestPath -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if (($preparedManifest.schemaVersion -ne 'flippars.dataset-manifest/2') -or
      ($preparedManifest.source.lineageKind -ne 'PUBLIC_BINANCE_ARCHIVE') -or
      (-not [bool]$preparedManifest.source.acquisitionEvidence.freshOfficialTransportEvidence) -or
      (([string]$preparedManifest.source.acquisitionEvidence.acquisitionManifestSha256).ToLowerInvariant() -ne
       $acquisitionManifestSha256) -or
      (([string]$preparedManifest.source.acquisitionEvidence.acquisitionArchiveIndexSha256).ToLowerInvariant() -ne
       ([string]$acquisitionManifest.acquisitionArchiveIndexSha256).ToLowerInvariant())) {
    throw 'Prepared dataset does not bind the governed public Binance acquisition evidence.'
  }
  $preparedArchives = @($preparedManifest.source.archives)
  $acquiredArchives = @($acquisitionManifest.archives)
  if ($preparedArchives.Count -ne $requestedFiles) {
    throw 'Prepared dataset manifest does not bind every requested archive.'
  }
  for ($index = 0; $index -lt $requestedFiles; $index += 1) {
    $preparedArchive = $preparedArchives[$index]
    $acquiredArchive = $acquiredArchives[$index]
    if (($preparedArchive.day -ne $acquiredArchive.day) -or
        ($preparedArchive.archive -ne $acquiredArchive.archiveName) -or
        (([string]$preparedArchive.archive_sha256).ToLowerInvariant() -ne
         ([string]$acquiredArchive.archiveSha256).ToLowerInvariant()) -or
        (([string]$preparedArchive.expected_sha256).ToLowerInvariant() -ne
         ([string]$acquiredArchive.expectedArchiveSha256).ToLowerInvariant()) -or
        ([long]$preparedArchive.archive_bytes -ne [long]$acquiredArchive.archiveBytes) -or
        ($preparedArchive.checksum_name -ne $acquiredArchive.checksumName) -or
        ([long]$preparedArchive.checksum_bytes -ne [long]$acquiredArchive.checksumBytes) -or
        (([string]$preparedArchive.checksum_sha256).ToLowerInvariant() -ne
         ([string]$acquiredArchive.checksumSha256).ToLowerInvariant())) {
      throw "Prepared archive verification disagrees with acquisition evidence at index $index."
    }
  }

  Write-Host 'Fitting, calibrating, and evaluating the offline DRAFT candidate...'
  $pipelineErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $pythonPath -m flippars_model_training train `
      --input $preparedPath `
      --manifest $datasetManifestPath `
      --output $artifactPath `
      --evaluation-output $evaluationPath `
      --signal-type $SignalType `
      --version $safeVersion `
      --deadband-bps $deadbandBps `
      --confidence-threshold $ConfidenceThreshold `
      --validity-days $ValidityDays 2>&1 | `
      Tee-Object -FilePath $cliOutputPath -Append -ErrorAction Stop
    $trainExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $pipelineErrorActionPreference
  }
  if ($trainExitCode -ne 0) {
    throw "Draft training command failed with exit code $trainExitCode."
  }
} finally {
  $env:PYTHONPATH = $previousPythonPath
}

foreach ($requiredOutput in @(
  $preparedPath,
  $datasetManifestPath,
  $artifactPath,
  $evaluationPath,
  $cliOutputPath
)) {
  if (-not (Test-Path -LiteralPath $requiredOutput -PathType Leaf)) {
    throw "Training did not produce required output: $requiredOutput"
  }
}

$artifact = Get-Content -LiteralPath $artifactPath -Raw | ConvertFrom-Json
$evaluation = Get-Content -LiteralPath $evaluationPath -Raw | ConvertFrom-Json
if (($artifact.schemaVersion -ne 'flippars.multinomial-candidate/3') -or
    ($artifact.status -ne 'DRAFT') -or
    ($artifact.signalType -ne $SignalType) -or
    ($artifact.version -ne $safeVersion)) {
  throw 'Draft artifact identity or lifecycle validation failed.'
}
if (($null -ne $artifact.approval.approvedAt) -or ($null -ne $artifact.approval.approvedBy)) {
  throw 'Training output must not contain model approval.'
}
if (($artifact.target.venue -ne 'BINANCE') -or
    ($artifact.target.marketType -ne 'SPOT') -or
    ($artifact.target.symbol -ne 'BTCUSDT') -or
    ([double]$artifact.target.deadbandBps -ne $deadbandBps) -or
    ([int]$artifact.target.durationSeconds -ne ($timeframeMinutes * 60)) -or
    ([int]$artifact.target.candidateSchedule.minimumLeadTimeSeconds -ne $minimumLeadTimeSeconds)) {
  throw 'Draft target contract does not match the governed training invocation.'
}
if (($evaluation.status -ne 'DRAFT') -or
    ($evaluation.schemaVersion -ne 'flippars.model-evaluation/3') -or
    ($evaluation.artifactSchemaVersion -ne 'flippars.multinomial-candidate/3') -or
    ([bool]$evaluation.productionEligible) -or
    ($evaluation.evaluationScope -ne 'BINANCE_CONDITIONAL_DETERMINISTIC_WINDOW_SAMPLE_DIAGNOSTIC_ONLY') -or
    ($evaluation.signalType -ne $SignalType) -or
    ($evaluation.version -ne $safeVersion) -or
    ([double]$evaluation.thresholdPolicy.deadbandBps -ne $deadbandBps) -or
    ([double]$evaluation.thresholdPolicy.confidenceThreshold -ne $ConfidenceThreshold)) {
  throw 'Evaluation policy does not match the governed training invocation.'
}
$preEvaluationPolicyHash = [string]$artifact.preEvaluationPolicySha256
if (($preEvaluationPolicyHash -notmatch '^[a-f0-9]{64}$') -or
    ($preEvaluationPolicyHash -cne [string]$evaluation.preEvaluationPolicySha256)) {
  throw 'Artifact and evaluation pre-evaluation policy digests do not match.'
}
if ($evaluation.fitDiagnostics.converged -ne $true) {
  throw 'Draft optimizer did not report successful convergence.'
}
if (($evaluation.productionGuardedPolicyReplay.scope -ne 'PRODUCTION_GUARDED_REPLAY') -or
    ($evaluation.productionGuardedPolicyReplay.crossVenueGuardRequired -ne $true) -or
    ([int]$evaluation.productionGuardedPolicyReplay.alertCount -ne 0) -or
    ([int]$evaluation.productionGuardedPolicyReplay.abstentionRowCounts.CROSS_VENUE_GUARD_UNAVAILABLE -le 0)) {
  throw 'Production-guarded replay did not preserve mandatory abstention.'
}
if ($evaluation.calibrationByDecisionPopulation.userFacingConfidenceCalibrationClaimSupported -ne $false) {
  throw 'Draft evaluation must not claim user-facing confidence calibration support.'
}
$pipelinePath = Join-Path $sourceRoot 'flippars_model_training\pipeline.py'
$pipelineHash = (Get-FileHash -LiteralPath $pipelinePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($pipelineHash -ne ([string]$artifact.trainingCodeSha256).ToLowerInvariant()) {
  throw 'Artifact training-code digest does not match the executed pipeline.'
}

$crossRuntimeVerifier = Join-Path $repositoryRoot 'scripts\verify-python-v3-artifact.mjs'
$compiledContract = Join-Path $repositoryRoot 'packages\contracts\dist\index.js'
$compiledArtifactSchema = Join-Path $repositoryRoot 'packages\model-artifact\dist\schema.js'
foreach ($verifierInput in @(
  $crossRuntimeVerifier,
  $compiledContract,
  $compiledArtifactSchema
)) {
  if (-not (Test-Path -LiteralPath $verifierInput -PathType Leaf)) {
    throw "Cross-runtime verification prerequisite is missing: $verifierInput"
  }
}
Write-Host 'Running strict Python-to-TypeScript lineage verification...'
$verifierErrorActionPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  & node $crossRuntimeVerifier `
    --artifact $artifactPath `
    --dataset-manifest $datasetManifestPath `
    --evaluation $evaluationPath `
    --pipeline $pipelinePath `
    --prepared $preparedPath `
    --acquisition-manifest $acquisitionManifestPath 2>&1 | `
    Tee-Object -FilePath $crossRuntimeOutputPath -ErrorAction Stop
  $crossRuntimeExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $verifierErrorActionPreference
}
if ($crossRuntimeExitCode -ne 0) {
  throw "Strict cross-runtime lineage verification failed with exit code $crossRuntimeExitCode."
}
if (-not (Test-Path -LiteralPath $crossRuntimeOutputPath -PathType Leaf)) {
  throw 'Strict cross-runtime lineage verification did not produce audit evidence.'
}

$finalRepositoryStatus = @(Get-RepositoryStatusSnapshot $repositoryRoot)
if (($initialRepositoryStatus -join "`n") -ne ($finalRepositoryStatus -join "`n")) {
  throw 'Training changed repository state; inspect and quarantine the unexpected files.'
}

$finalSourceIntegrityRecord = Get-Sha256Record $datasetIntegrityPath
if (([string]$finalSourceIntegrityRecord.Sha256).ToLowerInvariant() -ne
    $recordedIntegrityHash) {
  throw 'Dataset integrity evidence changed after validation.'
}
$finalAcquisitionRecord = Get-Sha256Record $acquisitionManifestPath
if (([string]$finalAcquisitionRecord.Sha256).ToLowerInvariant() -ne
    $acquisitionManifestSha256) {
  throw 'Acquisition evidence changed after dataset preparation.'
}

$repositoryCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to record training commit.' }
$runManifest = [ordered]@{
  schemaVersion = 2
  completionState = 'COMPLETE'
  completedAt = [datetime]::UtcNow.ToString('o')
  mode = $Mode
  repositoryCommit = $repositoryCommit
  repositoryWasClean = ($initialRepositoryStatus.Count -eq 0)
  environment = Get-Sha256Record $environmentManifestPath
  target = [ordered]@{
    venue = 'BINANCE'
    marketType = 'SPOT'
    symbol = 'BTCUSDT'
    signalType = $SignalType
    timeframeMinutes = $timeframeMinutes
    deadbandBps = $deadbandBps
    decisionCadenceSeconds = $decisionCadenceSeconds
    minimumLeadTimeSeconds = $minimumLeadTimeSeconds
    confidenceThreshold = $ConfidenceThreshold
    validityDays = $ValidityDays
  }
  dataWindow = [ordered]@{ startInclusive = $Start; endExclusive = $End }
  sourceIntegrity = $finalSourceIntegrityRecord
  acquisition = $finalAcquisitionRecord
  outputs = @(
    Get-Sha256Record $preparedPath
    Get-Sha256Record $datasetManifestPath
    Get-Sha256Record $artifactPath
    Get-Sha256Record $evaluationPath
    Get-Sha256Record $cliOutputPath
    Get-Sha256Record $crossRuntimeOutputPath
  )
  lifecycle = [ordered]@{
    artifactStatus = 'DRAFT'
    signalsEnabled = $false
    promotionAttempted = $false
  }
  limitations = @(
    'Binance Spot BTCUSDT-only data does not establish live multi-venue feature parity.',
    'Artifact expiry is not evidence that calibration remains stable for that period.',
    'Prospective shadow, independent validation, signing, registration, canary, and enablement remain separate gates.'
  )
}
Write-JsonEvidenceAtomic -Path $runManifestPath -Value $runManifest -Depth 12

Write-Host "Frozen DRAFT artifact: $artifactPath"
Write-Host "Evaluation: $evaluationPath"
Write-Host "Run evidence: $runManifestPath"
Write-Warning 'No model was approved, registered, promoted, or enabled.'
