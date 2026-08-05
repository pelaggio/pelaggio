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

All roadmap lookups go through `npx pelaggio roadmap ...`. The CLI dispatches to the configured adapter (markdown / github-issues / linear) so this skill is source-agnostic.

## Discover items

Run `npx pelaggio roadmap list --json` to get the open set (each item has `id`, `title`, `deps`, `sourceRef`, `status`, and optionally typed curation fields such as `priority` and `deferred`).

Claimed items arrive pre-marked: the adapter reports them as `status === "in-progress"` (markdown: a `feat/<id>` branch exists; github/linear: the server-side claim marker). Do NOT re-derive claims from `git branch --list` prose — the adapter is the single source.

## Selection

Parse `$ARGUMENTS` (may be empty).

**`/pick TOOL-16`** (argument is an item ID) — run `npx pelaggio roadmap get TOOL-16 --json`, then branch on the JSON's `status` field:
- `unknown` (exit 2) → report which source was queried and emit `pick-result: unknown-id`.
- `done` → report it and emit `pick-result: already-done`.
- `blocked` → **stop immediately** and report "⚠ {ID} is blocked: {blockedReason or deps text}. Cannot pick a blocked item." Do not create a branch or worktree. Emit `pick-result: blocked`.
- `open` → proceed to Claim. An open item with `deferred: true` is **not** an unconditional override: `roadmap claim` first runs the #367 charter-review activation (a fresh panel over the current body), clears the deferred state only on a `ship`, and exits 5 if the review does not ship. Resolve first with `npx pelaggio roadmap un-defer <id>`.
- `in-progress` → a cycle (or stale branch) holds the claim: report it and go to the reuse flow below (ask whether to reuse the existing worktree or pick a different item; emit `pick-result: worktree-exists`). Never attempt a fresh claim on an in-progress item — it deterministically exits 3.

**`/pick next`** (argument is exactly "next", no topic) — run `npx pelaggio roadmap next --json`. Parse the `{ candidates: [{ item, verdict }], verdicts: [...] }` envelope and claim candidates in their returned order. Deferred and declared over-scope items appear only as non-eligible verdicts (`reason: "deferred"` / `reason: "over-scope"`) and never in `candidates`. **Immediately auto-claim the first candidate — do NOT ask for confirmation, do NOT list alternatives, do NOT wait for user input.** If `candidates` is empty (including an all-deferred set), emit `pick-result: queue-empty`.

**`/pick next web-sync`** (argument is "next" followed by a topic) — run `npx pelaggio roadmap next --topic "web-sync" --json` and consume the same ordered envelope. Emit `pick-result: queue-empty` if `candidates` is empty.

**`/pick`** (no argument) — show all items from `roadmap list --json` grouped by source (use the `sourceRef` field). Mark blocked items and items with `deferred: true` but do not recommend them. Suggest a best unblocked, non-deferred pick. Ask user to confirm.

If the `feat/<id-lower>-*` branch already exists, report it, ask whether to reuse or pick a different item, and emit `pick-result: worktree-exists`.

## Claim

**If `$ARGUMENTS` contains `--no-worktree`** (CI / single-shot mode):
Run `npx pelaggio roadmap claim --no-worktree <ID>` instead of the regular claim. This creates and checks out the feature branch in-place (no sibling worktree directory is created). The returned `worktree=` value will be the main repo path itself. Skip the `worktree-deps` install step — node_modules is already present in the working directory. Proceed directly to step 3 (Report).

**Otherwise** (normal mode):

1. Create branch + worktree via the adapter:
   ```bash
   npx pelaggio roadmap claim <ID>
   ```
   This prints two lines:
   ```
   branch=<branch-name>
   worktree=<absolute-path>
   ```
   Parse both. The adapter picks adapter-correct branch/worktree names (e.g. `feat/tool-16-refit-split` for markdown, `feat/issue-123-<slug>` for github-issues, `feat/acme-7-<slug>` for linear).

   **If the claim exits 3** (already claimed — another pick won the race for the
   `feat/<id>` branch, or the claim's server-side marker never surfaced), do NOT
		 retry the same ID. In `/pick next` mode: continue to the next candidate in the
		 returned policy envelope (repeat as needed; emit `pick-result: queue-empty`
   if the list empties). For an explicit `/pick <ID>`: emit
   `pick-result: already-claimed`. The pipeline treats it as recoverable.

   **If the claim exits 4** (stale-quarantined — the staleness sweep (#217) flagged the
   item as suspected already-implemented or obsolete and quarantined it locally), do NOT
   retry and do NOT divert to another item. This is not expected in `/pick next` mode (the
   policy envelope already excludes quarantined ids); for an explicit `/pick <ID>` emit
   `pick-result: stale-quarantined` and stop. The stderr names the reason, the evidence, and
   the `npx pelaggio roadmap stale-resolve <ID> --as done|keep` command an operator runs to
   clear it. The pipeline treats it as recoverable.

2. Install deps: `npx pelaggio worktree-deps "$WORKTREE"`. When the worktree's `pnpm-lock.yaml` matches the main repo's, this symlinks `node_modules` to MAIN_REPO's instead of running a fresh install — fast and avoids I/O contention between parallel worktrees. On lockfile drift or a missing main `node_modules`, it falls through to `pnpm install --frozen-lockfile --silent`. The helper prints the action taken (`link` / `noop` / `install` / `reinstall` / `relink`).

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
| `already-claimed` | `roadmap claim` exited 3 — another pick raced you to the `feat/<id>` branch. |
| `queue-empty` | `/pick next [topic]` whose ranked list is empty after filtering blocked and in-progress items. |
| `stale-quarantined` | `roadmap claim` exited 4 — the item is staleness-quarantined (#217) and needs `stale-resolve` before it can be picked. |

The pipeline parses this line to decide whether the cycle continues (recoverable:
`queue-empty`, `worktree-exists`, `already-claimed`, `already-done`, `stale-quarantined`)
or halts (`blocked`, `unknown-id`). Restating the tag in a summary paragraph is fine — the
pipeline uses the last occurrence.
