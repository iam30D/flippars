# Beginner guide: production setup for the guest-first release

This is the start-to-finish owner checklist for release 1. Every available app
screen remains accessible after the short disclosure onboarding. There is no
login, account, subscription, entitlement, or paywall.

## Read this first: what “full guest access” means

The production guest release can provide:

- live public BTC/USD market state and data-health information;
- public signal history already stored by the service;
- dashboard, history, detail, settings, offline recovery, and guest reset;
- optional notifications after the guest explicitly opts in.

It cannot honestly create new public predictions yet. No approved production
model or complete production feature pipeline is bundled. The API now rejects
`SIGNALS_ENABLED=true` while its model provider is `disabled`. This is a safety
gate, not a guest-access restriction.

## The few things only the owner can supply

Prepare these before continuing:

1. A production cloud account and a managed PostgreSQL 17 database.
2. A domain such as `api.yourdomain.com` and an HTTPS/TLS load balancer or
   ingress that supports WebSockets.
3. An Expo account and the EAS Project ID.
4. An Apple Developer membership and App Store Connect app.
5. Ownership of the final bundle ID. The current value is
   `com.flippars.mobile`; change it before the first signed build if you do not
   own it.
6. A public privacy-policy URL, support URL, legal entity/contact information,
   launch countries, and legal/provider-licensing approval.
7. Later, licensed model data and an independent model approver. Do not treat
   yourself, this codebase, or an automated command as independent approval.

Everything named secret below belongs in your cloud/Expo/Apple secret manager,
never in Git, screenshots, issue comments, or chat.

## Part 1: verify the release locally

From the repository root in PowerShell:

```powershell
node -v
npm ci
npm run verify
npm audit --omit=dev --audit-level=high
```

Expected result: Node reports the 20.x line (at least 20.19), verification
passes, and the production dependency audit has no High/Critical finding.

For an iPhone development client, follow
[development-build.md](development-build.md) before continuing.

## Part 2: create the production API configuration

### 2.1 Make a temporary local validation file

This file is ignored by Git. It is only a worksheet; do not upload it with the
application image.

```powershell
Copy-Item apps/api/.env.production.example apps/api/.env.production.local
notepad apps/api/.env.production.local
```

Replace every uppercase placeholder. Leave `SIGNALS_ENABLED=false`,
`MODEL_PROVIDER=disabled`, and initially leave `APNS_ENABLED=false`.

### 2.2 Generate the device-token encryption key

Run this once in PowerShell:

```powershell
$flipparsKeyBytes = New-Object byte[] 32
$flipparsRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$flipparsRng.GetBytes($flipparsKeyBytes)
$flipparsDeviceKey = [Convert]::ToBase64String($flipparsKeyBytes)
$flipparsRng.Dispose()
$flipparsDeviceKey
```

Copy the printed value into your secret manager as
`DEVICE_TOKEN_ENCRYPTION_KEY`. Keep it stable across replicas, restarts, and
deployments. Rotating it without a planned re-encryption migration makes stored
push tokens unreadable. Clear the PowerShell value after storing it:

```powershell
Remove-Variable flipparsDeviceKey,flipparsKeyBytes -ErrorAction SilentlyContinue
```

### 2.3 Set the database values

- `DATABASE_URL`: the managed database connection string; it is a secret.
- `DATABASE_SSL=true`: recommended for a managed production database.
- `DATABASE_CA_CERT`: leave blank when the provider uses a publicly trusted CA.
  If the provider gives you a private CA PEM, store it as a secret and supply
  its content with newline characters escaped as `\n`.

Enable encryption at rest, automated backups/point-in-time recovery, and a
restore drill in the database provider dashboard. Use separate migration and
runtime database roles when your provider supports them.

### 2.4 Validate without printing secrets

```powershell
npm run env:check:production --workspace @flippars/api -- .env.production.local
```

Expected result:

```text
Production API environment is valid. No secrets were printed.
```

Transfer the values to your cloud secret manager/runtime configuration. Do not
copy `.env.production.local` into the container or commit it.

## Part 3: build and publish the API image

Sign in to the container registry selected for your cloud, then build from the
repository root. Replace the example registry owner:

```powershell
$flipparsRelease = git rev-parse --short HEAD
docker build -f apps/api/Dockerfile -t ghcr.io/YOUR_GITHUB_NAME/flippars-api:$flipparsRelease .
docker push ghcr.io/YOUR_GITHUB_NAME/flippars-api:$flipparsRelease
```

Scan the image, produce/store an SBOM, and use the immutable registry digest
(`...@sha256:...`) for deployment—not `latest` and not only a mutable tag.

The repository's Kubernetes files are a portable baseline, not a complete
cloud account. A provider-specific production overlay still needs the image
digest, ingress/load balancer, DNS, TLS certificate, secret-manager integration,
and monitoring integration.

## Part 4: deploy the API safely

