[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (Test-Path -LiteralPath 'variable:PSNativeCommandUseErrorActionPreference') {
  $PSNativeCommandUseErrorActionPreference = $false
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$failures = [System.Collections.Generic.List[string]]::new()

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { $script:failures.Add($Message) }
}

function Assert-Throws {
  param([scriptblock]$Operation, [string]$Message)
  try {
    & $Operation | Out-Null
    $script:failures.Add($Message)
  } catch {
    # Expected fail-closed behavior.
  }
}

$scripts = @(
  'model-training-guardrails.ps1',
  'setup-model-environment.ps1',
  'new-model-training-lock.ps1',
  'inspect-model-training-cache.ps1',
  'get-binance-training-data.ps1',
  'test-binance-training-archives.ps1',
  'invoke-model-training.ps1'
)
foreach ($scriptName in $scripts) {
  $scriptPath = Join-Path $PSScriptRoot $scriptName
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath,
    [ref]$tokens,
    [ref]$parseErrors
  )
  Assert-True ($parseErrors.Count -eq 0) "$scriptName has PowerShell parse errors: $parseErrors"
}

. (Join-Path $PSScriptRoot 'model-training-guardrails.ps1')

$externalCandidate = Join-Path $env:USERPROFILE 'Flippars-guardrail-test-workspace'
$normalizedExternal = Assert-ExternalTrainingRoot $externalCandidate $repositoryRoot
Assert-True `
  ($normalizedExternal -eq (ConvertTo-NormalizedFullPath $externalCandidate)) `
  'A dedicated external training root should be accepted.'

$filesystemRoot = [System.IO.Path]::GetPathRoot($repositoryRoot)
Assert-Throws { Assert-ExternalTrainingRoot $filesystemRoot $repositoryRoot } `
  'A filesystem root must be rejected.'
Assert-Throws { Assert-ExternalTrainingRoot $env:USERPROFILE $repositoryRoot } `
  'The user profile itself must be rejected.'
Assert-Throws { Assert-ExternalTrainingRoot $repositoryRoot $repositoryRoot } `
  'The repository must be rejected as TrainingRoot.'
Assert-Throws { Assert-ExternalTrainingRoot (Join-Path $repositoryRoot 'training') $repositoryRoot } `
  'A repository descendant must be rejected as TrainingRoot.'
Assert-Throws { Assert-ExternalTrainingRoot (Split-Path -Parent $repositoryRoot) $repositoryRoot } `
  'A directory containing the repository must be rejected as TrainingRoot.'
Assert-Throws {
  Assert-PathWithinTrainingRoot (Join-Path $normalizedExternal '..\escape') $normalizedExternal
} 'Path traversal outside TrainingRoot must be rejected.'

Assert-True ((Get-SignalTimeframeMinutes 'FIVE_MINUTE_REVERSAL') -eq 5) `
  'Five-minute reversal must map to five minutes.'
Assert-True ((Get-SignalTimeframeMinutes 'FIVE_MINUTE_EARLY_DIRECTION') -eq 5) `
  'Early direction must map to five minutes.'
Assert-True ((Get-SignalTimeframeMinutes 'FIFTEEN_MINUTE_REVERSAL') -eq 15) `
  'Fifteen-minute reversal must map to fifteen minutes.'
Assert-Throws { Assert-SafeEnvironmentName '..\escape' } `
  'Unsafe environment names must be rejected.'
Assert-Throws { Assert-SafeModelVersion '..\artifact' } `
  'Unsafe model versions must be rejected.'
Assert-Throws { Assert-ModelTrainingDateRange '2025-02-01' '2025-01-01' } `
  'Reversed training dates must be rejected.'
[void](Assert-ModelTrainingDateRange '2025-01-01' '2025-01-02')

$ps7StyleResponse = [pscustomobject]@{
  BaseResponse = [pscustomobject]@{
    RequestMessage = [pscustomobject]@{
      RequestUri = [uri]'https://data.binance.vision/official.CHECKSUM'
    }
  }
}
$winPsStyleResponse = [pscustomobject]@{
  BaseResponse = [pscustomobject]@{
    ResponseUri = [uri]'https://data.binance.vision/official.CHECKSUM'
  }
}
[void](Assert-BinanceDataVisionUri (Get-WebResponseFinalUri $ps7StyleResponse))
[void](Assert-BinanceDataVisionUri (Get-WebResponseFinalUri $winPsStyleResponse))
Assert-Throws {
  Assert-BinanceDataVisionUri ([uri]'https://attacker.invalid/substituted.CHECKSUM')
} 'A cross-host final checksum URI must be rejected.'
Assert-Throws {
  Assert-BinanceDataVisionUri ([uri]'http://data.binance.vision/insecure.CHECKSUM')
} 'A non-HTTPS Binance checksum URI must be rejected.'

Assert-NoTrackedTrainingMaterial $repositoryRoot

$guardrailsText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'model-training-guardrails.ps1') -Raw
Assert-True ($guardrailsText.Contains('$probe | & $PythonPath -')) `
  'Python runtime compatibility must be passed over stdin instead of a native command argument.'
