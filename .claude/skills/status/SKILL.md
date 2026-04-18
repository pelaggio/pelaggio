---
name: status
description: Show current work context — branch, plan, progress, and next steps
disable-model-invocation: true
allowed-tools: Read Glob Grep Bash(git:*) Bash(ls:*)
---

# /status — Where Am I?

Quick orientation for resuming work or checking progress.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO. Use the resulting absolute path in all paths below.

| Path | Purpose |
|------|---------|
| `{MAIN_REPO}/docs/plans/` | Implementation plans (keyed by branch) |
| `{MAIN_REPO}/docs/roadmap-*.md` | Task-tracking planning docs |

Resolve MAIN_REPO.

## Gather

1. Current branch: `git branch --show-current`
2. List in-flight items: `git branch --list 'feat/*'` and `git worktree list`. Extract item IDs from branch names, look up titles and status in `{MAIN_REPO}/docs/task-index.md`. Highlight current branch's entry.
3. If on a feature branch:
   - Progress: `git log main..HEAD --oneline`
   - Uncommitted work: `git status --short`
   - Plan: read `{MAIN_REPO}/docs/plans/{branch-without-feat-prefix}.md` if it exists
4. If on `main`: show all in-flight feature branches and their worktrees

## Report

Show a compact summary:

```
Branch:    feat/tool-16-refit-split
Item:      TOOL-16 — Split /refit → /bump-models + self-hosted Renovate (roadmap-core.md)
Worktree:  /path/to/{project}-tool-16

Commits (3):
  abc1234 scaffold bump-models skill
  def5678 add Renovate workflow
  ghi9012 wire self-hosted runner config

Uncommitted: 2 modified, 1 untracked

Plan: docs/plans/tool-16-refit-split.md (exists)
```

## Suggest next step

Based on state:
- No commits yet → "Run `/plan` to design the approach"
- Has commits, no review → "Run `/shakedown` when implementation is complete"
- Clean and reviewed → "Run `/ship` to finalize"
- Uncommitted changes → "Stage and commit, then continue"
