[CmdletBinding()]
param(
  [string]$TrainingRoot = (Join-Path $env:USERPROFILE 'Flippars-ml'),
  [string]$BootstrapEnvironmentName = 'bootstrap-env',
  [ValidateSet('GovernedBaseline', 'ChallengerExploration')]
  [string]$DependencyProfile = 'GovernedBaseline',
  [string]$LockFile = (Join-Path $TrainingRoot 'locks\requirements.lock.txt'),
  [string]$Wheelhouse = (Join-Path $TrainingRoot 'wheelhouse\frozen')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:PYTHONDONTWRITEBYTECODE = '1'

. (Join-Path $PSScriptRoot 'model-training-guardrails.ps1')

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$trainingPath = Assert-ExternalTrainingRoot $TrainingRoot $repositoryRoot
$safeEnvironmentName = Assert-SafeEnvironmentName $BootstrapEnvironmentName
$environmentPath = Assert-PathWithinTrainingRoot `
  (Join-Path $trainingPath $safeEnvironmentName) `
  $trainingPath
$pythonPath = Join-Path $environmentPath 'Scripts\python.exe'
$environmentManifestPath = Join-Path $environmentPath 'environment-manifest.json'
$requirementsPath = if ($DependencyProfile -eq 'GovernedBaseline') {
  Join-Path $repositoryRoot 'apps\model-training\requirements.txt'
} else {
  Join-Path $repositoryRoot 'apps\model-training\requirements-challengers.txt'
}
$lockPath = Assert-PathWithinTrainingRoot $LockFile $trainingPath
$wheelhousePath = Assert-PathWithinTrainingRoot $Wheelhouse $trainingPath
$semanticLockPath = Assert-PathWithinTrainingRoot "$lockPath.manifest.json" $trainingPath

Assert-NoTrackedTrainingMaterial $repositoryRoot
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  throw "Bootstrap Python environment is missing: $pythonPath"
}
if (-not (Test-Path -LiteralPath $environmentManifestPath -PathType Leaf)) {
  throw "Bootstrap environment evidence is missing: $environmentManifestPath"
}
$environmentManifest = Get-Content -LiteralPath $environmentManifestPath -Raw | ConvertFrom-Json
if (([int]$environmentManifest.schemaVersion -ne 2) -or
    ($environmentManifest.completionState -ne 'COMPLETE') -or
    ($environmentManifest.mode -ne 'Bootstrap')) {
  throw 'Lock resolution requires complete schema-2 Bootstrap environment evidence.'
}
if ($environmentManifest.dependencyProfile -ne $DependencyProfile) {
  throw 'Bootstrap environment dependency profile does not match the requested lock profile.'
}
if (Test-Path -LiteralPath $lockPath) {
  throw "Lock output already exists; choose a new path instead of overwriting evidence: $lockPath"
}
if (Test-Path -LiteralPath $semanticLockPath) {
  throw "Semantic lock evidence already exists: $semanticLockPath"
}
if (Test-Path -LiteralPath $wheelhousePath) {
  throw "Wheelhouse output already exists; choose a new path instead of overwriting evidence: $wheelhousePath"
}

$lockParent = Split-Path -Parent $lockPath
$wheelhouseParent = Split-Path -Parent $wheelhousePath
New-Item -ItemType Directory -Path $lockParent -Force | Out-Null
New-Item -ItemType Directory -Path $wheelhouseParent -Force | Out-Null

$buildId = [guid]::NewGuid().ToString('N')
$stagingRoot = Assert-PathWithinTrainingRoot `
  (Join-Path $trainingPath "evidence\lock-build-$buildId") `
  $trainingPath
$stagingWheelhouse = Join-Path $stagingRoot 'wheels'
$resolverReportPath = Join-Path $stagingRoot 'pip-resolver-report.json'
$stagingLockPath = Join-Path $stagingRoot 'requirements.lock.txt'
New-Item -ItemType Directory -Path $stagingWheelhouse -Force | Out-Null

Write-Host 'Downloading binary wheels from the public PyPI index into the external staging directory...'
& $pythonPath -m pip `
  --isolated `
  --disable-pip-version-check `
  --no-cache-dir `
  download `
  --only-binary=:all: `
  --index-url 'https://pypi.org/simple' `
  --dest $stagingWheelhouse `
  -r $requirementsPath
if ($LASTEXITCODE -ne 0) {
  throw "Wheel download failed. Partial external evidence remains at: $stagingRoot"
}

& $pythonPath -m pip `
  --isolated `
  --disable-pip-version-check `
  install `
  --dry-run `
  --ignore-installed `
  --no-index `
  --only-binary=:all: `
  --find-links $stagingWheelhouse `
  --report $resolverReportPath `
  -r $requirementsPath
if ($LASTEXITCODE -ne 0) {
  throw "Offline dependency resolution failed. External evidence remains at: $stagingRoot"
}

$wheelFiles = @(Get-ChildItem -LiteralPath $stagingWheelhouse -File)
if ($wheelFiles.Count -eq 0) { throw 'Resolver produced no wheels.' }
$unexpectedFiles = @($wheelFiles | Where-Object { $_.Extension -ne '.whl' })
if ($unexpectedFiles.Count -gt 0) {
  throw "Only wheels are permitted: $($unexpectedFiles.Name -join ', ')"
}

$resolverReport = Get-Content -LiteralPath $resolverReportPath -Raw | ConvertFrom-Json
$installRecords = @($resolverReport.install)
if ($installRecords.Count -eq 0) { throw 'Resolver report contains no install records.' }

