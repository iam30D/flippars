[CmdletBinding()]
param(
  [string]$TrainingRoot = (Join-Path $env:USERPROFILE "Flippars-ml"),
  [ValidatePattern("^(auto|3\.\d+)$")]
  [string]$PythonVersion = "auto"
)

$ErrorActionPreference = "Stop"
$env:PYTHON_BASIC_REPL = "1"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$selectedPythonVersion = $PythonVersion
$pythonCommand = "py"
Write-Host "Detecting an installed Python runtime..."
if ($PythonVersion -eq "auto") {
  foreach ($candidate in @("3.11", "3.12", "3.13", "3.14")) {
    try {
      & py "-$candidate" "--version" 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $selectedPythonVersion = $candidate
        break
      }
    } catch {
      continue
    }
  }
  if ($selectedPythonVersion -eq "auto") {
    try {
      $directVersion = & python "--version" 2>$null
      if ($LASTEXITCODE -eq 0 -and $directVersion -match "Python\s+(3\.\d+)") {
        $selectedPythonVersion = $Matches[1]
        $pythonCommand = "python"
      }
    } catch {
      # The final error below explains how to install Python.
    }
  }
}

if ($selectedPythonVersion -eq "auto") {
  throw "No supported Python 3.x runtime was found. Install Python 3.11 or newer, then run this script again."
}

if ($pythonCommand -eq "py") {
  & py "-$selectedPythonVersion" "--version" | Out-Host
} else {
  & python "--version" | Out-Host
}
if ($LASTEXITCODE -ne 0) {
  throw "Python $selectedPythonVersion was not found. Install it with the Python Launcher, then run this script again."
}
if ($selectedPythonVersion -ne "3.11") {
  Write-Warning "Python $selectedPythonVersion selected. Python 3.11 remains the preferred baseline when available."
}

$venvPath = Join-Path $TrainingRoot ".venv"
$pythonPath = Join-Path $venvPath "Scripts\python.exe"
$requirementsPath = Join-Path $repositoryRoot "apps\model-training\requirements.txt"
$trainingPackagePath = Join-Path $repositoryRoot "apps\model-training"

New-Item -ItemType Directory -Force -Path $TrainingRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TrainingRoot "data\raw\archives") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TrainingRoot "data\raw\normalized") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TrainingRoot "data\processed") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TrainingRoot "artifacts\draft") | Out-Null

if (-not (Test-Path -LiteralPath $pythonPath)) {
  Write-Host "Creating Python virtual environment..."
  if ($pythonCommand -eq "py") {
    & py "-$selectedPythonVersion" "-m" "venv" $venvPath
  } else {
    & python "-m" "venv" $venvPath
  }
  if ($LASTEXITCODE -ne 0) { throw "Python virtual environment creation failed." }
}

Write-Host "Installing model-training dependencies..."
& $pythonPath -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }

& $pythonPath -m pip install -r $requirementsPath
if ($LASTEXITCODE -ne 0) { throw "Model-training dependency installation failed." }

& $pythonPath -m pip install --editable $trainingPackagePath
if ($LASTEXITCODE -ne 0) { throw "Flippars model-training package installation failed." }

$lockPath = Join-Path $TrainingRoot "requirements.lock.txt"
& $pythonPath -m pip freeze | Out-File -FilePath $lockPath -Encoding utf8

Write-Host "Model-training environment is ready: $TrainingRoot"
Write-Host "Selected Python version: $selectedPythonVersion"
Write-Host "Python executable: $pythonPath"
Write-Host "Run '$pythonPath -m flippars_model_training --help' for the collector and training commands."
