# TOOL-5 — Skill body linter

Lint `.claude/skills/*/SKILL.md` files for frontmatter validity, unknown fields, dangling `!cat` references, and `$ARGUMENTS` usage without an `argument-hint`.

## Scope

**In scope:**
- New module `scripts/autopilot/check-skills.ts` exporting pure lint functions + a runnable entry point.
- New CLI binding `pnpm check:skills` (invokes the module via `tsx`).
- Unit tests at `scripts/autopilot/__tests__/check-skills.test.ts`.
- Update `.claude/skills/_rubric.md` Verification block to list `pnpm check:skills`.

**Out of scope (per roadmap):**
- Validating prose content.
- General markdown linting.
- Auto-fix — this is a pure checker.
- Git hook integration (pre-commit already runs Biome on TS; skill linting can be added to hooks in a later cycle if desired).

**Explicitly touched files:**
- `scripts/autopilot/check-skills.ts` (new)
- `scripts/autopilot/__tests__/check-skills.test.ts` (new)
- `package.json` — add `check:skills` script
- `.claude/skills/_rubric.md` — add command to Verification block

## Approach

### Module shape

Mirror the `sync.ts` / `stats.ts` pattern: pure functions + types exported for tests, plus a `main()` CLI entry. No class hierarchy; one file, ~150 lines.

```ts
// scripts/autopilot/check-skills.ts
export type Violation = { file: string; line?: number; rule: string; message: string };
export type SkillSchema = { required: readonly string[]; optional: readonly string[] };

export const SKILL_SCHEMA: SkillSchema = {
  required: ["name", "description", "allowed-tools"],
  optional: ["argument-hint", "context", "agent", "effort", "disable-model-invocation"],
};

export function lintSkillFile(absPath: string, repoRoot: string): Violation[];
export function lintAllSkills(repoRoot: string): Violation[];
export function formatViolations(violations: Violation[]): string;
export async function main(argv: string[]): Promise<number>;  // exit code
```

### Rules enforced

For each `SKILL.md`:

1. **Frontmatter exists.** Body must start with `---\n...\n---`. Missing → violation `frontmatter.missing`.
2. **Frontmatter parses as YAML.** Parse errors → `frontmatter.invalid-yaml` with message from the `yaml` library.
3. **Required fields present and non-empty strings** (`name`, `description`, `allowed-tools`). Missing → `frontmatter.required-missing`; empty/wrong-type → `frontmatter.required-invalid`.
4. **No unknown fields.** Any key outside `required ∪ optional` → `frontmatter.unknown-field`.
5. **`name` matches directory.** `frontmatter.name != basename(dirname(path))` → `frontmatter.name-mismatch`.
6. **Optional field type checks** (cheap, prevents silent typos) — emit `frontmatter.type-mismatch`:
   - `disable-model-invocation` must be boolean.
   - `context`, if set, must equal `"fork"` (only value used today).
   - `effort`, if set, must be one of `"min" | "low" | "medium" | "high" | "max"`.
   - `agent`, if set, must be a non-empty string.
   - `argument-hint`, if set, must be a non-empty string.
7. **`!cat` references resolve.** Scan the body for inline includes matching ``!`cat <path>(?: 2>/dev/null)?`\`` (and the bare form seen in `/plan` and `/shakedown`). Path is resolved relative to `repoRoot`. Missing file → `include.dangling` with line number.
8. **`$ARGUMENTS` requires `argument-hint`.** If `$ARGUMENTS` appears in the body but frontmatter lacks a non-empty `argument-hint`, emit `arguments.no-hint` with the first occurrence's line number.

### Parser detail

- Frontmatter: regex `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/` captures the YAML block. Parse via `yaml.parse()` (already a dep).
- Reuse `expandSkill`-style frontmatter handling? No — `expandSkill` strips; here we need the frontmatter contents and line numbers. Different job, own parser.
- `!cat` regex: `/!\x60cat\s+([^\x60\s]+)(?:\s+2>\/dev\/null)?\x60/g`. `\x60` = backtick to keep the regex source clean. Line numbers via counting `\n`s up to the match index.
- `$ARGUMENTS` detection: plain `body.indexOf("$ARGUMENTS")`; line count likewise.

### Output format

```
.claude/skills/plan/SKILL.md:12 [frontmatter.unknown-field] unknown field "priority"
.claude/skills/ship/SKILL.md [frontmatter.required-missing] missing "description"
.claude/skills/charter/SKILL.md:42 [include.dangling] !cat .claude/skills/_missing.md — file not found

3 violations in 2 files
```

One line per violation: `<file>[:<line>] [<rule>] <message>`. Single-space separators — no manual column padding. Empty output + exit 0 on success; summary line + exit 1 on any violation.

### CLI wiring

