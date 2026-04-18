# TOOL-8 — `.autopilot.yml` project config file + loader

**Item**: TOOL-8 (roadmap-core)
**Scope**: M
**Branch**: `feat/tool-8-autopilot-yml-config`

## Scope

### What this touches

- `scripts/autopilot/config.ts` — refactored to expose `DEFAULTS` + `loadConfig()`; existing named exports (`BUDGETS`, `TURN_LIMITS`, `EFFORT`, `MODEL_PROFILES`, `REPO`, `LOG_PATH`, `STEPS`) are preserved but now populated from a module-level `loadConfig()` call
- `scripts/autopilot/helpers.ts` — stop defining `WORKTREE_PREFIX` locally; import it from `config.ts` (where it becomes part of the resolved config)
- `scripts/autopilot/__tests__/config.test.ts` — new unit test file for the loader
- `package.json` — add `yaml` dependency
- `CLAUDE.md` — new "Configuration" section documenting the override mechanism and live keys
- `docs/config.md` — new schema reference with an annotated example

### What this does NOT touch

- `pipeline.ts`, `step-runner.ts`, `stats.ts`, `main.ts`, `tui.ts` — they keep importing the same named exports; zero call-site changes
- Skills (`.claude/skills/**`) — no skill depends on config directly
- The `.autopilot.yml` file itself — intentionally **not** committed to this repo, because the repo's defaults *are* the defaults and checking in a redundant copy is drift-prone. `docs/config.md` carries the canonical example
- Roadmap / ship / docs / project schema sections listed in the TOOL-8 charter — these are placeholders for TOOL-9/11/13; adding them now with no consumer violates YAGNI. The loader silently ignores unknown top-level keys so later TOOLs can extend without a second refactor
- Runtime reload, JSON-schema validation, secret handling — explicitly out per the charter
- Behavior when `.autopilot.yml` is absent — must be identical to today

## Approach

### Chosen design: module-level loader, function export for tests

`config.ts` performs a single top-level `loadConfig()` call and re-exports resolved values as `BUDGETS`, `TURN_LIMITS`, etc. This keeps every consumer (`helpers.ts`, `pipeline.ts`, `step-runner.ts`, `stats.ts`) unchanged — they continue to destructure the same named exports.

```ts
// config.ts shape after refactor
export const STEPS = [...] as const;
export type PipelineStep = ...;
export type Step = ...;

export const DEFAULTS = { budgets: {...}, turnLimits: {...}, effort: {...}, modelProfiles: {...}, worktreePrefix: null } as const;

export function loadConfig(opts?: { repo?: string; configPath?: string }): ResolvedConfig { ... }

const CONFIG = loadConfig();
export const REPO = CONFIG.repo;
export const LOG_PATH = resolve(REPO, ".dev", "autopilot-log.jsonl");
export const WORKTREE_PREFIX = CONFIG.worktreePrefix;
export const BUDGETS: Record<Step, number> = CONFIG.budgets;
export const TURN_LIMITS: Record<Step, number> = CONFIG.turnLimits;
export const EFFORT: Record<Step, "low" | "medium" | "high"> = CONFIG.effort;
export const MODEL_PROFILES: Record<string, Partial<Record<Step, string>>> = CONFIG.modelProfiles;
```

`loadConfig()` is exported for testability — callers can pass an explicit `configPath` and `repo` to hermetically exercise the merge logic without env-var juggling.

### Alternatives considered