### 4.1 Prepare the Kubernetes values

1. Replace `ghcr.io/iam30d/flippars-api:replace-me` with the same immutable image
   digest in the Deployment, retention CronJob, and a rendered copy of the
   migration Job.
2. Create `flippars-api-secrets` in namespace `flippars` through the platform's
   secret manager. Do not create or commit a Secret YAML file.
3. Keep these first-release values:

   ```text
   NODE_ENV=production
   MARKET_FEEDS=coinbase,kraken,binance
   MARKET_MIN_HEALTHY_VENUES=3
   REQUIRE_MARKET_FOR_READINESS=false
   SIMULATED_FEED_ENABLED=false
   SIGNALS_ENABLED=false
   MODEL_PROVIDER=disabled
   APNS_ENABLED=false
   ```

`REQUIRE_MARKET_FOR_READINESS=false` keeps guest reads online during a provider
outage. Market health still becomes degraded and the signal policy still
abstains. Alert on market-quorum loss separately.

### 4.2 Apply schema migrations once

The server never changes its own schema at startup. First apply the namespace,
ConfigMap, and externally managed Secret. Then create the release-specific copy
of [migrate.yaml](../deploy/k8s/jobs/migrate.yaml) and wait for that Job to
finish. The checked-in file deliberately uses `generateName` and is not part of
the base Kustomization, so an ordinary deploy cannot rerun it accidentally.

Expected migration log:

```text
Database migrations complete.
```

If migration fails, stop. Do not deploy the API and do not run a down migration.
Fix the cause and use an approved forward fix/new Job.

### 4.3 Apply the service

```powershell
kubectl kustomize deploy/k8s/base
kubectl apply -k deploy/k8s/base
kubectl rollout status deployment/flippars-api -n flippars
```

The network policy includes Coinbase/Kraken/APNs HTTPS, PostgreSQL, DNS, and
Binance's required TCP port 9443. The retention CronJob starts suspended; test a
manual job before enabling its schedule as described in
[retention.md](runbooks/retention.md).

### 4.4 Add the public HTTPS edge

Using your cloud dashboard or reviewed provider-specific manifests:

1. Point `api.yourdomain.com` to the load balancer.
2. Issue a trusted TLS certificate and redirect HTTP to HTTPS.
3. Enable long-lived WebSocket upgrades for `/v1/stream`.
4. Keep `/metrics` private to monitoring and restrict `/docs` if it is not meant
   to be public.
5. Restrict direct pod/service access so forwarded-client IP headers can be
   trusted safely before setting `TRUST_PROXY=true`.
6. Add WAF/rate-limit alerts without logging guest IDs, guest credentials, or
   push tokens.

Ingress is cloud-specific and intentionally not guessed in this repository.

### 4.5 Run smoke checks

Replace the hostname below:

```powershell
Invoke-RestMethod https://api.yourdomain.com/health/live
Invoke-RestMethod https://api.yourdomain.com/health/ready
Invoke-RestMethod https://api.yourdomain.com/v1/market/snapshot
```

Expected result: liveness is `ok`, readiness confirms the database is healthy,
and the market response reports live/degraded state honestly. No new signals is
the expected result while the provider is disabled.

Follow [deploy-rollback.md](runbooks/deploy-rollback.md) for every release and
rollback.

## Part 5: configure the production EAS build

Run these commands from `apps/mobile`, not the repository root. The three values
are public and embedded in the app; never put a secret in `EXPO_PUBLIC_*`.

```powershell
Set-Location apps/mobile
$env:EAS_PROJECT_ID="YOUR_REAL_EAS_PROJECT_UUID"
npx eas-cli@latest login
npx eas-cli@latest init --id $env:EAS_PROJECT_ID
npx eas-cli@latest env:create --environment production --name EAS_PROJECT_ID --value $env:EAS_PROJECT_ID --visibility plaintext
npx eas-cli@latest env:create --environment production --name EXPO_PUBLIC_API_URL --value https://api.yourdomain.com --visibility plaintext
npx eas-cli@latest env:create --environment production --name EXPO_PUBLIC_DEMO_MODE --value false --visibility plaintext
npx eas-cli@latest env:list --environment production
```

The production build now fails before compilation if the API URL is absent or
not HTTPS, demo mode is not exactly `false`, or the EAS Project ID is missing or
still the placeholder.

Confirm the final bundle ID in `apps/mobile/app.config.ts`. It must match the App
ID in Apple Developer, the App Store Connect app, and `APNS_BUNDLE_ID`.

## Part 6: TestFlight before App Store release

### 6.1 Create a production-signed build

```powershell
npx expo-doctor
npx eas-cli@latest credentials --platform ios
npx eas-cli@latest build --platform ios --profile production
```

EAS may create or reuse your distribution certificate and provisioning profile.
Inspect credentials in the correct Apple team; never download them into the
repository.

