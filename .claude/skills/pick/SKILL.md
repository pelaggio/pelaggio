---
name: pick
description: Select next work item from planning docs, claim it, create branch and worktree
argument-hint: "[item-id | next [topic]]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Bash(git:*) Bash(pnpm:*) Bash(npx:*)
---

# /pick — Select and Claim a Work Item

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO. Use the resulting absolute path in all paths below.

| Path | Purpose |
|------|---------|
| `{MAIN_REPO}/docs/plans/` | Implementation plans (keyed by branch) |
| `{MAIN_REPO}/docs/roadmap-*.md` | Task-tracking planning docs |

Resolve MAIN_REPO now.

## Discover items

Read `{MAIN_REPO}/docs/task-index.md` — this is the compact index of all open items (~1K tokens vs ~37K for full roadmaps). It lists ID, title, deps, plan link, and which roadmap file each item lives in.

Run `git branch --list 'feat/*'` to get in-flight branches. Extract item IDs from branch names (e.g. `feat/tool-16-refit-split` → `TOOL-16`) to exclude already-claimed items.

Only read a full `docs/roadmap-*.md` file if you need the detailed spec for a specific item (e.g. to report scope/deliverables). Use the "Roadmap" column in the task index to know which file to open — don't read all of them.

## Selection

Parse `$ARGUMENTS` (may be empty).

**`/pick TOOL-16`** (argument is an item ID) — find that item by ID:
- If the ID is absent from task-index.md's **Open items** table but appears in the **Recently completed** list, report it and emit `pick-result: already-done`.
- If the ID is in neither list, report which docs were searched and emit `pick-result: unknown-id`.
- If the item's Deps column starts with `blocked:`, **stop immediately** and report: "⚠ {ID} is blocked: {blocker text from Deps column}. Cannot pick a blocked item." Do not create a branch or worktree. Emit `pick-result: blocked`.
- **Charter→pick race guard:** If the item is found in the working-tree `task-index.md`, verify it is also committed by running:
  ```bash
  git show HEAD:docs/task-index.md | grep -F "{ID}"
  ```
  If this command fails (exit code non-zero), the item exists only in uncommitted working-tree edits — `/charter` ran but did not commit. **Stop immediately** and report: "⚠ {ID} is only in uncommitted main-tree changes; commit the charter first." Do not create a branch or worktree. Emit `pick-result: unknown-id`.
- Otherwise proceed to Claim.

**`/pick next`** (argument is exactly "next", no topic) — rank ALL **unblocked** pending items by: no unmet dependencies → calendar urgency → unblocks others → no overlap with claimed items. **Hard-skip any item whose Deps column contains `blocked:`** — these are never eligible for auto-pick. **Immediately auto-claim the top match — do NOT ask for confirmation, do NOT list alternatives, do NOT wait for user input.** Go straight from ranking to the Claim section below. Do NOT filter by topic — consider all tracks. If the ranked list is empty after filtering, emit `pick-result: queue-empty`.

**`/pick next web-sync`** (argument is "next" followed by a topic) — same ranking as above but filter pending items by the given topic (fuzzy match). Same blocked-item exclusion applies. Emit `pick-result: queue-empty` if nothing matches.

**`/pick`** (no argument) — show all pending items grouped by source doc. Mark blocked items with their blocker reason but do not suggest them as a best pick. Suggest a best pick from unblocked items only. Ask user to confirm.

If the `feat/<id-lower>-*` branch already exists (item is already in-flight), report it, ask whether to reuse or pick a different item, and emit `pick-result: worktree-exists`.

## Claim

1. Create branch + worktree:
   ```bash
   BRANCH="feat/{id-lower}-{short-desc}"   # max 50 chars
   WORKTREE="{MAIN_REPO}/../{project}-{id-lower}"   # e.g. $(basename "$MAIN_REPO")-{id-lower}
   git branch "$BRANCH" main
   git worktree add "$WORKTREE" "$BRANCH"
   ```

2. Note related `docs/plan-*.md` and `docs/design-*.md` files.

3. Install deps: `npx claude-autopilot worktree-deps "$WORKTREE"`. When the worktree's `pnpm-lock.yaml` matches the main repo's, this symlinks `node_modules` to MAIN_REPO's instead of running a fresh install — fast and avoids I/O contention between parallel worktrees. On lockfile drift or a missing main `node_modules`, it falls through to `pnpm install --frozen-lockfile --silent`. The helper prints the action taken (`link` / `noop` / `install` / `reinstall` / `relink`).

4. Report: item, branch, worktree, scope, related docs, dependencies.
   Next step: "Open a new terminal, `cd {worktree}`, run `claude`, then `/plan`."

5. Emit a final `pick-result: claimed` line (see below).

## Result tag

Every exit path MUST end with a single structured line on its own:

```
pick-result: <tag>
```

where `<tag>` is one of:

| Tag | When |
|-----|------|
| `claimed` | Branch + worktree created successfully. |
| `blocked` | `/pick <ID>` for an item whose Deps column starts with `blocked:`. |
| `unknown-id` | `/pick <ID>` for an ID absent from both task-index.md's Open items and Recently completed lists. |
| `already-done` | `/pick <ID>` for an ID in the Recently completed list. |
| `worktree-exists` | `/pick <ID>` where the `feat/<id-lower>-*` branch already exists. |
| `queue-empty` | `/pick next [topic]` whose ranked list is empty after filtering blocked items. |

The pipeline parses this line to decide whether the cycle continues (recoverable:
`queue-empty`, `worktree-exists`, `already-done`) or halts (`blocked`,
`unknown-id`). Restating the tag in a summary paragraph is fine — the pipeline
uses the last occurrence.