- **Async `loadConfig()`**: rejected — YAML parsing is sync-friendly, and making it async would force every import site to `await`. The pipeline already has a synchronous import graph.
- **Pass a `Config` object through function args instead of module-level exports**: rejected — would touch every call site in `helpers.ts`, `pipeline.ts`, `step-runner.ts`, `stats.ts`. YAGNI + diff explosion.
- **`zod` / JSON-Schema validation**: rejected — out of scope per the charter. Hand-written type narrowing is ~20 lines and avoids adding a 100KB dep.
- **Pre-existing YAML parsers (`js-yaml` vs `yaml`)**: pick `yaml` — it's maintained, TypeScript-native, no CVEs, and has cleaner error messages than `js-yaml`. The `yaml` package is ~50KB with zero deps.
- **Deep-merge via lodash**: rejected — a 15-line per-section merge is clearer and avoids a dep. We only merge at the level of `budgets.<step>`, `turnLimits.<step>`, `effort.<step>`, `modelProfiles.<profile>.<step>`; no recursive generic merge is needed.
- **Silent vs strict unknown-key handling**: silent. Strict rejection breaks forward-compatibility (a project using autopilot v0.3 with a v0.4 `.autopilot.yml` should keep working). We'll revisit if this bites.

### Env-var precedence

`CLAUDE_AUTOPILOT_WORKTREE_PREFIX` (env) > `worktree.prefix` (yml) > `basename(REPO) + "-"` (default). Env wins because it's the existing escape hatch and removing it silently would be a breaking change for any operator already using it.

### Config discovery

`loadConfig()` reads `${REPO}/.autopilot.yml` by default. `REPO` is resolved the same way as today (`__dirname` + `../..`). This is unchanged — we are not introducing cwd-based discovery, which would differ under worktrees.

### Merge semantics

For each of the four step-keyed Records (`budgets`, `turnLimits`, `effort`, `modelProfiles[profile]`), the merge is shallow: user-provided keys override, missing keys fall back to defaults. For `modelProfiles` itself, a user can add a new profile (e.g. `thrifty`) alongside `standard` and `quick` — we keep all profiles. If the user omits a step inside a profile, it falls back to the default for *that step in that profile*, not across profiles.

**Key-case translation**: `.autopilot.yml` uses kebab-case at the *section* level (`turn-limits`, `worktree.prefix`, `models.profiles`) which the loader maps to the camelCase `ResolvedConfig` fields (`turnLimits`, `worktreePrefix`, `modelProfiles`). Step names themselves (`pick`, `plan`, `shakedown-plan`, `shakedown-code`, `implement`, `ship`, `shipwreck`) are literal keys — their internal hyphens are part of the Step literal union and are NOT a casing convention; the loader does not transform them.

Model literals (`OPUS`, `SONNET` consts) remain in `config.ts`'s DEFAULTS block. The "no hardcoded model strings outside MODEL_PROFILES" rubric invariant is preserved — `.autopilot.yml` is the user-supplied override source, and DEFAULTS is the only other source inside `scripts/autopilot/`.

## Files to change

| File | Change |
|------|--------|
| `scripts/autopilot/config.ts` | Refactor: introduce `DEFAULTS`, `ResolvedConfig` type, `loadConfig()`; preserve `BUDGETS`/`TURN_LIMITS`/`EFFORT`/`MODEL_PROFILES`/`REPO`/`LOG_PATH`/`STEPS`/`WORKTREE_PREFIX` as resolved exports |
| `scripts/autopilot/helpers.ts` | Remove `WORKTREE_PREFIX` local definition; import from `config.js`. Delete the re-export comment line too |
| `scripts/autopilot/__tests__/config.test.ts` | New file: loader unit tests using `node:test` + temp files via `node:fs` / `node:os` |
| `package.json` | Add `"yaml": "^2.6.0"` to `devDependencies` (no separate runtime deps since everything runs via tsx) |
| `CLAUDE.md` | Add "Configuration" section after "Key constraints" documenting live config keys, fallback behavior, and env-var precedence |
| `docs/config.md` | New schema reference with annotated `.autopilot.yml` example showing every live key |

## Schema — live keys only

