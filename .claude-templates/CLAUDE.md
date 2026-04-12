# {{PROJECT_NAME}} — Claude Context

{{ONE-LINE-DESCRIPTION}} Expo React Native app (CNG / managed workflow). pnpm monorepo. iOS + Android. {{PLATFORM-CONSTRAINTS, e.g., "local-first, no analytics" | "cloud-native, multi-tenant" | "single-tenant, storefront-only"}}.

## Orientation

- Spec: `{{SPEC-FILE}}` *(or delete if none)*
- Architecture: [docs/architecture.md](docs/architecture.md) (C4 diagrams, data flows, invariants)
- Philosophy: [docs/philosophy.md](docs/philosophy.md) (why this project exists, what it optimizes for)
- Tone & voice: [docs/tone.md](docs/tone.md) (agent/app copy rules) *(delete if non-user-facing)*
- UI component conventions: [docs/conventions-ui.md](docs/conventions-ui.md) (buttons, tokens, responsive, shared components)
- Routes live at `apps/mobile/app/` (not `src/app/`)
- Path aliases: `@/*` → `src/*`, `@db/*` → `src/db/*`, `@design/*` → `src/design/*`
- Linter/formatter: **Biome** (not ESLint/Prettier) — `pnpm check` from `apps/mobile`

## Data model shape

{{DESCRIBE YOUR AGGREGATE HIERARCHY HERE}}

Example from an image-based product app:
```
L1  source_image     ← original photo, never modified
L2  item             ← individual entity extracted from source (a garment, a product)
L3  attribute        ← derived/extracted property (color, category, tag)
```

Every ingested record should land in a staging/candidate table first, then a promotion step moves it to the canonical table. Direct writes to canonical tables are only valid for explicit user-authored entries.

## Key constraints

{{2–4 LOAD-BEARING CONSTRAINTS. Examples:}}

- **{{CONSTRAINT 1}}**: description and where it's enforced
- **Propose-then-confirm**: any automation that mutates meaningful state proposes first, confirms second. Enforced at the architecture level, not layered on as UX
- **Confidence-gated automation**: three tiers (high = auto-act, mid = propose, low = flag). Applies to any ML/heuristic automation

## Data integrity principles

Check this list before adding new ingestion paths, analytics queries, or automation.

- **Raw preservation**: store originals alongside normalized versions. Never discard source data
- **Pipeline-time processing**: dedup/normalize/categorize at ingest, never at read time
- **Evidence chain**: every derived record should trace to its source
- **Confidence gates**: automated mutations need scored thresholds (high = auto, mid = review, low = flag)
- {{DOMAIN-SPECIFIC INTEGRITY RULES — examples below}}
- *(Example: **Price arithmetic**: amounts stored as `integer` (cents) with branded `Cents` type. `toCents()` at ingestion, `fromCents()` at display. `.toFixed(2)` on a cents value is a bug)*
- *(Example: **Color space**: dominant-color extraction always in OKLCH. Mixing sRGB and LAB comparisons produces wrong matches)*
- *(Example: **Source attribution**: every image traces to its original capture with source URL, photographer, or provenance)*

## Non-obvious conventions

{{STACK-WIDE CONVENTIONS that aren't obvious from reading code. Examples to keep or remove:}}

- **IDs**: ULIDs via `ulid` package — never auto-increment integers
- **Timestamps**: ISO-8601 UTC strings in SQLite — never Unix integers
- **Soft deletes**: `deleted_at` column — never hard delete. UI must show `Alert.alert` before any soft-delete
- **Fonts**: use PostScript names (`'Lora_400Regular'`), not CSS strings
- **Zustand**: v5 named import — `import { create } from 'zustand'`
- **DB encryption**: SQLCipher via op-sqlite. `src/db/client.ts` exports Proxy-backed `db` that throws until `openDatabase(encryptionKey)` is called
- **Drizzle migrations**: `drizzle-kit generate:sqlite`, never `push` in prod. After generating, **copy new SQL into `src/db/migrations/migrations.ts`** and add journal entry — Metro can't import `.sql` files
- **Drizzle + op-sqlite timestamps**: all insert sites **must pass `created_at`/`updated_at` explicitly** via `nowISO()` from `@/utils/dates`. The `.default()` in schema exists only for DDL generation
- **Schema-derived types**: use types from `@db/schema` — never duplicate enum unions. Use `$inferInsert`/`$inferSelect` for typed update objects
- **i18n**: `i18next` + `react-i18next` + `expo-localization`. Translations in `src/i18n/{en,fr}/`. Adding a key to `en/*.json` without `fr/*.json` fails `keyParity.test.ts` *(delete if single-language)*
- **Display-label functions**: `get{Foo}Label()` in `@/utils/format.ts` — use instead of hardcoded label maps
- **Import hooks**: hooks in `src/hooks/` are thin wrappers — business logic lives in domain engines (`src/{your-domain}/`)
- **Local Expo modules**: live in `modules/`. Import via relative path — no alias. Native code must be committed
- **Route redirects**: use `<Redirect href="..." />` from expo-router — never `useEffect` + `router.replace()`

## Phase scope

| Phase | Status | Focus |
|---|---|---|
| 1 | {{STATUS}} | {{SCAFFOLD/INFRA FOCUS}} |
| 2 | {{STATUS}} | {{CORE FEATURE FOCUS}} |
| 3 | {{STATUS}} | {{POLISH/RELEASE FOCUS}} |

Task index (for autopilot pick): [docs/task-index.md](docs/task-index.md)

## Bug reporter — automated fix instructions

When fixing bugs from automated reports:
- Do NOT attempt to run expo start, npm install, or any build commands
- Make minimal, surgical edits only
- Commit directly to main (solo workflow — no PRs unless `--pr` is passed to `/ship`)
- Do not modify any GitHub Actions workflow files

## Running things

```bash
pnpm typecheck          # workspace-wide, from repo root
pnpm check              # biome — run from apps/mobile
pnpm test --no-coverage # jest, from apps/mobile
pnpm exec drizzle-kit generate:sqlite  # from apps/mobile
eas build --profile development --platform ios  # from apps/mobile
```

Android emulator and build setup: [docs/build.md](docs/build.md)
