# Build & EAS Setup

## EAS project

- Account: `@{{YOUR-EXPO-ACCOUNT}}`
- Project ID: `{{EAS-PROJECT-ID}}`
- Dashboard: `https://expo.dev/accounts/{{account}}/projects/{{project}}`

## Required secrets

| Secret | Where to get it |
|---|---|
| `EXPO_TOKEN` | expo.dev → Account Settings → Access Tokens |
| `EAS_PROJECT_ID` | See project ID above |

Set both as GitHub Actions repository secrets and in `apps/mobile/.env.local`.

## Profiles

| Profile | Distribution | Notes |
|---|---|---|
| `development` | internal | iOS simulator (`simulator: true`), no Apple certs needed |
| `preview` | internal | Device build, requires Apple certs + provisioning |
| `production` | store | Requires Apple certs, App Store Connect app record |

## First dev build

```bash
cd apps/mobile             # ← all eas and expo commands must run from here
pnpm exec expo prebuild    # apply config plugins to ios/ and android/
git add ios android && git commit -m "chore: apply expo prebuild"
eas build --profile development --platform android
eas build --profile development --platform ios
```

> **Important**: always `cd apps/mobile` first. Running `eas` from the repo root will not find the `expo` package and will generate a stale `eas.json` at the root.

The resulting `.app` can be dragged into the iOS Simulator.

## Apple credentials (preview / production only)

Required fields in `eas.json` submit section before first TestFlight:
- `appleId`: your Apple ID email
- `ascAppId`: numeric ID from App Store Connect URL (`/apps/<ID>/`)

Bundle ID: `com.{{YOUR-ORG}}.{{project}}` (iOS) / `com.{{YOUR-ORG}}.{{project}}` (Android package name).
App Store Connect app record must be created at appstoreconnect.apple.com before first submission.
Privacy policy URL must be live before external TestFlight distribution.

## Android setup

See Expo's Android emulator guide. Key commands:

```bash
# From apps/mobile
pnpm exec expo run:android              # local development build
eas build --profile development --platform android --local  # local EAS build
```

## Local development loop

```bash
cd apps/mobile
pnpm start                              # metro bundler
# Then: press 'i' for iOS simulator, 'a' for Android emulator
```

For faster iteration, use development builds rather than Expo Go — Expo Go can't load native modules.

## Local Expo modules

Native modules live in `apps/mobile/modules/`. Import via relative path, not alias. Native code (ios/android dirs inside each module) must be committed to git — CI builds from committed state, not from generated.

After modifying a module's native code:
```bash
cd apps/mobile
pnpm exec expo prebuild --clean
# inspect the diff, commit the native changes
```

## Verification before shipping

```bash
# From repo root
pnpm typecheck       # workspace-wide tsc --noEmit
pnpm check           # biome check across workspaces
# From apps/mobile
pnpm test --no-coverage   # jest
```

All three must pass. Biome warnings are acceptable; errors block.
