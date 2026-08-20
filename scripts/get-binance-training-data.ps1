[CmdletBinding()]
param(
  [string]$TrainingRoot = (Join-Path $env:USERPROFILE 'Flippars-ml'),
  [string]$EnvironmentName = 'final-env',
  [string]$ArchiveCache = (Join-Path $TrainingRoot 'data\raw\archives'),
  [Parameter(Mandatory)][string]$Start,
  [Parameter(Mandatory)][string]$End,
  [ValidateRange(1, 3660)][int]$MaxFiles = 366,
  [string]$EvidenceOutput,
  [switch]$CopyArchives
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:PYTHONDONTWRITEBYTECODE = '1'

. (Join-Path $PSScriptRoot 'model-training-guardrails.ps1')

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$trainingPath = Assert-ExternalTrainingRoot $TrainingRoot $repositoryRoot
$safeEnvironmentName = Assert-SafeEnvironmentName $EnvironmentName
$environmentPath = Assert-PathWithinTrainingRoot `
  (Join-Path $trainingPath $safeEnvironmentName) `
  $trainingPath
$pythonPath = Join-Path $environmentPath 'Scripts\python.exe'
$dateRange = Assert-ModelTrainingDateRange $Start $End
$requestedFiles = [int]($dateRange.End - $dateRange.Start).TotalDays
if ($requestedFiles -gt $MaxFiles) {
  throw "Requested $requestedFiles daily archives, exceeding MaxFiles=$MaxFiles."
}
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  throw "Training environment is missing: $pythonPath"
}

$cachePath = Assert-PathWithinTrainingRoot $ArchiveCache $trainingPath
if ([System.IO.Path]::GetFileName($cachePath) -ne 'archives') {
  throw 'ArchiveCache must be the archives directory expected beneath a raw data root.'
}
if (-not (Test-Path -LiteralPath $cachePath)) {
  New-Item -ItemType Directory -Path $cachePath -Force | Out-Null
}
$cacheRawRoot = Split-Path -Parent $cachePath

$datasetKey = "BTCUSDT-$Start--$End"
$datasetsRoot = Assert-PathWithinTrainingRoot (Join-Path $trainingPath 'datasets') $trainingPath
$datasetRoot = Assert-PathWithinTrainingRoot (Join-Path $datasetsRoot $datasetKey) $trainingPath
if (Test-Path -LiteralPath $datasetRoot) {
  throw "Immutable dataset snapshot already exists: $datasetRoot"
}
if ([string]::IsNullOrWhiteSpace($EvidenceOutput)) {
  $EvidenceOutput = Join-Path $datasetRoot 'evidence\source-integrity.json'
}
$evidencePath = Assert-PathWithinTrainingRoot $EvidenceOutput $trainingPath
Assert-NoTrackedTrainingMaterial $repositoryRoot

