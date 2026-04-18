# TOOL-24 — Skill extension points: product-context include + sync allowlist

## Scope

Give consumers of claude-autopilot (fathom, future products) a first-class seam for injecting product-specific context (data-model invariants, shared component catalogs, domain conventions, merge-conflict patterns) into the three review-heavy skills — `plan`, `shakedown`, `ship` — without having to fork the SKILL.md bodies and fight merge conflicts every time `claude-autopilot sync` runs.

**In scope:**
- Add an optional `!cat .claude/skills/_project-context.md 2>/dev/null` include to the three skills that actually need product context (`plan`, `shakedown`, `ship`), placed under the existing rubric include so it sits in the same "quality / context" block the reviewer already reads.
- Ship a template file `.claude/skills/_project-context.md.example` with commented-out scaffolding ("Data model invariants", "Shared components", "Domain conventions", "Merge-conflict resolution patterns") so consumers have a starting point.
- Teach `scripts/autopilot/check-skills.ts` that `!cat <path> 2>/dev/null` is a *graceful optional* include — a missing file at the target path is not a `include.dangling` violation when the `2>/dev/null` suffix is present. Without this, `pnpm check:skills` fails for this repo (which deliberately does not populate `_project-context.md`).
- Add a regression test in `sync.test.ts` verifying that the package's own sync never overwrites a consumer's `_project-context.md` — even under `--force`, even when the example template differs byte-for-byte.
- Document the extension model in `CLAUDE.md` (a short section under an existing heading, not a new top-level section).

**Out of scope (per roadmap):**
- Populating `_project-context.md` in this repo — autopilot is the generic baseline, and keeping the file absent exercises the `2>/dev/null` fallback.
- Migrating fathom's in-skill customizations. That's downstream work after this lands.
- Per-step context files (e.g. separate `_plan-context.md` vs `_ship-context.md`). One file per consumer is enough; split later if volume warrants.
- Adding the include to other skills (`pick`, `charter`, `tidy`, `refit`, `pickup`, `status`, `shipwreck`). Those are procedural, not review-driven — product context would be noise.

## Approach

**Why an underscore-prefixed include file, not frontmatter?**
`.claude/skills/_rubric.md` and `.claude/skills/_review-logic.md` already use this shape: underscore prefix → shared include, not a skill in its own right. The `sync` CLI (`planSync()` in `scripts/autopilot/sync.ts:67`) and the linter (`lintAllSkills()` in `scripts/autopilot/check-skills.ts:201`) both already skip underscore-prefixed directory entries, so the naming convention *is* the allowlist. Adding a new underscore file at `.claude/skills/_project-context.md` inherits this skip behavior for free — no new allowlist code is needed, just a regression test.

**Why `2>/dev/null` instead of shipping an empty file?**
Shipping an empty `_project-context.md` in this repo would force every consumer to overwrite it on first use — exactly the merge-conflict dance we're trying to avoid. Keeping the file absent and swallowing the cat failure with `2>/dev/null` means consumers drop in their own copy with no prior conflict, and upstream `sync` leaves it alone because it lives under the underscore-prefix exclusion.

**Why the `.example` template, not inline docs in CLAUDE.md?**
A template file that consumers `cp` into place is zero-friction. Inline docs are fine as pointers but don't give consumers a starting buffer to fill in.

**Why loosen check-skills rather than require the file to exist?**
The whole point of the `2>/dev/null` idiom is "this include is optional at the consumer's discretion." The linter already reads that suffix (see `INCLUDE_RE` at `scripts/autopilot/check-skills.ts:27`) but only uses it for matching — not for deciding whether a missing file is a violation. Threading that signal through to the `existsSync` check is a 2-line fix.

## Files to change