### 6.2 Upload to App Store Connect

Add the App Store Connect Apple ID (`ascAppId`, the numeric app ID—not the bundle
ID) to the production submit profile when known, then run:

```powershell
npx eas-cli@latest submit --platform ios --profile production
```

After Apple processes the build, add it to an internal TestFlight group. Do not
send it to App Review yet.

### 6.3 Physical-iPhone acceptance test

On at least one supported iPhone, verify:

- first launch goes from disclosure onboarding to every guest screen;
- choosing “Not now” for notifications does not limit dashboard/history access;
- notification token is not uploaded until explicit in-app opt-in;
- reset removes the old guest server record or retains a retry until deletion
  succeeds, clears local data, and returns to onboarding;
- offline launch, reconnect, WebSocket gap recovery, and stale-data labels;
- VoiceOver, large Dynamic Type, dark/light appearance, contrast, reduced
  motion, focus, and non-color health cues;
- no Demo badge and the production API hostname is used;
- there is no account, paywall, subscription, exchange login, or trade action.

## Part 7: enable APNs only after the app works without it

1. In Apple Developer, create or select an APNs token key and download the `.p8`
   once. Record its Key ID and your Team ID.
2. Store the key in the backend secret manager, never in EAS public variables or
   Git.
3. Set:

   ```text
   APNS_ENVIRONMENT=production
   APNS_TEAM_ID=<Apple Team ID>
   APNS_KEY_ID=<APNs Key ID>
   APNS_BUNDLE_ID=<exact iOS bundle ID>
   APNS_PRIVATE_KEY=<full p8 content, with newlines preserved or escaped as \n>
   APNS_ENABLED=true
   ```

4. Keep the stable `DEVICE_TOKEN_ENCRYPTION_KEY` already configured.
5. Redeploy the API and repeat TestFlight notification opt-in, foreground,
   background, expiry, quiet-hours, disable/re-enable, and guest-reset tests.

Development/sandbox APNs tokens and production/TestFlight tokens are not
interchangeable. Use separate backends or leave APNs disabled in preview builds.

## Part 8: complete App Store and legal owner work

Before App Review, complete every unchecked item in
[release-checklist.md](release-checklist.md), especially:

- publish the reviewed privacy policy and support pages;
- disclose anonymous installation ID, explicit notification preference, APNs
  token, operational logs, deletion/reset, vendors, and actual retention;
- fill App Privacy answers in App Store Connect based on real production data
  handling, including third-party SDKs;
- finish provider/data licences, financial-promotion review, warnings, launch
  countries, export-compliance questions, screenshots, age/category choices,
  and review notes;
- complete independent mobile/API penetration testing and close every
  Critical/High finding;
- activate dashboards, alerts, on-call routing, database restore drill, provider
  outage drill, APNs failure handling, and rollback exercise.

Apple requires a privacy-policy URL and accurate App Privacy responses; see
[Apple's current instructions](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/).

## Part 9: model approval is a later governed release

Do not update `model_registry` manually and do not change
`SIGNALS_ENABLED=false`. The current repository can verify the integrity and
independent approval evidence of a future signed bundle, but it cannot create
that evidence or supply the missing live features.

The minimum path is:

1. license and freeze point-in-time data;
2. define a three-class target that retains `ABOVE_OPEN`, `BELOW_OPEN`, and flat
   `AT_OPEN` outcomes;
3. train a draft challenger and lock thresholds before untouched holdout;
4. independently review leakage, calibration, direction performance,
   limitations, security, and reproducibility;
5. run prospective live shadow for at least 12 weeks and 300 independent alert
   windows per target, whichever takes longer;
6. pass every gate in `docs/model-governance.md` and collect signed evidence;
7. verify the signed bundle using the model-artifact verifier and the runbook in
   `docs/runbooks/model-promotion.md`;
8. separately implement/validate the production feature provider, including all
   required anomaly inputs, then canary and exercise rollback;
9. only then add an enabled provider option and consider signals for an approved
   cohort.

Starting a shadow on August 2, 2026 cannot satisfy the 12-week minimum before
October 25, 2026, and the 300-window requirement may take longer.

## Final go/no-go checklist

Release the guest app only when all answers are yes:

- Production verification, dependency audit, container scan, and migration pass.
- HTTPS API, PostgreSQL backups, monitoring, retention, and rollback are active.
- Production build has `EXPO_PUBLIC_DEMO_MODE=false` and the correct HTTPS API.
- TestFlight guest/reset/offline/accessibility tests pass on physical iPhones.
- Privacy, support, licences, legal, security test, and App Store details are done.
- `SIGNALS_ENABLED=false` and `MODEL_PROVIDER=disabled` remain in effect.
- APNs is either fully tested in production mode or deliberately disabled.

That is a production-capable guest-first information release. It is not yet a
production signal-alert release, and the UI should continue to say so honestly.