Assert-True ($guardrailsText.Contains('must contain exactly five fields')) `
  'Python runtime compatibility must reject incomplete or expanded schemas.'
Assert-True ($guardrailsText.Contains('must be a nonempty string')) `
  'Python runtime compatibility must reject empty identity fields.'

$setupText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'setup-model-environment.ps1') -Raw
Assert-True ($setupText.Contains('--no-index')) 'Locked setup must disable package indexes.'
Assert-True ($setupText.Contains('--require-hashes')) 'Locked setup must require dependency hashes.'
Assert-True ($setupText.Contains('--only-binary=:all:')) 'Setup must accept binary wheels only.'
Assert-True ($setupText.Contains('semanticLock')) `
  'Locked setup must validate semantic lock evidence.'
Assert-True ($setupText.Contains("completionState = 'COMPLETE'")) `
  'Environment evidence must record an explicit complete state.'

$lockText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'new-model-training-lock.ps1') -Raw
Assert-True ($lockText.Contains('wheelIndexSha256')) `
  'Semantic lock evidence must bind the exact wheel inventory.'
Assert-True ($lockText.Contains('dependencyProfile = $DependencyProfile')) `
  'Semantic lock evidence must bind its dependency profile.'

$collectorText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'get-binance-training-data.ps1') -Raw
Assert-True `
  ($collectorText.Contains('https://data.binance.vision/')) `
  'The acquisition wrapper must name the official public endpoint.'
Assert-True ($collectorText.Contains('--symbol BTCUSDT')) `
  'The acquisition wrapper must fix the supported symbol.'
Assert-True ($collectorText.Contains('ItemType HardLink')) `
  'The acquisition wrapper must reuse verified cache bytes without mandatory duplication.'
Assert-True ($collectorText.Contains('-RefreshSelectedChecksums')) `
  'Governed acquisition must freshly retrieve every selected checksum.'
Assert-True ($collectorText.Contains('-RequireFreshChecksumTransport')) `
  'Isolated verification must require fresh checksum transport evidence.'
Assert-True ($collectorText.Contains('acquisitionArchiveIndexSha256')) `
  'Acquisition evidence must use the unambiguous archive-index digest name.'
Assert-True (-not $collectorText.Contains('archiveIndexSha256 =')) `
  'Acquisition evidence must not retain the ambiguous archiveIndexSha256 name.'

$inventoryText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inspect-model-training-cache.ps1') -Raw
Assert-True ($inventoryText.Contains('[switch]$ApplyQuarantine')) `
  'Cache quarantine must require an explicit switch.'
Assert-True ($inventoryText.Contains('deletionPerformed = $false')) `
  'Cache maintenance must record that it never deletes source material.'
Assert-True (-not $inventoryText.Contains('Remove-Item -LiteralPath $cachePath')) `
  'Cache maintenance must not delete the archive cache.'
Assert-True ($inventoryText.Contains('[switch]$IncludeUnselectedQuarantineCandidates')) `
  'Moving unselected cache findings must require a second explicit switch.'
Assert-True ($inventoryText.Contains('[switch]$RefreshSelectedChecksums')) `
  'Fresh checksum transport must require an explicit selected-window switch.'
Assert-True (-not $inventoryText.Contains('FetchMissingChecksums')) `
  'Missing-only checksum fetching must not create governed provenance.'
Assert-True ($inventoryText.Contains('-MaximumRedirection 5')) `
  'Checksum retrieval must permit only bounded redirects.'
Assert-True ($inventoryText.Contains('-TimeoutSec 60')) `
  'Checksum retrieval must have an explicit network timeout.'