```yaml
# .autopilot.yml — all keys optional, defaults apply for anything omitted

worktree:
  prefix: "myproj-"            # default: `${basename(REPO)}-`

budgets:                        # dollars per step
  pick: 2
  plan: 8
  shakedown-plan: 5
  implement: 25
  shakedown-code: 25
  ship: 3
  shipwreck: 3

turn-limits:                    # SDK turn cap per step
  pick: 30
  plan: 80
  # ...

effort:                         # "low" | "medium" | "high"
  pick: medium
  plan: high
  # ...

models:
  profiles:
    standard:
      pick: claude-sonnet-4-6
      plan: claude-opus-4-7
      # ...
    quick:
      pick: claude-sonnet-4-6
      # ...
    # Users can add additional named profiles here
```

Keys consumed today: `worktree.prefix`, `budgets.*`, `turn-limits.*`, `effort.*`, `models.profiles.<name>.*`. Other keys (e.g. `project`, `docs`, `roadmap`, `ship`) from the charter are reserved for TOOL-9/11/13 and are silently ignored by the loader until those items land.

## Schema changes

N/A — no database in this repo.

## Test strategy

New `scripts/autopilot/__tests__/config.test.ts` with these scenarios, each using `mkdtempSync` + `tmpdir()` for isolation:

1. **Missing `.autopilot.yml`** → `loadConfig({ configPath })` pointed at a non-existent path returns values deep-equal to `DEFAULTS`.
2. **Empty YAML file** → same as missing.
3. **YAML with only `worktree.prefix`** → returned `worktreePrefix === "custom-"`; all other fields match DEFAULTS.
4. **Partial `budgets` override** (e.g. `{ implement: 40 }`) → that step uses 40; every other step falls back to default.
5. **New profile `thrifty`** added under `models.profiles` → returned `modelProfiles.thrifty` is populated, and `standard` / `quick` are untouched.
6. **Partial profile override** (e.g. `models.profiles.standard.plan: "some-id"`) → that one slot changes; siblings in `standard` keep defaults.
7. **Env var precedence** (`CLAUDE_AUTOPILOT_WORKTREE_PREFIX` set) → env wins over yml value. Restore env after each test.
8. **Invalid YAML** (e.g. `budgets: [not a map]`) → throws an `Error` whose message mentions the file path and a parse/shape hint. Use `assert.throws(..., /\.autopilot\.yml/)`.
9. **Unknown top-level key** (`foo: bar`) → does not throw; does not appear on resolved config.
10. **Non-step key inside `budgets`** (e.g. `budgets.bogus: 5`) → ignored; DEFAULTS preserved for real steps.

All tests avoid mutating the real `${REPO}/.autopilot.yml`. None spawn the SDK. Run via `pnpm test` which already globs `scripts/autopilot/__tests__/*.test.ts`.

Also: re-run the existing suite (`helpers.test.ts`, `pipeline.test.ts`, `stats.test.ts`) to confirm no regression — they should all pass untouched because the named exports keep their shapes.

Parse-check the three import paths from the rubric:

```
npx tsx -e "import('./scripts/autopilot/config.ts')"
npx tsx -e "import('./scripts/autopilot/helpers.ts')"
npx tsx -e "import('./scripts/autopilot/pipeline.ts')"
```

## i18n

N/A — tooling repo, no user-facing strings.

## Rubric self-check

- **Well-typed** — `ResolvedConfig` is a discriminated-union-free plain record type. `Record<Step, T>` is preserved for the four step-keyed sections (exhaustiveness enforced at the DEFAULTS literal). No `any`; YAML parse result is typed as `unknown` and narrowed via explicit `typeof` / `Array.isArray` checks inside the merge helpers. New exported function `loadConfig()` has an explicit return type.
- **Well-tested** — New file covers loader edge cases (10 scenarios). Existing helper tests untouched and still pass.
- **Well-factored** — All config logic stays in `config.ts`. No business logic leaks; loader is pure (file in → object out). Removes the `WORKTREE_PREFIX` outlier that was living in `helpers.ts` — restoring the stated rule that `config.ts` owns all static configuration.
- **Idiomatic** — Biome-clean formatting (tabs, double quotes, trailing commas), import order (node builtins → external `yaml` → local). Named exports. Error path uses `try/catch` around `yaml.parse` and re-throws with file context. `.js` extension in relative imports.
- **Correct** — Step exhaustiveness guaranteed: the merge starts from `DEFAULTS` (which has every step), then overlays user values; missing user keys preserve defaults. Frontmatter stripping: unchanged. Verdict parsing: unchanged. Worktree isolation: unchanged. Rate-limit parking: unchanged. Phantom-ship guard: unchanged. The one genuinely new invariant is "env > yml > default" for worktree prefix; documented in CLAUDE.md.
- **Concise** — No placeholder schema sections for future TOOLs. No `zod`, no `lodash`, no custom merge library. Merge logic is ~30 lines. Single new dep (`yaml`).

