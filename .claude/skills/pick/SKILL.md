---
name: pick
description: Select next work item from planning docs, claim it, create branch and worktree
argument-hint: "[item-id | next [topic]]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Bash(git:*) Bash(pnpm:*)
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

Run `git branch --list 'feat/*'` to get in-flight branches. Extract item IDs from branch names (e.g. `feat/b3-rolling-averages` → `B3`) to exclude already-claimed items.

Only read a full `docs/roadmap-*.md` file if you need the detailed spec for a specific item (e.g. to report scope/deliverables). Use the "Roadmap" column in the task index to know which file to open — don't read all of them.

## Selection

Parse `$ARGUMENTS` (may be empty).

**`/pick B3`** (argument is an item ID) — find that item by ID. If not found, report which docs were searched and stop. Skip to Claim.

**`/pick next`** (argument is exactly "next", no topic) — rank ALL pending items by: no unmet dependencies → not blocked on external factors → calendar urgency → unblocks others → no overlap with claimed items. **Immediately auto-claim the top match — do NOT ask for confirmation, do NOT list alternatives, do NOT wait for user input.** Go straight from ranking to the Claim section below. Do NOT filter by topic — consider all tracks.

**`/pick next web-sync`** (argument is "next" followed by a topic) — same ranking as above but filter pending items by the given topic (fuzzy match).

**`/pick`** (no argument) — show all pending items grouped by source doc. Suggest a best pick. Ask user to confirm.

If the branch already exists (item is already in-flight), report it and ask whether to reuse or pick a different item.

Items marked as **blocked** on external factors (regulatory, third-party APIs not yet available, etc.) should be ranked below unblocked items, but can still be picked if nothing else is available.

## Claim

1. Create branch + worktree:
   ```bash
   BRANCH="feat/{id-lower}-{short-desc}"   # max 50 chars
   WORKTREE="{MAIN_REPO}/../{project}-{id-lower}"   # e.g. $(basename "$MAIN_REPO")-{id-lower}
   git branch "$BRANCH" main
   git worktree add "$WORKTREE" "$BRANCH"
   ```

2. Note related `docs/plan-*.md` and `docs/design-*.md` files.

3. Install deps: `cd "$WORKTREE" && pnpm install --frozen-lockfile`

4. Report: item, branch, worktree, scope, related docs, dependencies.
   Next step: "Open a new terminal, `cd {worktree}`, run `claude`, then `/plan`."