Assert-True ($inventoryText.Contains('Get-WebResponseFinalUri')) `
  'Checksum retrieval must validate its final response URI.'
Assert-True ($inventoryText.Contains('$finalUri.AbsoluteUri -ne ([uri]$requestedChecksumUri).AbsoluteUri')) `
  'Checksum retrieval must reject redirects away from the exact canonical URI.'
Assert-True ($inventoryText.Contains('[System.IO.File]::Replace')) `
  'Existing checksum sidecars must be replaced atomically after validation.'
Assert-True ($inventoryText.Contains('OFFLINE_LOCAL_INVENTORY_ONLY')) `
  'Read-only inventory must explicitly disclaim fresh transport provenance.'
foreach ($transportField in @(
  'archiveSourceUri',
  'requestedChecksumUri',
  'finalChecksumUri',
  'checksumRetrievedAt',
  'freshChecksumTransport'
)) {
  Assert-True ($inventoryText.Contains($transportField)) `
    "Cache transport evidence is missing: $transportField"
}

$archiveVerifierText = Get-Content -LiteralPath `
  (Join-Path $PSScriptRoot 'test-binance-training-archives.ps1') -Raw
Assert-True (-not $archiveVerifierText.Contains('Invoke-WebRequest')) `
  'Isolated verification must be offline and consume recorded transport evidence.'
Assert-True ($archiveVerifierText.Contains('[switch]$RequireFreshChecksumTransport')) `
  'Governed isolated verification must explicitly require fresh transport evidence.'
Assert-True ($archiveVerifierText.Contains('Assert-BinanceDataVisionUri $finalChecksumUri')) `
  'Isolated verification must revalidate the recorded final checksum URI.'
Assert-True ($archiveVerifierText.Contains('$finalChecksumUri.AbsoluteUri -ne ([uri]$checksumUrl).AbsoluteUri')) `
  'Isolated verification must require the exact canonical final checksum URI.'
Assert-True ($archiveVerifierText.Contains('UNATTESTED_LOCAL_FILES')) `
  'Offline local verification must not label sidecars as official Binance transport.'
foreach ($archiveField in @(
  'day',
  'archiveName',
  'archiveBytes',
  'archiveSha256',
  'checksumName',
  'checksumBytes',
  'checksumSha256',
  'expectedArchiveSha256',
  'archiveSourceUri',
  'requestedChecksumUri',
  'finalChecksumUri',
  'checksumRetrievedAt'
)) {
  Assert-True ($archiveVerifierText.Contains($archiveField)) `
    "Canonical acquisition archive projection is missing: $archiveField"
}

$runnerText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'invoke-model-training.ps1') -Raw
foreach ($runtimeProbeScript in @(
  [pscustomobject]@{ Name = 'setup-model-environment.ps1'; Text = $setupText }
  [pscustomobject]@{ Name = 'new-model-training-lock.ps1'; Text = $lockText }
  [pscustomobject]@{ Name = 'invoke-model-training.ps1'; Text = $runnerText }
)) {
  Assert-True (-not $runtimeProbeScript.Text.Contains('$pythonPath -c')) `
    "$($runtimeProbeScript.Name) must not pass inline Python through native -c arguments."
}
Assert-True ($runnerText.Contains('prepare-archives')) `
  'The final runner must use the network-free streamed archive command.'
Assert-True (-not $runnerText.Contains('--base-url')) `
  'The final runner must not accept or pass any acquisition URL.'
Assert-True (-not $runnerText.Contains('flippars_model_training all')) `
  'The final runner must not invoke the collection-capable all command.'
Assert-True ($runnerText.Contains('Tee-Object -FilePath $cliOutputPath')) `
  'The final runner must stream Python output instead of buffering it.'
Assert-True ($runnerText.Contains("dependencyProfile -ne 'GovernedBaseline'")) `
  'FrozenDraft must reject non-baseline dependency profiles.'
Assert-True ($runnerText.Contains('acquisitionManifest.schemaVersion -ne 3')) `
  'FrozenDraft must require schema-3 acquisition evidence.'
Assert-True ($runnerText.Contains('--acquisition-manifest $acquisitionManifestPath')) `
  'Preparation and cross-runtime verification must receive the acquisition manifest.'
Assert-True ($runnerText.Contains('$preparedArchive.day -ne $acquiredArchive.day')) `
  'Prepared archive comparison must use the canonical acquisition day field.'
Assert-True (-not $runnerText.Contains('$acquiredArchive.date')) `
  'The runner must not reference the nonexistent acquisition date field.'
Assert-True (-not $runnerText.Contains('--overwrite')) `
  'The final runner must never overwrite evidence or artifacts.'
Assert-True ($runnerText.Contains("artifactStatus = 'DRAFT'")) `
  'The final runner must record DRAFT lifecycle state.'
Assert-True ($runnerText.Contains('signalsEnabled = $false')) `
  'The final runner must not enable signals.'
Assert-True ($runnerText.Contains("if (`$SignalType -eq 'FIFTEEN_MINUTE_REVERSAL') { 30 } else { 15 }")) `
  'The runner must derive the governed 30-second lead for 15-minute reversal.'
