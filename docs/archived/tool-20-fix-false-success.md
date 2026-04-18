# TOOL-20 — Fix false-success on cycles that ship nothing

## Problem

On 2026-04-18 the TOOL-7 autopilot cycle logged `completed: true, verdict: APPROVE, ship.ok: true` and burned $2.51 — yet the `feat/tool-7-rubric-idioms-review-docs` branch contained only the `/plan` commit. No implementation, no merge, no task-index update. The roadmap stayed consistent only because `/ship`'s own skill body stopped partway and never wrote to the task index.

Root-cause hypothesis (confirmed by reading `step-runner.ts:211-217`): `ok = subtype === "success"` means "SDK session finished normally," **not** "the step achieved its goal." A `/ship` skill that hits its own phantom-ship guard and returns a polite "stopping because no code" message still finishes with `subtype: "success"` — so `ok: true` flows back up, `finish({ completed: ship.ok })` marks the cycle done, and the log lies.

The `/ship` skill already has a phantom-ship guard (ship/SKILL.md:59-63). It was either not followed reliably by the model, or it was followed but the skill's "stop and report" return path still reached a normal session end. Either way, the orchestration layer has no defense of its own, so a skill-body regression (or model regression) silently corrupts the cycle log.

## Scope

**In scope**
- Pipeline-level pre-condition before invoking `ship`: the feature branch must contain at least one commit touching non-docs files relative to `main`.
- On failure, mark the cycle `completed: false` with a clear error message — do not invoke the ship step at all.
- Regression test in `pipeline.test.ts` that exercises the "nothing to ship" path.
- Unit test for the new helper.
- Tighten wording of `/ship`'s phantom-ship guard to stress that stopping is mandatory, not advisory — defense in depth.

**Out of scope**
- Cleaning up the TOOL-7 ghost worktree (user decision).
- Retrying TOOL-7's actual work (separate `--resume TOOL-7`).
- Changing how `step-runner.ts` computes `ok` — `subtype === "success"` is the correct signal for "session completed"; semantic post-conditions belong in the pipeline.
- Post-ship verification that main received the merge — adds complexity (branch may be deleted by then) and is subsumed by the pre-condition: if we gate on the branch having deliverable commits, a successful `/ship` will have merged them.

## Approach

### Why a pre-condition, not a post-condition

The roadmap entry says "add a post-condition to the ship step." Reinterpreting this as a pre-condition check run by the pipeline:

1. **Saves SDK cost.** Invoking `ship` burns ~$0.10–$1 of model time. If the branch has nothing to ship, we detect it synchronously in <5ms.
2. **Branch state is available before ship.** After ship merges and cleans up, the feat branch may be deleted — forensics get harder.
3. **Covers more failure modes.** A post-condition only fires if ship runs to completion. A pre-condition also catches the case where ship errors out before its own guard — and any future bug that makes ship silently return ok with no merge.
4. **Matches existing pattern.** `pick` already has a pre-condition ("nothing to pick" via regex on `pick.text`) that aborts the cycle before proceeding. Adding a ship-pre-condition is the same shape.

### The invariant

*A cycle can only be marked `completed: true` if, immediately before ship runs, the feature branch contains at least one commit that touches a file outside `docs/` and with an extension other than `.md`.*

This matches the existing phantom-guard pattern in `/ship`'s SKILL.md:60 (`grep -v '^docs/' | grep -v '\.md$'`), so the skill and the pipeline agree on what counts as "deliverable." Changes that are purely documentation should not flow through autopilot cycles anyway — they don't need a plan, shakedown, or ship squash.

### Helper — `hasDeliverableCommits`

In `scripts/autopilot/helpers.ts`:

```typescript
/**
 * True iff the feat branch has at least one commit beyond main that touches
 * a file outside docs/ and not ending in .md. Matches the phantom-ship guard
 * in .claude/skills/ship/SKILL.md. Returns false on any git error.
 */
export function hasDeliverableCommits(worktree: string): boolean {
	try {
		const files = execSync("git diff --name-only main..HEAD", {
			cwd: worktree,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (!files) return false;
		return files.split("\n").some((f) => !f.startsWith("docs/") && !f.endsWith(".md"));
	} catch {
		return false;
	}
}
```

