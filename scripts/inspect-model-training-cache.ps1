[CmdletBinding()]
param(
  [string]$TrainingRoot = (Join-Path $env:USERPROFILE 'Flippars-ml'),
  [string]$ArchiveCache = (Join-Path $TrainingRoot 'data\raw\archives'),
  [string]$Start,
  [string]$End,
  [string]$EvidenceOutput,
  [switch]$RefreshSelectedChecksums,
  [switch]$VerifyChecksums,
  [switch]$ApplyQuarantine,
  [switch]$IncludeUnselectedQuarantineCandidates
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'model-training-guardrails.ps1')

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$trainingPath = Assert-ExternalTrainingRoot $TrainingRoot $repositoryRoot
$cachePath = Assert-PathWithinTrainingRoot $ArchiveCache $trainingPath
if (-not (Test-Path -LiteralPath $cachePath -PathType Container)) {
  throw "Archive cache does not exist: $cachePath"
}

$hasStart = -not [string]::IsNullOrWhiteSpace($Start)
$hasEnd = -not [string]::IsNullOrWhiteSpace($End)
if ($hasStart -ne $hasEnd) { throw 'Start and End must be supplied together.' }
if ($RefreshSelectedChecksums -and -not $hasStart) {
  throw 'Refreshing checksums requires an explicit Start and End window.'
}
if ($hasStart) {
  $dateRange = Assert-ModelTrainingDateRange $Start $End
} else {
  $dateRange = $null
}

