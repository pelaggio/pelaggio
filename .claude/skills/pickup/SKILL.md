---
name: pickup
description: Rebuild context for in-progress work — read plan, show progress, suggest next step
argument-hint: "[item-id]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Bash(git:*) Bash(ls:*) Bash(npx:*)
---

# /pickup — Pick Up Where You Left Off

Rebuild context for in-progress work so you can continue without re-reading everything manually.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO.

Roadmap lookups go through `npx claude-autopilot roadmap ...`.

## Selection

**`/pickup TOOL-16`** — find a branch matching that item ID via `git branch --list 'feat/*'`. If no matching branch, report and stop.

**`/pickup`** (no argument) — if on a feature branch, use the current branch. If on `main`, list in-flight items from `git branch --list 'feat/*'` and `git worktree list`, and ask which to pick up.

## Gather

1. Current branch: `git branch --show-current`
2. Extract item ID from branch name (e.g. `feat/tool-16-refit-split` → `TOOL-16`). Run `npx claude-autopilot roadmap get <ID> --json` for title, deps, sourceRef. Get worktree path from `git worktree list`.
3. Resolve plan path: `npx claude-autopilot roadmap plan-path --id <ID> --worktree "$PWD"` — exit 0 means it exists, exit 2 means it doesn't. Read it if present.
4. Progress: `git log main..HEAD --oneline` (run in the item's worktree)
5. Uncommitted work: `git status --short` (run in the item's worktree)
6. Files changed: `git diff main...HEAD --stat` (run in the item's worktree)

## Report

Compact summary:

```
Item:      TOOL-16 — Split /refit → /bump-models + self-hosted Renovate
Source:    <sourceRef from roadmap get>
Branch:    feat/tool-16-refit-split
Worktree:  /path/to/{project}-tool-16

Plan: <resolved plan-path> (exists)
Scope: {1-2 sentence summary from plan}

Commits (3):
  abc1234 scaffold bump-models skill
  def5678 add Renovate workflow
  ghi9012 wire self-hosted runner config

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
