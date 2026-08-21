Set-StrictMode -Version Latest

function ConvertTo-WindowsNativeArgument {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [AllowEmptyString()]
    [string]$Value
  )

  if (($Value.Length -gt 0) -and ($Value -notmatch '[\s"]')) {
    return $Value
  }

  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashCount = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashCount += 1
      continue
    }
    if ($character -eq '"') {
      if ($backslashCount -gt 0) {
        [void]$builder.Append(('\' * ($backslashCount * 2)))
      }
      [void]$builder.Append('\"')
      $backslashCount = 0
      continue
    }
    if ($backslashCount -gt 0) {
      [void]$builder.Append(('\' * $backslashCount))
      $backslashCount = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashCount -gt 0) {
    [void]$builder.Append(('\' * ($backslashCount * 2)))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Invoke-LoggedNativeProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$FilePath,
    [Parameter(Mandatory)]
    [AllowEmptyCollection()]
    [AllowEmptyString()]
    [string[]]$ArgumentList,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$LogPath,
    [ValidateNotNullOrEmpty()][string]$WorkingDirectory = (Get-Location).Path,
    [switch]$Append
  )

  $workingPath = [System.IO.Path]::GetFullPath($WorkingDirectory)
  if (-not [System.IO.Directory]::Exists($workingPath)) {
    throw "Native process working directory does not exist: $workingPath"
  }
  $fullLogPath = [System.IO.Path]::GetFullPath($LogPath)
  $logParent = [System.IO.Path]::GetDirectoryName($fullLogPath)
  if ([string]::IsNullOrWhiteSpace($logParent) -or
      -not [System.IO.Directory]::Exists($logParent)) {
    throw "Native process log parent does not exist: $logParent"
  }

  $encodedArguments = @(
    foreach ($argument in $ArgumentList) {
      ConvertTo-WindowsNativeArgument -Value $argument
    }
  )
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = [string]::Join(' ', [string[]]$encodedArguments)
  $startInfo.WorkingDirectory = $workingPath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $startInfo.StandardOutputEncoding = $utf8
  $startInfo.StandardErrorEncoding = $utf8

  $fileMode = if ($Append) {
    [System.IO.FileMode]::Append
  } else {
    [System.IO.FileMode]::CreateNew
  }
  $logStream = $null
  $writer = $null
  $process = $null
  $processStarted = $false
  try {
    $logStream = [System.IO.File]::Open(
      $fullLogPath,
      $fileMode,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::Read
    )
    $writer = [System.IO.StreamWriter]::new($logStream, $utf8, 4096, $true)
    $writer.AutoFlush = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
      throw "Unable to start native process: $FilePath"
    }
    $processStarted = $true

    $stdoutOpen = $true
    $stderrOpen = $true
    $stdoutTask = $process.StandardOutput.ReadLineAsync()
    $stderrTask = $process.StandardError.ReadLineAsync()
    while ($stdoutOpen -or $stderrOpen) {
      $advanced = $false
      if ($stdoutOpen -and $stdoutTask.IsCompleted) {
        $line = $stdoutTask.GetAwaiter().GetResult()
        if ($null -eq $line) {
          $stdoutOpen = $false
        } else {
          $writer.WriteLine($line)
          try { [Console]::Out.WriteLine($line) } catch { }
          $stdoutTask = $process.StandardOutput.ReadLineAsync()
        }
        $advanced = $true
      }
      if ($stderrOpen -and $stderrTask.IsCompleted) {
        $line = $stderrTask.GetAwaiter().GetResult()
        if ($null -eq $line) {
          $stderrOpen = $false
        } else {
          $writer.WriteLine($line)
          try { [Console]::Error.WriteLine($line) } catch { }
          $stderrTask = $process.StandardError.ReadLineAsync()
        }
        $advanced = $true
      }
      if (-not $advanced) {
        [System.Threading.Thread]::Sleep(10)
      }
    }

    $process.WaitForExit()
    $exitCode = [int]$process.ExitCode
    if ($exitCode -ne 0) {
      $footer = '[flippars-native-exit] exitCode={0}' -f `
        $exitCode.ToString([System.Globalization.CultureInfo]::InvariantCulture)
      $writer.WriteLine($footer)
      try { [Console]::Error.WriteLine($footer) } catch { }
    }
    $writer.Flush()
    $logStream.Flush($true)
    return $exitCode
  } finally {
    if ($processStarted) {
      $shouldStop = $false
      try { $shouldStop = -not $process.HasExited } catch { }
      if ($shouldStop) {
        try { $process.Kill() } catch { }
        try { $process.WaitForExit() } catch { }
      }
    }
    if ($null -ne $writer) { try { $writer.Dispose() } catch { } }
    if ($null -ne $logStream) { try { $logStream.Dispose() } catch { } }
    if ($null -ne $process) { try { $process.Dispose() } catch { } }
  }
}

function ConvertTo-NormalizedFullPath {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
  $trimmedPath = $fullPath.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  $trimmedRoot = $pathRoot.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )

  if ($trimmedPath.Equals($trimmedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $pathRoot
  }
  return $trimmedPath
}

function Test-PathWithin {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][string]$Parent
  )

  $candidatePath = ConvertTo-NormalizedFullPath $Candidate
  $parentPath = ConvertTo-NormalizedFullPath $Parent
  if ($candidatePath.Equals($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }

  $prefix = $parentPath
  if (-not $prefix.EndsWith([System.IO.Path]::DirectorySeparatorChar.ToString())) {
    $prefix += [System.IO.Path]::DirectorySeparatorChar
  }
  return $candidatePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePointAncestor {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)

  $currentPath = ConvertTo-NormalizedFullPath $Path
  while ($null -ne $currentPath) {
    if (Test-Path -LiteralPath $currentPath) {
      $item = Get-Item -LiteralPath $currentPath -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Training paths cannot traverse a symbolic link or reparse point: $currentPath"
      }
    }

    $parent = [System.IO.Directory]::GetParent($currentPath)
    if ($null -eq $parent) {
      $currentPath = $null
    } else {
      $currentPath = $parent.FullName
    }
  }
}

function Assert-ExternalTrainingRoot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$TrainingRoot,
    [Parameter(Mandatory)][string]$RepositoryRoot
  )

  $trainingPath = ConvertTo-NormalizedFullPath $TrainingRoot
  $repositoryPath = ConvertTo-NormalizedFullPath $RepositoryRoot
  $filesystemRoot = [System.IO.Path]::GetPathRoot($trainingPath)
  if ($trainingPath.TrimEnd('\', '/').Equals(
      $filesystemRoot.TrimEnd('\', '/'),
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "TrainingRoot cannot be a filesystem root: $trainingPath"
  }

  if ($env:USERPROFILE) {
    $profilePath = ConvertTo-NormalizedFullPath $env:USERPROFILE
    if ($trainingPath.Equals($profilePath, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "TrainingRoot cannot be the user profile itself. Choose a dedicated external directory."
    }
  }

  if ((Test-PathWithin $trainingPath $repositoryPath) -or
      (Test-PathWithin $repositoryPath $trainingPath)) {
    throw "TrainingRoot must be separate from, and must not contain, the repository."
  }

  Assert-NoReparsePointAncestor $trainingPath
  return $trainingPath
}

function Assert-PathWithinTrainingRoot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$TrainingRoot
  )

  $fullPath = ConvertTo-NormalizedFullPath $Path
  if (-not (Test-PathWithin $fullPath $TrainingRoot)) {
    throw "Path must remain inside TrainingRoot: $fullPath"
  }
  Assert-NoReparsePointAncestor $fullPath
  return $fullPath
}

function Assert-SafeEnvironmentName {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$EnvironmentName)

  if ($EnvironmentName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$') {
    throw "EnvironmentName must contain 1-32 safe filename characters."
  }
  return $EnvironmentName
}

function Assert-SafeModelVersion {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Version)

  if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw "Version must contain 1-64 safe filename characters."
  }
  return $Version
}

function Get-SignalTimeframeMinutes {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [ValidateSet(
      'FIVE_MINUTE_REVERSAL',
      'FIFTEEN_MINUTE_REVERSAL',
      'FIVE_MINUTE_EARLY_DIRECTION'
    )]
    [string]$SignalType
  )

  if ($SignalType -eq 'FIFTEEN_MINUTE_REVERSAL') { return 15 }
  return 5
}

function Get-SignalArtifactSlug {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [ValidateSet(
      'FIVE_MINUTE_REVERSAL',
      'FIFTEEN_MINUTE_REVERSAL',
      'FIVE_MINUTE_EARLY_DIRECTION'
    )]
    [string]$SignalType
  )

  return $SignalType.ToLowerInvariant().Replace('_', '-')
}

function Assert-ModelTrainingDateRange {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Start,
    [Parameter(Mandatory)][string]$End
  )

  $format = 'yyyy-MM-dd'
  $culture = [System.Globalization.CultureInfo]::InvariantCulture
  $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal
  $startDate = [datetime]::MinValue
  $endDate = [datetime]::MinValue
  if (-not [datetime]::TryParseExact($Start, $format, $culture, $styles, [ref]$startDate)) {
    throw "Start must be an exact UTC calendar date in yyyy-MM-dd form."
  }
  if (-not [datetime]::TryParseExact($End, $format, $culture, $styles, [ref]$endDate)) {
    throw "End must be an exact UTC calendar date in yyyy-MM-dd form."
  }
  if ($endDate -le $startDate) {
    throw "End is exclusive and must be later than Start."
  }
  if ($endDate -gt [datetime]::UtcNow.Date) {
    throw "End is exclusive and cannot include the current or a future UTC day."
  }

  return [pscustomobject]@{ Start = $startDate; End = $endDate }
}

function Get-RepositoryStatusSnapshot {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$RepositoryRoot)

  $status = @(& git -C $RepositoryRoot status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0) { throw "Unable to inspect repository status." }
  return $status
}

function Assert-NoTrackedTrainingMaterial {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$RepositoryRoot)

  $paths = @(& git -C $RepositoryRoot ls-files --cached)
  if ($LASTEXITCODE -ne 0) { throw "Unable to inspect tracked repository paths." }
  $forbidden = @($paths | Where-Object {
    ($_ -match '(^|/)(data|artifacts|models)(/|$)') -or
    ($_ -match '(^|/)(\.venv[^/]*|__pycache__|[^/]+\.egg-info)(/|$)') -or
    (($_ -match '(^|/)\.env[^/]*$') -and ($_ -notmatch '\.example$'))
  })
  if ($forbidden.Count -gt 0) {
    throw "Forbidden training or environment material is tracked: $($forbidden -join ', ')"
  }
}

function Get-Sha256Record {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)

  $item = Get-Item -LiteralPath $Path
  if (-not $item.PSIsContainer) {
    return [pscustomobject]@{
      Path = $item.FullName
      Bytes = $item.Length
      LastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
      Sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  throw "Cannot hash a directory as a file: $Path"
}

function Get-Utf8TextSha256 {
  [CmdletBinding()]
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Text)
    $digest = $sha256.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-PythonRuntimeCompatibility {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$PythonPath)

  # Keep this probe ASCII-only and send it over stdin. Windows PowerShell can
  # strip embedded quotes when serializing native executable arguments.
  $probe = @'
import json
import platform
import sys
import sysconfig

payload = {
    "implementation": platform.python_implementation(),
    "version": platform.python_version(),
    "cacheTag": sys.implementation.cache_tag,
    "platform": sysconfig.get_platform(),
    "machine": platform.machine(),
}
print(json.dumps(payload, separators=(",", ":")))
'@
  $output = @($probe | & $PythonPath -)
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to inspect Python runtime compatibility.'
  }
  $json = $output -join [Environment]::NewLine
  try {
    $compatibility = $json | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'Python runtime compatibility output is not valid JSON.'
  }

  $expectedFields = @('implementation', 'version', 'cacheTag', 'platform', 'machine')
  $properties = @($compatibility.PSObject.Properties)
  if ($properties.Count -ne $expectedFields.Count) {
    throw 'Python runtime compatibility must contain exactly five fields.'
  }
  for ($index = 0; $index -lt $expectedFields.Count; $index += 1) {
    $property = $properties[$index]
    if ($property.Name -cne $expectedFields[$index]) {
      throw 'Python runtime compatibility fields are missing, reordered, or unexpected.'
    }
    if (($property.Value -isnot [string]) -or
        [string]::IsNullOrWhiteSpace([string]$property.Value)) {
      throw "Python runtime compatibility field '$($property.Name)' must be a nonempty string."
    }
  }
  return $compatibility
}

function Assert-BinanceDataVisionUri {
  [CmdletBinding()]
  param([Parameter(Mandatory)][uri]$Uri)

  if ((-not $Uri.IsAbsoluteUri) -or
      ($Uri.Scheme -cne 'https') -or
      (-not $Uri.DnsSafeHost.Equals(
        'data.binance.vision',
        [System.StringComparison]::OrdinalIgnoreCase
      )) -or
      (-not [string]::IsNullOrEmpty($Uri.UserInfo)) -or
      ((-not $Uri.IsDefaultPort) -and ($Uri.Port -ne 443))) {
    throw "Public Binance data URI must remain on HTTPS data.binance.vision: $Uri"
  }
  return $Uri
}

function Get-WebResponseFinalUri {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$Response)

  $baseProperty = $Response.PSObject.Properties['BaseResponse']
  if (($null -ne $baseProperty) -and ($null -ne $baseProperty.Value)) {
    $baseResponse = $baseProperty.Value
    $requestMessageProperty = $baseResponse.PSObject.Properties['RequestMessage']
    if (($null -ne $requestMessageProperty) -and ($null -ne $requestMessageProperty.Value)) {
      $requestUriProperty = $requestMessageProperty.Value.PSObject.Properties['RequestUri']
      if (($null -ne $requestUriProperty) -and ($null -ne $requestUriProperty.Value)) {
        return [uri]$requestUriProperty.Value
      }
    }
    $responseUriProperty = $baseResponse.PSObject.Properties['ResponseUri']
    if (($null -ne $responseUriProperty) -and ($null -ne $responseUriProperty.Value)) {
      return [uri]$responseUriProperty.Value
    }
  }
  $wrapperUriProperty = $Response.PSObject.Properties['ResponseUri']
  if (($null -ne $wrapperUriProperty) -and ($null -ne $wrapperUriProperty.Value)) {
    return [uri]$wrapperUriProperty.Value
  }
  throw 'Unable to determine the final URI of the public Binance response.'
}

function Write-JsonEvidenceAtomic {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)]$Value,
    [ValidateRange(2, 100)][int]$Depth = 12,
    [switch]$Overwrite
  )

  if ((Test-Path -LiteralPath $Path) -and -not $Overwrite) {
    throw "Evidence already exists and will not be overwritten: $Path"
  }
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  Assert-NoReparsePointAncestor $parent
  $temporary = Join-Path $parent ".$([System.IO.Path]::GetFileName($Path)).$([guid]::NewGuid().ToString('N')).part"
  try {
    $json = $Value | ConvertTo-Json -Depth $Depth
    [System.IO.File]::WriteAllText(
      $temporary,
      "$json$([Environment]::NewLine)",
      [System.Text.UTF8Encoding]::new($false)
    )
    $stream = [System.IO.File]::Open(
      $temporary,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    try {
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    if ((Test-Path -LiteralPath $Path) -and -not $Overwrite) {
      throw "Evidence appeared concurrently and will not be overwritten: $Path"
    }
    Move-Item -LiteralPath $temporary -Destination $Path -Force:$Overwrite
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}
