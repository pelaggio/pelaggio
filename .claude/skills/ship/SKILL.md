---
name: ship
description: Finalize, commit, push, and clean up a completed work item
argument-hint: "[--no-squash] [--pr]"
disable-model-invocation: true
allowed-tools: Read Edit Bash(git:*) Bash(pnpm:*) Bash(npx tsx:*) Bash(npx biome:*) Bash(gh pr:*)
---

# /ship — Finalize and Ship

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO. Use the resulting absolute path in all paths below.

| Path | Purpose |
|------|---------|
| `{MAIN_REPO}/docs/plans/` | Implementation plans (keyed by branch) |
| `{MAIN_REPO}/docs/roadmap-*.md` | Task-tracking planning docs |

Resolve MAIN_REPO. Parse `$ARGUMENTS` for `--no-squash` and `--pr` flags.

**CWD rule**: run steps 1-3 from your current working directory (the worktree). `HEAD` here is your feature branch. After the merge (step 4), all remaining steps run in `{MAIN_REPO}` on `main`.

## 1. Verify (conditional)

!`cat .claude/skills/_rubric.md`

!`cat .claude/skills/_project-context.md 2>/dev/null`

**If `Arguments:` at the bottom of this prompt contains the string `autopilot`**, you were invoked by the pipeline immediately after `/shakedown` — which just blocked on any rubric-failing state. Pre-merge re-verification is redundant: **skip to step 2**. Post-merge verification at step 5 still runs unconditionally (merging main can break things independent of this branch).

**Otherwise (inline invocation)**, run the rubric's verification commands now. All must pass (exit 0) — stop and report if any fail.

**Policy (applies to any verification run, pre- or post-merge):**
- **Biome** — only *errors* block shipping. Warnings are acceptable; do not spend turns fixing them. Check the exit code, not the warning count.
- **Pre-existing test failures** — if a test fails but the test file is not in `git diff main...HEAD --name-only`, the failure is pre-existing. Note it and move on; do not investigate or fix.

## 2. Identify

Get item ID from branch name (e.g. `feat/tool-16-refit-split` → `TOOL-16`). Find the source doc by grepping `{MAIN_REPO}/docs/roadmap-*.md` for that ID. Read the planning doc for title/description.

## 3. Squash (unless `--no-squash`)

Verify clean working tree (`git status --porcelain` must be empty — stop if not).

```bash
git reset --soft $(git merge-base main HEAD)
git commit -m "$(cat <<'EOF'
{type}: {description} ({item ID})

- {bullet 1}
- {bullet 2}

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Types: `feat`, `fix`, `refactor`, `docs`. Imperative mood, lowercase, no period.

If the commit fails after reset, all changes are still staged — just re-run the commit command.

**Phantom ship guard** (defense-in-depth — the pipeline's `hasDeliverableCommits()` pre-check is primary; this inline guard covers non-pipeline use). After squashing, verify the branch touches something beyond the plan file:
```bash
git diff --name-only main...HEAD | grep -v '^docs/plans/'
```
If the output is empty (only the `/plan` artifact changed), **abort immediately** — the feature branch has no implementation. Do not proceed with merge. Doc-only work outside `docs/plans/` (rubric, skill bodies, README, roadmap edits) is legitimate and should pass.

## 4. Merge code

**If `--pr`**: skip merge, `git push -u origin HEAD`, create PR via `gh pr create`. Then skip to step 9 (Report) — docs updates will happen when the PR is merged.

**Otherwise** (direct merge):

**If in worktree** (worktree path != MAIN_REPO):
```bash
cd "{MAIN_REPO}"
git pull --no-rebase origin main
git merge "$BRANCH" --no-edit
```

**If not in worktree**:
```bash
git checkout main
git pull --no-rebase origin main
git merge "$BRANCH" --no-edit
```

**Merge conflicts**: only auto-resolve clearly-additive patterns where both sides added independent content (e.g. both sides added rows to a table, both appended to an exports list). For anything else — edits to the same lines, deletions, non-additive changes — stop and report. Do not force through.

## 5. Post-merge verification

If `pnpm-lock.yaml` was modified in the merge, run `pnpm install --frozen-lockfile` from `{MAIN_REPO}` first — the lockfile is merged but new packages won't be available until installed.

Re-run the verification commands from `.claude/skills/_rubric.md`'s Verification section from `{MAIN_REPO}`. If any fail, **stop and fix** — do not push broken code to main. This catches regressions introduced by the merge itself (e.g., main moved while the feature branch was in flight).

## 6. Mark done (on main)

All paths below use `{MAIN_REPO}` — you are now on `main`. The item ID, title, and description were already extracted in step 2.

Update the item in its planning doc (detect checkbox vs table format):
- Checkbox: `- [ ]` → `- [x]`, append ` *(YYYY-MM-DD)*`
- Table: status → `**Done** — {description} (YYYY-MM-DD)`

Check cross-references in other `{MAIN_REPO}/docs/roadmap-*.md` files.

**Collapse the spec section**: in the roadmap, replace the item's full spec (the `### ID. Title` section with What/Scope/Deps table and Deliverables list) with:
```
### {ID}. {Title} ✓

Completed. See git history for implementation details.
```
Keep the heading so links still resolve.

**Update task index**: in `{MAIN_REPO}/docs/task-index.md`:
- Remove the item's row from the "Open items" table
- Add `- {ID} ✓` as a new line in the "Recently completed" list, in alphabetical order (alpha by prefix, then numeric within prefix)

## 7. Archive plan docs (on main)

If a plan file exists in `{MAIN_REPO}/docs/plans/` for this item (filename matches the branch slug or item ID prefix) and the work is complete: `git mv` it to `docs/archived/`. Don't archive multi-item or in-progress docs.

## 8. Commit doc updates and push

Stage and commit all doc changes from steps 6-7 as a separate commit on `main`:
```bash
git add docs/
git commit -m "docs: mark {item ID} done"
```

Then push:
```bash
git push origin main
```

If `git push` fails because main moved, run `git pull --no-rebase origin main`, re-run post-merge verification (step 5), and retry the push (up to 2 retries).

## 9. Clean up

**If in worktree**:
```bash
git worktree remove "$WORKTREE" --force
git branch -d "$BRANCH"
git push origin --delete "$BRANCH" 2>/dev/null
```

**If not in worktree**:
```bash
git branch -d "$BRANCH"
git push origin --delete "$BRANCH" 2>/dev/null
```

If `git worktree remove` fails because of files the consuming project left behind (e.g. `node_modules` on Windows), clean those first from the worktree path, then retry.

## 10. Report

What shipped: item, branch, commit, planning doc updated, archives, worktree status.
