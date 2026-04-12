# Phase 1 — Core Infrastructure Roadmap

Baseline items every new Expo/local-first project needs before feature work can begin. Copy this to a new project as `docs/roadmap-phase1-core.md`, prune what doesn't apply, and charter the rest.

Opinionated assumptions baked in:
- **Expo** (CNG / managed workflow), **pnpm** monorepo, **TypeScript** strict, **Biome** linter
- **Local-first** — SQLite on device via op-sqlite, encrypted at rest, no telemetry
- **Drizzle** ORM, ULIDs as primary keys, ISO-8601 timestamps, integer units for anything quantitative
- **Zustand v5** for UI state, **React Query** for server/async state, **Restyle** for theming
- **expo-router** for file-based routing, **i18next** for bilingual (EN/FR) from day one
- **Biometric lock** at boot, SQLCipher key derived from device secure enclave
- **Propose-then-confirm** for any automation that mutates data

If you're not doing one of these, strike the relevant items and note why in `docs/decisions.md`.

**Related:** [task-index.md](task-index.md)

> **Sequencing:** Items are ordered roughly by dependency — DB-1 → DB-2 → everything else. DESIGN and I18N can proceed in parallel after DB is live. AUTH is needed before any real data can be stored. EAS can be last.

## Progress

**Open items** (all, on a new project):

| Item | Depends on |
|------|-----------|
| INFRA-1. Monorepo scaffold (pnpm workspaces + Biome + tsconfig + paths) | — |
| DB-1. Drizzle schema + op-sqlite client + migration runner | INFRA-1 |
| DB-2. SQLCipher encryption + Proxy-backed lazy client | DB-1 |
| AUTH-1. Biometric lock screen + SecureStore key derivation | DB-2 |
| DESIGN-1. Restyle theme, tokens (spacing, radii, motion), press feedback hooks | INFRA-1 |
| DESIGN-2. Shared components (Screen, ScreenHeader, Button, IconButton, ButtonGroup, InfoRow) | DESIGN-1 |
| I18N-1. i18next bilingual setup (EN/FR namespaces, expo-localization, key parity test) | INFRA-1 |
| STATE-1. Zustand stores scaffold (theme, locale, auth) | DESIGN-1 |
| NAV-1. expo-router layout, tab bar, ContentContainer, responsive breakpoints | DESIGN-2, I18N-1 |
| DATA-1. React Query provider + queryKey factory + invalidation helpers | DB-1 |
| TEST-1. Jest + testing-library baseline, first integration test against real SQLite | DB-1 |
| BUILD-1. EAS development profile + first dev build verified on simulator | INFRA-1 |

---

## Items

### INFRA-1. Monorepo scaffold

| What | Scope | Deps |
|------|-------|------|
| pnpm workspaces, apps/mobile + packages/shared, Biome, strict tsconfig, path aliases (`@/*`, `@db/*`, `@design/*`) | M | — |

**Deliverables:**
- `pnpm-workspace.yaml` with `apps/*` and `packages/*`
- `apps/mobile/` with `@app/mobile` package name
- `biome.json` at repo root with project's formatting preferences
- Root `tsconfig.json` extending `expo/tsconfig.base`
- Path aliases configured in `tsconfig.json` and `babel.config.js`
- Scripts: `pnpm typecheck`, `pnpm check`, `pnpm test` all runnable from repo root
- `lefthook.yml` pre-commit hooks for staged-file biome + typecheck

**Out of scope:**
- Any actual application code
- CI workflows (defer to BUILD-1)

---

### DB-1. Drizzle + op-sqlite + migrations

| What | Scope | Deps |
|------|-------|------|
| First schema file, Drizzle migrations generator, op-sqlite client, migration runner on boot | L | INFRA-1 |

