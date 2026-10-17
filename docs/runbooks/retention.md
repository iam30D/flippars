# Operational Retention Runbook

## Scope and safety

The retention command deletes only expired rows from `market_observations` and
`notification_deliveries`. It compares `retain_until` with the command start
time, deletes in small locked batches, and enforces a hard per-table bound.

It never deletes `signals`, `signal_outcomes`, `model_registry`, `audit_events`,
guest devices, or preferences. Do not broaden this scope without an approved
privacy, model-risk, and migration review.

## Validate and run

1. Confirm the approved retention periods and a current database backup.
2. Test the command against a production-like non-production database:

   ```sh
   npm run retention --workspace @flippars/api -- --batch-size=1000 --max-rows-per-table=100000
   ```

3. In Kubernetes, keep `flippars-retention` suspended initially. Create one
   manual Job from the CronJob, watch it to completion, and inspect its single
   JSON result line:

   ```sh
   kubectl create job --namespace flippars --from=cronjob/flippars-retention flippars-retention-manual
   kubectl logs --namespace flippars job/flippars-retention-manual
   ```

4. Verify the oldest remaining operational rows and application/database health.
   A `capped: true` result means the safety bound was reached and expired backlog
   may remain. Prefer another bounded run or a more frequent schedule instead of
   an unbounded delete.
5. After validation, unsuspend the hourly CronJob through the reviewed production
   overlay and alert on failed Jobs or repeatedly capped results.

## Failure handling

- The CronJob forbids concurrent scheduled runs; SQL also uses `SKIP LOCKED` so
  an accidental overlapping manual run does not wait on the same rows.
- A failed batch is atomic. Fix connectivity or permissions, then start another
  bounded run.
- Deletion is not reversible through the application. If protected rows were
  affected by an unauthorized manual operation, stop retention, preserve logs,
  and follow the database restore and security incident procedures.
- Monitor table and index growth and PostgreSQL autovacuum after clearing a large
  backlog; do not run blocking maintenance during peak traffic without approval.