Assert-True ($runnerText.Contains('artifact.target.durationSeconds')) `
  'The runner must validate the v3 target duration field.'
Assert-True (-not $runnerText.Contains('artifact.target.candleDurationSeconds')) `
  'The runner must not validate an obsolete target duration field.'
Assert-True (-not $runnerText.Contains('normalizedRoot')) `
  'The runner must use streamed archive preparation rather than normalized intermediates.'
Assert-True ($runnerText.Contains("'implementation', 'version', 'cacheTag', 'platform', 'machine'")) `
  'FrozenDraft must compare the current Python runtime identity to environment evidence.'
Assert-True ($runnerText.Contains('pip --isolated freeze --all')) `
  'FrozenDraft must compare the complete current package snapshot.'
Assert-True ($runnerText.Contains('pip --isolated check')) `
  'FrozenDraft must check current dependency consistency.'
Assert-True ($runnerText.Contains('preEvaluationPolicySha256')) `
  'The runner must bind artifact and evaluation to one pre-evaluation policy.'
Assert-True ($runnerText.Contains('verify-python-v3-artifact.mjs')) `
  'The runner must independently verify Python-to-TypeScript lineage.'
Assert-True ($runnerText.Contains('Strict cross-runtime lineage verification failed')) `
  'The runner must fail closed when cross-runtime lineage verification fails.'
Assert-True ($runnerText.Contains('cross-runtime-verification.log')) `
  'The runner must retain cross-runtime verification evidence outside Git.'
Assert-True ($runnerText.Contains('Dataset integrity evidence changed after validation.')) `
  'Run finalization must reject mutated source-integrity evidence.'
Assert-True ($runnerText.Contains('Acquisition evidence changed after dataset preparation.')) `
  'Run finalization must reject mutated acquisition evidence.'
Assert-True ($runnerText.Contains('sourceIntegrity = $finalSourceIntegrityRecord')) `
  'Run evidence must record the final validated source-integrity hash record.'
Assert-True ($runnerText.Contains('acquisition = $finalAcquisitionRecord')) `
  'Run evidence must record the final validated acquisition hash record.'
Assert-True ($runnerText.Contains('fitDiagnostics.converged')) `
  'The runner must fail closed when optimization does not converge.'
Assert-True ($runnerText.Contains('productionGuardedPolicyReplay')) `
  'The runner must validate production-guarded replay abstention.'
Assert-True ($runnerText.Contains('userFacingConfidenceCalibrationClaimSupported')) `
  'The runner must reject an unsupported user-facing calibration claim.'

$crossRuntimeVerifierText = Get-Content -LiteralPath `
  (Join-Path $repositoryRoot 'scripts\verify-python-v3-artifact.mjs') -Raw
Assert-True ($crossRuntimeVerifierText.Contains('external acquisition-manifest digest')) `
  'Cross-runtime verification must bind the external acquisition manifest bytes.'
Assert-True ($crossRuntimeVerifierText.Contains('corpusPassAudit.passesMatched')) `
  'Cross-runtime verification must require matching prepared-corpus passes.'
Assert-True ($crossRuntimeVerifierText.Contains('createReadStream')) `
  'Cross-runtime verification must hash large prepared data as a stream.'
Assert-True (-not $crossRuntimeVerifierText.Contains('sha256(readFileSync(argumentsByName.get("--prepared")))')) `
  'Cross-runtime verification must not buffer the complete prepared corpus.'
Assert-True ($crossRuntimeVerifierText.Contains('acquisitionArchiveIndexSha256')) `
  'Cross-runtime verification must recompute the canonical acquisition archive index.'

$runbookText = Get-Content -LiteralPath `
  (Join-Path $repositoryRoot 'docs\runbooks\offline-model-training.md') -Raw
