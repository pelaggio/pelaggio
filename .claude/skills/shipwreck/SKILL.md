---
name: shipwreck
description: Recover a failed /ship attempt — diagnose state, resolve, merge, and log the failure pattern
argument-hint: "[item-id]"
disable-model-invocation: true
allowed-tools: Read Edit Bash(git:*) Bash(pnpm:*) Bash(npx:*)
---

# /shipwreck — Recover a Failed Ship

Recover a failed `/ship` run: diagnose, finish the merge, and log the failure pattern.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — strip the trailing `/.git` to get MAIN_REPO.

## 1. Identify

The **first token** of `$ARGUMENTS` is the item ID (or empty → infer from the worktree). A trailing `autopilot --target=direct-push` is the pipeline's hand-off signal — it is **not** part of the ID; it is consumed at step 5a to decide whether to stop after the merge.

**`/shipwreck COMP3`** — find branch matching item ID via `git branch --list 'feat/*'`.

**`/shipwreck`** — if in a worktree on a feature branch, use that. Otherwise list worktrees and ask.

Extract ITEM_ID from the branch name. Find the worktree path via `git worktree list`.

## 2. Diagnose

```bash
# In MAIN_REPO — mid-merge?
cd "{MAIN_REPO}" && git status
# In worktree — squash state?
cd "{WORKTREE}" && git status && git log --oneline main..HEAD
```

Classify:

| State | Symptoms | Go to |
|-------|----------|-------|
| **mid-merge** | MAIN_REPO has `MERGE_HEAD` or conflict markers | 3a |
| **aborted-merge** | MAIN_REPO clean, worktree has squashed commit(s) | 3b |
| **mid-squash** | Worktree has staged changes, no commit after reset | 3c |
| **pre-squash** | Worktree has multiple commits, clean tree | 3d |
| **unknown** | None of the above | Report and stop |

Report the diagnosed state before proceeding.

## 3. Recover

### 3a: Resolve mid-merge conflicts

```bash
cd "{MAIN_REPO}"
git diff --name-only --diff-filter=U
```

Resolve using `/ship`'s known-safe patterns (see step 7 of `/ship`). For conflicts not matching a known pattern: read both sides, understand intent, resolve. Note novel patterns for step 6.

```bash
git add -A
git commit --no-edit
```

### 3b: Retry merge

```bash
cd "{MAIN_REPO}"
git pull --no-rebase origin main
git merge "$BRANCH" --no-edit
```

If conflicts arise, follow 3a.

### 3c: Finish squash

Staged changes from `git reset --soft` need a commit:

```bash
git commit -m "$(cat <<'EOF'
{type}: {description} ({ITEM_ID})

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

Then proceed to 3b. (mark-done / archive / push now live past the gate — step 5a or step 6.)

### 3d: Full recovery

Run `/ship` steps 3–4: squash, then merge into `main`. Stop there — mark-done / archive / push / cleanup are deferred to the gate (step 5a hands them to the pipeline; inline runs them at step 6).

## 4. Verify

From MAIN_REPO, run the verification commands listed in `.claude/skills/_rubric.md`'s Verification section. All must exit 0. Biome warnings don't block (if biome is configured).

If verification fails due to a conflict resolution error, fix and amend the merge commit.

## 5. Log the failure

Append to `{MAIN_REPO}/.claude/shipwreck.log` (create if it doesn't exist):

```
## {ITEM_ID} — {YYYY-MM-DD}

State: {diagnosed state}
Failure: {what went wrong}
Resolution: {how it was resolved}
Pattern: {novel conflict pattern to add to /ship, or "none"}
```

If Pattern is non-empty, suggest updating `/ship`'s merge-conflict list in the report.

## 5a. Autopilot hand-off gate

**If `Arguments` contains `autopilot` and `--target=direct-push`**: you were invoked by the pipeline's ship-recovery path. The merge has landed on `main` and step 4 verification passed. **STOP here** — report `ship-merged: {ITEM_ID}` on the final line. Do **not** run step 6 (mark-done, archive, push, cleanup): the pipeline owns them deterministically once it re-verifies the merge. They are zero-turn, idempotent, best-effort code — running them yourself only burns budget the pipeline will redo. If recovery could **not** land or verify the merge, report that failure instead of `ship-merged`, so the pipeline's `verifyShipLanded` gate keeps it from pushing an unlanded merge.

**Otherwise (inline / human-invoked)**: continue to step 6 and run the bookkeeping tail yourself.

## 6. Finish bookkeeping (inline only)

Reached only from step 5a's inline branch. Mirror `/ship` steps 6–9 — mark done, archive plan, push, then clean up:

```bash
cd "{MAIN_REPO}"
npx @cdhorne/claude-autopilot roadmap mark-done "$ITEM_ID"
npx @cdhorne/claude-autopilot roadmap archive-plan "$ITEM_ID"
git push origin main
# TOOL-52: repair MAIN's node_modules if a worktree-side `pnpm install`
# re-pointed any top-level symlinks into the worktree's .pnpm store.
npx @cdhorne/claude-autopilot worktree-deps --repair-main
git worktree remove "$WORKTREE" --force 2>/dev/null
git branch -d "$BRANCH" 2>/dev/null
git push origin --delete "$BRANCH" 2>/dev/null
```

## 7. Report

```
Recovered: {ITEM_ID} — {title}
State was: {diagnosed state}
Conflicts: {count} resolved ({file list})
Pattern logged: {yes/no — and what}
Pushed: {commit hash}
```
