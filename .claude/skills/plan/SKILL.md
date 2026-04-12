---
name: plan
description: Generate an implementation plan for the current work item, self-review it, and revise until solid
allowed-tools: Read Glob Grep Bash(git:*) Bash(ls:*)
---

# /plan — Plan and Self-Review

Generate an implementation plan for the current work item. Then review it yourself — is the outcome well-factored, well-tested, well-typed, correct, concise and idiomatic? Do we meet or exceed best practices, standards and patterns in the industry? Revise the plan until it's solid. Output only the final version.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO. Use the resulting absolute path in all paths below.

| Path | Purpose |
|------|---------|
| `{MAIN_REPO}/docs/plans/` | Implementation plans (keyed by branch) |
| `{MAIN_REPO}/docs/roadmap-*.md` | Task-tracking planning docs |

Resolve MAIN_REPO now.

**Target item: `$ARGUMENTS`** — if a value appears above, find the matching branch via `git branch --list 'feat/*'`. Otherwise get the branch from `git branch --show-current` (must not be `main`).

1. Extract item ID from branch name. Read `{MAIN_REPO}/docs/task-index.md` to find which roadmap file contains the item. Then read only that roadmap file for the item's full scope and dependencies. Don't read all roadmaps.
3. Read related `{MAIN_REPO}/docs/plan-*.md` and `{MAIN_REPO}/docs/design-*.md` files.
4. Read `apps/mobile/src/db/schema.ts` if data changes are involved.
5. Find reference implementations for similar features already in the codebase.
6. **Verify component APIs**: for every shared component you plan to use (`StatCard`, `InfoRow`, `Button`, `IconButton`, `Screen`, `ScreenHeader`, `ContentContainer`, etc.), read its actual source file and confirm the real props interface. Do not assume prop names — check them. If a component doesn't support what you need, note it in the plan and either propose extending the component or use an alternative approach.

## Quality rubric

!`cat .claude/skills/_rubric.md`

## Write the plan

**You MUST write the plan to a file on disk** at `{MAIN_REPO}/docs/plans/{branch-name-without-feat-prefix}.md` (create the directory if needed). Use the Write tool — do not just output the plan as text. This file is read by `/shakedown` in a separate session.

**After writing the plan file, commit it** so it isn't left as untracked debris:
```bash
git add "{MAIN_REPO}/docs/plans/{slug}.md"
git commit -m "docs: add implementation plan for {item ID}"
```

Note: `{MAIN_REPO}` is the path resolved via `git rev-parse` above — NOT the current working directory (which may be a worktree). The `docs/plans/` directory lives in the main repo so it's shared across worktrees.

Cover: scope (what it does and doesn't touch), approach (why this over alternatives), files to change, schema changes, test strategy, i18n needs, and a rubric self-check.

## Self-review

Re-read the plan as a critical reviewer:
- Score each rubric dimension. Are there blockers or concerns?
- Check project-specific invariants: correct column types, data flows through `transaction_candidates`, confidence-gated automation, evidence chain, transfer exclusion, shared component reuse, performance targets.
- If you find issues, **revise the plan inline** and note what changed.

## Output

Show the final plan. If you revised anything during self-review, briefly note what changed and why.

Then: "Run `/shakedown` for an independent review, or say **go** to start building. When done, run `/shakedown` again to review the code."
