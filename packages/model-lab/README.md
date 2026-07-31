# `@flippars/model-lab`

This package turns point-in-time JSONL feature rows into a reproducible,
calibrated **draft challenger**. It deliberately cannot approve, register, or
deploy the artifact it creates.

Safeguards:

- chronologically ordered train, calibration, and untouched holdout partitions;
- overlapping label windows purged at partition boundaries;
- unhealthy and high-anomaly rows excluded by declared policy;
- fixed feature schema and train-only normalization;
- Platt calibration fitted outside the training partition;
- Brier, log-loss, calibration, precision, and coverage metrics;
- canonical dataset SHA-256 and immutable draft metadata.

Example:

```powershell
npm run train --workspace @flippars/model-lab -- `
  --input .\data\five-minute-reversal.jsonl `
  --output .\artifacts\candidate-2026-07.json `
  --signal-type FIVE_MINUTE_REVERSAL `
  --version 2026.07.1
```

The output remains `DRAFT` with null approval fields. Promotion requires the
independent review, prospective shadow period, signing, registry approval, and
canary controls in `docs/model-governance.md`.
