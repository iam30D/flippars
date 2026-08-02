[CmdletBinding()]
param(
  [string]$TrainingRoot = (Join-Path $env:USERPROFILE "Flippars-ml"),
  [ValidatePattern("^3\\.\\d+$")]
  [string]$PythonVersion = "3.11"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pythonLauncherArguments = @("-$PythonVersion")

& py @pythonLauncherArguments --version | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "Python $PythonVersion was not found. Install Python $PythonVersion with the Python Launcher, then run this script again."
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
  & py @pythonLauncherArguments -m venv $venvPath
  if ($LASTEXITCODE -ne 0) { throw "Python virtual environment creation failed." }
}

& $pythonPath -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }

& $pythonPath -m pip install -r $requirementsPath
if ($LASTEXITCODE -ne 0) { throw "Model-training dependency installation failed." }

& $pythonPath -m pip install --editable $trainingPackagePath
if ($LASTEXITCODE -ne 0) { throw "Flippars model-training package installation failed." }

$lockPath = Join-Path $TrainingRoot "requirements.lock.txt"
& $pythonPath -m pip freeze | Out-File -FilePath $lockPath -Encoding utf8

Write-Host "Model-training environment is ready: $TrainingRoot"
Write-Host "Python executable: $pythonPath"
Write-Host "Run '$pythonPath -m flippars_model_training --help' for the collector and training commands."
