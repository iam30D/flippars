# Kubernetes baseline

The manifests deploy the stateless API against managed PostgreSQL and external
provider/APNs endpoints. Create `flippars-api-secrets` through the platform
secret manager; do not commit a Secret manifest.

Required secret keys are documented in `apps/api/.env.example`. Replace the
image reference with a digest-pinned release, run migrations as a controlled
job, and keep `SIGNALS_ENABLED=false` until shadow and approval gates pass.

The public API readiness baseline deliberately does not depend on market quorum.
`/health/ready` therefore keeps public reads available during a provider outage,
while its response still reports market health and the signal worker continues
to abstain on unhealthy data. Alert on market health separately.

`DATABASE_SSL`, the optional database CA certificate, and `TRUST_PROXY` are
provider-specific trust-boundary choices and are intentionally absent from the
portable ConfigMap. Set them in a reviewed overlay/secret after confirming the
managed database certificate chain and the exact ingress proxy path.

`base/retention-cronjob.yaml` is included but suspended. Validate one manual run
and the approved retention policy before enabling it. See
`docs/runbooks/retention.md`.

The migration Job is intentionally outside the base Kustomization so an ordinary
`kubectl apply -k deploy/k8s/base` cannot rerun migrations. For each release,
render `jobs/migrate.yaml` with the exact digest used by the Deployment, then use
`kubectl create -f <rendered-migration-job>` and wait for that generated Job to
complete. On the first release, provision the namespace, reviewed ConfigMap,
operations NetworkPolicy, and Secret before creating the Job. Do not apply the
checked-in `replace-me` image.

Validate with:

```sh
kubectl kustomize deploy/k8s/base
```

Deployment and rollback sequencing is in
`docs/runbooks/deploy-rollback.md`. Production signals require a durable
cross-pod signal/outcome fanout or an explicitly approved single-writer design;
the current in-process WebSocket hub is not a multi-replica event bus.
