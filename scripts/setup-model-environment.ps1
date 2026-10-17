[CmdletBinding()]
param(
  [string]$TrainingRoot = (Join-Path $env:USERPROFILE 'Flippars-ml'),
  [ValidateSet('Bootstrap', 'Locked')]
  [string]$Mode = 'Bootstrap',
  [ValidateSet('GovernedBaseline', 'ChallengerExploration')]
  [string]$DependencyProfile = 'GovernedBaseline',
  [string]$EnvironmentName = 'bootstrap-env',
  [ValidatePattern('^(auto|3\.(11|12|13|14))$')]
  [string]$PythonVersion = 'auto',
  [string]$PythonExecutable,
  [string]$LockFile,
  [string]$Wheelhouse
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:PYTHON_BASIC_REPL = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'

. (Join-Path $PSScriptRoot 'model-training-guardrails.ps1')

function Get-RequirementsClosure {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$EntryPath,
    [Parameter(Mandatory)][string]$AllowedRoot
  )

  $pending = [System.Collections.Generic.Stack[string]]::new()
  $seen = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  $result = [System.Collections.Generic.List[string]]::new()
  $pending.Push($EntryPath)
  while ($pending.Count -gt 0) {
    $resolved = (Resolve-Path -LiteralPath $pending.Pop()).Path
    if (-not (Test-PathWithin $resolved $AllowedRoot)) {
      throw "Requirements include escapes the model-training package: $resolved"
    }
    if (-not $seen.Add($resolved)) { continue }
    $result.Add($resolved)
    foreach ($line in Get-Content -LiteralPath $resolved) {
      if ($line -match '^\s*(?:-r|--requirement)\s+([^\s#]+)\s*(?:#.*)?$') {
        $pending.Push((Join-Path (Split-Path -Parent $resolved) $Matches[1]))
      }
    }
  }
  return @($result | Sort-Object)
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$trainingPath = Assert-ExternalTrainingRoot $TrainingRoot $repositoryRoot
$safeEnvironmentName = Assert-SafeEnvironmentName $EnvironmentName
$environmentPath = Assert-PathWithinTrainingRoot `
  (Join-Path $trainingPath $safeEnvironmentName) `
  $trainingPath
$pythonPath = Join-Path $environmentPath 'Scripts\python.exe'
$requirementsPath = if ($DependencyProfile -eq 'GovernedBaseline') {
  Join-Path $repositoryRoot 'apps\model-training\requirements.txt'
} else {
  Join-Path $repositoryRoot 'apps\model-training\requirements-challengers.txt'
}
$pyprojectPath = Join-Path $repositoryRoot 'apps\model-training\pyproject.toml'
$requirementsRoot = Join-Path $repositoryRoot 'apps\model-training'
$requirementsFiles = @(Get-RequirementsClosure $requirementsPath $requirementsRoot)

Assert-NoTrackedTrainingMaterial $repositoryRoot

if ($Mode -eq 'Locked') {
  if ([string]::IsNullOrWhiteSpace($LockFile) -or [string]::IsNullOrWhiteSpace($Wheelhouse)) {
    throw 'Locked mode requires both -LockFile and -Wheelhouse.'
  }
  $lockPath = Assert-PathWithinTrainingRoot $LockFile $trainingPath
  $wheelhousePath = Assert-PathWithinTrainingRoot $Wheelhouse $trainingPath
  $semanticLockPath = Assert-PathWithinTrainingRoot "$lockPath.manifest.json" $trainingPath
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    throw "Lock file does not exist: $lockPath"
  }
  if (-not (Test-Path -LiteralPath $wheelhousePath -PathType Container)) {
    throw "Wheelhouse does not exist: $wheelhousePath"
  }
  if (-not (Test-Path -LiteralPath $semanticLockPath -PathType Leaf)) {
    throw "Semantic lock evidence does not exist: $semanticLockPath"
  }

  $semanticLock = Get-Content -LiteralPath $semanticLockPath -Raw | ConvertFrom-Json
  if (([int]$semanticLock.schemaVersion -ne 2) -or
      ($semanticLock.completionState -ne 'COMPLETE') -or
      ($semanticLock.dependencyProfile -ne $DependencyProfile) -or
      ((ConvertTo-NormalizedFullPath ([string]$semanticLock.wheelhousePath)) -ne
       (ConvertTo-NormalizedFullPath $wheelhousePath))) {
    throw 'Semantic lock evidence has the wrong schema, profile, state, or wheelhouse.'
  }
  $currentLockHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($currentLockHash -ne ([string]$semanticLock.lock.Sha256).ToLowerInvariant()) {
    throw 'Semantic lock evidence does not match the selected lock file.'
  }
  $currentRequirementRecords = @($requirementsFiles | ForEach-Object { Get-Sha256Record $_ })
  $recordedRequirementRecords = @($semanticLock.requirementsFiles)
  if ($currentRequirementRecords.Count -ne $recordedRequirementRecords.Count) {
    throw 'Semantic lock requirements closure no longer matches the repository.'
  }
  for ($index = 0; $index -lt $currentRequirementRecords.Count; $index += 1) {
    $currentRequirementPath = ConvertTo-NormalizedFullPath `
      ([string]$currentRequirementRecords[$index].Path)
    $recordedRequirementPath = ConvertTo-NormalizedFullPath `
      ([string]$recordedRequirementRecords[$index].Path)
    $currentRequirementHash = ([string]$currentRequirementRecords[$index].Sha256).ToLowerInvariant()
    $recordedRequirementHash = ([string]$recordedRequirementRecords[$index].Sha256).ToLowerInvariant()
    if (($currentRequirementPath -ne $recordedRequirementPath) -or
        ($currentRequirementHash -ne $recordedRequirementHash)) {
      throw 'A requirements file changed after semantic lock creation.'
    }
  }
  $recordedWheels = @($semanticLock.wheels)
  $actualWheels = @(Get-ChildItem -LiteralPath $wheelhousePath -File -Force)
  if (($actualWheels.Count -ne [int]$semanticLock.wheelCount) -or
      ($recordedWheels.Count -ne $actualWheels.Count)) {
    throw 'Wheelhouse file count no longer matches semantic lock evidence.'
  }
  $wheelByName = @{}
  foreach ($record in $recordedWheels) {
    $key = ([string]$record.fileName).ToLowerInvariant()
    if ($wheelByName.ContainsKey($key)) { throw "Duplicate semantic wheel identity: $key" }
    $wheelByName[$key] = $record
  }
  foreach ($wheel in $actualWheels) {
    if (($wheel.Extension -ne '.whl') -or (-not $wheelByName.ContainsKey($wheel.Name.ToLowerInvariant()))) {
      throw "Wheelhouse contains an unmanifested file: $($wheel.Name)"
    }
    $expectedWheelHash = ([string]$wheelByName[$wheel.Name.ToLowerInvariant()].sha256).ToLowerInvariant()
    $actualWheelHash = (Get-FileHash -LiteralPath $wheel.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualWheelHash -ne $expectedWheelHash) {
      throw "Wheel digest mismatch: $($wheel.Name)"
    }
  }

  $effectiveLockLines = @(Get-Content -LiteralPath $lockPath | ForEach-Object {
    $_.Trim()
  } | Where-Object { $_ -and -not $_.StartsWith('#') })
  if ($effectiveLockLines.Count -eq 0) { throw 'Lock file is empty.' }
  foreach ($line in $effectiveLockLines) {
    if (($line -notmatch '^[A-Za-z0-9_.-]+==[^\s]+\s+--hash=sha256:[a-fA-F0-9]{64}$') -or
        ($line -match '(://|\s@\s|^-e\s|--editable)')) {
      throw "Lock entries must be exact wheel versions with one SHA-256 hash and no URLs: $line"
    }
  }
} else {
  if ($PSBoundParameters.ContainsKey('LockFile') -or $PSBoundParameters.ContainsKey('Wheelhouse')) {
    throw 'LockFile and Wheelhouse apply only to Locked mode.'
  }
  $lockPath = $null
  $wheelhousePath = $null
  $semanticLockPath = $null
  $semanticLock = $null
}