$inventoryStamp = [datetime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$inventorySuffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
$inventoryRoot = Assert-PathWithinTrainingRoot `
  (Join-Path $trainingPath "evidence\cache-inventory\acquire-$inventoryStamp-$inventorySuffix") `
  $trainingPath
$preInventoryPath = Join-Path $inventoryRoot 'before-collection.json'
$postInventoryPath = Join-Path $inventoryRoot 'after-collection.json'

Write-Host 'Inventorying the shared cache before any archive download...'
& (Join-Path $PSScriptRoot 'inspect-model-training-cache.ps1') `
  -TrainingRoot $trainingPath `
  -ArchiveCache $cachePath `
  -Start $Start `
  -End $End `
  -EvidenceOutput $preInventoryPath

$preInventory = Get-Content -LiteralPath $preInventoryPath -Raw | ConvertFrom-Json
if (@($preInventory.missingArchives).Count -gt 0) {
  $sourceRoot = Join-Path $repositoryRoot 'apps\model-training\src'
  $previousPythonPath = $env:PYTHONPATH
  $env:PYTHONPATH = $sourceRoot
  try {
    Write-Host 'Downloading missing public dates; existing verified cache files remain unchanged...'
    & $pythonPath -m flippars_model_training collect `
      --symbol BTCUSDT `
      --start $Start `
      --end $End `
      --raw-root $cacheRawRoot `
      --base-url 'https://data.binance.vision/' `
      --max-files $MaxFiles
    if ($LASTEXITCODE -ne 0) { throw 'Public training-data collection failed.' }
  } finally {
    $env:PYTHONPATH = $previousPythonPath
  }
} else {
  Write-Host 'All selected archive bytes are already cached; no archive download is needed.'
}

Write-Host 'Refreshing every selected checksum from pinned Binance HTTPS...'
& (Join-Path $PSScriptRoot 'inspect-model-training-cache.ps1') `
  -TrainingRoot $trainingPath `
  -ArchiveCache $cachePath `
  -Start $Start `
  -End $End `
  -EvidenceOutput $postInventoryPath `
  -RefreshSelectedChecksums `
  -VerifyChecksums
$effectivePostInventoryPath = $postInventoryPath
$postInventory = Get-Content -LiteralPath $effectivePostInventoryPath -Raw | ConvertFrom-Json
if (([int]$postInventory.schemaVersion -ne 3) -or
    ($postInventory.completionState -ne 'COMPLETE') -or
    ($postInventory.provenanceMode -ne 'FRESH_BINANCE_HTTPS_CHECKSUMS') -or
    (-not [bool]$postInventory.freshOfficialTransportEvidence) -or
    ([int]$postInventory.selectedBlockingIssueCount -ne 0) -or
    (@($postInventory.verification | Where-Object { -not $_.valid }).Count -gt 0) -or
    (@($postInventory.verification | Where-Object {
      $_.valid -and $_.freshChecksumTransport
    }).Count -ne $requestedFiles)) {
  throw "The selected cache window is incomplete or invalid. Evidence: $postInventoryPath"
}

$stagingRoot = Assert-PathWithinTrainingRoot `
  (Join-Path $datasetsRoot ".$datasetKey.staging-$([guid]::NewGuid().ToString('N'))") `
  $trainingPath
$stagingArchiveRoot = Join-Path $stagingRoot 'raw\archives'
New-Item -ItemType Directory -Path $stagingArchiveRoot -Force | Out-Null
$stagingSucceeded = $false
try {
  for ($date = $dateRange.Start; $date -lt $dateRange.End; $date = $date.AddDays(1)) {
    $archiveName = "BTCUSDT-trades-$($date.ToString('yyyy-MM-dd')).zip"
    $checksumName = "$archiveName.CHECKSUM"
    $sourceArchive = Join-Path $cachePath $archiveName
    $sourceChecksum = Join-Path $cachePath $checksumName
    $targetArchive = Join-Path $stagingArchiveRoot $archiveName
    $targetChecksum = Join-Path $stagingArchiveRoot $checksumName

    if ($CopyArchives) {
      $temporaryArchive = "$targetArchive.copy-$([guid]::NewGuid().ToString('N'))"
      Copy-Item -LiteralPath $sourceArchive -Destination $temporaryArchive
      Move-Item -LiteralPath $temporaryArchive -Destination $targetArchive
    } else {
      New-Item -ItemType HardLink -Path $targetArchive -Target $sourceArchive | Out-Null
    }
    $temporaryChecksum = "$targetChecksum.copy-$([guid]::NewGuid().ToString('N'))"
    Copy-Item -LiteralPath $sourceChecksum -Destination $temporaryChecksum
    Move-Item -LiteralPath $temporaryChecksum -Destination $targetChecksum
  }

  Move-Item -LiteralPath $stagingRoot -Destination $datasetRoot
  $stagingSucceeded = $true
} finally {
  if (-not $stagingSucceeded -and (Test-Path -LiteralPath $stagingRoot)) {
    Write-Warning "Staging was not removed automatically; inspect or quarantine it explicitly: $stagingRoot"
  }
}

& (Join-Path $PSScriptRoot 'test-binance-training-archives.ps1') `
  -TrainingRoot $trainingPath `
  -ArchiveRoot (Join-Path $datasetRoot 'raw\archives') `
  -Start $Start `
  -End $End `
  -EvidenceOutput $evidencePath `
  -ChecksumTransportEvidence $effectivePostInventoryPath `
  -RequireFreshChecksumTransport

$acquisitionManifestPath = Join-Path $datasetRoot 'evidence\acquisition-manifest.json'
$isolatedIntegrity = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
if (([int]$isolatedIntegrity.schemaVersion -ne 3) -or
    ($isolatedIntegrity.completionState -ne 'COMPLETE') -or
    ($isolatedIntegrity.provenanceMode -ne 'FRESH_BINANCE_HTTPS_CHECKSUMS') -or
    (-not [bool]$isolatedIntegrity.freshOfficialTransportEvidence) -or
    (@($isolatedIntegrity.archives).Count -ne $requestedFiles)) {
  throw 'Isolated dataset lacks complete fresh Binance checksum transport evidence.'
}
$archiveBindings = @($isolatedIntegrity.archives | ForEach-Object {
  [ordered]@{
    day = [string]$_.day
    archiveName = [string]$_.archiveName
    archiveBytes = [long]$_.archiveBytes
    archiveSha256 = ([string]$_.archiveSha256).ToLowerInvariant()
    checksumName = [string]$_.checksumName
    checksumBytes = [long]$_.checksumBytes
    checksumSha256 = ([string]$_.checksumSha256).ToLowerInvariant()
    expectedArchiveSha256 = ([string]$_.expectedArchiveSha256).ToLowerInvariant()
    archiveSourceUri = [string]$_.archiveSourceUri
    requestedChecksumUri = [string]$_.requestedChecksumUri
    finalChecksumUri = [string]$_.finalChecksumUri
    checksumRetrievedAt = [string]$_.checksumRetrievedAt
  }
})
$archiveIndexJson = ConvertTo-Json -InputObject @($archiveBindings) -Depth 6 -Compress
$acquisitionManifest = [ordered]@{
  schemaVersion = 3
  completionState = 'COMPLETE'
  completedAt = [datetime]::UtcNow.ToString('o')
  freshOfficialTransportEvidence = $true
  source = [ordered]@{
    provider = 'Binance Data Vision'
    marketType = 'SPOT'
    symbol = 'BTCUSDT'
    dataKind = 'DAILY_TRADES'
    timeBasis = 'EVENT_TIME'
    cache = $cachePath
  }
  window = [ordered]@{
    startInclusive = $Start
    endExclusive = $End
    dayCount = $requestedFiles
  }
  materialization = if ($CopyArchives) { 'ATOMIC_COPY' } else { 'HARD_LINK' }
  archiveRoot = Join-Path $datasetRoot 'raw\archives'
  archives = $archiveBindings
  acquisitionArchiveIndexSha256 = Get-Utf8TextSha256 $archiveIndexJson
  cacheInventoryBefore = Get-Sha256Record $preInventoryPath
  cacheInventoryAfter = Get-Sha256Record $effectivePostInventoryPath
  isolatedIntegrity = Get-Sha256Record $evidencePath
  credentialsUsed = $false
  tradingApiUsed = $false
}
Write-JsonEvidenceAtomic -Path $acquisitionManifestPath -Value $acquisitionManifest -Depth 12

Write-Host "Isolated verified dataset: $datasetRoot"
Write-Host "Source evidence: $evidencePath"
Write-Host "Acquisition evidence: $acquisitionManifestPath"
if (-not $CopyArchives) {
  Write-Warning 'Archives were hard-linked to avoid duplicating the cache; never modify cache files in place.'
}
Write-Host 'Collection completed without exchange credentials or trading API access.'