**Deliverables:**
- `src/db/schema.ts` with 2-3 starter tables (users / settings / ledger, adapted to domain)
- `src/db/client.ts` exporting `db` (op-sqlite + drizzle)
- `src/db/migrations/migrations.ts` with first migration baked in (remember: Metro can't import `.sql`)
- `src/db/migrations/meta/_journal.json` entry for migration 0000
- Boot sequence in `_layout.tsx` calls `runMigrations()` before rendering routes
- Generated types via `$inferInsert` / `$inferSelect` — no hand-written duplicates
- `nowISO()` helper in `src/utils/dates.ts` for explicit timestamp insertion

**Out of scope:**
- Encryption (DB-2)
- Any domain-specific tables beyond the starter 2-3

---

### DB-2. SQLCipher encryption + Proxy-backed lazy client

| What | Scope | Deps |
|------|-------|------|
| Encrypt the SQLite DB at rest using SQLCipher. Client wrapped in Proxy that throws until `openDatabase(key)` is called | M | DB-1 |

**Deliverables:**
- `src/db/client.ts` exports a Proxy-backed `db` that throws `"Database not opened"` on access until initialized
- `openDatabase(encryptionKey)` function resolves the Proxy
- Key stored in SecureStore, derived via `expo-crypto` on first launch
- `_layout.tsx` boot sequence gates DB open on `isAuthenticated`
- Key rotation deferred — note in `docs/decisions.md` how rotation would work

**Out of scope:**
- Biometric unlock UI (AUTH-1)
- Cloud backup of key (never — by design, key never leaves device)

---

### AUTH-1. Biometric lock screen + key derivation

| What | Scope | Deps |
|------|-------|------|
| Lock screen rendered outside ThemeProvider, biometric prompt, key derivation from SecureStore | M | DB-2 |

**Deliverables:**
- Lock screen component using raw RN `View` / `Text` (no theme tokens — ThemeProvider isn't mounted yet at this boot phase)
- `expo-local-authentication` integration for Face ID / Touch ID / device passcode fallback
- SecureStore key retrieval with device-bound encryption
- `isAuthenticated` Zustand store slice
- `_layout.tsx` gates route rendering on `isAuthenticated`
- Enrollment flow for first launch (no biometric yet → set up passcode fallback)

**Out of scope:**
- Account/user auth (this app is single-user, local-first)
- Cloud sync auth (defer to Phase 3 if applicable)

---

### DESIGN-1. Restyle theme + tokens + press feedback

| What | Scope | Deps |
|------|-------|------|
| Restyle theme with typography/spacing/radii/colors, PRESS and MOTION tokens, press feedback hooks | M | INFRA-1 |

**Deliverables:**
- `src/design/theme.ts` with light + dark variants
- `src/design/tokens.ts` exporting RADII (xs..full), PRESS (scale/opacity), MOTION (duration.*), BREAKPOINTS (phone/tablet/desktop)
- `src/design/hooks/usePressStyle.ts` — instant feedback for cards/pills/rows
- `src/design/hooks/useAnimatedPress.ts` — smooth 150ms animated feedback for buttons
- `src/design/hooks/useReducedMotion.ts` — reads `AccessibilityInfo`, gates all animations
- Font loading via `expo-font` with PostScript names
- `ThemeProvider` wiring in `_layout.tsx`

**Out of scope:**
- Any specific colors beyond a placeholder palette — pick the real palette when you have design direction

---

### DESIGN-2. Shared components

| What | Scope | Deps |
|------|-------|------|
| Screen, ScreenHeader, Button (5 variants, 3 sizes), IconButton, ButtonGroup, InfoRow | M | DESIGN-1 |

**Deliverables:**
- `src/components/Screen.tsx` — wraps content with SafeArea + theme background
- `src/components/ScreenHeader.tsx` — title, optional caption, optional action slot
- `src/components/Button.tsx` — variants: primary/secondary/ghost/danger/confirm; sizes: sm/md/lg; optional icon + haptic props
- `src/components/IconButton.tsx` — circular, requires accessibilityLabel
- `src/components/ButtonGroup.tsx` — row/column layout wrapper
- `src/components/InfoRow.tsx` — label/value pair, `borderless` variant for inline breakdowns
- `src/utils/haptics.ts` — `fireHaptic(weight)` via `expo-haptics`
- All interactive elements use press feedback hooks from DESIGN-1
- Unit tests for Button and IconButton variants

**Out of scope:**
- Domain-specific components (StatCard, ItemTable, etc.) — add as the domain takes shape

---

### I18N-1. i18next bilingual setup

| What | Scope | Deps |
|------|-------|------|
| i18next + react-i18next + expo-localization, EN/FR namespaces, type-safe keys, key parity test | M | INFRA-1 |

**Deliverables:**
- `src/i18n/index.ts` initializes i18next with expo-localization detection
- `src/i18n/en/common.json`, `src/i18n/en/screens.json` — starter namespaces
- `src/i18n/fr/common.json`, `src/i18n/fr/screens.json` — parallel structure
- Type-safe `useTranslation` via i18next's TypeScript plugin
- `src/i18n/__tests__/keyParity.test.ts` — fails if `en/*.json` and `fr/*.json` drift
- Locale switcher in settings (deferred to Phase 2 if no settings screen yet)

**Out of scope:**
- Real translated content beyond "Hello" / "Settings" / basic UI labels
- RTL support (not needed for EN/FR, add if adding AR/HE later)

---

### STATE-1. Zustand stores scaffold

| What | Scope | Deps |
|------|-------|------|
| Zustand v5 stores for theme, locale, auth. Named import pattern. Persistence via AsyncStorage for non-sensitive slices | S | DESIGN-1 |

**Deliverables:**
- `src/stores/themeStore.ts` — light/dark/system, persisted
- `src/stores/localeStore.ts` — current locale, persisted
- `src/stores/authStore.ts` — isAuthenticated, last unlock time, NOT persisted
- All stores use `import { create } from 'zustand'` (v5 named import)
- Subscriptions via `useStore((s) => s.field)` to minimize re-renders

**Out of scope:**
- Domain-specific stores — add as features ship

---

### NAV-1. expo-router layout + tab bar + responsive

| What | Scope | Deps |
|------|-------|------|
| File-based routing, tab bar (bottom on phone, sidebar on desktop), `ContentContainer`, responsive hooks | M | DESIGN-2, I18N-1 |

**Deliverables:**
- `apps/mobile/app/_layout.tsx` — root layout with boot sequence gate
- `apps/mobile/app/(tabs)/_layout.tsx` — tab configuration
- `apps/mobile/app/(tabs)/index.tsx` — home tab placeholder
- `src/components/ContentContainer.tsx` — opt-in max-width wrapper for text-heavy screens
- Custom `tabBar` renders sidebar on desktop (`position: 'absolute'` + `sceneStyle: { marginLeft }`)
- `src/design/hooks/useLayout.ts` — returns `{ isTablet, isDesktop, isLandscape, contentMaxWidth, breakpoint }`
- Route redirects via `<Redirect href>` only — never `useEffect` + `router.replace()`

**Out of scope:**
- Actual tab content (placeholders are fine)
- Deep linking configuration

---

### DATA-1. React Query + query key factory

| What | Scope | Deps |
|------|-------|------|
| React Query provider, query key factory, invalidation helpers, devtools in dev only | S | DB-1 |

**Deliverables:**
- `QueryClientProvider` in `_layout.tsx` (inside ThemeProvider)
- `src/hooks/queryKeys.ts` — factory for all query keys, typed as const
- Invalidation helpers for cross-cutting refreshes (`invalidateAllAccounts`, etc. — adapt to domain)
- React Query Devtools conditionally loaded in `__DEV__` only
- Default `staleTime: 0`, `gcTime: 5 * 60_000`, retry on mount false (adjust per query as needed)

**Out of scope:**
- Any actual query/mutation hooks (those come with features)

---

### TEST-1. Jest baseline + first integration test

| What | Scope | Deps |
|------|-------|------|
| Jest + `@testing-library/react-native`, first integration test against real SQLite (not mocked) | M | DB-1 |

**Deliverables:**
- `jest.config.js` with Expo preset
- `jest.setup.js` for global mocks (SafeArea, reanimated, etc.)
- `src/db/__tests__/schema.test.ts` — opens a real SQLite DB in memory, runs migrations, inserts and reads back a row
- Test script: `pnpm test --no-coverage` from `apps/mobile`
- CI-ready: tests must pass without network, without simulator

**Out of scope:**
- Component snapshot tests (snapshot tests are low-value on a fresh project)
- E2E tests (Detox / Maestro — defer until there's enough UI to justify them)

---

### BUILD-1. EAS development profile + first verified build

| What | Scope | Deps |
|------|-------|------|
| EAS project, development profile, first dev build on iOS simulator, build succeeds from CI | M | INFRA-1 |

**Deliverables:**
- `apps/mobile/eas.json` with `development` profile (simulator: true, no credentials)
- `apps/mobile/app.config.ts` with bundleId, display name, icon placeholder
- First `eas build --profile development --platform ios` succeeds locally
- `.github/workflows/eas-preview.yml` for PR builds (optional, can defer)
- `docs/build.md` filled in with project-specific IDs and commands

**Out of scope:**
- Preview profile (requires Apple certs)
- Production profile (requires App Store Connect record)
- Android credentials (Expo handles keystore via EAS)

---

## Scope legend

- **XS** — 1-2 files, <1 hour of work
- **S** — 2-4 files, 1-3 hours
- **M** — 4-10 files, half day to full day
- **L** — 10+ files, multi-day, probably needs a plan
- **XL** — major feature, definitely needs a plan + shakedown-plan pass

Autopilot detects scope from the `scope: X` hint in the item text. XS/S items skip the planning step and go straight to implementation.

---

## After Phase 1 is done

Once all twelve items are shipped, you have a fully wired Expo project with:
- Encrypted local DB
- Biometric lock
- Theme + shared components
- Bilingual i18n
- Type-safe state management
- Query/mutation infrastructure
- First dev build on device
- Test baseline

That's roughly the point where feature work becomes productive. Start authoring Phase 2 roadmaps (e.g., `roadmap-phase2-core-features.md`) with your domain-specific items.
