---
name: ship
description: Finalize a completed work item
argument-hint: "[--no-squash] [--pr]"
disable-model-invocation: true
allowed-tools: Read Edit Bash(git:*) Bash(pnpm:*) Bash(npx:*)
---

# /ship — Finalize and Ship

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO.

Roadmap lookups go through `npx pelaggio roadmap ...`; all mark-done / archive logic dispatches to the configured adapter.

Parse `$ARGUMENTS` for `--no-squash`, `--pr`, and `--target=<name>` flags.

**CWD rule**: run steps 1-3 from your current working directory (the worktree). `HEAD` here is your feature branch. After the merge (step 4), all remaining steps run in `{MAIN_REPO}` on `main`.

## 1. Verify (conditional)

!`cat .claude/skills/_rubric.md`

!`cat .claude/skills/_project-context.md 2>/dev/null`

**If `Arguments:` at the bottom of this prompt contains the string `pelaggio`**, you were invoked by the pipeline immediately after `/shakedown` — which just blocked on any rubric-failing state. Pre-merge re-verification is redundant: **skip to step 2**. Post-merge verification at step 5 still runs unconditionally (merging main can break things independent of this branch).

**Otherwise (inline invocation)**, run the rubric's verification commands now. All must pass (exit 0) — stop and report if any fail.

**Policy (applies to any verification run, pre- or post-merge):**
- **Biome** — only *errors* block shipping. Warnings are acceptable; do not spend turns fixing them. Check the exit code, not the warning count.
- **Pre-existing test failures** — if a test fails but the test file is not in `git diff main...HEAD --name-only`, the failure is pre-existing. Note it and move on; do not investigate or fix.

## 2. Identify

Get item ID from the current branch name.

For PR targets (`--pr`, `--target=pull-request`, or `--target=auto-merge-pr`), do not run roadmap commands. Derive the PR title/body from the branch name, existing commits, and diff summary.

For direct-push, run `npx pelaggio roadmap get <ID> --json` to fetch title + description for the commit message. The `title` field is the commit subject source.

## 3. Squash (direct-push only, unless `--no-squash`)

For PR targets (`--pr`, `--target=pull-request`, or `--target=auto-merge-pr`), skip this step. The harness owns the squash/commit after it validates `SHIP_DECISION`.

Verify clean working tree (`git status --porcelain` must be empty — stop if not).

```bash
git reset --soft $(git merge-base main HEAD)
git commit -m "$(cat <<'EOF'
{type}: {description} ({item ID})

- {bullet 1}
- {bullet 2}

Assisted-by: Claude <noreply@anthropic.com>
EOF
)"
```

Types: `feat`, `fix`, `refactor`, `docs`. Imperative mood, lowercase, no period.

