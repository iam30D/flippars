# Kubernetes baseline

The manifests deploy the stateless API against managed PostgreSQL and external
provider/APNs endpoints. Create `flippars-api-secrets` through the platform
secret manager; do not commit a Secret manifest.

Required secret keys are documented in `apps/api/.env.example`. Replace the
image reference with a digest-pinned release, run migrations as a controlled
job, and keep `SIGNALS_ENABLED=false` until shadow and approval gates pass.

Validate with:

```sh
kubectl kustomize deploy/k8s/base
```