| Path | Change |
|------|--------|
| `.claude/skills/plan/SKILL.md` | Add `!cat .claude/skills/_project-context.md 2>/dev/null` on a new blank-padded line immediately after the existing `!cat .claude/skills/_rubric.md` (line 33). |
| `.claude/skills/shakedown/SKILL.md` | Same insertion after the rubric include (line 31). Leave the `_review-logic.md` include untouched below it. |
| `.claude/skills/ship/SKILL.md` | Same insertion after the rubric include (line 26). |
| `.claude/skills/_project-context.md.example` | **New file**. Top comment explains purpose + that `sync` leaves it alone. Four commented section stubs: `## Data model invariants`, `## Shared components`, `## Domain conventions`, `## Merge-conflict resolution patterns`. Each section has a one-line hint about what belongs there. No executable markdown directives. |
| `scripts/autopilot/check-skills.ts` | In `INCLUDE_RE` handling (line 154-168), capture the `2>/dev/null` suffix into a second group and suppress `include.dangling` when the group matched. Update the explanatory doc-comment above `INCLUDE_RE`. |
| `scripts/autopilot/__tests__/check-skills.test.ts` | Add one test: `"accepts dangling !cat include when 2>/dev/null suffix is present"`. Uses the same `makeRepoWithSkill` helper as the existing dangling-include test. |
| `scripts/autopilot/__tests__/sync.test.ts` | Add one test in the `runSync` describe block: `"--force never touches _project-context.md or .example"`. Pre-populate both files in the consumer (a `SENTINEL` body and a divergent body in the fake package); run `force: true, dryRun: false`; assert both consumer files are byte-unchanged. |
| `CLAUDE.md` | Add a short subsection under the existing `## Non-obvious conventions` heading (or under `## Orientation` — pick the better fit when writing) describing: "`_project-context.md` is the consumer-side extension point for the three review skills (`plan`, `shakedown`, `ship`). It's read opt-in via `!cat ... 2>/dev/null` and is deliberately absent from this repo so the fallback path is exercised. Upstream `sync` never touches it; consumers copy `_project-context.md.example` to get started." |

**Files explicitly NOT touched:**
- `scripts/autopilot/sync.ts` — no code change needed. The existing underscore-prefix exclusion at `readdirSync(pkgSkillsRoot)` level (line 67) and the `ALLOWED_DEST` regex (`/\/\.claude\/skills\/([^/_][^/]*)\/SKILL\.md(\.upstream)?$/`, line 93) already refuse any write to `_project-context.md` or `.example`. Adding "defense-in-depth" here would be dead code. The regression test in `sync.test.ts` locks this in behaviorally so a future refactor can't silently widen the allowlist.
- `scripts/autopilot/pipeline.ts`, `helpers.ts`, `step-runner.ts` — `expandSkill()` already returns the body verbatim with frontmatter stripped; the new `!cat` line rides the same mechanism as the existing rubric/review-logic includes with zero pipeline changes. (Confirmed: `helpers.ts:9-16` just strips frontmatter and returns the rest.)
- `config.ts` — no new `Step`, no new keys. Step exhaustiveness invariants are untouched.
- `.autopilot.yml` schema — no new configuration surface. This is a skill-layer extension, not a pipeline-layer one.
- The three other review skills' content — only the single include line is added. No other rewording.

## Implementation order

1. **Loosen `check-skills.ts` first.** If we add the new `!cat` line before the linter is graceful, `pnpm check:skills` will fail and block subsequent commits/checkpoints.
2. Add the corresponding test in `check-skills.test.ts`; run it to confirm red→green.
3. Add the `!cat _project-context.md 2>/dev/null` line to the three SKILL.md files.
4. Create `_project-context.md.example` with the four commented stubs.
5. Add the sync regression test in `sync.test.ts` and run it to confirm green.
6. Update `CLAUDE.md` with the extension-model paragraph.
7. Run the full verification suite (see below) and make sure nothing else regressed.

## Test strategy

- **check-skills graceful-fallback**: new unit test asserts a `!cat missing.md 2>/dev/null` include produces zero violations, mirroring the shape of the existing `"flags dangling !cat include"` test at `check-skills.test.ts:97` but with the suffix and no corresponding file.
- **check-skills regression**: the existing `"flags dangling !cat include"` test (no `2>/dev/null`) must still pass — guards against accidentally making the linter permissive for all dangling includes.
- **sync allowlist regression**: new unit test pre-populates the consumer with `_project-context.md` (body `"SENTINEL\n"`) and `_project-context.md.example` (body `"CONSUMER_EXAMPLE\n"`), builds a fake package with *different* bodies for both, runs `runSync({ force: true })`, and asserts both consumer files are byte-identical after. Mirrors the existing `"--force never touches _rubric.md"` test at `sync.test.ts:198`.
- **Live smoke**: after edits, run `pnpm check:skills` against this repo (where `_project-context.md` is absent) → must exit 0, confirming the fallback path actually exercises.
- **Full verification suite** (rubric Verification section):
  - `pnpm check` (biome — only errors block)
  - `pnpm check:skills`
  - `npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/*.test.ts`
  - `npx tsx -e "import('./scripts/autopilot/config.ts')"` / `helpers.ts` / `pipeline.ts` parse-checks
