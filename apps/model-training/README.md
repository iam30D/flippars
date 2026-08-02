# Flippars market-data collector and draft training

This package is a repository-side implementation of the offline training
workflow. The Python environment, raw exchange data, and model artifacts must
remain outside Git. The collector uses Binance Data Vision's object listing and
download endpoint; it does not use trading credentials or place orders.

The setup installs model libraries, not a pre-trained Bitcoin checkpoint:

- [LightGBM official source and MIT license](https://github.com/lightgbm-org/LightGBM)
- [LightGBM Python package](https://pypi.org/project/lightgbm/)
- [XGBoost official source and Apache-2.0 license](https://github.com/dmlc/xgboost)
- [XGBoost Python package](https://pypi.org/project/xgboost/)

## Setup on Windows

From the repository root:

```powershell
.\scripts\setup-model-environment.ps1
```

The default training workspace is `C:\Users\<you>\Flippars-ml`. Use
`-TrainingRoot` to select another directory. Python 3.11 is the supported
baseline for the first release.

## Collect and train in one command

Use an explicitly permitted date range. The end date is exclusive:

```powershell
$python = "$env:USERPROFILE\Flippars-ml\.venv\Scripts\python.exe"
& $python -m flippars_model_training all `
  --symbol BTCUSDT `
  --start 2025-01-01 `
  --end 2025-02-01 `
  --raw-root "$env:USERPROFILE\Flippars-ml\data\raw" `
  --prepared-output "$env:USERPROFILE\Flippars-ml\data\processed\btc-5m.jsonl" `
  --artifact-output "$env:USERPROFILE\Flippars-ml\artifacts\draft\candidate-five-minute-2025.01.json" `
  --evaluation-output "$env:USERPROFILE\Flippars-ml\artifacts\draft\candidate-five-minute-2025.01.evaluation.json" `
  --signal-type FIVE_MINUTE_EARLY_DIRECTION `
  --version 2025.01.1 `
  --max-files 31
```

The command downloads daily ZIP files from:

`https://data.binance.vision/?prefix=data/spot/daily/trades/BTCUSDT/`

It then normalizes trades, builds five-minute candle features, trains a
three-class multinomial-logistic baseline, calibrates it, evaluates the
untouched chronological holdout, and writes a `DRAFT` artifact.

LightGBM and XGBoost are installed for challenger experiments. The current
Flippars artifact contract and runtime accept the multinomial-logistic draft;
those tree models are not silently promoted or used for production until a
versioned runtime contract is added and independently reviewed.

## Separate commands

```powershell
& $python -m flippars_model_training collect `
  --symbol BTCUSDT --start 2025-01-01 --end 2025-01-02 `
  --raw-root "$env:USERPROFILE\Flippars-ml\data\raw"

& $python -m flippars_model_training prepare `
  --normalized-root "$env:USERPROFILE\Flippars-ml\data\raw\normalized" `
  --output "$env:USERPROFILE\Flippars-ml\data\processed\btc-5m.jsonl" `
  --signal-type FIVE_MINUTE_EARLY_DIRECTION

& $python -m flippars_model_training train `
  --input "$env:USERPROFILE\Flippars-ml\data\processed\btc-5m.jsonl" `
  --output "$env:USERPROFILE\Flippars-ml\artifacts\draft\candidate.json" `
  --evaluation-output "$env:USERPROFILE\Flippars-ml\artifacts\draft\evaluation.json" `
  --signal-type FIVE_MINUTE_EARLY_DIRECTION --version 2025.01.1
```

The generated candidate is intentionally not approved, registered, or
production-ready. The first feature/label builder is a conservative baseline
using the previous completed candle to predict the next candle's close
relation. Signal-specific production semantics, live risk features, shadow
recording, independent approval, and the production runtime remain required.

Do not put raw data, provider contracts, credentials, model artifacts, or
approval keys in this repository. A model must pass the governance process in
`docs/model-governance.md` before guest notifications are enabled in
production.