Pure-ish (shell wrapper), no SDK calls, no event emission — fits `helpers.ts` module boundary.

### Pipeline integration — `pipeline.ts`

Between the shakedown-code block (ends at line 378) and the ship invocation (line 386), add:

```typescript
if (!opts.dryRun && !hasDeliverableCommits(worktree!)) {
	log("⚠ no deliverable commits on branch — skipping ship");
	return finish({
		itemId,
		completed: false,
		cost,
		verdict,
		error: "nothing to ship: branch has no non-docs commits",
	});
}
```

Placement: after the `parkExit()` check but before `log("shipping...")` so a parked cycle still parks cleanly, and so the error message lands in the log before any ship cost is incurred.

The `dryRun` bypass mirrors other ship-adjacent checks (e.g., `!opts.dryRun && !existsSync(worktree)`).

### `/ship` skill wording — defense in depth

Current text (ship/SKILL.md:59-63):
```
**Phantom ship guard**: after squashing, verify the commit contains non-docs code:
...
If the output is empty (only docs files changed), **stop and report** — the feature branch has no implementation. Do not proceed with merge.
```

Update to make it unambiguous that stopping means aborting, not "mention it and continue." Current phrasing leaves room for "stop and report" → "report in the summary and proceed." Proposed:

```
**Phantom ship guard**: after squashing, verify the commit contains non-docs code:
...
If the output is empty (only docs files changed), **abort immediately**: do NOT merge, do NOT update the task index, do NOT push. Emit a one-line error ("phantom ship: no deliverable commits") and exit. The pipeline has an identical pre-check that will flag the cycle as failed.
```

This is only a wording tightening — the behavior was already specified, the enforcement now lives in the pipeline.

## Files to change

| File | Change |
|------|--------|
| `scripts/autopilot/helpers.ts` | Add `hasDeliverableCommits(worktree): boolean` |
| `scripts/autopilot/pipeline.ts` | Import helper; add pre-ship guard + early `finish(...)` |
| `scripts/autopilot/__tests__/helpers.test.ts` | Unit tests for `hasDeliverableCommits` across 4 cases |
| `scripts/autopilot/__tests__/pipeline.test.ts` | Integration test: implement writes docs-only → ship not called, cycle failed |
| `scripts/autopilot/__tests__/mocks.ts` | Update `makeTempGitRepo` to create a `feat/tool-99` branch so `main..HEAD` diff is meaningful |
| `scripts/autopilot/__tests__/pipeline.test.ts` | Add `writes: { "impl.txt": "..." }` to the happy-path `implement` mock so the new guard sees a non-docs commit (existing test has `{ ok: true }` with no writes — would break) |
| `.claude/skills/ship/SKILL.md` | Tighten phantom-guard wording (wording-only) |
| `CLAUDE.md` | Update "Phantom ship guard" invariant line to note pipeline-level pre-check is primary; skill guard is defense in depth |
| `.claude/skills/_rubric.md` | Same update to the "Phantom ship guard" bullet in the Correct section |

No changes to `config.ts`, `types.ts`, `step-runner.ts`. No new Step. No schema changes. No i18n.

## Test strategy

### Unit — `helpers.test.ts`