$operatorBlocks = [regex]::Matches(
  $runbookText,
  '(?ms)^```powershell\r?\n(?<body>.*?)^```$'
)
Assert-True ($operatorBlocks.Count -eq 3) `
  'The offline runbook must contain exactly three PowerShell operator blocks.'
foreach ($operatorBlock in $operatorBlocks) {
  $operatorBody = [string]$operatorBlock.Groups['body'].Value
  Assert-True ($operatorBody.TrimStart().StartsWith('& {')) `
    'Every operator block must execute as one transactional script block.'
  Assert-True ($operatorBody.TrimEnd().EndsWith('}')) `
    'Every transactional operator block must end inside its script block.'
  Assert-True ($operatorBody.Contains('catch {') -and $operatorBody.Contains('throw')) `
    'Every transactional operator block must report and rethrow failures.'
}
Assert-True (-not $runbookText.Contains('PowerShell tests failed with exit code')) `
  'The runbook must not inspect stale native exit state after a PowerShell script.'
Assert-True ($runbookText.Contains('$smokeFailure')) `
  'Verification must preserve its primary failure through smoke cleanup.'
Assert-True ($runbookText.Contains('^Flippars-v3-smoke-[a-f0-9]{32}$')) `
  'Smoke cleanup must bind the exact generated temporary directory name.'
Assert-True ($runbookText.Contains('npm run build --workspace @flippars/contracts')) `
  'Offline training must build the reviewed contracts before model runs.'
Assert-True ($runbookText.Contains('npm run build --workspace @flippars/model-artifact')) `
  'Offline training must build the artifact schema before model runs.'

$nativeExitLog = Join-Path ([System.IO.Path]::GetTempPath()) `
  "Flippars-native-exit-$([guid]::NewGuid().ToString('N')).log"
$nativeFailure = $null
try {
  $childPowerShell = @(
    (Join-Path $PSHOME 'pwsh.exe'),
    (Join-Path $PSHOME 'powershell.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($childPowerShell)) {
    throw 'Unable to resolve a child PowerShell executable for native-exit testing.'
  }
  try {
    $pipelineErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & $childPowerShell -NoProfile -NonInteractive -Command `
        "[Console]::Out.WriteLine('EARLY-MARKER'); [Console]::Error.WriteLine('ERROR-MARKER'); exit 17" `
        2>&1 | Tee-Object -FilePath $nativeExitLog -ErrorAction Stop | Out-Null
      $nativeExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $pipelineErrorActionPreference
    }
    if ($nativeExitCode -ne 0) {
      throw "Synthetic native command failed with exit code $nativeExitCode."
    }
  } catch {
    $nativeFailure = $_.Exception.Message
  }
  $nativeLogText = if (Test-Path -LiteralPath $nativeExitLog -PathType Leaf) {
    Get-Content -LiteralPath $nativeExitLog -Raw
  } else {
    "MISSING-LOG: $nativeFailure"
  }
  Assert-True ($nativeFailure -match 'exit code 17') `
    'A streamed native exit code 17 must propagate as a failure.'
  Assert-True ($nativeLogText.Contains('EARLY-MARKER')) `
    'Streamed native stdout must reach the evidence log before failure.'
  Assert-True ($nativeLogText.Contains('ERROR-MARKER')) `
    'Streamed native stderr must reach the evidence log before failure.'
} finally {
  if (Test-Path -LiteralPath $nativeExitLog) {
    Remove-Item -LiteralPath $nativeExitLog -Force
  }
  $global:LASTEXITCODE = 0
}

$pipelineText = Get-Content -LiteralPath (
  Join-Path $repositoryRoot 'apps\model-training\src\flippars_model_training\pipeline.py'
) -Raw
foreach ($requiredContractText in @(
  'prepare-archives',
  'select_offline_archives',
  '--manifest-output',
  '--timeframe-minutes',
  '--decision-cadence-seconds',
  '--minimum-lead-time-seconds',
  '--confidence-threshold',
  '--validity-days',
  '"status": "DRAFT"'
)) {
  Assert-True ($pipelineText.Contains($requiredContractText)) `
    "Training CLI contract is missing: $requiredContractText"
}