- `scripts/autopilot/check-skills.ts` ends with the `sync.ts` direct-invocation idiom (path-normalized, robust to `file://` prefix differences):
  ```ts
  const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  if (isDirectInvocation) {
    main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
  }
  ```
- `package.json` scripts: `"check:skills": "tsx scripts/autopilot/check-skills.ts"`.
- Resolves `repoRoot` via the existing `REPO` constant from `config.ts` (consistent with other scripts; keeps `config.ts` the single source of repo path).

### Ordering of violations

Sort by `(file, line ?? 0, rule)` so output is deterministic — tests can assert on exact strings.

## Files to change

| File | Change |
|------|--------|
| `scripts/autopilot/check-skills.ts` | New — lint logic + CLI entry |
| `scripts/autopilot/__tests__/check-skills.test.ts` | New — unit tests |
| `package.json` | Add `check:skills` script |
| `.claude/skills/_rubric.md` | Add `pnpm check:skills` to Verification block |

No changes to `helpers.ts`, `config.ts`, `pipeline.ts`, or any existing SKILL.md (all current skills should already pass).

## Test strategy

`node:test` + `tsx --test`, matching existing convention. All tests use temp directories built with `mkdtempSync` (mirrors `sync.test.ts`).

**Unit tests on the pure lint function** — construct a fake skill on disk, call `lintSkillFile`, assert violation shape.

1. Valid skill (all required, no unknowns, resolved `!cat`, `$ARGUMENTS` with `argument-hint`) → `[]`.
2. Missing frontmatter → one `frontmatter.missing` violation.
3. Unparseable YAML → `frontmatter.invalid-yaml`.
4. Missing `description` → `frontmatter.required-missing`.
5. Unknown field `priority` → `frontmatter.unknown-field`.
6. `name` field differs from directory → `frontmatter.name-mismatch`.
7. `disable-model-invocation: "true"` (string, not bool) → `frontmatter.type-mismatch`.
8. Dangling `!cat .claude/skills/_ghost.md` → `include.dangling` with correct line number.
9. `$ARGUMENTS` used, no `argument-hint` → `arguments.no-hint`.
10. `$ARGUMENTS` used, `argument-hint` present → no violation.

**Integration test** — run `lintAllSkills(REAL_REPO_ROOT)` against this repo's actual skills and assert `[]`. This is the regression guard: adding a malformed skill fails CI. Matches the "smoke-test real package" pattern in `sync.test.ts`.

## Rubric self-check

- **Well-typed** ✓ — `Violation` is a plain record; `SKILL_SCHEMA` uses `readonly` tuples so unknown-field detection compares against the literal list. No `any`. Exported functions have explicit return types. YAML parse output narrowed via type guards, not `as` casts.
- **Well-tested** ✓ — pure lint logic has unit tests plus a real-repo integration test. CLI `main()` is thin; covered by running it against the real repo via the integration test path.
- **Well-factored** ✓ — single-purpose module, no cross-dependencies beyond `yaml` (existing dep) and `config.REPO`. No business logic bleeds into `helpers.ts`. Follows the `sync.ts` / `stats.ts` pattern (pure + CLI tail).
- **Well-tested edge cases** ✓ — regex-driven parsers flagged by the rubric (`$ARGUMENTS` detection, `!cat` extraction, frontmatter boundary) each have at least one dedicated test.
- **Correct** ✓ — No interaction with pipeline invariants (STEPS, expandSkill, worktree isolation, ship guards, rate-limit parking). Linter is a pure read-only checker; cannot corrupt sibling worktrees or alter ship behavior.
- **Concise** ✓ — one file, ~150 LOC. No abstraction layer for "multiple linter backends". Rules are inlined. No `--fix` flag, no config file (rubric schema is a constant).
- **Idioms** — deferred to `/shakedown`.

### Self-review revisions

- **Revision 1:** Initial draft used `gray-matter` for frontmatter parsing. Swapped to `yaml` because it's already a dep (used by `config.ts`) — no new dependency needed, and we only need YAML + manual delimiter detection. Rule of "no premature abstraction" applies.
- **Revision 2:** Added rule #6 (optional field type checks). Without it, a typo like `disable-model-invocation: "tru"` passes silently. The roadmap didn't explicitly ask for this, but ~15 lines of code prevent a real class of drift.
- **Revision 3:** Added a deterministic sort on output so test assertions aren't flaky — violations can be produced in any order depending on rule evaluation, and I want golden-string tests.
- **Revision 4:** Decided against wiring this into the pre-commit hook. The rubric's `pnpm check:skills` entry + `pnpm autopilot` verification pass is enough; a pre-commit hook adds friction for skill edits.
- **Revision 5:** Confirmed `STEPS` doesn't change — no `BUDGETS`/`TURN_LIMITS`/`EFFORT`/`MODEL_PROFILES` updates needed. Linter runs outside the step graph.