if (Test-Path -LiteralPath $environmentPath) {
  throw "Environment path already exists. Choose a new EnvironmentName: $environmentPath"
}

$selectedPythonVersion = $PythonVersion
$pythonCommand = 'py'
$explicitPythonPath = $null
$explicitPythonCompatibility = $null
Write-Host 'Detecting an installed Python runtime...'
if ($PSBoundParameters.ContainsKey('PythonExecutable')) {
  if ([string]::IsNullOrWhiteSpace($PythonExecutable) -or
      (-not [System.IO.Path]::IsPathRooted($PythonExecutable))) {
    throw 'PythonExecutable must be a nonempty absolute path.'
  }
  $explicitPythonPath = [System.IO.Path]::GetFullPath($PythonExecutable)
  Assert-NoReparsePointAncestor $explicitPythonPath
  if (-not (Test-Path -LiteralPath $explicitPythonPath -PathType Leaf)) {
    throw "Explicit Python executable does not exist: $explicitPythonPath"
  }
  $pythonItem = Get-Item -LiteralPath $explicitPythonPath -Force
  if (($pythonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Explicit Python executable cannot be a reparse point: $explicitPythonPath"
  }
  $explicitPythonCompatibility = Get-PythonRuntimeCompatibility $explicitPythonPath
  $explicitVersionMatch = [regex]::Match(
    [string]$explicitPythonCompatibility.version,
    '^3\.(11|12|13|14)\.\d+$'
  )
  if (($explicitPythonCompatibility.implementation -ne 'CPython') -or
      (-not $explicitVersionMatch.Success)) {
    throw 'PythonExecutable must identify a supported CPython 3.11-3.14 runtime.'
  }
  $detectedPythonVersion = "3.$($explicitVersionMatch.Groups[1].Value)"
  if (($PythonVersion -ne 'auto') -and
      ($PythonVersion -ne $detectedPythonVersion)) {
    throw 'PythonExecutable runtime does not match PythonVersion.'
  }
  $selectedPythonVersion = $detectedPythonVersion
  $pythonCommand = 'explicit'
} elseif ($PythonVersion -eq 'auto') {
  foreach ($candidate in @('3.11', '3.12', '3.13', '3.14')) {
    try {
      & py "-$candidate" --version 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $selectedPythonVersion = $candidate
        break
      }
    } catch {
      continue
    }
  }
  if ($selectedPythonVersion -eq 'auto') {
    try {
      $directVersion = & python --version 2>$null
      if (($LASTEXITCODE -eq 0) -and ($directVersion -match 'Python\s+(3\.(11|12|13|14))')) {
        $selectedPythonVersion = $Matches[1]
        $pythonCommand = 'python'
      }
    } catch {
      # The explicit error below is safe to show to the operator.
    }
  }
}