**Assisted-by trailer (#189):** always stamp at least one `Assisted-by: <Name> <email>` line for the AI provider(s) that authored the change (Claude / Codex / Grok). Prefer `Assisted-by` over `Co-Authored-By` — the model assists; DCO `Signed-off-by` remains the human author. On PR targets the harness stamps this on the squash commit; the skill template above covers direct-push.

If the commit fails after reset, all changes are still staged — just re-run the commit command.

**Phantom ship guard** (defense-in-depth — the pipeline's `hasDeliverableCommits()` pre-check is primary; this inline guard covers non-pipeline use). After squashing, verify the branch touches something beyond the plan file:
```bash
git diff --name-only main...HEAD | grep -v '^docs/plans/'
```
If the output is empty (only the `/plan` artifact changed), **abort immediately** — the feature branch has no implementation. Do not proceed with merge. Doc-only work outside `docs/plans/` (rubric, skill bodies, README, roadmap edits) is legitimate and should pass.

## 4. Merge code

**Never discard MAIN_REPO changes.** If the merge target (`{MAIN_REPO}` on `main`) has uncommitted changes — e.g. a prior cycle's deferred `create-item` or pending bookkeeping — **commit them** (`git add -A && git commit -m "chore: recover uncommitted bookkeeping" --no-verify`); do **not** `git checkout`/`reset --hard`/`stash drop`/`git clean` them away to get a clean tree. Destroying a sibling cycle's work to make your merge tidy is never acceptable.

**If `--pr` or `--target=pull-request` or `--target=auto-merge-pr`**: skip merge and emit a harness decision. The pipeline owns squash, commit, push, PR create/update, optional auto-merge queueing, and the review-drain and revise reconcilers. Mark-done, archive, and worktree/branch cleanup happen after confirmed landing through the zero-turn reap reconciler, not in the ship session.

For PR targets, do not run `git reset`, `git commit`, `git push`, `gh`, `npx pelaggio roadmap`, mark-done, archive, or cleanup. Inspect with read-only commands as needed, then:

1. Write the PR body (markdown, up to 512 KiB) to exactly `.dev/ship/pr-body-{ID}.md` inside the worktree. Create `.dev/ship/` if needed. The path must be a plain file (not a symlink); overwrite if present. Do **not** put the body inline in JSON.
2. Emit exactly one marked decision block with short scalar fields only, referencing that file via `prBodyFile`:

```text
SHIP_DECISION
{"target":"pull-request","itemId":"{ID}","headBranch":"{BRANCH}","prTitle":"{title}","prBodyFile":".dev/ship/pr-body-{ID}.md"}
END_SHIP_DECISION
```

Use `"target": "auto-merge-pr"` when arguments contain `--target=auto-merge-pr`. Do not include an inline `prBody` field — the harness reads the body only from the fixed file path. Then stop — the harness will report the PR URL after effects run.

**Otherwise** (direct merge):

**If in worktree** (worktree path != MAIN_REPO):
```bash
cd "{MAIN_REPO}"
git checkout main
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

Re-run the verification commands from `.claude/skills/_rubric.md`'s Verification section from `{MAIN_REPO}`. If any fail, **stop and fix** — do not push broken code to main. This catches regressions introduced by the merge itself.

## 5a. Pelaggio hand-off gate

**If `Arguments` contains `pelaggio` and `--target=direct-push`**: you are the pipeline's ship step, and the merge has now landed on local `main`. **STOP here** — report `ship-merged: {ID}` on the final line. Do **not** run steps 6–10 (mark-done, archive, push, cleanup): the pipeline owns them deterministically once it detects the merge. They are zero-turn, idempotent, best-effort code — running them yourself only burns budget the pipeline will redo. If post-merge verification (step 5) surfaced a genuine regression you could not fix, report that as a failure instead of `ship-merged` so the pipeline routes to `/shipwreck`.

**Otherwise (inline `/ship`, human-invoked)**: continue to step 6 and run the flow end to end yourself.

## 6. Mark done

From `{MAIN_REPO}`, dispatch to the adapter:

```bash
npx pelaggio roadmap mark-done <ID> --note "<short description>"
```

Markdown adapter: strikes the roadmap row, moves the task-index entry to "Recently completed", and commits internally. Github-issues: posts a comment and closes the issue. Linear: posts a comment and transitions the issue to completed. Either way, nothing further to stage on `main`.

## 7. Archive plan docs

```bash
npx pelaggio roadmap archive-plan <ID>
```

Markdown: `git mv` the plan from `docs/plans/` to `docs/archived/` and commit. Gh/linear: no-op.

## 8. Push

```bash
git push origin main
```

If `git push` fails because main moved, run `git pull --no-rebase origin main`, re-run post-merge verification (step 5), and retry the push (up to 2 retries).

## 9. Clean up

Worktree remove + `--repair-main` always run after a successful push. **Claim-branch delete (local + remote) runs only if mark-done (step 6) succeeded** — a retained `feat/<id>` claim keeps the still-open tracker item ineligible for re-pick until the operator reconciles mark-done and then deletes the branch (or runs `/tidy`). Matches the pipeline's deterministic tail (`runShipBookkeeping`).

**If in worktree**:
```bash
# TOOL-52: repair MAIN's node_modules if a worktree-side `pnpm install`
# re-pointed any top-level symlinks into the worktree's .pnpm store.
npx pelaggio worktree-deps --repair-main
git worktree remove "$WORKTREE" --force
```

**If mark-done succeeded** (step 6 exited 0), also delete the claim branch:
```bash
git branch -d "$BRANCH"
git push origin --delete "$BRANCH" 2>/dev/null
```

**If mark-done failed**: leave `$BRANCH` intact locally and on origin. Report that the claim was retained to prevent re-pick, and that the operator should rerun `npx pelaggio roadmap mark-done <ID>` then delete the branch (or `/tidy`).

If `git worktree remove` fails because of files the consuming project left behind (e.g. `node_modules` on Windows), clean those first from the worktree path, then retry.

## 10. Report

What shipped: item, branch, commit, archives, worktree status.