$lockLines = @()
$licenseRecords = @()
$usedWheels = @()
foreach ($record in $installRecords) {
  $name = [string]$record.metadata.name
  $version = [string]$record.metadata.version
  if (($name -notmatch '^[A-Za-z0-9_.-]+$') -or [string]::IsNullOrWhiteSpace($version)) {
    throw "Resolver returned an unsafe package identity: $name $version"
  }

  $downloadUri = [uri]$record.download_info.url
  $wheelName = [uri]::UnescapeDataString(
    [System.IO.Path]::GetFileName($downloadUri.AbsolutePath)
  )
  $wheelPath = Join-Path $stagingWheelhouse $wheelName
  if (-not (Test-Path -LiteralPath $wheelPath -PathType Leaf)) {
    throw "Resolved wheel is missing from the wheelhouse: $wheelName"
  }

  $wheelHash = (Get-FileHash -LiteralPath $wheelPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $lockLines += "$name==$version --hash=sha256:$wheelHash"
  $usedWheels += $wheelName

  $metadataProperties = @($record.metadata.PSObject.Properties.Name)
  $licenseRecords += [ordered]@{
    name = $name
    version = $version
    wheel = $wheelName
    sha256 = $wheelHash
    licenseExpression = if ($metadataProperties -contains 'license_expression') {
      $record.metadata.license_expression
    } else { $null }
    license = if ($metadataProperties -contains 'license') {
      $record.metadata.license
    } else { $null }
    classifiers = if ($metadataProperties -contains 'classifier') {
      @($record.metadata.classifier)
    } else { @() }
  }
}

$duplicatePackages = @($lockLines | ForEach-Object {
  ($_ -split '==', 2)[0].ToLowerInvariant()
} | Group-Object | Where-Object Count -gt 1)
if ($duplicatePackages.Count -gt 0) {
  throw "Resolver returned duplicate package identities: $($duplicatePackages.Name -join ', ')"
}
$unusedWheels = @($wheelFiles.Name | Where-Object { $usedWheels -notcontains $_ })
if ($unusedWheels.Count -gt 0) {
  throw "Downloaded wheels were not bound into the resolver report: $($unusedWheels -join ', ')"
}

$sortedLockLines = @($lockLines | Sort-Object)
[System.IO.File]::WriteAllLines(
  $stagingLockPath,
  $sortedLockLines,
  [System.Text.UTF8Encoding]::new($false)
)

$inventoryPath = Join-Path $stagingRoot 'dependency-inventory.json'
$inventory = [ordered]@{
  schemaVersion = 2
  completionState = 'COMPLETE'
  createdAt = [datetime]::UtcNow.ToString('o')
  reviewRequired = $true
  note = 'Automated metadata capture is not legal or security approval.'
  requirements = Get-Sha256Record $requirementsPath
  bootstrapEnvironment = Get-Sha256Record $environmentManifestPath
  dependencies = @($licenseRecords | Sort-Object name)
}
Write-JsonEvidenceAtomic -Path $inventoryPath -Value $inventory -Depth 12

$runtime = Get-PythonRuntimeCompatibility $pythonPath

Move-Item -LiteralPath $stagingWheelhouse -Destination $wheelhousePath
Move-Item -LiteralPath $stagingLockPath -Destination $lockPath

$wheelBindings = @($licenseRecords | Sort-Object name | ForEach-Object {
  [ordered]@{
    name = [string]$_.name
    version = [string]$_.version
    fileName = [string]$_.wheel
    sha256 = ([string]$_.sha256).ToLowerInvariant()
  }
})
$wheelIndexSha256 = Get-Utf8TextSha256 ($wheelBindings | ConvertTo-Json -Depth 6 -Compress)
$semanticLock = [ordered]@{
  schemaVersion = 2
  completionState = 'COMPLETE'
  createdAt = [datetime]::UtcNow.ToString('o')
  dependencyProfile = $DependencyProfile
  requirementsFiles = @($environmentManifest.requirementsFiles)
  python = [ordered]@{
    implementation = [string]$runtime.implementation
    version = [string]$runtime.version
    cacheTag = [string]$runtime.cacheTag
    platform = [string]$runtime.platform
    machine = [string]$runtime.machine
  }
  lock = Get-Sha256Record $lockPath
  wheelhousePath = $wheelhousePath
  wheelCount = $wheelBindings.Count
  wheelIndexSha256 = $wheelIndexSha256
  wheels = $wheelBindings
}
Write-JsonEvidenceAtomic -Path $semanticLockPath -Value $semanticLock -Depth 12

$completionPath = Join-Path $stagingRoot 'lock-build-manifest.json'
$completion = [ordered]@{
  schemaVersion = 2
  completionState = 'COMPLETE'
  completedAt = [datetime]::UtcNow.ToString('o')
  lock = Get-Sha256Record $lockPath
  wheelhouse = $wheelhousePath
  wheelCount = $wheelFiles.Count
  resolverReport = Get-Sha256Record $resolverReportPath
  dependencyInventory = Get-Sha256Record $inventoryPath
  semanticLock = Get-Sha256Record $semanticLockPath
}
Write-JsonEvidenceAtomic -Path $completionPath -Value $completion -Depth 10

Write-Host "Hash-locked requirements: $lockPath"
Write-Host "Frozen wheelhouse: $wheelhousePath"
Write-Host "Semantic lock evidence: $semanticLockPath"
Write-Host "Dependency/license inventory requiring review: $inventoryPath"
Write-Host 'The lock is a trust-on-first-use snapshot of PyPI downloads; retain and independently review its evidence.'
