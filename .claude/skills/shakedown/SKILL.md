---
name: shakedown
description: Review current work — plan or code — against the rubric and fix issues
context: fork
agent: general-purpose
effort: max
argument-hint: "[path | 'autopilot plan-review' | 'autopilot code-review']"
allowed-tools: Read Glob Grep Edit Write Bash(git:*) Bash(ls:*) Bash(pnpm:*) Bash(npx:*)
---

# /shakedown — Review and Fix

Stress-test current work against the rubric. Surface every issue, fix what's fixable, defer what's out of scope. Applies to plans *or* code — detect the target, dispatch, do the work.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO.

Roadmap lookups go through `npx claude-autopilot roadmap ...`; all plan-path resolution and deferred-item creation dispatches to the configured adapter.

Must be on a feature branch (not `main`).

**CWD rule**: run all `git` commands from your current working directory (the worktree). `HEAD` here is your feature branch. Only use `{MAIN_REPO}` paths for reading shared docs — never `cd` there for git operations.

## Quality rubric

!`cat .claude/skills/_rubric.md`

!`cat .claude/skills/_project-context.md 2>/dev/null`

## Review logic

!`cat .claude/skills/_review-logic.md`

## Dispatch

This forked, out-of-context review is the primary enforcer of the **Idioms** rubric dimension. Fresh eyes — unbiased by the authoring session's reasoning trail — are what catch convention drift, framework-version creep, and cleverness-over-simplicity. `/plan`'s self-review owns project-invariant checks; shakedown owns Idioms.

Apply the target detection rules above. You will land in one of two modes.

### Plan review mode

Target: a `.md` plan file (usually `docs/plans/{branch-slug}.md`).

1. Read the plan in full.
2. Extract the item ID from the branch name. Run `npx claude-autopilot roadmap get <ID> --json` for title, deps, and `sourceRef` (markdown: roadmap file path; github-issues/linear: issue URL + full body). Read the `sourceRef` file / review the body for scope and dependencies.
3. Read related design docs in `{MAIN_REPO}/docs/` if the plan references them.
4. Read any source files the plan names as deliverables — confirm file existence, current shape, and that the plan's proposed edits are compatible with what's actually there.
5. **Verify APIs the plan assumes** — for every function, type, or component the plan calls or extends, read the actual source and confirm signatures match. Flag mismatches concretely (e.g., "plan assumes `foo()` returns `X` but it returns `Y`").
6. Find reference implementations for similar features already in the codebase — don't review in a vacuum.
7. Apply the rubric. Focus on design soundness, project invariants from the Correct dimension, and Idioms drift.
8. **Fix issues in place** — edit the plan file directly to address every fix-now item. The user wants a better plan, not just a list of complaints.
9. **If the plan has a fundamental design flaw** that in-place editing cannot fix (wrong data model, wrong architectural layer, contradicts a core invariant the whole approach depends on) — emit `Verdict: RETHINK` and stop. Do not paper over structural problems.
10. Output the summary and verdict per the review logic above.

### Code review mode

Target: the diff — union of unstaged, staged, and `git diff main...HEAD`.

1. Identify every changed file. Read each in full. Do not review hunks in isolation.
2. **Run the verification commands listed in the rubric's "Verification" section above.** The rubric is authoritative — do not substitute your own commands. Any failure is a fix-now item. If the rubric says biome warnings are acceptable, respect that; only errors block.
3. Apply the rubric. Categorize findings.
4. **Fix every fix-now and near-term item.** Edit files directly, commit nothing (the pipeline checkpoints).
5. Re-run the verifications until all pass. Fix any regressions your changes introduced.
6. Output the summary and verdict.

## Autopilot extensions

If `Arguments:` at the bottom of this prompt contains the string `autopilot`:

- `autopilot plan-review` → force plan review mode regardless of git state. The pipeline is staging the plan for implementation and wants a verdict.
- `autopilot code-review` → force code review mode regardless of git state. The pipeline has finished implementation and wants fixes + verification + roadmap updates.
- In code review mode, additionally: for each deferred item, run `npx claude-autopilot roadmap create-item --title "<concise imperative title>" [--scope <XS|S|M|L|XL>] [--deps "<csv of IDs>"] --json` (from `{MAIN_REPO}`) so `/pick` can find it later. The markdown adapter appends to the roadmap + task-index; gh/linear open an issue.
- The `Verdict:` line is parsed by the pipeline's verdict parser — emit it with the exact format `Verdict: APPROVE` / `REVISE` / `RETHINK`.

If `Arguments:` is absent or doesn't mention `autopilot`, you're running inline. Skip the roadmap-update step for deferred items — just list them in the output so the user decides whether to track them.

## Output

End with the summary and verdict per the review logic. Then:

- **Plan review, inline**: "Ready to implement — say **go** or run `/shakedown` again to iterate."
- **Code review, inline**: "Ready for `/ship`."
- **Autopilot** (either mode): just the summary + verdict line. No trailing prompt.
