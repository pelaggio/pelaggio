---
name: pickup
description: Rebuild context for in-progress work — read plan, show progress, suggest next step
argument-hint: "[item-id]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Bash(git:*) Bash(ls:*)
---

# /pickup — Pick Up Where You Left Off

Rebuild context for in-progress work so you can continue without re-reading everything manually.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO. Use the resulting absolute path in all paths below.

| Path | Purpose |
|------|---------|
| `{MAIN_REPO}/docs/plans/` | Implementation plans (keyed by branch) |
| `{MAIN_REPO}/docs/roadmap-*.md` | Task-tracking planning docs |

Resolve MAIN_REPO.

## Selection

**`/pickup F2`** — find a branch matching that item ID via `git branch --list 'feat/*'`. If no matching branch, report and stop.

**`/pickup`** (no argument) — if on a feature branch, use the current branch. If on `main`, list in-flight items from `git branch --list 'feat/*'` and `git worktree list`, and ask which to pick up.

## Gather

1. Current branch: `git branch --show-current`
2. Extract item ID from branch name (e.g. `feat/b3-rolling-averages` → `B3`). Read `{MAIN_REPO}/docs/task-index.md` to find which roadmap contains the item, then read only that file for scope/deps. Get worktree path from `git worktree list`.
3. Read the source doc entry for full scope and dependencies
4. Read `{MAIN_REPO}/docs/plans/{branch-without-feat-prefix}.md` if it exists
5. Progress: `git log main..HEAD --oneline` (run in the item's worktree)
6. Uncommitted work: `git status --short` (run in the item's worktree)
7. Files changed: `git diff main...HEAD --stat` (run in the item's worktree)

## Report

Compact summary:

```
Item:      B3 — Rolling 30/90-day averages (roadmap-data-quality.md)
Branch:    feat/b3-rolling-averages
Worktree:  C:/Users/.../{project}-b3

Plan: docs/plans/b3-rolling-averages.md
Scope: {1-2 sentence summary from plan}

Commits (3):
  abc1234 add rolling average engine
  def5678 add unit tests
  ghi9012 wire up to bearings screen

Uncommitted: 2 modified, 1 untracked
Files touched: 8 files (+240, -30)
```

## Suggest next step

Based on state:
- No plan yet → "Run `/plan` to design the approach"
- Plan exists, no commits → "Ready to start building — the plan is at {path}"
- Has commits, not reviewed → "Run `/shakedown` when implementation is complete"
- Clean and reviewed → "Run `/ship` to finalize"
- Uncommitted changes → "You have uncommitted work — stage and commit, then continue"
