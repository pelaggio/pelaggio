---
name: charter
description: Charter a new work item — define scope, dependencies, and destination roadmap
argument-hint: "<description> [--to <roadmap>] [--create] [--prefix <PFX>] [--format checkbox|table] [--scope XS|S|M|L|XL] [--after <id>] [--priority high|normal]"
allowed-tools: Read Glob Grep Bash(npx:*)
---

# /charter — Charter a Work Item

A ship's charter is its mission document — what the voyage is, what it delivers, and what it costs. `/charter` defines a new work item so `/pick` can claim it and autopilot can execute it.

## Context

All item creation goes through `npx @cdhorne/claude-autopilot roadmap create-item`. The CLI dispatches to the configured adapter (markdown writes a roadmap row + task-index entry; github-issues opens a labeled issue; linear creates a team issue).

Parse `$ARGUMENTS` — the full text is the item description. Extract flags if present:
- `--to <roadmap>` — target roadmap (partial match for markdown; ignored by gh/linear).
- `--create` — markdown-only: if `--to <roadmap>` has no existing match, create `docs/roadmap-<roadmap>.md`.
- `--prefix <PFX>` — markdown-only: explicit item ID prefix, letters only, e.g. `INST`.
- `--format checkbox|table` — markdown-only: explicit roadmap row format, bypassing adapter inference.
- `--scope XS|S|M|L|XL` — estimated scope. Default: infer from description (see "Scope inference" below).
- `--after <id>` — insert after this item ID (markdown-only; ignored elsewhere).
- `--priority high|normal` — priority hint.
- `--bug` — shorthand: prefix title with "Fix:", scope S, mark as a bug-fix item.

## Scope inference

If `--scope` was supplied, use it verbatim and skip this section. If `--bug` was supplied, scope is **S** — skip inference. Otherwise run the heuristic below against the description text (case-insensitive, word-boundary matches — `\bfix\b` not bare `fix`).

Scan ranks top-down; **first match wins**. Broadest-first so "migrate and rename" correctly infers XL, not XS.

| Rank | Scope | Trigger keywords (any match, word-boundary) | Rationale phrase |
|------|-------|---------------------------------------------|------------------|
| 1 | XL | `migration`, `migrate`, `rewrite`, `schema change`, `re-architect` | migration / rewrite / schema change |
| 2 | L  | `new system`, `new engine`, `new pipeline`, `new framework` | new system / engine |
| 3 | M  | `new screen`, `new page`, `new component`, `new hook`, `new adapter`, `new command` | new screen / component / adapter |
| 4 | S  | `add`, `one file`, `small`, `extract`, `wire up` | add X / single-file change |
| 5 | XS | `fix`, `typo`, `rename`, `tweak`, `bump` | fix / typo / rename |
| — | M  | (no keyword matched) | default — no keyword matched |

Default on no match is **M**, not S. S routes through `isQuickScope` straight to `/implement`, skipping planning — too risky for an ambiguous description. Over-scoping to M adds a plan step; under-scoping to S skips one.

Remember the chosen scope and its rationale phrase for the Report step below.

## Create the item

Build the argument list from the parsed flags and call the adapter:

```bash
npx @cdhorne/claude-autopilot roadmap create-item \
  --title "<concise imperative title derived from the user's input>" \
  [--scope <XS|S|M|L|XL>] \
  [--to <roadmap>] \
  [--create] \
  [--prefix <PFX>] \
  [--format checkbox|table] \
  [--after <id>] \
  [--priority high|normal] \
  [--deps "<csv of existing IDs>"] \
  --json
```

The CLI prints JSON with `id`, `title`, `deps`, `sourceRef`. The `id` is adapter-assigned — markdown allocates the next prefixed ID in the chosen roadmap file, github-issues returns the new issue number, linear returns the team-prefixed identifier. All file/format detection (checkbox vs table, prefix scanning, task-index update) lives in the adapter; only pass `--prefix` or `--format` when the user explicitly wants to override markdown inference.

## Report

Confirm: item ID (from the JSON response), title, roadmap/source (from `sourceRef`). Mention that `/pick {ID}` or `/pick next` will pick it up.

If scope was inferred (i.e. neither `--scope` nor `--bug` was supplied), append two lines after the confirmation:

```
Inferred scope: {scope} ({rationale phrase})
Override with `/charter ... --scope <XS|S|M|L|XL>` if wrong.
```

Skip these lines when `--scope` or `--bug` was explicit — the absence signals the user supplied the value.
