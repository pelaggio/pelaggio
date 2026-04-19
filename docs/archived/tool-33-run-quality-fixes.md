# TOOL-33 — Autopilot run-quality fixes from Fathom telemetry

Four independent fixes from the 2026-04-18 fathom batch. Bundled because they share one goal (cleaner next batch) and each touches a small, non-overlapping surface.

## Scope

**In scope**
1. Ship step — bump `TURN_LIMITS.ship` 40 → 60, switch `MODEL_PROFILES.standard.ship` Sonnet-4.6 → Opus-4.7.
2. Pick rejection reasons — replace the single `error: "nothing to pick"` with tagged reasons (`blocked`, `unknown-id`, `already-done`, `worktree-exists`, `queue-empty`), and sort them into *recoverable* (worker continues) vs *fatal* (worker halts).
3. Dynamic implement turn budget — compute per-cycle from the plan's file count: `clamp(2 × files + 60, 100, 250)`; falls back to the static `TURN_LIMITS.implement` when the plan is absent or files can't be parsed.
4. Edit-loop threshold — raise `EDIT_LOOP_THRESHOLD` 12 → 22.

**Out of scope**
- Rate-limit backoff / batch saturation (roadmap says explicitly deferred).
- Telemetry schema changes beyond the one new `error` tag surface (TOOL-25 already covers measurement).
- `/shakedown-plan` or `/shakedown-code` budgets (no evidence in the batch).
- Changing the implement budget computation to key off actual edit counts mid-run — the roadmap is explicit that the plan is on disk *before* implement starts, so static-from-plan is enough.

## Approach

### 1. Ship config bump — `config.ts` only

`DEFAULTS.turnLimits.ship: 40` → `60`; `DEFAULTS.modelProfiles.standard.ship: SONNET` → `OPUS`. The `quick` profile keeps Sonnet for ship (speed > depth when scope is small). No test needed — `config.ts` parses at import; existing step-exhaustiveness is already enforced by the `satisfies Record<Step, T>` constraints.

### 2. Pick rejection reasons

Today `pipeline.ts:163` emits `error: "pick failed"` on SDK failure and `:166` emits `error: "nothing to pick"` when the skill's output does not match `/claimed|worktree add|successfully/i`. That single string masks four distinct cases (blocked, unknown-ID, already done, worktree exists) plus the legitimate `queue-empty` from `/pick next` with no unblocked items.

**Dropped from the union**: `ambiguous`. The skill has no ambiguity path today — fuzzy topic match in `/pick next <topic>` picks the top-ranked hit; a direct `/pick <ID>` lookup is exact-match. A hypothetical fuzzy collision can fold into `unknown-id` without losing fidelity. Adding a tag without a producing code path is dead code.

**Design choice — structured trailing line in the skill, parsed by the pipeline.** The `/pick` skill runs inside a Claude SDK session; its stdout is the only channel back. Two alternatives rejected:

- *SDK tool-call emission* — richer, but would require a custom tool surface; too heavy for one scalar.
- *Regex over skill prose* — brittle; drifts every time the skill wording changes. Structured trailing line is a one-line convention we control.

**Skill change** (`.claude/skills/pick/SKILL.md`): on every exit path, emit a final line:

```
pick-result: <tag>
```

where `<tag>` is one of `claimed | blocked | unknown-id | already-done | worktree-exists | queue-empty`. Map each existing exit path in the skill body:

- Successful branch+worktree creation (end of **Claim**) → `claimed`
- `/pick <ID>` where the row's Deps column starts with `blocked:` → `blocked`
- `/pick <ID>` where the ID is absent from task-index.md's **Open items** table but appears in the **Recently completed** list → `already-done` (new detection: after the Open-items lookup, cross-check the Recently-completed list before giving up)
- `/pick <ID>` where the ID is in neither list → `unknown-id`
- `/pick <ID>` where `feat/<id-lower>-*` branch already exists (the "branch already exists" branch in the skill) → `worktree-exists`
- `/pick next` whose ranked-list is empty after filtering blocked items → `queue-empty`

**Pipeline change** (`pipeline.ts`): add a pure helper in `helpers.ts`:

```ts
export type PickReason = "claimed" | "blocked" | "unknown-id" | "already-done" | "worktree-exists" | "queue-empty";
export function parsePickResult(text: string): PickReason | null;
```

It reads the last `pick-result: <tag>` occurrence in the combined text (skill can restate earlier; last-wins). Unknown tag → `null`.

Rewrite the pick block in `pipeline.ts:158-176`:
- On `!pick.ok`: keep `error: "pick failed"` (SDK-side failure, unrelated to skill logic).
- When skill succeeded: call `parsePickResult(pickAll)`. If `claimed`, fall through to item-ID parsing. Otherwise `finish({ error: \`pick:${reason ?? "unknown"}\` })`.
- Drop the `/claimed|worktree add|successfully/i` regex fallback entirely — the structured tag replaces it. (The skill is fully under our control; there are no external `/pick` callers depending on the old string.)

**Recoverable-vs-fatal policy** (the point of the split). Update `RECOVERABLE` at `pipeline.ts:590` from `new Set(["plan needs rethink", "nothing to pick", "parked"])` to the new union:

```ts
const RECOVERABLE = new Set([
    "plan needs rethink",
    "parked",
    "pick:queue-empty",      // pool dry, but another cycle might find more
    "pick:worktree-exists",  // already in flight — try next item
    "pick:already-done",     // already completed — try next item
    "pick:unknown",          // parser fallback when tag missing/unrecognised (preserve old lenient behavior)
]);
```

`pick:unknown-id` and `pick:blocked` are deliberately **fatal** — typos in `--item X,Y,Z` and user-requested blocked items should halt loudly so the caller sees them, matching the roadmap's "`--item X` invocations fail loud on typos" requirement.

**Log shape**: `error` becomes `pick:blocked`, `pick:unknown-id`, etc. Existing JSONL readers that treat `error` as free-form keep working; `summary.ts` / any downstream summariser that groups by exact-string will auto-split. No new field needed.

**Tests**:
- Extend `__tests__/helpers.test.ts` with `parsePickResult` cases — each tag, multiple occurrences (last-wins), unknown tag, no tag (→ null), whitespace/casing tolerance.
- Update `__tests__/pipeline.test.ts:459` ("nothing to pick — aborts…") to assert `result.error === "pick:unknown"` (or pick a specific tag and include it in the mock's pick output). Refresh the test's mock pick text to emit `pick-result: queue-empty` and flip the assertion to `"pick:queue-empty"` so the test exercises the new contract rather than the parser-fallback path.
- Update `__tests__/orchestrator.test.ts:83-86` ("recoverable error … keeps worker pulling subsequent cycles") to use `error: "pick:queue-empty"` — the behavioural claim is unchanged (still recoverable), only the error key moves.

### 3. Dynamic implement turn budget

**Computation**: count distinct file paths listed as implementation targets in the plan body. Heuristic:

1. If the plan has a markdown table whose header row contains the word `Files` (case-insensitive) — e.g. "Files to change" — collect the first column of data rows, de-dup, count.
2. Otherwise, match path-shaped tokens across the whole plan body with a project-style extension (`.ts`, `.tsx`, `.js`, `.md`, `.yml`, `.yaml`, `.json`, `.sh`, `.py`), excluding paths starting with `docs/plans/` (plan self-references) and fenced example snippets. De-dup.

Budget formula from roadmap: `clamp(2 × files + 60, 100, 250)`. If the helper returns `0` or the plan file is missing, fall through to `TURN_LIMITS.implement` (current static default).

**Helper** — new pure function in `helpers.ts`:

```ts
export function countPlanFiles(body: string): number;
export function computeImplementTurns(planBody: string | null, fallback: number): number;
```

Both unit-tested; the second one is a thin formula wrapper but tests pin the clamp bounds.

**Wiring**: extend `RunStepOpts` in `step-runner.ts` with `maxTurnsOverride?: number`, used as `const turns = opts.maxTurnsOverride ?? TURN_LIMITS[name];` at `step-runner.ts:46`. `pipeline.ts` reads the plan body before the implement loop (it already resolves `planPath` at `:263`), computes the override, and passes it through the `runStep` call chain.

**Passthrough path** — `runStep` today is invoked via `pipeline.ts`'s local `step()` helper (line ~90, implicit from earlier read). The `step()` helper already takes an `opts` bag (used for `{ attempt, commitLabel }`). Extend with an optional `maxTurnsOverride`, pass through to `runStep`. No change to the log shape — the actual budget used will be visible via `steps[].turns` (already recorded) and the step-header emit (already includes `maxTurns`).

**Observability**: the step-header emit at `step-runner.ts:51-58` already echoes `maxTurns` to the event stream, so dynamic budgets show up in verbose/TUI output automatically.

**Tests**: `countPlanFiles` — table-driven, include a real-looking plan sample with mixed bullet + table + fenced-code to catch the false-positive trap. `computeImplementTurns` — boundary tests at 0, small, large, cap.

### 4. Edit-loop threshold

One-line change in `step-runner.ts`: `EDIT_LOOP_THRESHOLD = 12` → `22`. Midpoint of the roadmap's 20-25 band. Explicitly rejecting the "relative to total turn count" alternative: it adds a cross-cutting state dependency (threshold varies during the run) for no measured benefit over a fixed ceiling.

## Files to change

| Path | Change |
|------|--------|
| `scripts/autopilot/config.ts` | `turnLimits.ship: 40 → 60`; `modelProfiles.standard.ship: SONNET → OPUS` |
| `scripts/autopilot/helpers.ts` | Add `parsePickResult`, `countPlanFiles`, `computeImplementTurns` + `PickReason` type |
| `scripts/autopilot/pipeline.ts` | Rewrite pick exit handling (`:158-176`); expand `RECOVERABLE` set (`:590`); compute + pass `maxTurnsOverride` before the implement loop (`:260-317`) |
| `scripts/autopilot/step-runner.ts` | Add `maxTurnsOverride?: number` to `RunStepOpts`; use at `:46`; bump `EDIT_LOOP_THRESHOLD` to 22 |
| `.claude/skills/pick/SKILL.md` | Document `pick-result: <tag>` trailing line; specify tag for each exit path |
| `scripts/autopilot/__tests__/helpers.test.ts` | Tests for the three new helpers |
| `scripts/autopilot/__tests__/pipeline.test.ts` | Update `"nothing to pick"` assertion (`:459`) to the new tag-based error string |
| `scripts/autopilot/__tests__/orchestrator.test.ts` | Update recoverable-worker-continuation test (`:83-86`) to use `pick:queue-empty` |

No type or module-boundary violations. `helpers.ts` stays pure (no SDK, no I/O beyond existing shell wrappers).

## Test strategy

- **Unit tests** (all three new helpers) via the existing `node:test` + `npx tsx --test` setup. Each helper is regex- or math-driven — no I/O — so tests stay in-process.
- **Integration smoke** — `pnpm autopilot --dry-run --cycles 1` after the changes to confirm nothing crashed at import. Dry-run exercises `loadConfig`, import graph, and the `step()` wiring without burning SDK turns.
- **No integration test for the pick-tag round-trip** — would require mocking the SDK; parity with current policy (rubric says "Pipeline integration is harder to test … acceptable to leave untested"). The unit tests on `parsePickResult` cover the pure half; the skill-side half is reviewed by `/shakedown`.
- **Manual validation**: after merge, next fathom batch is the measurement surface. Roadmap entry makes the success criterion explicit (shipwreck rate ↓, typo'd `--item` fails loud, MAN-1-style 200-turn walls rare).

## Rubric self-check

- **Well-typed**: `PickReason` is a literal union; `parsePickResult` returns `PickReason | null`, not a bare string. `RunStepOpts.maxTurnsOverride` is `number | undefined`. No `any`. Existing `satisfies Record<Step, T>` on config blocks catches any step-exhaustiveness slip in the ship bump.
- **Well-tested**: every new helper has unit tests; the lone untested surface (skill body + pipeline parse path) is accepted per rubric's pipeline-integration carve-out. Edge cases pinned: unknown tag, missing tag, whitespace tolerance, clamp bounds, table-vs-bullet plan layouts.
- **Well-factored**: no new module. Pure helpers go in `helpers.ts` (correct home). Runtime override on `RunStepOpts` stays in `step-runner.ts`. `config.ts` stays declarative — no business logic leaks in. Skill prose change is localised to `/pick`.
- **Correct**: step exhaustiveness untouched (ship key already present in all four Step records). `expandSkill()` frontmatter stripping unaffected — `pick-result:` is in the body. Worktree isolation unaffected. Rate-limit parking: the new pick exit paths run *before* any worktree is created (`pipeline.ts:149-176`), so `parkExit()` is not required — the mutex is released in `finally` as before. Phantom-ship guard unaffected (ship changes are budget-only). Verdict-parsing default unchanged.
- **Concise**: one-line threshold bump, one-line ship model swap, one-line ship turns bump. Pick handling is a rewrite of ~3 lines → ~8 lines (still small; the old regex goes away cleanly). Dynamic-turn plumbing adds one `RunStepOpts` field + one `??` in step-runner + one `computeImplementTurns` call site. No new files, no new module boundaries, no dead-code fallbacks: the `parsePickResult(...) ?? "unknown"` is genuine defence against a skill emitting an unrecognised tag, not hypothetical backwards-compat.

## What changed in self-review

- Initial draft floated mutating `TURN_LIMITS.implement` directly before the implement step. Rejected: leaks into concurrent worker cycles in `--parallel` mode (`TURN_LIMITS` is a module-level singleton). Switched to a per-call `maxTurnsOverride` in `RunStepOpts` — isolated per `runStep()` invocation.
- Initial draft proposed a second JSONL field `pickReason` alongside `error`. Rejected as redundant — mapping reasons into `error` as `pick:<tag>` is one field, one source of truth, and existing log readers already treat `error` as free-form.
- Added explicit "last-wins" semantics for multiple `pick-result:` lines so the skill can safely restate the tag in a summary paragraph without tripping the parser.
- Added explicit clamp-to-static-fallback when the plan is absent — without it, a `--resume` that starts at `implement` with no plan on disk would get a 60-turn budget and near-certainly fail.
- Shakedown round 1: the pick rewrite initially left `RECOVERABLE` at `pipeline.ts:590` pointing at the old literal `"nothing to pick"`. Missed that the worker loop (`:646`) uses this set to decide whether to continue after a non-claim — without an update every `pick:queue-empty` would halt parallel batches. Expanded the set and added an explicit recoverable-vs-fatal policy so `--item TYPO,REAL` halts loudly on the typo instead of silently skipping it (the roadmap's whole point).
- Shakedown round 1: dropped `ambiguous` from the tag union (no producing code path in the skill today → dead tag) and spelled out `already-done` detection (cross-check task-index.md's Recently-completed list) since neither was explicit in the skill-change section.
- Shakedown round 1: the existing `pipeline.test.ts` and `orchestrator.test.ts` asserted on the old `"nothing to pick"` string literal; flagged those edits in the Files-to-change table so the cycle doesn't ship with red tests.