if ($selectedPythonVersion -eq 'auto') {
  throw 'No supported Python 3.11-3.14 runtime was found. Python 3.11 is the reproducibility baseline.'
}
if (($Mode -eq 'Locked') -and
    (-not ([string]$semanticLock.python.version).StartsWith("$selectedPythonVersion."))) {
  throw 'Selected Python minor version does not match semantic lock evidence.'
}
if (($Mode -eq 'Locked') -and ($null -ne $explicitPythonCompatibility)) {
  foreach ($field in @('implementation', 'version', 'cacheTag', 'platform', 'machine')) {
    if ([string]$explicitPythonCompatibility.$field -ne
        [string]$semanticLock.python.$field) {
      throw "Explicit Python compatibility field '$field' does not match semantic lock evidence."
    }
  }
}
if ($selectedPythonVersion -ne '3.11') {
  Write-Warning "Python $selectedPythonVersion selected. Reproduce governed runs on the same Python minor version."
}

New-Item -ItemType Directory -Path $trainingPath -Force | Out-Null
foreach ($relativePath in @(
  'datasets',
  'data\processed',
  'artifacts\draft',
  'evidence',
  'locks',
  'wheelhouse'
)) {
  $directory = Assert-PathWithinTrainingRoot (Join-Path $trainingPath $relativePath) $trainingPath
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

Write-Host "Creating isolated Python environment: $environmentPath"
if ($pythonCommand -eq 'explicit') {
  & $explicitPythonPath -m venv $environmentPath
} elseif ($pythonCommand -eq 'py') {
  & py "-$selectedPythonVersion" -m venv $environmentPath
} else {
  & python -m venv $environmentPath
}
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  throw 'Python virtual environment creation failed.'
}

$commonPipArguments = @(
  '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-cache-dir',
  'install', '--only-binary=:all:'
)
if ($Mode -eq 'Locked') {
  Write-Host 'Installing only hash-locked wheels from the external wheelhouse...'
  & $pythonPath @commonPipArguments `
    --no-index `
    --find-links $wheelhousePath `
    --require-hashes `
    -r $lockPath
} else {
  Write-Warning 'Bootstrap mode resolves version ranges online and is not acceptable for a frozen draft run.'
  & $pythonPath @commonPipArguments `
    --index-url 'https://pypi.org/simple' `
    -r $requirementsPath
}
if ($LASTEXITCODE -ne 0) { throw 'Model-training dependency installation failed.' }

