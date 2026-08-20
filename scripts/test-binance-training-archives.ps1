[CmdletBinding()]
param(
  [string]$TrainingRoot = (Join-Path $env:USERPROFILE 'Flippars-ml'),
  [string]$ArchiveRoot = (Join-Path $TrainingRoot 'data\raw\archives'),
  [Parameter(Mandatory)][string]$Start,
  [Parameter(Mandatory)][string]$End,
  [Parameter(Mandatory)][string]$EvidenceOutput,
  [string]$ChecksumTransportEvidence,
  [switch]$RequireFreshChecksumTransport
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'model-training-guardrails.ps1')

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$trainingPath = Assert-ExternalTrainingRoot $TrainingRoot $repositoryRoot
$archivePath = Assert-PathWithinTrainingRoot $ArchiveRoot $trainingPath
$evidencePath = Assert-PathWithinTrainingRoot $EvidenceOutput $trainingPath
$dateRange = Assert-ModelTrainingDateRange $Start $End

if (-not (Test-Path -LiteralPath $archivePath -PathType Container)) {
  throw "Archive directory does not exist: $archivePath"
}
if (Test-Path -LiteralPath $evidencePath) {
  throw "Integrity evidence already exists; choose a new path instead of overwriting it: $evidencePath"
}
if ($RequireFreshChecksumTransport -and [string]::IsNullOrWhiteSpace($ChecksumTransportEvidence)) {
  throw 'Governed verification requires fresh checksum transport evidence.'
}

$transportByDate = @{}
$freshTransportRequired = $RequireFreshChecksumTransport.IsPresent
$freshTransportEvidenceProvided =
  -not [string]::IsNullOrWhiteSpace($ChecksumTransportEvidence)
if ($freshTransportEvidenceProvided) {
  $transportEvidencePath = Assert-PathWithinTrainingRoot $ChecksumTransportEvidence $trainingPath
  if (-not (Test-Path -LiteralPath $transportEvidencePath -PathType Leaf)) {
    throw "Checksum transport evidence does not exist: $transportEvidencePath"
  }
  $transportEvidence = Get-Content -LiteralPath $transportEvidencePath -Raw | ConvertFrom-Json
  if (([int]$transportEvidence.schemaVersion -ne 3) -or
      ($transportEvidence.completionState -ne 'COMPLETE') -or
      ($transportEvidence.provenanceMode -ne 'FRESH_BINANCE_HTTPS_CHECKSUMS') -or
      (-not [bool]$transportEvidence.freshOfficialTransportEvidence) -or
      ($transportEvidence.selectedWindow.startInclusive -ne $Start) -or
      ($transportEvidence.selectedWindow.endExclusive -ne $End)) {
    throw 'Checksum transport evidence is incomplete or does not match the requested window.'
  }
  foreach ($transportRecord in @($transportEvidence.verification)) {
    $transportDate = [string]$transportRecord.date
    if ($transportByDate.ContainsKey($transportDate)) {
      throw "Checksum transport evidence contains a duplicate date: $transportDate"
    }
    $transportByDate[$transportDate] = $transportRecord
  }
}