Using `makeTempGitRepo`-style helpers (inline, since the unit test file doesn't import from `mocks.ts` today):

1. **Fresh branch with code commit** — write `src/foo.ts`, commit on feat branch → `true`.
2. **Branch with only plan commit** — write `docs/plans/x.md`, commit → `false`.
3. **Branch with only markdown** — write `README.md`, commit → `false`.
4. **Branch identical to main** — no commits ahead → `false`.
5. **Invalid worktree** — non-existent directory → `false` (no throw).

### Integration — `pipeline.test.ts`

New test: "aborts ship when branch has no deliverable commits"

- Mock all five steps with `ok: true`.
- `implement` mock writes `docs/plans/tool-99.md` instead of code — this becomes the implementation checkpoint commit (docs-only).
- Assert:
  - `calls` does NOT include `ship`.
  - `result.completed === false`.
  - `result.error` matches `/nothing to ship/`.
  - Log entry has `completed: false` and the same error.

### Test-infra adjustment — `mocks.ts`

`makeTempGitRepo` today does `git init -b main` plus an empty commit — so HEAD equals main and `git diff main..HEAD` is always empty. For the new guard to behave realistically in tests, the helper must create an implementation branch:

```typescript
execSync("git checkout -b feat/tool-99", { cwd: dir });
```

after the initial `main` commit.

**Existing happy-path test needs a write.** `runPipeline — happy path` currently mocks `implement: { ok: true }` with no `writes`. After the guard lands, a no-writes implement produces no checkpoint commit, so `git diff main..HEAD` stays empty and ship is skipped — the test's "all 5 steps ran" assertion fails. Fix by adding `writes: { "impl.txt": "x" }` to that mock. The turn-limit retry test already writes impl-a.txt/impl-b.txt and continues to work unchanged. The RETHINK and rate-limit park tests don't reach the ship block, so they're unaffected.

### Verification commands (from `_rubric.md`)

```
npx tsx --test scripts/autopilot/__tests__/*.test.ts
npx tsx -e "import('./scripts/autopilot/helpers.ts')"
npx tsx -e "import('./scripts/autopilot/pipeline.ts')"
```

All must pass.

## Rubric self-check

- **Well-typed** — `hasDeliverableCommits(worktree: string): boolean`. Explicit return type. No `any`. No new type unions needed. ✓
- **Well-tested** — Unit tests cover the 4+1 edge cases. Integration test exercises the new pipeline branch end-to-end via the existing SDK mock. ✓
- **Well-factored** — Helper in `helpers.ts` (shell wrapper, pure-ish), guard call in `pipeline.ts` (orchestration). Matches existing module boundaries. ✓
- **Idiomatic** — `execSync` + `try/catch` + `.trim().split("\n")` mirrors `listWorktrees` and `findPlanPath`. `.js` relative import convention preserved. ✓
- **Correct** — The invariant "completed iff branch had deliverable commits before ship" is now enforced in the pipeline layer where it can't be silently bypassed by a skill regression. The existing `/ship` phantom-guard remains as defense in depth. Update CLAUDE.md's "Phantom ship guard" bullet and `_rubric.md`'s matching line so the docs name the pipeline as the enforcement point and call the skill guard defense-in-depth. ✓
- **Concise** — ~12 lines of helper, ~8 lines of pipeline call-site, ~40 lines of tests. No new types, no new config, no abstraction layers. ✓

### Concerns reviewed

- **Could a legitimate cycle touch only docs?** Unlikely in practice — the pipeline is for feature/bugfix work, not docs-only commits. If it happens, the user can ship manually without autopilot, or we'd revisit the invariant. Not a blocker.
- **What about `--pr` mode?** PR mode still needs code to push. Same invariant applies; the guard runs unconditionally before the ship step regardless of `opts.pr`.
- **What if `main` doesn't exist in the worktree?** `git diff main..HEAD` fails → helper returns `false` → cycle fails with "nothing to ship." That's the safe default; a worktree that can't resolve main is broken state.
- **Interaction with `--resume`?** Resume re-enters at `detectResumeStep()`'s chosen step. If it resumes at `ship`, the guard runs and correctly flags a cycle where prior steps produced no code. Good.
- **Does this need a new entry in `STEPS` / `BUDGETS` / `MODEL_PROFILES`?** No — the guard is not a step, it's a predicate before an existing step. ✓

## Self-review notes

Re-read as a critical reviewer:
- Considered adding a post-condition too (check main's log after ship). Rejected — the pre-condition is strictly stronger for this failure mode and avoids duplicating the check. If a future bug makes ship return ok without merging despite a valid branch, that's a different failure class worth a separate item.
- Considered making the check a new pipeline step. Rejected — steps need model profiles, budgets, turn limits, and log entries. A 3-line predicate before ship is the right weight.
- Considered fixing this in `step-runner.ts` by making `ok` require "observable git progress." Rejected — `ok` means "session finished cleanly," which is the right primitive for the many callers that don't touch git (plan writes files, shakedown reviews). Mixing concerns would hurt factoring.
- Considered skipping the `/ship` SKILL.md tightening since the pipeline check makes it redundant. Kept it — defense in depth is cheap, and the skill is also invoked by humans outside the pipeline.