if ([string]::IsNullOrWhiteSpace($EvidenceOutput)) {
  $stamp = [datetime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $EvidenceOutput = Join-Path $trainingPath "evidence\cache-inventory\inventory-$stamp-$suffix.json"
}
$evidencePath = Assert-PathWithinTrainingRoot $EvidenceOutput $trainingPath
if (Test-Path -LiteralPath $evidencePath) {
  throw "Inventory evidence already exists: $evidencePath"
}

$archivePattern = '^BTCUSDT-trades-(\d{4}-\d{2}-\d{2})\.zip$'
$checksumPattern = '^BTCUSDT-trades-(\d{4}-\d{2}-\d{2})\.zip\.CHECKSUM$'
$allFiles = @(Get-ChildItem -LiteralPath $cachePath -Force -File)
$nestedEntries = @(Get-ChildItem -LiteralPath $cachePath -Force -Directory)
$archivesByDate = @{}
$checksumsByDate = @{}
$structuralIssues = [System.Collections.Generic.List[object]]::new()
$quarantineCandidates = @{}

function Add-QuarantineCandidate {
  param([System.IO.FileInfo]$File, [string]$Reason, [bool]$BlocksSelectedWindow)
  $fullPath = ConvertTo-NormalizedFullPath $File.FullName
  if (-not (Test-PathWithin $fullPath $script:cachePath)) {
    throw "Refusing to quarantine a file outside ArchiveCache: $fullPath"
  }
  if (($File.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to quarantine a symbolic link or reparse point: $fullPath"
  }
  if (-not $script:quarantineCandidates.ContainsKey($fullPath)) {
    $script:quarantineCandidates[$fullPath] = [ordered]@{
      source = $fullPath
      bytes = $File.Length
      reason = $Reason
      blocksSelectedWindow = $BlocksSelectedWindow
    }
  }
}

function Test-DateSelected {
  param([string]$DateText)
  if ($null -eq $script:dateRange) { return $false }
  $value = [datetime]::ParseExact(
    $DateText,
    'yyyy-MM-dd',
    [System.Globalization.CultureInfo]::InvariantCulture
  )
  return ($value -ge $script:dateRange.Start) -and ($value -lt $script:dateRange.End)
}

foreach ($file in $allFiles) {
  if ($file.Name -cmatch $archivePattern) {
    $dateText = $Matches[1]
    try {
      [void][datetime]::ParseExact(
        $dateText,
        'yyyy-MM-dd',
        [System.Globalization.CultureInfo]::InvariantCulture
      )
      $archivesByDate[$dateText] = $file
      if ($file.Length -eq 0) {
        $selected = Test-DateSelected $dateText
        $structuralIssues.Add([ordered]@{ path = $file.FullName; reason = 'ZERO_BYTE_ARCHIVE'; selected = $selected })
        Add-QuarantineCandidate $file 'ZERO_BYTE_ARCHIVE' $selected
      }
    } catch {
      $structuralIssues.Add([ordered]@{ path = $file.FullName; reason = 'INVALID_ARCHIVE_DATE'; selected = $false })
      Add-QuarantineCandidate $file 'INVALID_ARCHIVE_DATE' $false
    }
    continue
  }
  if ($file.Name -cmatch $checksumPattern) {
    $dateText = $Matches[1]
    try {
      [void][datetime]::ParseExact(
        $dateText,
        'yyyy-MM-dd',
        [System.Globalization.CultureInfo]::InvariantCulture
      )
      $checksumsByDate[$dateText] = $file
      if ($file.Length -eq 0) {
        $selected = Test-DateSelected $dateText
        $reason = if ($selected -and $RefreshSelectedChecksums) {
          'ZERO_BYTE_CHECKSUM_PENDING_FRESH_REPLACEMENT'
        } else {
          'ZERO_BYTE_CHECKSUM'
        }
        $structuralIssues.Add([ordered]@{
          path = $file.FullName
          reason = $reason
          selected = $selected
        })
        if (-not ($selected -and $RefreshSelectedChecksums)) {
          Add-QuarantineCandidate $file 'ZERO_BYTE_CHECKSUM' $selected
        }
      }
    } catch {
      $structuralIssues.Add([ordered]@{ path = $file.FullName; reason = 'INVALID_CHECKSUM_DATE'; selected = $false })
      Add-QuarantineCandidate $file 'INVALID_CHECKSUM_DATE' $false
    }
    continue
  }

  $reason = if (($file.Extension -eq '.part') -or ($file.Name -match '\.download-[A-Fa-f0-9]+$')) {
    'PARTIAL_DOWNLOAD'
  } else {
    'UNEXPECTED_CACHE_FILE'
  }
  $structuralIssues.Add([ordered]@{ path = $file.FullName; reason = $reason; selected = $false })
  Add-QuarantineCandidate $file $reason $false
}

foreach ($directory in $nestedEntries) {
  $structuralIssues.Add([ordered]@{
    path = $directory.FullName
    reason = 'NESTED_DIRECTORY_REQUIRES_MANUAL_REVIEW'
    selected = $false
  })
}

$orphanChecksums = @()
foreach ($dateText in @($checksumsByDate.Keys)) {
  if (-not $archivesByDate.ContainsKey($dateText)) {
    $checksumFile = [System.IO.FileInfo]$checksumsByDate[$dateText]
    $orphanChecksums += $checksumFile.FullName
    Add-QuarantineCandidate $checksumFile 'ORPHAN_CHECKSUM' (Test-DateSelected $dateText)
  }
}
$allArchiveDatesWithoutChecksums = @(
  $archivesByDate.Keys | Where-Object { -not $checksumsByDate.ContainsKey($_) } | Sort-Object
)

$requestedDates = @()
if ($null -ne $dateRange) {
  for ($date = $dateRange.Start; $date -lt $dateRange.End; $date = $date.AddDays(1)) {
    $requestedDates += $date.ToString('yyyy-MM-dd')
  }
}
$missingArchives = [System.Collections.Generic.List[string]]::new()
$missingChecksums = [System.Collections.Generic.List[string]]::new()
$refreshedChecksums = [System.Collections.Generic.List[string]]::new()
$verificationRecords = [System.Collections.Generic.List[object]]::new()
$baseUrl = 'https://data.binance.vision/data/spot/daily/trades/BTCUSDT'

foreach ($dateText in $requestedDates) {
  if (-not $archivesByDate.ContainsKey($dateText)) {
    $missingArchives.Add($dateText)
    continue
  }
  $archiveFile = [System.IO.FileInfo]$archivesByDate[$dateText]
  if ($archiveFile.Length -eq 0) { continue }
  $archiveName = $archiveFile.Name
  $checksumPath = Join-Path $cachePath "$archiveName.CHECKSUM"
  $archiveSourceUri = "$baseUrl/$archiveName"
  $requestedChecksumUri = "$archiveSourceUri.CHECKSUM"
  $finalChecksumUri = $null
  $checksumRetrievedAt = $null
  $freshChecksumTransport = $false

  if ($RefreshSelectedChecksums) {
    [void](Assert-BinanceDataVisionUri ([uri]$requestedChecksumUri))
    if (Test-Path -LiteralPath $checksumPath) {
      $existingChecksum = Get-Item -LiteralPath $checksumPath -Force
      if ((($existingChecksum.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
          (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf))) {
        Add-QuarantineCandidate $existingChecksum 'UNSAFE_CHECKSUM_REPLACEMENT_TARGET' $true
        $verificationRecords.Add([ordered]@{
          date = $dateText
          valid = $false
          freshChecksumTransport = $false
          reason = 'UNSAFE_CHECKSUM_REPLACEMENT_TARGET'
        })
        continue
      }
    }
    $temporaryChecksum = "$checksumPath.download-$([guid]::NewGuid().ToString('N'))"
    try {
      $downloaded = $false
      for ($attempt = 1; $attempt -le 3 -and -not $downloaded; $attempt += 1) {
        try {
          $response = Invoke-WebRequest `
            -Uri $requestedChecksumUri `
            -UseBasicParsing `
            -MaximumRedirection 5 `
            -TimeoutSec 60
          $finalUri = Get-WebResponseFinalUri $response
          [void](Assert-BinanceDataVisionUri $finalUri)
          if ($finalUri.AbsoluteUri -ne ([uri]$requestedChecksumUri).AbsoluteUri) {
            throw "Binance checksum redirects must preserve the exact canonical URI: $requestedChecksumUri"
          }
          $finalChecksumUri = $finalUri.AbsoluteUri
          $contentProperty = $response.PSObject.Properties['Content']
          if (($null -eq $contentProperty) -or ($null -eq $contentProperty.Value)) {
            throw 'The public Binance checksum response did not contain a body.'
          }
          if ($contentProperty.Value -is [byte[]]) {
            [System.IO.File]::WriteAllBytes($temporaryChecksum, $contentProperty.Value)
          } else {
            [System.IO.File]::WriteAllText(
              $temporaryChecksum,
              [string]$contentProperty.Value,
              [System.Text.UTF8Encoding]::new($false)
            )
          }
          $downloaded = $true
        } catch {
          if ($attempt -eq 3) { throw }
          Start-Sleep -Seconds ([int][math]::Pow(2, $attempt - 1))
        }
      }

      $downloadedItem = Get-Item -LiteralPath $temporaryChecksum -Force
      if (($downloadedItem.Length -lt 1) -or ($downloadedItem.Length -gt 1024)) {
        throw "Fresh Binance checksum has an invalid byte length: $requestedChecksumUri"
      }
      $downloadedBytes = [System.IO.File]::ReadAllBytes($temporaryChecksum)
      if (@($downloadedBytes | Where-Object { ($_ -lt 32) -and ($_ -notin @(10, 13)) }).Count -gt 0) {
        throw "Fresh Binance checksum contains a control character: $requestedChecksumUri"
      }
      try {
        $decoder = [System.Text.UTF8Encoding]::new($false, $true)
        $downloadedText = $decoder.GetString($downloadedBytes)
      } catch {
        throw "Fresh Binance checksum must be valid UTF-8: $requestedChecksumUri"
      }
      if ($downloadedText -match '(\r?\n){2,}$') {
        throw "Fresh Binance checksum contains trailing payload: $requestedChecksumUri"
      }
      $downloadedText = $downloadedText.TrimEnd([char[]]@(13, 10))
      if (($downloadedText -match '[\r\n]') -or
          ($downloadedText -notmatch '^([a-fA-F0-9]{64}) +\*?([A-Za-z0-9._-]+)$')) {
        throw "Fresh Binance checksum has an unexpected format: $requestedChecksumUri"
      }
      $freshExpectedHash = $Matches[1].ToLowerInvariant()
      if ($Matches[2].Trim() -ne $archiveName) {
        throw "Fresh Binance checksum does not bind the expected archive: $archiveName"
      }
      $freshObservedHash = (
        Get-FileHash -LiteralPath $archiveFile.FullName -Algorithm SHA256
      ).Hash.ToLowerInvariant()
      if ($freshObservedHash -ne $freshExpectedHash) {
        throw "Fresh Binance checksum does not match cached archive: $archiveName"
      }

      if (Test-Path -LiteralPath $checksumPath -PathType Leaf) {
        [System.IO.File]::Replace($temporaryChecksum, $checksumPath, $null, $true)
      } else {
        [System.IO.File]::Move($temporaryChecksum, $checksumPath)
      }
      $checksumRetrievedAt = [datetime]::UtcNow.ToString('o')
      $freshChecksumTransport = $true
    } finally {
      if (Test-Path -LiteralPath $temporaryChecksum) {
        Remove-Item -LiteralPath $temporaryChecksum -Force
      }
    }
    $refreshedChecksums.Add($dateText)
    if (($refreshedChecksums.Count % 25) -eq 0) {
      Write-Host "Refreshed $($refreshedChecksums.Count) checksum sidecars for the selected window..."
    }
  } elseif (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
      $missingChecksums.Add($dateText)
      continue
  }

  if ($VerifyChecksums -or $RefreshSelectedChecksums) {
    $checksumFile = Get-Item -LiteralPath $checksumPath -Force
    if ((($checksumFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
        ($checksumFile.Length -lt 1) -or
        ($checksumFile.Length -gt 1024)) {
      Add-QuarantineCandidate $checksumFile 'INVALID_CHECKSUM_FORMAT' $true
      $verificationRecords.Add([ordered]@{ date = $dateText; valid = $false; reason = 'INVALID_CHECKSUM_FORMAT' })
      continue
    }
    $checksumBytes = [System.IO.File]::ReadAllBytes($checksumPath)
    if (@($checksumBytes | Where-Object { ($_ -lt 32) -and ($_ -notin @(10, 13)) }).Count -gt 0) {
      Add-QuarantineCandidate $checksumFile 'INVALID_CHECKSUM_FORMAT' $true
      $verificationRecords.Add([ordered]@{ date = $dateText; valid = $false; reason = 'INVALID_CHECKSUM_FORMAT' })
      continue
    }
    try {
      $decoder = [System.Text.UTF8Encoding]::new($false, $true)
      $checksumText = $decoder.GetString($checksumBytes)
    } catch {
      Add-QuarantineCandidate $checksumFile 'INVALID_CHECKSUM_ENCODING' $true
      $verificationRecords.Add([ordered]@{ date = $dateText; valid = $false; reason = 'INVALID_CHECKSUM_ENCODING' })
      continue
    }
    if ($checksumText -match '(\r?\n){2,}$') {
      Add-QuarantineCandidate $checksumFile 'INVALID_CHECKSUM_FORMAT' $true
      $verificationRecords.Add([ordered]@{ date = $dateText; valid = $false; reason = 'INVALID_CHECKSUM_FORMAT' })
      continue
    }
    $checksumText = $checksumText.TrimEnd([char[]]@(13, 10))
    if (($checksumText -match '[\r\n]') -or
        ($checksumText -notmatch '^([a-fA-F0-9]{64}) +\*?([A-Za-z0-9._-]+)$')) {
      Add-QuarantineCandidate $checksumFile 'INVALID_CHECKSUM_FORMAT' $true
      $verificationRecords.Add([ordered]@{ date = $dateText; valid = $false; reason = 'INVALID_CHECKSUM_FORMAT' })
      continue
    }
    $expectedHash = $Matches[1].ToLowerInvariant()
    if ($Matches[2].Trim() -ne $archiveName) {
      Add-QuarantineCandidate $checksumFile 'CHECKSUM_FILENAME_MISMATCH' $true
      $verificationRecords.Add([ordered]@{ date = $dateText; valid = $false; reason = 'CHECKSUM_FILENAME_MISMATCH' })
      continue
    }
    $observedHash = (Get-FileHash -LiteralPath $archiveFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($observedHash -ne $expectedHash) {
      Add-QuarantineCandidate $archiveFile 'ARCHIVE_SHA256_MISMATCH' $true
      Add-QuarantineCandidate $checksumFile 'PAIRED_WITH_INVALID_ARCHIVE' $true
      $verificationRecords.Add([ordered]@{
        date = $dateText
        valid = $false
        reason = 'ARCHIVE_SHA256_MISMATCH'
        expectedSha256 = $expectedHash
        observedSha256 = $observedHash
      })
      continue
    }
    $verificationRecords.Add([ordered]@{
      date = $dateText
      valid = $true
      archiveSourceUri = if ($freshChecksumTransport) { $archiveSourceUri } else { $null }
      requestedChecksumUri = if ($freshChecksumTransport) { $requestedChecksumUri } else { $null }
      finalChecksumUri = $finalChecksumUri
      checksumRetrievedAt = $checksumRetrievedAt
      freshChecksumTransport = $freshChecksumTransport
      expectedSha256 = $expectedHash
      archive = Get-Sha256Record $archiveFile.FullName
      checksum = Get-Sha256Record $checksumPath
    })
  }
}

$quarantineActions = [System.Collections.Generic.List[object]]::new()
$quarantineRoot = $null
if ($IncludeUnselectedQuarantineCandidates -and -not $ApplyQuarantine) {
  throw 'IncludeUnselectedQuarantineCandidates requires ApplyQuarantine.'
}
$approvedQuarantineCandidates = @($quarantineCandidates.Values | Where-Object {
  $IncludeUnselectedQuarantineCandidates -or [bool]$_.blocksSelectedWindow
})
if ($ApplyQuarantine -and $approvedQuarantineCandidates.Count -gt 0) {
  $stamp = [datetime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $quarantineRoot = Assert-PathWithinTrainingRoot `
    (Join-Path $trainingPath "quarantine\archive-cache\$stamp-$suffix") `
    $trainingPath
  New-Item -ItemType Directory -Path $quarantineRoot | Out-Null
  $index = 0
  foreach ($candidate in @($approvedQuarantineCandidates | Sort-Object source)) {
    $index += 1
    $sourcePath = [string]$candidate.source
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
    $destinationName = '{0:D4}-{1}' -f $index, ([System.IO.Path]::GetFileName($sourcePath))
    $destinationPath = Join-Path $quarantineRoot $destinationName
    Move-Item -LiteralPath $sourcePath -Destination $destinationPath
    $quarantineActions.Add([ordered]@{
      source = $sourcePath
      destination = $destinationPath
      reason = $candidate.reason
    })
  }
}

$selectedBlockingCandidates = @($quarantineCandidates.Values | Where-Object blocksSelectedWindow)
$selectedBlockingIssueCount =
  $missingArchives.Count + $missingChecksums.Count + $selectedBlockingCandidates.Count
$freshVerificationCount = @($verificationRecords | Where-Object {
  $_.valid -and $_.freshChecksumTransport
}).Count
$freshTransportComplete = (
  $RefreshSelectedChecksums -and
  ($requestedDates.Count -gt 0) -and
  ($freshVerificationCount -eq $requestedDates.Count) -and
  ($selectedBlockingIssueCount -eq 0)
)
$finalFiles = @(Get-ChildItem -LiteralPath $cachePath -Force -File)
$archiveBytes = [long]0
foreach ($archive in @($archivesByDate.Values)) { $archiveBytes += [long]$archive.Length }
$evidence = [ordered]@{
  schemaVersion = 3
  completionState = if ($RefreshSelectedChecksums -and -not $freshTransportComplete) {
    'INCOMPLETE'
  } else {
    'COMPLETE'
  }
  inspectedAt = [datetime]::UtcNow.ToString('o')
  provenanceMode = if ($RefreshSelectedChecksums) {
    'FRESH_BINANCE_HTTPS_CHECKSUMS'
  } else {
    'OFFLINE_LOCAL_INVENTORY_ONLY'
  }
  freshOfficialTransportEvidence = $freshTransportComplete
  archiveCache = $cachePath
  inventory = [ordered]@{
    fileCountBeforeActions = $allFiles.Count
    fileCountAfterActions = $finalFiles.Count
    recognizedArchiveCount = $archivesByDate.Count
    recognizedArchiveBytes = $archiveBytes
    recognizedChecksumCountBeforeFetch = $checksumsByDate.Count
    archiveWithoutChecksumCountBeforeFetch = $allArchiveDatesWithoutChecksums.Count
    archiveDatesWithoutChecksumsBeforeFetch = $allArchiveDatesWithoutChecksums
    nestedDirectoryCount = $nestedEntries.Count
    structuralIssues = @($structuralIssues)
    orphanChecksums = $orphanChecksums
  }
  selectedWindow = if ($null -ne $dateRange) {
    [ordered]@{ startInclusive = $Start; endExclusive = $End; dayCount = $requestedDates.Count }
  } else { $null }
  missingArchives = @($missingArchives)
  missingChecksums = @($missingChecksums)
  refreshedChecksums = @($refreshedChecksums)
  verification = @($verificationRecords)
  selectedBlockingIssueCount = $selectedBlockingIssueCount
  quarantine = [ordered]@{
    applyRequested = [bool]$ApplyQuarantine
    includeUnselectedCandidates = [bool]$IncludeUnselectedQuarantineCandidates
    candidateCount = $quarantineCandidates.Count
    approvedCandidateCount = $approvedQuarantineCandidates.Count
    candidates = @($quarantineCandidates.Values | Sort-Object source)
    destination = $quarantineRoot
    actions = @($quarantineActions)
    deletionPerformed = $false
  }
}

Write-JsonEvidenceAtomic -Path $evidencePath -Value $evidence -Depth 14

Write-Host "Cache inventory evidence: $evidencePath"
Write-Host "Archives: $($archivesByDate.Count); bytes: $archiveBytes; quarantine candidates: $($quarantineCandidates.Count)"
if (-not $ApplyQuarantine -and $quarantineCandidates.Count -gt 0) {
  Write-Warning 'Preview only: no file was moved. Review evidence, then use -ApplyQuarantine explicitly if appropriate.'
}
if ($ApplyQuarantine) {
  Write-Host "Quarantined files: $($quarantineActions.Count); deleted files: 0"
}
