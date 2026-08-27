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
  [string]$Mode = 'FrozenDraft',
  [switch]$Resume,
  [switch]$ResumePreflightOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (Test-Path -LiteralPath 'variable:PSNativeCommandUseErrorActionPreference') {
  $PSNativeCommandUseErrorActionPreference = $false
}
$env:PYTHON_BASIC_REPL = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONUNBUFFERED = '1'
$env:PYTHONIOENCODING = 'utf-8'

. (Join-Path $PSScriptRoot 'model-training-guardrails.ps1')

if ($ResumePreflightOnly -and -not $Resume) {
  throw 'ResumePreflightOnly requires -Resume.'
}

function Get-ModelTrainingRunStartState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ProcessedRoot,
    [Parameter(Mandatory)][string]$ArtifactRoot,
    [Parameter(Mandatory)][string]$EvidenceRoot,
    [Parameter(Mandatory)][string]$PreparedPath,
    [Parameter(Mandatory)][string]$DatasetManifestPath,
    [Parameter(Mandatory)][string]$CheckpointRoot,
    [Parameter(Mandatory)][string]$CommandLogPath,
    [switch]$Resume
  )

  if (-not $Resume) {
    foreach ($root in @($ProcessedRoot, $ArtifactRoot, $EvidenceRoot)) {
      if (Test-Path -LiteralPath $root) {
        throw "Run output already exists; use a new model version instead of overwriting evidence: $root"
      }
    }
    return [pscustomobject][ordered]@{
      Kind = 'Fresh'
      SkipPreparation = $false
      AppendFirstChild = $false
    }
  }

  if (Test-Path -LiteralPath $ArtifactRoot) {
    throw "Resume requires the artifact root to be absent: $ArtifactRoot"
  }

  foreach ($requiredDirectory in @(
    [pscustomobject]@{ Path = $ProcessedRoot; Label = 'processed root' }
    [pscustomobject]@{ Path = $EvidenceRoot; Label = 'evidence root' }
  )) {
    if (-not (Test-Path -LiteralPath $requiredDirectory.Path -PathType Container)) {
      throw "Resume requires an existing real $($requiredDirectory.Label): $($requiredDirectory.Path)"
    }
    $item = Get-Item -LiteralPath $requiredDirectory.Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Resume rejects a reparse-point $($requiredDirectory.Label): $($requiredDirectory.Path)"
    }
  }

  $evidenceEntries = @(Get-ChildItem -LiteralPath $EvidenceRoot -Force)
  $commandLogName = [System.IO.Path]::GetFileName($CommandLogPath)
  if (($evidenceEntries.Count -ne 1) -or
      ([string]$evidenceEntries[0].Name -cne $commandLogName)) {
    throw 'Resume evidence root must contain only training-command-output.log.'
  }
  $commandLog = $evidenceEntries[0]
  if ($commandLog.PSIsContainer -or
      (($commandLog.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
      ([long]$commandLog.Length -le 0)) {
    throw 'Resume requires a nonempty regular training-command-output.log.'
  }

  $processedEntries = @(Get-ChildItem -LiteralPath $ProcessedRoot -Force)
  $checkpointName = [System.IO.Path]::GetFileName($CheckpointRoot)
  $checkpointMatches = @(
    $processedEntries | Where-Object { [string]$_.Name -ceq $checkpointName }
  )
  if ($checkpointMatches.Count -eq 1) {
    $checkpoint = $checkpointMatches[0]
    if (-not $checkpoint.PSIsContainer -or
        (($checkpoint.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw 'Resume archive checkpoint store must be a real directory.'
    }
    $preparedName = [System.IO.Path]::GetFileName($PreparedPath)
    $manifestName = [System.IO.Path]::GetFileName($DatasetManifestPath)
    $preparedTempPattern = '^\.' +
      [regex]::Escape($preparedName) +
      '\.[A-Za-z0-9_-]{8}\.part$'
    $manifestTempPattern = '^\.' +
      [regex]::Escape($manifestName) +
      '\.[A-Za-z0-9_-]{8}\.part$'
    $planTempPattern = '^\.plan\.json\.[A-Za-z0-9_-]{8}\.part$'
    $checkpointEntries = @(
      Get-ChildItem -LiteralPath $CheckpointRoot -Force |
        Sort-Object -Property Name -CaseSensitive
    )
    if ($checkpointEntries.Count -eq 0) {
      if ($processedEntries.Count -ne 1) {
        throw 'Resume rejects sibling content beside an empty checkpoint store.'
      }
      return [pscustomobject][ordered]@{
        Kind = 'ArchivePreparation'
        SkipPreparation = $false
        AppendFirstChild = $true
      }
    }
    $archivesMatches = @(
      $checkpointEntries | Where-Object { [string]$_.Name -ceq 'archives' }
    )
    $planMatches = @(
      $checkpointEntries | Where-Object { [string]$_.Name -ceq 'plan.json' }
    )
    $planTemporaryMatches = @(
      $checkpointEntries | Where-Object { [string]$_.Name -cmatch $planTempPattern }
    )
    if ($archivesMatches.Count -ne 1) {
      throw 'Resume archive checkpoint store requires exactly one archives directory.'
    }
    $archivesDirectory = $archivesMatches[0]
    if (-not $archivesDirectory.PSIsContainer -or
        (($archivesDirectory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw 'Resume archive checkpoint store requires a real archives directory.'
    }
    $archiveCheckpoints = @(Get-ChildItem -LiteralPath $archivesDirectory.FullName -Force)
    if (($checkpointEntries.Count -eq 1) -and ($archiveCheckpoints.Count -eq 0)) {
      if ($processedEntries.Count -ne 1) {
        throw 'Resume rejects sibling content beside an initial archives-only checkpoint store.'
      }
      return [pscustomobject][ordered]@{
        Kind = 'ArchivePreparation'
        SkipPreparation = $false
        AppendFirstChild = $true
      }
    }
    $isInitialPlanPublication = (
      ($checkpointEntries.Count -eq 2) -and
      ($planMatches.Count -eq 0) -and
      ($planTemporaryMatches.Count -eq 1)
    )
    if ($isInitialPlanPublication) {
      $planTemporary = $planTemporaryMatches[0]
      if (($processedEntries.Count -ne 1) -or
          $planTemporary.PSIsContainer -or
          (($planTemporary.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
          ($archiveCheckpoints.Count -ne 0)) {
        throw 'Resume rejects an ambiguous initial checkpoint-plan publication state.'
      }
      return [pscustomobject][ordered]@{
        Kind = 'ArchivePreparation'
        SkipPreparation = $false
        AppendFirstChild = $true
      }
    }
    if (($checkpointEntries.Count -ne 2) -or
        ($planMatches.Count -ne 1) -or
        ($planTemporaryMatches.Count -ne 0)) {
      throw 'Resume archive checkpoint store must contain only archives and plan.json.'
    }
    $planFile = $planMatches[0]
    if ($planFile.PSIsContainer -or
        (($planFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
        ([long]$planFile.Length -le 0)) {
      throw 'Resume archive checkpoint store has an invalid plan file.'
    }
    $publishedPrepared = @(
      $processedEntries | Where-Object { [string]$_.Name -ceq $preparedName }
    )
    $publishedManifest = @(
      $processedEntries | Where-Object { [string]$_.Name -ceq $manifestName }
    )
    if ($publishedPrepared.Count -gt 1 -or $publishedManifest.Count -gt 1) {
      throw 'Resume checkpoint state has an invalid published dataset state.'
    }
    $hasPublishedPair = (
      ($publishedPrepared.Count -eq 1) -and
      ($publishedManifest.Count -eq 1)
    )
    if ($publishedManifest.Count -eq 1 -and -not $hasPublishedPair) {
      throw 'Resume checkpoint state cannot contain a manifest without its dataset.'
    }
    if ($hasPublishedPair) {
      if ($processedEntries.Count -ne 3) {
        throw 'Resume completed-output reconciliation rejects sibling content.'
      }
      foreach ($publishedEntry in @($publishedPrepared[0], $publishedManifest[0])) {
        if ($publishedEntry.PSIsContainer -or
            (($publishedEntry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
            ([long]$publishedEntry.Length -le 0)) {
          throw 'Resume completed-output reconciliation requires nonempty regular files.'
        }
      }
      return [pscustomobject][ordered]@{
        Kind = 'ArchivePreparation'
        SkipPreparation = $false
        AppendFirstChild = $true
      }
    }
    if ($publishedPrepared.Count -eq 1) {
      $publishedPreparedEntry = $publishedPrepared[0]
      if ($publishedPreparedEntry.PSIsContainer -or
          (($publishedPreparedEntry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
          ([long]$publishedPreparedEntry.Length -le 0)) {
        throw 'Resume checkpoint state requires a nonempty regular published dataset.'
      }
    }
    foreach ($temporaryEntry in @(
      $processedEntries | Where-Object {
        ([string]$_.Name -cne $checkpointName) -and
        ([string]$_.Name -cne $preparedName)
      }
    )) {
      if ($temporaryEntry.PSIsContainer -or
          (($temporaryEntry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
          (([string]$temporaryEntry.Name -cnotmatch $preparedTempPattern) -and
           ([string]$temporaryEntry.Name -cnotmatch $manifestTempPattern))) {
        throw 'Resume checkpoint state contains unexpected preparation debris.'
      }
    }
    return [pscustomobject][ordered]@{
      Kind = 'ArchivePreparation'
      SkipPreparation = $false
      AppendFirstChild = $true
    }
  }

  $expectedPreparedNames = @(
    [System.IO.Path]::GetFileName($DatasetManifestPath),
    [System.IO.Path]::GetFileName($PreparedPath)
  ) | Sort-Object -CaseSensitive
  $actualPreparedNames = @(
    $processedEntries | ForEach-Object { [string]$_.Name } | Sort-Object -CaseSensitive
  )
  if (($actualPreparedNames.Count -ne 2) -or
      (($actualPreparedNames -join "`n") -cne ($expectedPreparedNames -join "`n"))) {
    throw 'Resume processed root must contain only a checkpoint store or the prepared dataset pair.'
  }
  foreach ($preparedEntry in $processedEntries) {
    if ($preparedEntry.PSIsContainer -or
        (($preparedEntry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
        ([long]$preparedEntry.Length -le 0)) {
      throw 'Resume requires nonempty regular prepared dataset files.'
    }
  }
  return [pscustomobject][ordered]@{
    Kind = 'PreparedDataset'
    SkipPreparation = $true
    AppendFirstChild = $true
  }
}

function Throw-ModelTrainingResumeReplacementRequired {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Message)

  $exception = [System.InvalidOperationException]::new($Message)
  $exception.Data['FlipparsResumeDisposition'] = 'REPLACEMENT_REQUIRED'
  throw $exception
}

function Assert-ArchiveResumeSemanticCompatibility {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$CheckpointRoot,
    [Parameter(Mandatory)][string]$PipelinePath,
    [Parameter(Mandatory)][string]$AcquisitionManifestPath,
    [Parameter(Mandatory)][string]$PreparedPath,
    [Parameter(Mandatory)][string]$DatasetManifestPath,
    [Parameter(Mandatory)][string]$SignalType,
    [Parameter(Mandatory)][double]$DeadbandBps,
    [Parameter(Mandatory)][int]$TimeframeMinutes,
    [Parameter(Mandatory)][int]$DecisionCadenceSeconds,
    [Parameter(Mandatory)][int]$MinimumLeadTimeSeconds,
    [Parameter(Mandatory)][int]$ArchiveCount
  )

  $planPath = Join-Path $CheckpointRoot 'plan.json'
  if (-not (Test-Path -LiteralPath $planPath -PathType Leaf)) {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume requires a durable archive-preparation plan before semantic ' +
      'compatibility can be established. Preserve this run and use a new model version.'
    )
  }
  $planItem = Get-Item -LiteralPath $planPath -Force
  if (($planItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Resume rejects a reparse-point archive-preparation plan.'
  }
  try {
    $plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
  } catch {
    throw 'Resume archive-preparation plan is not valid JSON.'
  }
  if ([string]::IsNullOrWhiteSpace([string]$plan.schemaVersion)) {
    throw 'Resume archive-preparation plan has an unsupported identity.'
  }
  if ($plan.schemaVersion -ne 'flippars.archive-preparation-plan/1') {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume archive-preparation plan uses a different schema. ' +
      'Preserve this run and use a new model version.'
    )
  }
  if ([string]$plan.fingerprintSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Resume archive-preparation plan has an invalid fingerprint.'
  }
  $inputs = $plan.inputs
  if ($null -eq $inputs) {
    throw 'Resume archive-preparation plan is missing its immutable inputs.'
  }
  if (($inputs.schemas.dataset -ne 'flippars.training-dataset/3') -or
      ($inputs.schemas.datasetManifest -ne 'flippars.dataset-manifest/3') -or
      ($inputs.schemas.feature -ne 'binance-spot-signal-features/1') -or
      ($inputs.schemas.labelPolicy -ne 'binance-spot-trade-close-relation/1') -or
      ($inputs.schemas.decisionPolicy -ne 'flippars-signal-candidate-sampling/1')) {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume archive-preparation schemas differ from the current gap-aware policy. ' +
      'Preserve this run and use a new model version.'
    )
  }
  if ([string]$inputs.generator.pipelineSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Resume archive-preparation generator has an invalid pipeline digest.'
  }
  if ($inputs.generator.packageVersion -ne '0.3.0') {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume archive-preparation generator is incompatible with the current runner. ' +
      'Preserve this run and use a new model version.'
    )
  }
  $currentPipelineSha256 = (
    Get-FileHash -LiteralPath $PipelinePath -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if (([string]$inputs.generator.pipelineSha256).ToLowerInvariant() -ne
      $currentPipelineSha256) {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume archive-preparation code digest differs from the current pipeline. ' +
      'Preserve this run and use a new model version.'
    )
  }
  $options = $inputs.options
  if (($options.signal_type -ne $SignalType) -or
      ([double]$options.deadband_bps -ne $DeadbandBps) -or
      ([int]$options.timeframe_minutes -ne $TimeframeMinutes) -or
      ([int]$options.decision_cadence_seconds -ne $DecisionCadenceSeconds) -or
      ([int]$options.minimum_lead_time_seconds -ne $MinimumLeadTimeSeconds)) {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume archive-preparation options differ from the requested signal policy. ' +
      'Preserve this run and use a new model version.'
    )
  }
  if ((ConvertTo-NormalizedFullPath ([string]$inputs.output)) -cne
      (ConvertTo-NormalizedFullPath $PreparedPath) -or
      (ConvertTo-NormalizedFullPath ([string]$inputs.manifestOutput)) -cne
      (ConvertTo-NormalizedFullPath $DatasetManifestPath)) {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume archive-preparation outputs differ from the immutable plan. ' +
      'Preserve this run and use a new model version.'
    )
  }
  if (-not (Test-Path -LiteralPath $AcquisitionManifestPath -PathType Leaf)) {
    throw 'Resume acquisition evidence is missing.'
  }
  $acquisitionInput = $inputs.acquisitionManifest
  if (($null -eq $acquisitionInput) -or
      ((ConvertTo-NormalizedFullPath ([string]$acquisitionInput.path)) -cne
       (ConvertTo-NormalizedFullPath $AcquisitionManifestPath))) {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume acquisition evidence path differs from the immutable plan. ' +
      'Preserve this run and use a new model version.'
    )
  }
  $currentAcquisitionSha256 = (
    Get-FileHash -LiteralPath $AcquisitionManifestPath -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if (([string]$acquisitionInput.sha256).ToLowerInvariant() -ne
      $currentAcquisitionSha256) {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume acquisition evidence digest differs from the immutable plan. ' +
      'Preserve this run and use a new model version.'
    )
  }
  if (@($inputs.archives).Count -ne $ArchiveCount) {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume archive count differs from the requested immutable date range. ' +
      'Preserve this run and use a new model version.'
    )
  }

  $archivesRoot = Join-Path $CheckpointRoot 'archives'
  $archiveCheckpointEntries = @(
    Get-ChildItem -LiteralPath $archivesRoot -Force
  )
  $durableArchiveCheckpointEntries = @()
  foreach ($entry in $archiveCheckpointEntries) {
    if ([string]$entry.Name -cmatch
        '^\.[0-9]{8}\.[A-Za-z0-9_-]{8}\.part$') {
      if (-not $entry.PSIsContainer -or
          (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'Resume archive checkpoint temporary entry is invalid.'
      }
      $temporaryDirectories = [System.Collections.Generic.Stack[string]]::new()
      $temporaryDirectories.Push($entry.FullName)
      while ($temporaryDirectories.Count -gt 0) {
        $temporaryDirectory = $temporaryDirectories.Pop()
        foreach ($temporaryChild in @(
          Get-ChildItem -LiteralPath $temporaryDirectory -Force
        )) {
          if (($temporaryChild.Attributes -band
              [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Resume archive checkpoint temporary contains a reparse point.'
          }
          if ($temporaryChild.PSIsContainer) {
            $temporaryDirectories.Push($temporaryChild.FullName)
          }
        }
      }
      continue
    }
    if (-not $entry.PSIsContainer -or
        (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
        ([string]$entry.Name -cnotmatch '^[0-9]{8}$')) {
      throw 'Resume archive checkpoints contain an invalid entry.'
    }
    $durableArchiveCheckpointEntries += $entry
    $checkpointPath = Join-Path $entry.FullName 'checkpoint.json'
    if (-not (Test-Path -LiteralPath $checkpointPath -PathType Leaf)) {
      throw 'Resume archive checkpoint is missing checkpoint.json.'
    }
    try {
      $checkpoint = Get-Content -LiteralPath $checkpointPath -Raw | ConvertFrom-Json
    } catch {
      throw 'Resume archive checkpoint is not valid JSON.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$checkpoint.schemaVersion)) {
      throw 'Resume archive checkpoint is missing its schema identity.'
    }
    if ($checkpoint.schemaVersion -ne 'flippars.archive-preparation-checkpoint/2') {
      Throw-ModelTrainingResumeReplacementRequired -Message (
        'Resume archive checkpoint uses a different schema. ' +
        'Preserve this run and use a new model version.'
      )
    }
    if ([string]$checkpoint.planFingerprintSha256 -cnotmatch '^[a-f0-9]{64}$') {
      throw 'Resume archive checkpoint has an invalid plan fingerprint.'
    }
    if ($checkpoint.planFingerprintSha256 -cne $plan.fingerprintSha256) {
      throw 'Resume archive checkpoint fingerprint contradicts the durable plan.'
    }
  }
  if ($durableArchiveCheckpointEntries.Count -eq 0) {
    Throw-ModelTrainingResumeReplacementRequired -Message (
      'Resume has no durable daily checkpoint to preserve. ' +
      'Preserve this run and use a new model version.'
    )
  }
}

function Get-ArchiveResumeSemanticDisposition {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$CheckpointRoot,
    [Parameter(Mandatory)][string]$PipelinePath,
    [Parameter(Mandatory)][string]$AcquisitionManifestPath,
    [Parameter(Mandatory)][string]$PreparedPath,
    [Parameter(Mandatory)][string]$DatasetManifestPath,
    [Parameter(Mandatory)][string]$SignalType,
    [Parameter(Mandatory)][double]$DeadbandBps,
    [Parameter(Mandatory)][int]$TimeframeMinutes,
    [Parameter(Mandatory)][int]$DecisionCadenceSeconds,
    [Parameter(Mandatory)][int]$MinimumLeadTimeSeconds,
    [Parameter(Mandatory)][int]$ArchiveCount
  )

  try {
    Assert-ArchiveResumeSemanticCompatibility @PSBoundParameters
    return [pscustomobject][ordered]@{
      Disposition = 'PYTHON_VALIDATION_REQUIRED'
      Reason = $null
    }
  } catch {
    if ([string]$_.Exception.Data['FlipparsResumeDisposition'] -ceq
        'REPLACEMENT_REQUIRED') {
      return [pscustomobject][ordered]@{
        Disposition = 'REPLACEMENT_REQUIRED'
        Reason = $_.Exception.Message
      }
    }
    throw
  }
}

function Assert-PythonArchiveResumeAdmission {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$PythonPath,
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$ArchiveRoot,
    [Parameter(Mandatory)][string]$Start,
    [Parameter(Mandatory)][string]$End,
    [Parameter(Mandatory)][string]$PreparedPath,
    [Parameter(Mandatory)][string]$DatasetManifestPath,
    [Parameter(Mandatory)][string]$AcquisitionManifestPath,
    [Parameter(Mandatory)][string]$SignalType,
    [Parameter(Mandatory)][double]$DeadbandBps,
    [Parameter(Mandatory)][int]$TimeframeMinutes,
    [Parameter(Mandatory)][int]$DecisionCadenceSeconds,
    [Parameter(Mandatory)][int]$MinimumLeadTimeSeconds,
    [Parameter(Mandatory)][int]$ArchiveCount
  )

  $previousPythonPath = $env:PYTHONPATH
  $env:PYTHONPATH = $SourceRoot
  try {
    Write-Host (
      'Running read-only Python checkpoint admission; validating the latest and ' +
      'next source archives can be quiet for several minutes...'
    ) -ForegroundColor DarkCyan
    $result = Invoke-CapturedNativeProcess `
      -FilePath $PythonPath `
      -ArgumentList @(
        '-m', 'flippars_model_training', 'preflight-archive-resume',
        '--archive-root', $ArchiveRoot,
        '--start', $Start,
        '--end', $End,
        '--output', $PreparedPath,
        '--manifest-output', $DatasetManifestPath,
        '--acquisition-manifest', $AcquisitionManifestPath,
        '--signal-type', $SignalType,
        '--deadband-bps', [string]$DeadbandBps,
        '--timeframe-minutes', [string]$TimeframeMinutes,
        '--decision-cadence-seconds', [string]$DecisionCadenceSeconds,
        '--minimum-lead-time-seconds', [string]$MinimumLeadTimeSeconds
      ) `
      -WorkingDirectory $RepositoryRoot
  } finally {
    $env:PYTHONPATH = $previousPythonPath
  }
  if ([int]$result.ExitCode -ne 0) {
    $failure = ([string]$result.Stderr).Trim()
    if ([string]::IsNullOrWhiteSpace($failure)) {
      $failure = 'Python returned no diagnostic output.'
    }
    throw "Python archive-resume admission failed: $failure"
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$result.Stderr)) {
    throw 'Python archive-resume admission emitted unexpected diagnostic output.'
  }
  $responseText = ([string]$result.Stdout).Trim()
  if ([string]::IsNullOrWhiteSpace($responseText) -or
      $responseText -match '[\r\n]') {
    throw 'Python archive-resume admission did not return exactly one JSON record.'
  }
  try {
    $response = $responseText | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'Python archive-resume admission returned invalid JSON.'
  }
  $archiveCountIsInteger = (
    ($response.archiveCount -is [int]) -or
    ($response.archiveCount -is [long])
  )
  $checkpointCountIsInteger = (
    ($response.checkpointCount -is [int]) -or
    ($response.checkpointCount -is [long])
  )
  if (($response.schemaVersion -cne 'flippars.archive-resume-admission/1') -or
      ($response.state -cne 'ArchivePreparation') -or
      (-not ($response.readOnly -is [bool])) -or
      ($response.readOnly -ne $true) -or
      (-not $archiveCountIsInteger) -or
      (-not $checkpointCountIsInteger) -or
      ([int]$response.archiveCount -ne $ArchiveCount) -or
      ([int]$response.checkpointCount -lt 1) -or
      ([int]$response.checkpointCount -gt $ArchiveCount)) {
    throw 'Python archive-resume admission returned an invalid contract.'
  }
}

function Write-ModelTrainingResumeSessionMarker {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$LogPath,
    [Parameter(Mandatory)][ValidateSet('ArchivePreparation', 'PreparedDataset')]
    [string]$State,
    [Parameter(Mandatory)][string]$Version
  )

  if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
    throw "Resume session log is missing: $LogPath"
  }
  $marker = '[flippars-resume-session] startedAt={0} state={1} version={2}' -f `
    [datetime]::UtcNow.ToString('o', [System.Globalization.CultureInfo]::InvariantCulture),
    $State,
    $Version
  $encoding = [System.Text.UTF8Encoding]::new($false)
  $payload = $encoding.GetBytes(
    [Environment]::NewLine + $marker + [Environment]::NewLine
  )
  $stream = $null
  try {
    $stream = [System.IO.File]::Open(
      $LogPath,
      [System.IO.FileMode]::Append,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::Read
    )
    $stream.Write($payload, 0, $payload.Length)
    $stream.Flush($true)
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
  Write-Host $marker -ForegroundColor DarkCyan
}

function Remove-CompletedArchiveCheckpointStore {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ProcessedRoot,
    [Parameter(Mandatory)][string]$CheckpointRoot
  )

  try {
    $normalizedProcessedRoot = ConvertTo-NormalizedFullPath $ProcessedRoot
    $normalizedCheckpointRoot = ConvertTo-NormalizedFullPath $CheckpointRoot
    $expectedCheckpointRoot = ConvertTo-NormalizedFullPath (
      Join-Path $normalizedProcessedRoot '.prepared.jsonl.archive-checkpoints'
    )
    if (-not [string]::Equals(
      $normalizedCheckpointRoot,
      $expectedCheckpointRoot,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw 'Checkpoint cleanup target is not the exact governed checkpoint child.'
    }
    if (-not (Test-Path -LiteralPath $normalizedProcessedRoot -PathType Container)) {
      throw 'Checkpoint cleanup processed root is not a directory.'
    }
    $processedItem = Get-Item -LiteralPath $normalizedProcessedRoot -Force
    if (($processedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Checkpoint cleanup refuses a reparse-point processed root.'
    }
    if (-not (Test-Path -LiteralPath $normalizedCheckpointRoot)) {
      return $false
    }
    $checkpointItem = Get-Item -LiteralPath $normalizedCheckpointRoot -Force
    if (-not $checkpointItem.PSIsContainer -or
        (($checkpointItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw 'Checkpoint cleanup target must be a real directory.'
    }
    $directoriesToInspect = [System.Collections.Generic.Stack[string]]::new()
    $directoriesToInspect.Push($normalizedCheckpointRoot)
    while ($directoriesToInspect.Count -gt 0) {
      $directoryToInspect = $directoriesToInspect.Pop()
      foreach ($descendant in @(Get-ChildItem -LiteralPath $directoryToInspect -Force)) {
        if (($descendant.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw 'Checkpoint cleanup refuses a store containing a reparse point.'
        }
        if ($descendant.PSIsContainer) {
          $directoriesToInspect.Push($descendant.FullName)
        }
      }
    }
    Remove-Item -LiteralPath $normalizedCheckpointRoot -Recurse -Force -ErrorAction Stop
    Write-Host 'Removed completed archive-preparation checkpoints.' -ForegroundColor DarkGray
    return $true
  } catch {
    Write-Warning (
      'The COMPLETE run manifest is durable, but checkpoint cleanup was not completed: {0}' -f `
        $_.Exception.Message
    )
    return $false
  }
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = Join-Path $repositoryRoot 'apps\model-training\src'
$pipelinePath = Join-Path $sourceRoot 'flippars_model_training\pipeline.py'
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

$preparedPath = Join-Path $processedRoot 'prepared.jsonl'
$datasetManifestPath = Join-Path $processedRoot 'dataset-manifest.json'
$archiveCheckpointRoot = Join-Path $processedRoot '.prepared.jsonl.archive-checkpoints'
$artifactPath = Join-Path $artifactRoot 'candidate.json'
$evaluationPath = Join-Path $artifactRoot 'evaluation.json'
$cliOutputPath = Join-Path $runEvidenceRoot 'training-command-output.log'
$crossRuntimeOutputPath = Join-Path $runEvidenceRoot 'cross-runtime-verification.log'
$runManifestPath = Join-Path $runEvidenceRoot 'run-manifest.json'
$runStartState = Get-ModelTrainingRunStartState `
  -ProcessedRoot $processedRoot `
  -ArtifactRoot $artifactRoot `
  -EvidenceRoot $runEvidenceRoot `
  -PreparedPath $preparedPath `
  -DatasetManifestPath $datasetManifestPath `
  -CheckpointRoot $archiveCheckpointRoot `
  -CommandLogPath $cliOutputPath `
  -Resume:$Resume
$resumeSemanticDisposition = [pscustomobject][ordered]@{
  Disposition = 'NOT_APPLICABLE'
  Reason = $null
}
if ($Resume) {
  if ($runStartState.Kind -eq 'PreparedDataset') {
    $resumeSemanticDisposition = [pscustomobject][ordered]@{
      Disposition = 'REPLACEMENT_REQUIRED'
      Reason = (
        'The prepared pair has no durable archive checkpoint plan. ' +
        'Preserve this run and use a new model version.'
      )
    }
  } elseif ($runStartState.Kind -eq 'ArchivePreparation') {
    $resumeCompatibilityParameters = @{
      CheckpointRoot = $archiveCheckpointRoot
      PipelinePath = $pipelinePath
      AcquisitionManifestPath = $acquisitionManifestPath
      PreparedPath = $preparedPath
      DatasetManifestPath = $datasetManifestPath
      SignalType = $SignalType
      DeadbandBps = $deadbandBps
      TimeframeMinutes = $timeframeMinutes
      DecisionCadenceSeconds = $decisionCadenceSeconds
      MinimumLeadTimeSeconds = $minimumLeadTimeSeconds
      ArchiveCount = $requestedFiles
    }
    $resumeSemanticDisposition = Get-ArchiveResumeSemanticDisposition `
      @resumeCompatibilityParameters
    if ($resumeSemanticDisposition.Disposition -ceq
        'PYTHON_VALIDATION_REQUIRED') {
      Assert-PythonArchiveResumeAdmission `
        -PythonPath $pythonPath `
        -SourceRoot $sourceRoot `
        -RepositoryRoot $repositoryRoot `
        -ArchiveRoot $archiveRoot `
        -Start $Start `
        -End $End `
        -PreparedPath $preparedPath `
        -DatasetManifestPath $datasetManifestPath `
        -AcquisitionManifestPath $acquisitionManifestPath `
        -SignalType $SignalType `
        -DeadbandBps $deadbandBps `
        -TimeframeMinutes $timeframeMinutes `
        -DecisionCadenceSeconds $decisionCadenceSeconds `
        -MinimumLeadTimeSeconds $minimumLeadTimeSeconds `
        -ArchiveCount $requestedFiles
      $resumeSemanticDisposition = [pscustomobject][ordered]@{
        Disposition = 'RESUMABLE'
        Reason = $null
      }
    }
  }
}
if ($ResumePreflightOnly) {
  [ordered]@{
    schemaVersion = 'flippars.model-training-resume-preflight/1'
    disposition = [string]$resumeSemanticDisposition.Disposition
    state = [string]$runStartState.Kind
    version = $safeVersion
    reason = $resumeSemanticDisposition.Reason
  } | ConvertTo-Json -Compress
  return
}
if ($Resume -and
    $resumeSemanticDisposition.Disposition -ceq 'REPLACEMENT_REQUIRED') {
  throw (
    'Same-version resume is incompatible: {0}' -f `
      [string]$resumeSemanticDisposition.Reason
  )
}

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
  $currentPythonCompatibility = Get-PythonRuntimeCompatibility $pythonPath
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
$acquisitionManifestSha256 = (
  Get-FileHash -LiteralPath $acquisitionManifestPath -Algorithm SHA256
).Hash.ToLowerInvariant()

& $pythonPath -m pip --isolated check
if ($LASTEXITCODE -ne 0) { throw 'Training environment dependency check failed.' }

if ($runStartState.Kind -eq 'Fresh') {
  New-Item -ItemType Directory -Path $runEvidenceRoot | Out-Null
}

$previousPythonPath = $env:PYTHONPATH
$env:PYTHONPATH = $sourceRoot
try {
  if (-not $runStartState.SkipPreparation) {
    Write-Host 'Preparing verified archives through the network-free streamed path...'
    if ($runStartState.Kind -eq 'ArchivePreparation') {
      Write-ModelTrainingResumeSessionMarker `
        -LogPath $cliOutputPath `
        -State $runStartState.Kind `
        -Version $safeVersion
    }
    $prepareExitCode = Invoke-LoggedNativeProcess `
      -FilePath $pythonPath `
      -ArgumentList @(
        '-m', 'flippars_model_training', 'prepare-archives',
        '--archive-root', $archiveRoot,
        '--start', $Start,
        '--end', $End,
        '--output', $preparedPath,
        '--manifest-output', $datasetManifestPath,
        '--acquisition-manifest', $acquisitionManifestPath,
        '--signal-type', $SignalType,
        '--deadband-bps', $deadbandBps,
        '--timeframe-minutes', $timeframeMinutes,
        '--decision-cadence-seconds', $decisionCadenceSeconds,
        '--minimum-lead-time-seconds', $minimumLeadTimeSeconds
      ) `
      -LogPath $cliOutputPath `
      -WorkingDirectory $repositoryRoot `
      -Append:$runStartState.AppendFirstChild
    if ($prepareExitCode -ne 0) {
      throw (
        "Offline dataset preparation failed with exit code $prepareExitCode. " +
        'For an interruption or transient failure with unchanged source, code, and policy, ' +
        'rerun the exact same invocation with -Resume. If source, code, or policy was ' +
        'corrected or changed, preserve this run and use a new model version without -Resume.'
      )
    }
  } else {
    Write-Host 'Reusing the complete prepared dataset pair after strict resume admission.'
  }
  $preparedManifest = Get-Content -LiteralPath $datasetManifestPath -Raw | ConvertFrom-Json
  if (($preparedManifest.schemaVersion -ne 'flippars.dataset-manifest/3') -or
      ($preparedManifest.symbol -ne 'BTCUSDT') -or
      ($preparedManifest.source.lineageKind -ne 'PUBLIC_BINANCE_ARCHIVE') -or
      ($preparedManifest.source.startDateInclusive -ne $Start) -or
      ($preparedManifest.source.endDateExclusive -ne $End) -or
      ([int]$preparedManifest.source.dayCount -ne $requestedFiles) -or
      (-not [bool]$preparedManifest.source.acquisitionEvidence.freshOfficialTransportEvidence) -or
      (([string]$preparedManifest.source.acquisitionEvidence.acquisitionManifestSha256).ToLowerInvariant() -ne
       $acquisitionManifestSha256) -or
      (([string]$preparedManifest.source.acquisitionEvidence.acquisitionArchiveIndexSha256).ToLowerInvariant() -ne
       ([string]$acquisitionManifest.acquisitionArchiveIndexSha256).ToLowerInvariant()) -or
      ($preparedManifest.target.signalType -ne $SignalType) -or
      ([double]$preparedManifest.target.deadbandBps -ne $deadbandBps) -or
      ([int]$preparedManifest.target.durationSeconds -ne ($timeframeMinutes * 60)) -or
      ([int]$preparedManifest.target.candidateSchedule.cadenceSeconds -ne $decisionCadenceSeconds) -or
      ([int]$preparedManifest.target.candidateSchedule.minimumLeadTimeSeconds -ne
       $minimumLeadTimeSeconds)) {
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
  if ($runStartState.Kind -eq 'PreparedDataset') {
    Write-ModelTrainingResumeSessionMarker `
      -LogPath $cliOutputPath `
      -State $runStartState.Kind `
      -Version $safeVersion
  }
  $trainExitCode = Invoke-LoggedNativeProcess `
    -FilePath $pythonPath `
    -ArgumentList @(
      '-m', 'flippars_model_training', 'train',
      '--input', $preparedPath,
      '--manifest', $datasetManifestPath,
      '--output', $artifactPath,
      '--evaluation-output', $evaluationPath,
      '--signal-type', $SignalType,
      '--version', $safeVersion,
      '--deadband-bps', $deadbandBps,
      '--confidence-threshold', $ConfidenceThreshold,
      '--validity-days', $ValidityDays
    ) `
    -LogPath $cliOutputPath `
    -WorkingDirectory $repositoryRoot `
    -Append
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
if (($artifact.schemaVersion -ne 'flippars.multinomial-candidate/4') -or
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
    ($evaluation.schemaVersion -ne 'flippars.model-evaluation/4') -or
    ($evaluation.artifactSchemaVersion -ne 'flippars.multinomial-candidate/4') -or
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
$pipelineHash = (Get-FileHash -LiteralPath $pipelinePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($pipelineHash -ne ([string]$artifact.trainingCodeSha256).ToLowerInvariant()) {
  throw 'Artifact training-code digest does not match the executed pipeline.'
}

$crossRuntimeVerifier = Join-Path $repositoryRoot 'scripts\verify-python-artifact.mjs'
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
$crossRuntimeExitCode = Invoke-LoggedNativeProcess `
  -FilePath 'node' `
  -ArgumentList @(
    $crossRuntimeVerifier,
    '--artifact', $artifactPath,
    '--dataset-manifest', $datasetManifestPath,
    '--evaluation', $evaluationPath,
    '--pipeline', $pipelinePath,
    '--prepared', $preparedPath,
    '--acquisition-manifest', $acquisitionManifestPath
  ) `
  -LogPath $crossRuntimeOutputPath `
  -WorkingDirectory $repositoryRoot
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
[void](Remove-CompletedArchiveCheckpointStore `
  -ProcessedRoot $processedRoot `
  -CheckpointRoot $archiveCheckpointRoot)

Write-Host "Frozen DRAFT artifact: $artifactPath"
Write-Host "Evaluation: $evaluationPath"
Write-Host "Run evidence: $runManifestPath"
Write-Warning 'No model was approved, registered, promoted, or enabled.'
