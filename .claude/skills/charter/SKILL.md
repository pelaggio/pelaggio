---
name: charter
description: Charter a new work item — define scope, dependencies, and destination roadmap
argument-hint: "<description> [--to <roadmap>] [--scope XS|S|M|L|XL] [--after <id>] [--priority high|normal]"
allowed-tools: Read Glob Grep Edit
---

# /charter — Charter a Work Item

A ship's charter is its mission document — what the voyage is, what it delivers, and what it costs. `/charter` defines a new work item so `/pick` can claim it and autopilot can execute it.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO.

Parse `$ARGUMENTS` — the full text is the item description. Extract flags if present:
- `--to <roadmap>` — target roadmap file (partial match, e.g. `phase4-competitive`, `app-store`). If omitted, infer from content.
- `--scope XS|S|M|L|XL` — estimated scope. Default: infer from description (see "Scope inference" below).
- `--after <id>` — insert after this item ID. Default: append to end of appropriate section.
- `--priority high` — mark as high priority (appears earlier in section).
- `--bug` — shorthand: prefix title with "Fix:", scope S, add to the release/bugs roadmap.

## Discover roadmaps

Read `{MAIN_REPO}/docs/task-index.md` to understand existing item IDs and which roadmaps they belong to. Then read only the target roadmap file to understand:
1. The ID prefix convention for the track (e.g. COMP-, FORE-, DISC-, PE-, F-, etc.)
2. The format: checkbox (`- [ ] **ID. Title**`) or table (`| ID | Status | ...`)
3. The next available ID number in the chosen track

## Select target

If `--to` is specified, match it to a roadmap file. Otherwise infer from the item description and the existing roadmap topics. If unclear, ask the user.

## Scope inference

If `--scope` was supplied, use it verbatim and skip this section. If `--bug` was
supplied, scope is **S** (bug-fix override) — skip inference. Otherwise run the
heuristic below against the description text (case-insensitive, word-boundary
matches — `\bfix\b` not bare `fix`, so "prefix" / "fixture" don't trigger XS).

Scan ranks top-down; **first match wins**. Broadest-first so "migrate and
rename" correctly infers XL, not XS.

| Rank | Scope | Trigger keywords (any match, word-boundary) | Rationale phrase |
|------|-------|---------------------------------------------|------------------|
| 1 | XL | `migration`, `migrate`, `rewrite`, `schema change`, `re-architect` | migration / rewrite / schema change |
| 2 | L  | `new system`, `new engine`, `new pipeline`, `new framework` | new system / engine |
| 3 | M  | `new screen`, `new page`, `new component`, `new hook`, `new adapter`, `new command` | new screen / component / adapter |
| 4 | S  | `add`, `one file`, `small`, `extract`, `wire up` | add X / single-file change |
| 5 | XS | `fix`, `typo`, `rename`, `tweak`, `bump` | fix / typo / rename |
| — | M  | (no keyword matched) | default — no keyword matched |

Default on no match is **M**, not S. S routes through `isQuickScope` straight
to `/implement`, skipping planning — too risky for an ambiguous description.
Over-scoping to M adds a plan step; under-scoping to S skips one.

Remember the chosen scope and its rationale phrase for the Report step below.

## Generate item

1. **ID**: Next available in the track's prefix sequence (e.g. if last is COMP-19, use COMP-20)
2. **Title**: Concise imperative description derived from the user's input
3. **Status**: Not started
4. **Scope**: `--scope` wins; else `--bug` → S; else the value from "Scope inference" above
5. **Dependencies**: Infer from description if obvious, otherwise none
6. **Description**: 1-2 sentences capturing what and why, derived from user input

## Write

Edit the target roadmap file. Match the existing format exactly:

**Checkbox format:**
```
- [ ] **{ID}. {Title}** — {description}. Scope: {XS|S|M|L|XL}. {Dependencies if any}.
```

**Table format:**
Add a row matching the existing column structure.

Insert at the position indicated by `--after`, or append to the end of the appropriate section.

## Update task index

After writing to the roadmap, also add the new item to `{MAIN_REPO}/docs/task-index.md` in the "Open items" table. Match the existing format:
```
| {ID} | {Title} | {deps or —} | — | {roadmap-name} |
```

Order rows alphabetically by prefix, then numerically within prefix — `/pick` relies on deterministic ordering.

## Report

Confirm: item ID, title, roadmap file, location. Mention that `/pick {ID}` or `/pick next` will pick it up.

If scope was inferred (i.e. neither `--scope` nor `--bug` was supplied), append two lines after the confirmation:

```
Inferred scope: {scope} ({rationale phrase})
Override with `/charter ... --scope <XS|S|M|L|XL>` if wrong.
```

Skip these lines when `--scope` or `--bug` was explicit — the absence signals the user supplied the value.
