---
name: pick
description: Select next work item from the configured roadmap source, claim it, create branch and worktree
argument-hint: "[item-id | next [topic]]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Bash(git:*) Bash(pnpm:*) Bash(npx:*)
---

# /pick — Select and Claim a Work Item

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO.

All roadmap lookups go through `npx @cdhorne/claude-autopilot roadmap ...`. The CLI dispatches to the configured adapter (markdown / github-issues / linear) so this skill is source-agnostic.

## Discover items

Run `npx @cdhorne/claude-autopilot roadmap list --json` to get the open set (each item has `id`, `title`, `deps`, `sourceRef`, `status`).

Run `git branch --list 'feat/*'` to get in-flight branches. Extract item IDs (e.g. `feat/tool-16-refit-split` → `TOOL-16`) to exclude already-claimed items.

## Selection

Parse `$ARGUMENTS` (may be empty).

**`/pick TOOL-16`** (argument is an item ID) — run `npx @cdhorne/claude-autopilot roadmap get TOOL-16 --json`, then branch on the JSON's `status` field:
- `unknown` (exit 2) → report which source was queried and emit `pick-result: unknown-id`.
- `done` → report it and emit `pick-result: already-done`.
- `blocked` → **stop immediately** and report "⚠ {ID} is blocked: {blockedReason or deps text}. Cannot pick a blocked item." Do not create a branch or worktree. Emit `pick-result: blocked`.
- `open` or `in-progress` → proceed to Claim.

**`/pick next`** (argument is exactly "next", no topic) — from the `roadmap list --json` output, **hard-skip any item with `status === "blocked"`**, then rank the remainder by: no unmet dependencies (empty `deps` or all deps satisfied) → calendar urgency → unblocks others → no overlap with claimed items. **Immediately auto-claim the top match — do NOT ask for confirmation, do NOT list alternatives, do NOT wait for user input.** Go straight from ranking to Claim. Do NOT filter by topic — consider all tracks. If the ranked list is empty after filtering, emit `pick-result: queue-empty`.

**`/pick next web-sync`** (argument is "next" followed by a topic) — same ranking but fuzzy-match the item's title against the topic. Same blocked exclusion. Emit `pick-result: queue-empty` if nothing matches.

**`/pick`** (no argument) — show all items from `roadmap list --json` grouped by source (use the `sourceRef` field). Mark blocked items but don't suggest them. Suggest a best unblocked pick. Ask user to confirm.

If the `feat/<id-lower>-*` branch already exists, report it, ask whether to reuse or pick a different item, and emit `pick-result: worktree-exists`.

## Claim

**If `$ARGUMENTS` contains `--no-worktree`** (CI / single-shot mode):
Run `npx @cdhorne/claude-autopilot roadmap claim --no-worktree <ID>` instead of the regular claim. This creates and checks out the feature branch in-place (no sibling worktree directory is created). The returned `worktree=` value will be the main repo path itself. Skip the `worktree-deps` install step — node_modules is already present in the working directory. Proceed directly to step 3 (Report).

**Otherwise** (normal mode):

1. Create branch + worktree via the adapter:
   ```bash
   npx @cdhorne/claude-autopilot roadmap claim <ID>
   ```
   This prints two lines:
   ```
   branch=<branch-name>
   worktree=<absolute-path>
   ```
   Parse both. The adapter picks adapter-correct branch/worktree names (e.g. `feat/tool-16-refit-split` for markdown, `feat/issue-123-<slug>` for github-issues, `feat/acme-7-<slug>` for linear).

2. Install deps: `npx @cdhorne/claude-autopilot worktree-deps "$WORKTREE"`. When the worktree's `pnpm-lock.yaml` matches the main repo's, this symlinks `node_modules` to MAIN_REPO's instead of running a fresh install — fast and avoids I/O contention between parallel worktrees. On lockfile drift or a missing main `node_modules`, it falls through to `pnpm install --frozen-lockfile --silent`. The helper prints the action taken (`link` / `noop` / `install` / `reinstall` / `relink`).

3. Report: item, branch, worktree, related docs, dependencies.
   Next step: "Open a new terminal, `cd {worktree}`, run `claude`, then `/plan`."

4. Emit `pick-item: <ID>` on its own line (the ID you just claimed, e.g. `pick-item: COMP-11C-II`) immediately followed by `pick-result: claimed` on the next line. The pipeline reads the ID from this marker — free-text ID mentions elsewhere in the output can be ambiguous when parent/child IDs share a prefix.

## Result tag

Every claim path MUST end with two structured lines on their own:

```
pick-item: <ID>
pick-result: <tag>
```

`pick-item:` is only emitted on the `claimed` path (it names the successfully-claimed ID). All other exit paths emit just `pick-result: <tag>`, where `<tag>` is one of:

| Tag | When |
|-----|------|
| `claimed` | Branch + worktree created successfully. |
| `blocked` | `/pick <ID>` for an item whose `status` is `blocked`. |
| `unknown-id` | `/pick <ID>` for an ID the adapter reports as `unknown` (exit 2). |
| `already-done` | `/pick <ID>` for an item whose `status` is `done`. |
| `worktree-exists` | `/pick <ID>` where the `feat/<id-lower>-*` branch already exists. |
| `queue-empty` | `/pick next [topic]` whose ranked list is empty after filtering blocked items. |

The pipeline parses this line to decide whether the cycle continues (recoverable:
`queue-empty`, `worktree-exists`, `already-done`) or halts (`blocked`,
`unknown-id`). Restating the tag in a summary paragraph is fine — the pipeline
uses the last occurrence.
