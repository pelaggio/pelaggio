---
name: tidy
description: Clean up roadmaps — archive completed tracks, remove stale worktrees, verify codebase health
allowed-tools: Read Glob Grep Edit Bash(git:*) Bash(pnpm:*) Bash(npx:*)
---

# /tidy — Roadmap & Workspace Cleanup

Periodic maintenance: archive completed work, prune stale state, verify health.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO.

Detect the configured roadmap source via `npx pelaggio roadmap source` (prints e.g. `markdown`, `github-issues`, `linear`). Sections §1 and §1b below are markdown-specific — **skip them** when the source is not `markdown` (remote adapters own their own archival/indexing; there is no local roadmap file or task index to sync).

## 1. Roadmap audit (markdown only)

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

## 1b. Task index sync (markdown only)

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

## 4. Decision register hygiene

From `MAIN_REPO`, run `npx pelaggio decisions archive-resolved --older-than 30d`. Report the moved count. The deterministic locked command archives only resolved rows; leave unresolved and `default-taken` rows untouched and do not edit the Markdown register manually.

## 4b. Staleness quarantine sweep (#217)

From `MAIN_REPO`, run `npx pelaggio roadmap stale-scan --write`.

This runs deterministic, high-precision heuristics over the **open** set — `shipped-by-commit` (a `git log main` subject completes the id), `superseded-marker` (the body says it was done by a done sibling), `title-match-done` (title equals a done item's title) — and upserts active hits into `MAIN_REPO/.dev/stale-quarantine.json` (fingerprint-bound, gitignored). It also prunes entries whose ids are no longer open. Quarantined items are then excluded from `roadmap next` and refused by `roadmap claim` (**exit 4**) until an operator resolves them, so a stale item never silently burns a cycle.

Report the table it prints (`id`, `reason`, `evidence`). Review existing entries with `npx pelaggio roadmap stale-list`. **Do not auto-resolve** — human confirmation is required. For each quarantined item, an operator runs one of:

- `npx pelaggio roadmap stale-resolve <id> --as done [--note "…"]` — confirm it is already implemented/obsolete: closes it (`markDone`) and clears the entry.
- `npx pelaggio roadmap stale-resolve <id> --as keep` — a false positive or still-real work: a sticky `keep` suppresses re-quarantine until the item's title/body/deps change.

## 5. Pelaggio log review

If `{MAIN_REPO}/.dev/pelaggio-log.jsonl` exists, read it and report:
- Total cycles run, total cost
- Success rate (completed / total)
- Most common failure step
- Average cost per successful cycle
- Incomplete items (completed=false) that still have worktrees

## 6. Expired session-record cleanup

From `MAIN_REPO`, run `npx pelaggio sessions-sweep`. Report removed expired records and retained live/malformed counts. Do **not** hand-parse or delete `.dev/sessions/*.json` — the deterministic command owns expiry and compare-before-remove. SIGKILL/OOM/crash residue is cleaned here via content expiry.

## 7. Codebase health check

Run from MAIN_REPO the verification commands listed in `.claude/skills/_rubric.md`'s Verification section.

Report any errors. These should be zero — if not, flag as blocking for pelaggio.

## Output

Summary table:
- Roadmaps: X active, Y archived this run; decisions: Z resolved rows archived; stale: Q items quarantined (awaiting resolve)
- Worktrees: X active, Y stale (flagged)
- Branches: X active, Y merged (safe to delete)
- Sessions: X expired removed, Y retained
- Pelaggio: X cycles, Y shipped, $Z spent
- Health: typecheck ✅/❌, lint ✅/❌
