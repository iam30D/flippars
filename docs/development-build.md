# Beginner guide: create an iPhone development build

This guide creates an installable Flippars development client from Windows by
using Expo's macOS cloud builders. It does not publish the app to the App Store.

## What you need

- Node.js 20.19 or newer in the Node 20 line (`node -v`)
- An [Expo account](https://expo.dev/signup)
- A paid Apple Developer membership for a cloud-built physical-iPhone app
- The iPhone you will test, with Developer Mode enabled
- PowerShell opened in the repository root

Do not paste Apple, Expo, database, or APNs secrets into source files or chat.

## 1. Install and verify the project

```powershell
npm ci
npm run verify
```

Expected result: every check ends successfully. If `npm ci` fails, confirm that
`node -v` reports Node 20.19 through 20.x, not Node 21 or newer.

## 2. Create or find the Expo project ID

1. Sign in at [expo.dev](https://expo.dev/).
2. Create a project named `flippars`, or open the existing Flippars project.
3. Open project settings and copy its Project ID. It looks like a UUID, for
   example `12345678-1234-4234-9234-123456789abc`.
4. From the app directory, link this checkout to that project:

```powershell
Set-Location apps/mobile
$env:EAS_PROJECT_ID="PASTE_YOUR_PROJECT_ID_HERE"
npx eas-cli@latest login
npx eas-cli@latest whoami
npx eas-cli@latest init --id $env:EAS_PROJECT_ID
```

Expected result: `whoami` shows your Expo username and `init` says the project is
linked. Run all EAS commands from `apps/mobile`; Expo requires that for monorepos.

## 3. Add the development build variables to EAS

The development build may use visible demo data while you finish the backend.
These are public build values, not secrets.

```powershell
npx eas-cli@latest env:create --environment development --name EAS_PROJECT_ID --value $env:EAS_PROJECT_ID --visibility plaintext
npx eas-cli@latest env:create --environment development --name EXPO_PUBLIC_DEMO_MODE --value true --visibility plaintext
npx eas-cli@latest env:create --environment development --name EXPO_PUBLIC_API_URL --value https://api.example.com --visibility plaintext
npx eas-cli@latest env:list --environment development
```

Expected result: all three names appear under the `development` environment.
Demo mode is visibly labelled in the app and is acceptable only for internal
development. It is blocked in a production build.

To test a real development API instead, set `EXPO_PUBLIC_DEMO_MODE=false` and
replace the URL with your own HTTPS API URL. A physical iPhone cannot use the
computer's `localhost`, and Flippars rejects insecure non-local HTTP URLs.

## 4. Register the iPhone

```powershell
npx eas-cli@latest device:create
```

1. Choose the website/QR-code option.
2. Open the supplied link on the iPhone.
3. Follow Apple's prompts to register the device.
4. On iOS 16 or newer, enable **Settings > Privacy & Security > Developer Mode**.

## 5. Build and install the development client

```powershell
npx eas-cli@latest build --platform ios --profile development
```

On the first build, allow EAS to create the development certificate and
provisioning profile, or select existing credentials you already control. When
the build finishes, scan its install QR code on the registered iPhone.

This profile contains `expo-dev-client`; it is a debug tool and must never be
submitted to the App Store. Expo's current physical-device walkthrough is
[here](https://docs.expo.dev/tutorial/eas/ios-development-build-for-devices/).

## 6. Start the development server

Keep PowerShell in `apps/mobile` and run:

```powershell
npx expo start --dev-client
```

Open Flippars on the iPhone, choose the displayed development server, and wait
for the dashboard. In the current demo configuration you should see a visible
Demo badge. Every screen is available as a guest; notification permission is
optional.

## 7. When code or configuration changes

- JavaScript/TypeScript-only change: restart Metro if needed; normally no new
  native build is required.
- Native dependency, Expo plugin, icon, bundle ID, or native configuration
  change: run the EAS development build command again.
- Added a new iPhone: run `device:create`, then rebuild or re-sign the build.

## Common problems

- **`EAS_PROJECT_ID` is missing:** set it in the current PowerShell session and
  in the EAS `development` environment, then rebuild.
- **The app says the API is not configured:** either set demo mode to `true` for
  internal development or supply a reachable HTTPS development API.
- **The iPhone cannot install the build:** confirm it was registered before the
  build and Developer Mode is on.
- **Push notifications do not arrive:** development builds use the APNs sandbox.
  Do not point sandbox tokens at the production APNs backend.
- **A generated `expo-env.d.ts` appears:** leave it ignored. Project-owned env
  typings live in `apps/mobile/env.d.ts`.