$expectedArchiveNames = @()
for ($expectedDate = $dateRange.Start; $expectedDate -lt $dateRange.End; $expectedDate = $expectedDate.AddDays(1)) {
  $expectedArchiveNames += "BTCUSDT-trades-$($expectedDate.ToString('yyyy-MM-dd')).zip"
}
$expectedChecksumNames = @($expectedArchiveNames | ForEach-Object { "$_.CHECKSUM" })
$expectedNameSet = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)
foreach ($name in @($expectedArchiveNames + $expectedChecksumNames)) {
  if (-not $expectedNameSet.Add($name)) { throw "Duplicate expected archive identity: $name" }
}
if (($transportByDate.Count -gt 0) -and
    ($transportByDate.Count -ne $expectedArchiveNames.Count)) {
  throw 'Checksum transport evidence does not cover the exact requested date set.'
}
$allEntries = @(Get-ChildItem -LiteralPath $archivePath -Force)
$unexpectedEntries = @($allEntries | Where-Object {
  $_.PSIsContainer -or
  (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
  (-not $expectedNameSet.Contains($_.Name))
})
if ($unexpectedEntries.Count -gt 0) {
  throw "Archive directory contains nested, reparse, or unmanifested entries: $($unexpectedEntries.Name -join ', ')"
}
if ($allEntries.Count -ne $expectedNameSet.Count) {
  throw "Archive directory entry count does not match the exact requested window."
}

$baseUrl = 'https://data.binance.vision/data/spot/daily/trades/BTCUSDT'
$records = @()
for ($date = $dateRange.Start; $date -lt $dateRange.End; $date = $date.AddDays(1)) {
  $dateText = $date.ToString('yyyy-MM-dd')
  $archiveName = "BTCUSDT-trades-$dateText.zip"
  $archiveFile = Join-Path $archivePath $archiveName
  $checksumName = "$archiveName.CHECKSUM"
  $checksumFile = Join-Path $archivePath $checksumName
  $checksumUrl = "$baseUrl/$checksumName"

  if (-not (Test-Path -LiteralPath $archiveFile -PathType Leaf)) {
    throw "Expected public archive is missing: $archiveFile"
  }
  if (-not (Test-Path -LiteralPath $checksumFile -PathType Leaf)) {
    throw "Checksum sidecar is missing from the isolated snapshot: $checksumFile"
  }

  $checksumItem = Get-Item -LiteralPath $checksumFile -Force
  if (($checksumItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Checksum sidecar cannot be a reparse point: $checksumFile"
  }
  if (($checksumItem.Length -lt 1) -or ($checksumItem.Length -gt 1024)) {
    throw "Local checksum sidecar has an invalid byte length: $checksumFile"
  }
  $checksumBytes = [System.IO.File]::ReadAllBytes($checksumFile)
  if (@($checksumBytes | Where-Object { ($_ -lt 32) -and ($_ -notin @(10, 13)) }).Count -gt 0) {
    throw "Local checksum sidecar contains a control character: $checksumFile"
  }
  try {
    $decoder = [System.Text.UTF8Encoding]::new($false, $true)
    $checksumText = $decoder.GetString($checksumBytes)
  } catch {
    throw "Local checksum sidecar must be valid UTF-8: $checksumFile"
  }
  if ($checksumText -match '(\r?\n){2,}$') {
    throw "Local checksum sidecar contains trailing payload: $checksumFile"
  }
  $checksumText = $checksumText.TrimEnd([char[]]@(13, 10))
  if (($checksumText -match '[\r\n]') -or
      ($checksumText -notmatch '^([a-fA-F0-9]{64}) +\*?([A-Za-z0-9._-]+)$')) {
    throw "Local checksum sidecar has an unexpected format: $checksumFile"
  }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $boundName = $Matches[2].Trim()
  if ($boundName -ne $archiveName) {
    throw "Checksum binds '$boundName', not the expected '$archiveName'."
  }

  $archiveRecord = Get-Sha256Record $archiveFile
  if ($archiveRecord.Sha256 -ne $expectedHash) {
    throw "SHA-256 mismatch for $archiveName. Expected $expectedHash; received $($archiveRecord.Sha256)."
  }
  $checksumRecord = Get-Sha256Record $checksumFile
  $transportRecord = if ($transportByDate.ContainsKey($dateText)) {
    $transportByDate[$dateText]
  } else {
    $null
  }
  if ($null -ne $transportRecord) {
    if ((-not [bool]$transportRecord.valid) -or
        (-not [bool]$transportRecord.freshChecksumTransport)) {
      throw "Checksum transport evidence is not fresh and valid for $dateText."
    }
    if (([string]$transportRecord.archiveSourceUri -ne
         $checksumUrl.Substring(0, $checksumUrl.Length - '.CHECKSUM'.Length)) -or
        ([string]$transportRecord.requestedChecksumUri -ne $checksumUrl)) {
      throw "Checksum transport evidence has a source URI mismatch for $dateText."
    }
    $finalChecksumUri = [uri][string]$transportRecord.finalChecksumUri
    [void](Assert-BinanceDataVisionUri $finalChecksumUri)
    if ($finalChecksumUri.AbsoluteUri -ne ([uri]$checksumUrl).AbsoluteUri) {
      throw "Checksum transport final URI is not the canonical sidecar URI for $dateText."
    }
    if ([string]::IsNullOrWhiteSpace([string]$transportRecord.checksumRetrievedAt)) {
      throw "Checksum transport evidence lacks a retrieval timestamp for $dateText."
    }
    try {
      $retrievedAt = [datetimeoffset]::Parse(
        [string]$transportRecord.checksumRetrievedAt,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind
      )
    } catch {
      throw "Checksum retrieval timestamp is invalid for $dateText."
    }
    if ($retrievedAt.Offset -ne [timespan]::Zero) {
      throw "Checksum retrieval timestamp is not UTC for $dateText."
    }
    if (([string]$transportRecord.expectedSha256).ToLowerInvariant() -ne $expectedHash) {
      throw "Checksum transport evidence has an expected digest mismatch for $dateText."
    }
    if (([long]$transportRecord.archive.Bytes -ne [long]$archiveRecord.Bytes) -or
        ([string]$transportRecord.archive.Sha256).ToLowerInvariant() -ne
         ([string]$archiveRecord.Sha256).ToLowerInvariant()) {
      throw "Archive bytes differ from fresh checksum transport evidence for $dateText."
    }
    if (([long]$transportRecord.checksum.Bytes -ne [long]$checksumRecord.Bytes) -or
        ([string]$transportRecord.checksum.Sha256).ToLowerInvariant() -ne
         ([string]$checksumRecord.Sha256).ToLowerInvariant()) {
      throw "Checksum bytes differ from fresh transport evidence for $dateText."
    }
  } elseif ($freshTransportRequired) {
    throw "Fresh checksum transport evidence is missing for $dateText."
  }

  $hasFreshTransport = $null -ne $transportRecord
  $records += [ordered]@{
    day = $dateText
    archiveName = $archiveName
    archiveBytes = [long]$archiveRecord.Bytes
    archiveSha256 = ([string]$archiveRecord.Sha256).ToLowerInvariant()
    checksumName = $checksumName
    checksumBytes = [long]$checksumRecord.Bytes
    checksumSha256 = ([string]$checksumRecord.Sha256).ToLowerInvariant()
    expectedArchiveSha256 = $expectedHash
    archiveSourceUri = if ($hasFreshTransport) {
      [string]$transportRecord.archiveSourceUri
    } else {
      $null
    }
    requestedChecksumUri = if ($hasFreshTransport) {
      [string]$transportRecord.requestedChecksumUri
    } else {
      $null
    }
    finalChecksumUri = if ($hasFreshTransport) {
      [string]$transportRecord.finalChecksumUri
    } else {
      $null
    }
    checksumRetrievedAt = if ($hasFreshTransport) {
      [string]$transportRecord.checksumRetrievedAt
    } else {
      $null
    }
  }
}

$evidenceParent = Split-Path -Parent $evidencePath
New-Item -ItemType Directory -Path $evidenceParent -Force | Out-Null
$evidence = [ordered]@{
  schemaVersion = 3
  completionState = 'COMPLETE'
  verifiedAt = [datetime]::UtcNow.ToString('o')
  provenanceMode = if ($freshTransportEvidenceProvided) {
    'FRESH_BINANCE_HTTPS_CHECKSUMS'
  } else {
    'OFFLINE_LOCAL_INTEGRITY_ONLY'
  }
  freshOfficialTransportEvidence = $freshTransportEvidenceProvided
  provider = if ($freshTransportEvidenceProvided) {
    'Binance Data Vision'
  } else {
    'UNATTESTED_LOCAL_FILES'
  }
  market = 'spot'
  symbol = 'BTCUSDT'
  dataset = 'daily trades'
  startInclusive = $Start
  endExclusive = $End
  officialChecksumBaseUrl = if ($freshTransportEvidenceProvided) { $baseUrl } else { $null }
  archives = $records
  acquisitionArchiveIndexSha256 = Get-Utf8TextSha256 (
    ConvertTo-Json -InputObject @($records) -Depth 8 -Compress
  )
}
Write-JsonEvidenceAtomic -Path $evidencePath -Value $evidence -Depth 12

Write-Host "Verified $($records.Count) BTCUSDT Spot archive(s)."
Write-Host "Integrity evidence: $evidencePath"
