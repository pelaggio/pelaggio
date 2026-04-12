---
name: tidy
description: Clean up roadmaps — archive completed tracks, remove stale worktrees, verify codebase health
allowed-tools: Read Glob Grep Edit Bash(git:*) Bash(pnpm:*)
---

# /tidy — Roadmap & Workspace Cleanup

Periodic maintenance: archive completed work, prune stale state, verify health.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO.

## 1. Roadmap audit

Glob `{MAIN_REPO}/docs/roadmap-*.md`. For each file, count done vs pending items.

**Collapse un-collapsed Done specs:**
- Scan for Done items (from the progress table) that still have full spec sections (What/Scope/Deps table + Deliverables list). Replace with:
  ```
  ### {ID}. {Title} ✓

  Completed. See git history for implementation details.
  ```
- This keeps roadmaps lean — full specs are only needed for open items.

**Archive fully-complete roadmaps:**
- If a roadmap has 0 pending items → `git mv` to `docs/archived/`
- Update any references in `CLAUDE.md` and other roadmaps

**Archive completed tracks within active roadmaps:**
- If a track/section within a roadmap is 100% done and has 5+ items, consider collapsing the detail into a one-line summary (e.g. "Sync Track: 5/5 Done (see archived/roadmap-phase3.md)")
- Don't archive tracks with <5 items — not worth the churn

## 1b. Task index sync

Read `{MAIN_REPO}/docs/task-index.md` and verify it matches the roadmap state:
- Every "Not started" item in roadmaps should appear in the "Open items" table
- Every "Done" item in roadmaps should appear in the "Recently completed" line, not in "Open items"
- Fix any drift (items marked done but still in open list, new items missing from index)

## 2. Stale worktree cleanup

Run `git worktree list`. For each worktree that isn't MAIN_REPO:
- Check if the branch has been merged to main (`git branch --merged main`)
- If merged: report it as safe to remove (don't auto-remove — user may have uncommitted work)
- If not merged: check last commit date. If >7 days stale with no recent commits, flag it

## 3. Stale branch cleanup

Run `git branch --list 'feat/*'`. For branches not associated with a worktree:
- If merged to main → safe to delete. Report but don't auto-delete.
- If not merged and >14 days old → flag as potentially abandoned

## 4. Autopilot log review

If `{MAIN_REPO}/.dev/autopilot-log.jsonl` exists, read it and report:
- Total cycles run, total cost
- Success rate (completed / total)
- Most common failure step
- Average cost per successful cycle
- Incomplete items (completed=false) that still have worktrees

## 5. Codebase health check

Run from MAIN_REPO:
```bash
pnpm typecheck
pnpm check          # from apps/mobile
```

Report any errors. These should be zero — if not, flag as blocking for autopilot.

## Output

Summary table:
- Roadmaps: X active, Y archived this run
- Worktrees: X active, Y stale (flagged)
- Branches: X active, Y merged (safe to delete)
- Autopilot: X cycles, Y shipped, $Z spent
- Health: typecheck ✅/❌, lint ✅/❌
