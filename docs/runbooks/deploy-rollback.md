# API Deployment and Rollback Runbook

## Preconditions

1. Keep `SIGNALS_ENABLED=false` unless every model gate is approved and a
   durable cross-pod signal/outcome fanout (or reviewed single-writer design) is
   operating. The current WebSocket hub is process-local.
2. Build, scan, and publish one immutable API image. Pin its digest in the API
   Deployment, retention CronJob, and release-specific migration Job.
3. Confirm the managed PostgreSQL backup is current and the release migration is
   backwards compatible with both the old and new application versions.
4. Render the manifests and inspect them before changing the cluster:

   ```sh
   kubectl kustomize deploy/k8s/base
   ```

## Deploy

1. Provision the namespace, reviewed provider overlay/ConfigMap, operations
   NetworkPolicy, and `flippars-api-secrets` through the release pipeline. Never
   commit a Secret manifest. These prerequisites must exist before the first
   migration Job.
2. Render `deploy/k8s/jobs/migrate.yaml` with the release image digest. The Job
   uses `generateName` and is not part of the base Kustomization.
3. Create the rendered migration Job exactly once and wait for completion. Stop
   the release if it fails; inspect its logs before retrying with a new Job.
4. Apply the digest-pinned base/overlay and wait for the Deployment rollout.
5. Check `/health/live`, `/health/ready`, and the readiness response's database,
   market, and safety fields. Public readiness intentionally survives loss of
   market quorum; market degradation must page separately and must suppress
   signals.
6. Verify provider connections, database errors, WebSocket reconnects, and the
   absence of new signals while emission is disabled.
7. Validate one manual retention Job before unsuspending the scheduled CronJob.

## Roll back

1. Disable signal emission first if it was enabled and preserve audit evidence.
2. Roll the Deployment back to the last known-good image digest only when that
   version is compatible with the migrated schema.
3. Do not run a down migration. Released migrations are append-only; use an
   approved forward fix. Restore the database only for a declared data-loss or
   corruption incident with the database owner and incident commander.
4. Recheck liveness, readiness details, market abstention, guest reads, and
   WebSocket recovery. Keep signals disabled until the incident review approves
   re-enablement.
5. Record image digests, migration Job name, timestamps, symptoms, decision
   owner, and follow-up work.