- **Manual pipeline smoke**: not required for this change — no pipeline or SDK behavior changed. The SKILL.md edits only add an optional include line; `expandSkill()` passes it through verbatim exactly as it does for `_rubric.md`.

## Rubric self-check (in-context pass)

**Correct** — *the dimension this pass should catch best, per the review model.*
- Step exhaustiveness: no new `Step` added; `STEPS`/`BUDGETS`/`TURN_LIMITS`/`EFFORT`/`MODEL_PROFILES` untouched. ✓
- Frontmatter stripping: we're editing *bodies*, not frontmatter. `expandSkill()` still strips correctly. ✓
- Worktree isolation: no pipeline or hook changes. ✓
- Rate-limit parking: no new pipeline exit path. ✓
- Phantom ship guard: this branch adds TS + markdown changes beyond `docs/plans/`, so `hasDeliverableCommits()` sees real work and ship fires normally. ✓
- No hardcoded model strings added. ✓
- `parseVerdict` default (APPROVE on no match): untouched. ✓
- Sync allowlist invariant: the underscore-prefix rule is the load-bearing invariant. This plan does not widen it, and adds a regression test to prevent future widening. ✓
- check-skills `include.dangling` semantics: the change narrows the rule to "dangling AND no graceful suffix." The existing test for plain dangling includes stays green, locking in the old behavior for plain includes. ✓

**Well-typed** — No `any` added. The check-skills change is a regex group index and a boolean guard; types flow naturally. No `as` casts. ✓

**Well-factored** — The change sits entirely in the skill markdown + one linter + one template file. No cross-module coupling. No new helper needed; existing `existsSync`/regex plumbing suffices. ✓

**Well-tested** — Two new unit tests, both in the `scripts/autopilot/__tests__/` convention using `node:test`. Both are pure, no integration needed. ✓

**Concise** — No new module, no new helper, no new config key. A single 2-line linter tweak, three one-line SKILL.md additions, one template file, one CLAUDE.md paragraph. ~5 files touched for a skill-layer seam. ✓

**Idioms** — Deferred to `/shakedown`'s forked review per the review model. My own in-context eye will miss convention drift; fresh eyes own this. I'll flag only the deliberate choices so shakedown can agree or push back:
- Chose `2>/dev/null` over checking-in an empty file (rationale in Approach).
- Chose not to add sync.ts defense-in-depth (rationale in Files-NOT-touched).
- Placed include *immediately after* rubric without a new heading (preserves "one logical block of quality context" framing the roadmap asked for).

## Self-review notes

On re-read, I tightened three things:

1. **Initially** I had planned to edit `scripts/autopilot/sync.ts` to add an explicit `_project-context.md` to an allowlist, mirroring the roadmap's literal wording. **Revised**: confirmed by reading `sync.ts:67` and `sync.ts:93` that the underscore-prefix exclusion + `ALLOWED_DEST` regex already cover this. Adding an explicit allowlist entry would be dead code (YAGNI per the Concise dimension) and would actually *weaken* the invariant by suggesting the underscore rule isn't load-bearing. Changed the plan to rely on the existing mechanism and prove it via the sync test.

2. **Initially** I hadn't identified the `check-skills.ts` blocker — I assumed the `2>/dev/null` suffix was enough and only realized on reading `check-skills.ts:157-168` that the linter still flags dangling even with the suffix. Added that as step 1 of the implementation order so the rest of the work isn't blocked by a failing `pnpm check:skills`.

3. **Initially** I had the include going into every skill. **Revised** per the roadmap's explicit scoping to three review-heavy skills (`plan`, `shakedown`, `ship`). `pick`/`charter`/etc. don't need product context and adding it there would just bloat prompts with empty `cat` output.