## Self-review

Re-read as a critical reviewer:

- **Hidden risk: module-level `loadConfig()` runs at import time.** If the user's `.autopilot.yml` has a syntax error, *every* tsx entry point (including `pnpm test` and `pnpm autopilot stats`) crashes on import before any error handling runs. This is the right behavior (fail loud, fail early) but the error message has to be excellent — file path, line/column if `yaml` provides it, and a "remove the file to fall back to defaults" hint. Captured as a requirement in the loader implementation and in test #8.
- **Hidden risk: `WORKTREE_PREFIX` move touches `helpers.ts` public export.** Other code (`pipeline.ts` line 21) imports `WORKTREE_PREFIX` from `./helpers.js`. Options: (a) re-export from `helpers.ts` via `export { WORKTREE_PREFIX } from "./config.js"` to preserve the import path; or (b) change `pipeline.ts` to import from `config.js` directly. Pick **(b)** — it's one line, aligns with the factoring rule ("config.ts owns static configuration"), and avoids a lingering re-export. Updated the Files-to-change table — flag `pipeline.ts:21` import tweak (single line, no behavior change).
- **Hidden risk: `LOG_PATH` depends on `REPO`.** Currently `REPO` is a `const` computed from `__dirname`. Keeping `REPO` as today (not from yml) is deliberate — making it configurable would tangle with the worktree-isolation hook logic in `step-runner.ts` that uses `REPO` to build hook rules. Charter does not ask for `REPO` to be configurable. Leaving it alone.
- **Performance**: loader runs once at startup; ~1ms file read + parse. Non-issue.
- **Back-compat for logs**: `.dev/autopilot-log.jsonl` path depends on `LOG_PATH` which depends on `REPO`. Unchanged. Resume detection and stats continue to work.

### Revisions made during self-review

- Added `scripts/autopilot/pipeline.ts` to the Files-to-change table (one-line import swap for `WORKTREE_PREFIX` from `config.js` instead of `helpers.js`).
- Strengthened the invalid-YAML test requirement to check that the error message includes the `.autopilot.yml` path so operators can find the broken file.

## Files-to-change (revised)

| File | Change |
|------|--------|
| `scripts/autopilot/config.ts` | Introduce `DEFAULTS`, `ResolvedConfig` type, `loadConfig()`; resolve and re-export `BUDGETS`/`TURN_LIMITS`/`EFFORT`/`MODEL_PROFILES`/`WORKTREE_PREFIX`; keep `REPO`/`LOG_PATH`/`STEPS` as-is |
| `scripts/autopilot/helpers.ts` | Delete local `WORKTREE_PREFIX` declaration and its re-export; import from `./config.js` where needed (inside `resolveWorktree`) |
| `scripts/autopilot/pipeline.ts` | Swap the `WORKTREE_PREFIX` import source from `./helpers.js` to `./config.js` (line 21) |
| `scripts/autopilot/__tests__/config.test.ts` | New file — 10 loader scenarios |
| `package.json` | `devDependencies`: add `"yaml": "^2.6.0"` |
| `CLAUDE.md` | New "Configuration" subsection under orientation or constraints |
| `docs/config.md` | New schema-reference doc with annotated example |
