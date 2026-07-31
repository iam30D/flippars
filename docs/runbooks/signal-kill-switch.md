# Signal Kill-Switch Runbook

Use the kill switch for integrity, model, legal, security, or notification
incidents.

1. Set the deployment's signal-emission switch to disabled.
2. Confirm readiness remains available while new signals stop.
3. Stop APNs retries for expired or withdrawn release cohorts.
4. Preserve observations, decisions, abstentions, and audit logs.
5. Diagnose without editing existing signal records.
6. Validate the fix in simulation and shadow mode.
7. Require the designated model/product/security approvals before re-enabling.
8. Canary the restored target and monitor its declared gates.