$ignoreText = Get-Content -LiteralPath (Join-Path $repositoryRoot '.gitignore') -Raw
foreach ($ignorePattern in @('.venv/', '__pycache__/', '*.py[cod]', '*.egg-info/')) {
  Assert-True ($ignoreText.Contains($ignorePattern)) `
    "Repository ignore rules are missing: $ignorePattern"
}

$temporaryBase = ConvertTo-NormalizedFullPath ([System.IO.Path]::GetTempPath())
$temporaryTrainingRoot = Join-Path $temporaryBase "Flippars-cache-guard-test-$([guid]::NewGuid().ToString('N'))"
try {
  $temporaryCache = Join-Path $temporaryTrainingRoot 'data\raw\archives'
  New-Item -ItemType Directory -Path $temporaryCache -Force | Out-Null
  $validName = Join-Path $temporaryCache 'BTCUSDT-trades-2025-01-01.zip'
  $partialName = Join-Path $temporaryCache 'BTCUSDT-trades-2025-01-02.zip.part'
  [System.IO.File]::WriteAllBytes($validName, [byte[]](1, 2, 3))
  [System.IO.File]::WriteAllBytes($partialName, [byte[]](4, 5, 6))

  $previewPath = Join-Path $temporaryTrainingRoot 'evidence\preview.json'
  & (Join-Path $PSScriptRoot 'inspect-model-training-cache.ps1') `
    -TrainingRoot $temporaryTrainingRoot `
    -ArchiveCache $temporaryCache `
    -EvidenceOutput $previewPath
  $preview = Get-Content -LiteralPath $previewPath -Raw | ConvertFrom-Json
  Assert-True (Test-Path -LiteralPath $partialName -PathType Leaf) `
    'Preview mode must not move a partial file.'
  Assert-True (-not [bool]$preview.quarantine.applyRequested) `
    'Preview evidence must record that quarantine was not requested.'
  Assert-True ([int]$preview.quarantine.candidateCount -eq 1) `
    'Preview should identify exactly the synthetic partial file.'

  $applyPath = Join-Path $temporaryTrainingRoot 'evidence\apply.json'
  & (Join-Path $PSScriptRoot 'inspect-model-training-cache.ps1') `
    -TrainingRoot $temporaryTrainingRoot `
    -ArchiveCache $temporaryCache `
    -EvidenceOutput $applyPath `
    -ApplyQuarantine
  $applied = Get-Content -LiteralPath $applyPath -Raw | ConvertFrom-Json
  Assert-True (Test-Path -LiteralPath $partialName -PathType Leaf) `
    'Unselected cache findings must remain without the second explicit switch.'
  Assert-True (Test-Path -LiteralPath $validName -PathType Leaf) `
    'Explicit quarantine must leave a structurally valid archive in place.'
  Assert-True (@($applied.quarantine.actions).Count -eq 0) `
    'Selected-window quarantine must not move an unselected cache finding.'
  Assert-True (-not [bool]$applied.quarantine.deletionPerformed) `
    'Quarantine evidence must record that no deletion occurred.'

  $allApplyPath = Join-Path $temporaryTrainingRoot 'evidence\apply-all.json'
  & (Join-Path $PSScriptRoot 'inspect-model-training-cache.ps1') `
    -TrainingRoot $temporaryTrainingRoot `
    -ArchiveCache $temporaryCache `
    -EvidenceOutput $allApplyPath `
    -ApplyQuarantine `
    -IncludeUnselectedQuarantineCandidates
  $allApplied = Get-Content -LiteralPath $allApplyPath -Raw | ConvertFrom-Json
  Assert-True (-not (Test-Path -LiteralPath $partialName)) `
    'Both explicit switches should move the synthetic unselected partial file.'
  Assert-True (@($allApplied.quarantine.actions).Count -eq 1) `
    'All-cache quarantine should record one exact move.'
} finally {
  if (Test-Path -LiteralPath $temporaryTrainingRoot) {
    $resolvedTemporaryRoot = ConvertTo-NormalizedFullPath $temporaryTrainingRoot
    if (($resolvedTemporaryRoot -eq $temporaryBase) -or
        (-not (Test-PathWithin $resolvedTemporaryRoot $temporaryBase))) {
      throw "Refusing unsafe synthetic-test cleanup: $resolvedTemporaryRoot"
    }
    Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
  }
}

if ($failures.Count -gt 0) {
  throw "Model-training operator checks failed:`n- $($failures -join "`n- ")"
}

Write-Host "Model-training operator checks passed ($($scripts.Count) scripts)."
Write-Host 'The temporary synthetic cache was removed; no environment, model artifact, signal, commit, or push was created.'
