---
name: shakedown
description: Review current work — plan or code — against the rubric and fix issues
context: fork
agent: general-purpose
effort: max
argument-hint: "[path | 'autopilot plan-review' | 'autopilot code-review']"
allowed-tools: Read Glob Grep Edit Write Bash(git:*) Bash(ls:*) Bash(pnpm:*) Bash(npx jest:*) Bash(npx biome:*)
---

# /shakedown — Review and Fix

Stress-test current work against the rubric. Surface every issue, fix what's fixable, defer what's out of scope. Applies to plans *or* code — detect the target, dispatch, do the work.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO. Use the resulting absolute path in all paths below.

| Path | Purpose |
|------|---------|
| `{MAIN_REPO}/docs/plans/` | Implementation plans (keyed by branch) |
| `{MAIN_REPO}/docs/roadmap-*.md` | Task-tracking planning docs |
| `{MAIN_REPO}/docs/task-index.md` | Cross-roadmap item index |

Resolve MAIN_REPO. Must be on a feature branch (not `main`).

**CWD rule**: run all `git` commands from your current working directory (the worktree). `HEAD` here is your feature branch. Only use `{MAIN_REPO}` paths for reading shared docs — never `cd` there for git operations.

## Quality rubric

!`cat .claude/skills/_rubric.md`

## Review logic

!`cat .claude/skills/_review-logic.md`

## Dispatch

Apply the target detection rules above. You will land in one of two modes.

### Plan review mode

Target: a `.md` plan file (usually `docs/plans/{branch-slug}.md`).

1. Read the plan in full.
2. Extract the item ID from the branch name. Read `{MAIN_REPO}/docs/task-index.md` to find the roadmap file that owns the item, then read only that roadmap entry for scope and dependencies.
3. Read related design docs in `{MAIN_REPO}/docs/` (`plan-*.md`, `design-*.md`) if the plan references them.
4. Read `apps/mobile/src/db/schema.ts` if the plan proposes data changes.
5. Find reference implementations for similar features already in the codebase — don't review in a vacuum.
6. **Verify component APIs**: for every shared component the plan references (`StatCard`, `InfoRow`, `Button`, `IconButton`, `Screen`, `ScreenHeader`, `ContentContainer`, `ButtonGroup`, `ItemTable`, `ResultCard`, etc.), read its actual source file and confirm the real props interface. Flag any mismatches (e.g., "plan assumes `StatCard` has a `trend` prop but it doesn't").
7. Apply the rubric. Focus on design soundness and project-specific invariants: correct column types (ULID, integer cents, ISO-8601, soft deletes), data flowing through `transaction_candidates`, confidence-gated automation, i18n parity, evidence chain, transfer exclusion on spend/income, shared component reuse, performance targets.
8. **Fix issues in place** — edit the plan file directly to address every fix-now item. The user wants a better plan, not just a list of complaints.
9. **If the plan has a fundamental design flaw** that in-place editing cannot fix (wrong data model, wrong architectural layer, contradicts a core invariant that the whole approach depends on) — emit `Verdict: RETHINK` and stop. Do not paper over structural problems.
10. Output the summary and verdict per the review logic above.

### Code review mode

Target: the diff — union of unstaged, staged, and `git diff main...HEAD`.

1. Identify every changed file. Read each in full. Do not review hunks in isolation.
2. Run the three verifications from the rubric (`pnpm typecheck` from repo root, `pnpm check` from `apps/mobile`, `npx jest --no-coverage` from `apps/mobile`). Any failure is a fix-now item. Biome *warnings* are acceptable — only errors block.
3. Apply the rubric. Categorize findings.
4. **Fix every fix-now and near-term item.** Edit files directly, commit nothing (the pipeline checkpoints).
5. Re-run the three verifications until all pass. Fix any regressions your changes introduced.
6. Output the summary and verdict.

## Autopilot extensions

If `Arguments:` at the bottom of this prompt contains the string `autopilot`:

- `autopilot plan-review` → force plan review mode regardless of git state. The pipeline is staging the plan for implementation and wants a verdict.
- `autopilot code-review` → force code review mode regardless of git state. The pipeline has finished implementation and wants fixes + verification + roadmap updates.
- In code review mode, additionally: for each deferred item, append it to the appropriate `{MAIN_REPO}/docs/roadmap-*.md` file (detect checkbox vs table format and match) AND add a row to `{MAIN_REPO}/docs/task-index.md` "Open items" so `/pick` finds it.
- The `Verdict:` line is parsed by `scripts/autopilot/helpers.ts:parseVerdict` — emit it with the exact format `Verdict: APPROVE` / `REVISE` / `RETHINK`.

If `Arguments:` is absent or doesn't mention `autopilot`, you're running inline. Skip the roadmap-update step for deferred items — just list them in the output so the user decides whether to track them.

## Output

End with the summary and verdict per the review logic. Then:

- **Plan review, inline**: "Ready to implement — say **go** or run `/shakedown` again to iterate."
- **Code review, inline**: "Ready for `/ship`."
- **Autopilot** (either mode): just the summary + verdict line. No trailing prompt.