& $pythonPath -m pip --isolated check
if ($LASTEXITCODE -ne 0) { throw 'Installed dependency consistency check failed.' }

$freezePath = Join-Path $environmentPath 'pip-freeze.txt'
$inspectPath = Join-Path $environmentPath 'pip-inspect.json'
$freeze = @(& $pythonPath -m pip --isolated freeze --all)
if ($LASTEXITCODE -ne 0) { throw 'Unable to record installed dependency versions.' }
[System.IO.File]::WriteAllLines(
  $freezePath,
  $freeze,
  [System.Text.UTF8Encoding]::new($false)
)
$inspect = & $pythonPath -m pip --isolated inspect --local
if ($LASTEXITCODE -ne 0) { throw 'Unable to record installed dependency metadata.' }
[System.IO.File]::WriteAllText(
  $inspectPath,
  ($inspect -join [Environment]::NewLine),
  [System.Text.UTF8Encoding]::new($false)
)

$pythonCompatibility = Get-PythonRuntimeCompatibility $pythonPath
$pythonRuntimeVersion = [string]$pythonCompatibility.version
if ($Mode -eq 'Locked') {
  foreach ($field in @('implementation', 'version', 'cacheTag', 'platform', 'machine')) {
    if ([string]$pythonCompatibility.$field -ne [string]$semanticLock.python.$field) {
      throw "Python compatibility field '$field' does not match semantic lock evidence."
    }
  }
}
$pipRuntimeVersion = (& $pythonPath -m pip --version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to record pip runtime version.' }
$repositoryCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to record repository commit.' }
$sourceStatus = @(Get-RepositoryStatusSnapshot $repositoryRoot)

$sourceFiles = @(
  $requirementsFiles
  $pyprojectPath,
  (Join-Path $repositoryRoot 'apps\model-training\src\flippars_model_training\pipeline.py'),
  (Join-Path $repositoryRoot 'apps\model-training\src\flippars_model_training\__main__.py'),
  $PSCommandPath,
  (Join-Path $PSScriptRoot 'model-training-guardrails.ps1'),
  (Join-Path $PSScriptRoot 'new-model-training-lock.ps1'),
  (Join-Path $PSScriptRoot 'inspect-model-training-cache.ps1'),
  (Join-Path $PSScriptRoot 'get-binance-training-data.ps1'),
  (Join-Path $PSScriptRoot 'test-binance-training-archives.ps1'),
  (Join-Path $PSScriptRoot 'invoke-model-training.ps1')
)
$sourceHashes = @($sourceFiles | Sort-Object -Unique | ForEach-Object { Get-Sha256Record $_ })
$manifest = [ordered]@{
  schemaVersion = 2
  completionState = 'COMPLETE'
  createdAt = [datetime]::UtcNow.ToString('o')
  mode = $Mode
  dependencyProfile = $DependencyProfile
  reproducibleOfflineInstall = ($Mode -eq 'Locked')
  environmentPath = $environmentPath
  python = $pythonRuntimeVersion
  pythonCompatibility = $pythonCompatibility
  pip = $pipRuntimeVersion
  requirementsFiles = @($requirementsFiles | ForEach-Object { Get-Sha256Record $_ })
  lock = if ($null -ne $lockPath) { Get-Sha256Record $lockPath } else { $null }
  semanticLock = if ($null -ne $semanticLockPath) { Get-Sha256Record $semanticLockPath } else { $null }
  wheelhouse = if ($null -ne $wheelhousePath) {
    [ordered]@{
      Path = $wheelhousePath
      WheelCount = @((Get-ChildItem -LiteralPath $wheelhousePath -File -Force)).Count
      IndexSha256 = if ($null -ne $semanticLock) { [string]$semanticLock.wheelIndexSha256 } else { $null }
    }
  } else { $null }
  freeze = Get-Sha256Record $freezePath
  inspect = Get-Sha256Record $inspectPath
  repositoryCommit = $repositoryCommit
  repositoryWasClean = ($sourceStatus.Count -eq 0)
  sourceHashes = $sourceHashes
}
$manifestPath = Join-Path $environmentPath 'environment-manifest.json'
Write-JsonEvidenceAtomic -Path $manifestPath -Value $manifest -Depth 12

Write-Host "Model-training environment is ready: $environmentPath"
Write-Host "Environment evidence: $manifestPath"
Write-Host 'Repository source is not installed into the environment; use the governed runner so its digest is captured.'
