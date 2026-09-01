---
name: shakedown
description: Review current work — plan or code — against the rubric and fix issues
context: fork
agent: general-purpose
effort: max
argument-hint: "[path | 'pelaggio plan-review' | 'pelaggio code-review']"
allowed-tools: Read Glob Grep Edit Write Bash(git:*) Bash(ls:*) Bash(pnpm:*) Bash(npx:*)
---

# /shakedown — Review and Fix

Stress-test current work against the rubric. Surface every issue as one class finding plus a sweep: a confirmed finding names the defect class and sweeps that class's surface (N instances of one class are one class finding, not N patch requests). Fix what's fixable, defer what's out of scope. Applies to plans *or* code — detect the target, dispatch, do the work.

When a confirmed finding can be classified, note optional `closure` as exactly one of:

- `patch` — a localized fix retires the finding and should converge.
- `construction` — the finding is one instance of a class with a completeness surface; retirement requires a §8.2 construction move (chokepoint, extract-and-require, or default-deny), because an instance patch predicts recurrence.
- `authority` — the guarantee is not this item's to make; closure is chartering/re-chartering through the authority path established by #745.
- `policy` — the finding trades against a stated design constraint; closure requires a routed decision.

Do not put closure modes in taxonomy `class` / `classHint`. Taxonomy class remains the safety/judgment floor (#293/#294); closure is a second, optional axis. This does not change the APPROVE / REVISE / RETHINK protocol.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO.

Roadmap lookups go through `npx pelaggio roadmap ...`; all plan-path resolution and deferred-item creation dispatches to the configured adapter.

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
2. Understand the item. If a `## Roadmap item context` block appears in your Arguments (pelaggio mode — the harness provides the item because a sandboxed provider can't fetch it), use THAT as the spec and do **not** run `roadmap get` / `gh issue view` (read its `sourceRef` local file only if you need more). Otherwise (inline): extract the item ID from the branch name and run `npx pelaggio roadmap get <ID> --json` for title, deps, `sourceRef` (markdown: roadmap file path; github-issues: issue body); read the `sourceRef` file / body for scope and dependencies.
3. Read related design docs in `{MAIN_REPO}/docs/` if the plan references them.
4. Read any source files the plan names as deliverables — confirm file existence, current shape, and that the plan's proposed edits are compatible with what's actually there.
5. **Verify APIs the plan assumes** — for every function, type, or component the plan calls or extends, read the actual source and confirm signatures match. Flag mismatches concretely (e.g., "plan assumes `foo()` returns `X` but it returns `Y`").
6. Find reference implementations for similar features already in the codebase — don't review in a vacuum.
7. Apply the rubric. Focus on design soundness, project invariants from the Correct dimension, and Idioms drift.
8. **Fix issues in place** — edit the plan file directly to address every fix-now item. The user wants a better plan, not just a list of complaints.
9. **If the plan has a fundamental design flaw** that in-place editing cannot fix (wrong data model, wrong architectural layer, contradicts a core invariant the whole approach depends on) — emit `Verdict: RETHINK` and stop. Do not paper over structural problems.
10. Output the summary and verdict per the review logic above.

For reviewer-vetoable forks affecting invariants, security, cost, public API surface, or scope beyond M, emit `DECISION: <fork> | chose: <default> | alternatives: <other options>` and continue the review. It is non-halting, may appear multiple times, and is not for routine choices. Preserve these lines in the review summary.

### Code review mode

Target: the diff — union of unstaged, staged, and `git diff main...HEAD`.

1. Identify every changed file. Read each in full. Do not review hunks in isolation.
2. **Run the verification commands listed in the rubric's "Verification" section above.** The rubric is authoritative — do not substitute your own commands. Any failure is a fix-now item. If the rubric says biome warnings are acceptable, respect that; only errors block.
3. **Self-referential roadmap guard (markdown roadmap only).** The current item's own row in `docs/roadmap-*.md` (and its mirror in `docs/task-index.md`) is owned by ship bookkeeping (`roadmap mark-done`) — never by implement. An implement diff that strikes the row through, flips `[ ]`→`[x]`, moves it to "Recently completed", or edits its cells signals premature completion, no-ops the ship-tail `markDone`, and writes the shared roadmap file outside its mutation lock. This is the review-time sibling of the plan-polish block (implement executes code; it does not do bookkeeping).
   - Derive the item ID from the branch: `git rev-parse --abbrev-ref HEAD` gives `feat/<slug>`; the ID is the leading `[a-z][0-9a-z]*(-[0-9]+)?` token of `<slug>`, uppercased (mirrors the markdown adapter's `parseItemId` fallback).
   - Surface any diff line touching that ID in the roadmap files: `git diff main -- 'docs/roadmap-*.md' 'docs/task-index.md' | grep -iE '^[+-].*\bID\b'` (path globs quoted so git does the matching; the single-ref `git diff main` form — working tree vs `main`, not `main..HEAD` — is the union of committed and working-tree changes). No hits → clean; on a github-issues/linear repo there are no such files, so this is a no-op.
   - Any hit is **fix-now**: revert the item's own row to its pre-branch state (edit the file back — the pipeline checkpoints, so commit nothing) so ship's `markDone` can strike it at the right time. Rows for *other* new items (the harness creates deferred items after this step) carry different IDs and won't match — leave them. The rare item whose deliverable *is* the roadmap tooling (editing every row incl. its own) is a judgment call — this is a flag, not a hard block.
4. Apply the rubric. Categorize findings.
5. **Fix every fix-now and near-term item.** Edit files directly, commit nothing (the pipeline checkpoints).
6. Re-run the verifications until all pass. Fix any regressions your changes introduced.
7. Output the summary and verdict.

Apply the same `DECISION:` threshold and format from plan review mode to code-review findings and summary.

## Pelaggio extensions

If `Arguments:` at the bottom of this prompt contains the string `pelaggio`:

- `pelaggio plan-review` → force plan review mode regardless of git state. The pipeline is staging the plan for implementation and wants a verdict.
- `pelaggio code-review` → force code review mode regardless of git state. The pipeline has finished implementation and wants fixes + verification + roadmap updates.
- In code review mode, additionally: for each deferred follow-up, emit a `deferred-item:` marker line — one compact JSON object per item: `deferred-item: {"title": "<concise imperative title>", "scope": "<XS|S|M|L|XL>", "deps": "<csv of IDs>"}` (scope/deps optional). The **harness** creates these after the step (so `/pick` finds them later) — do **not** run `roadmap create-item` yourself (a sandboxed provider can't, and the harness owns it to avoid duplicates).
- The `Verdict:` line is parsed by the pipeline's verdict parser — emit it with the exact format `Verdict: APPROVE` / `REVISE` / `RETHINK`.

If `Arguments:` is absent or doesn't mention `pelaggio`, you're running inline. Skip the roadmap-update step for deferred items — just list them in the output so the user decides whether to track them.

## Output

End with the summary and verdict per the review logic. Then:

- **Plan review, inline**: "Ready to implement — say **go** or run `/shakedown` again to iterate."
- **Code review, inline**: "Ready for `/ship`."
- **Pelaggio** (either mode): just the summary + verdict line. No trailing prompt.
