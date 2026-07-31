# Provider Outage Runbook

1. Confirm the affected venue, sequence/freshness alarms, and receive-time lag.
2. Verify the venue has been quarantined and excluded from the composite.
3. Confirm new signals are suppressed when quorum or conversion policy fails.
4. Do not manually mark stale data healthy.
5. Compare the provider's official status and an independent venue.
6. Allow the adapter to recover from a fresh snapshot and valid sequence.
7. Review signals around the incident; append `VOID` only when truth integrity
   was actually compromised.
8. Record timeline, impact, evidence, and follow-up action.
