---
name: refit
description: Refresh Claude model IDs and dependencies — scan for outdated versions, categorize by risk, bump in reviewed stages
allowed-tools: Read Edit Bash(pnpm:*) Bash(git:*) Bash(npm:*) WebFetch
---

# /refit — Model & Dependency Refresh

Weekly-to-daily maintenance. Anthropic doesn't ship `-latest` aliases, so Opus/Sonnet IDs in `scripts/autopilot/config.ts` must be bumped manually. Package deps drift too. This skill scans both, stages safe bumps together, and tackles majors one-by-one with research + separate commits.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — strip the trailing `/.git` to get MAIN_REPO.

Verify `git status` is clean-ish: a few pre-existing unstaged files are fine, but don't bundle them into refit commits — stage explicitly.

## 1. Model ID check

Read `scripts/autopilot/config.ts` and find the `OPUS` and `SONNET` constants.

Fetch https://platform.claude.com/docs/en/about-claude/models/overview.md and identify the newest `claude-opus-4-*` and `claude-sonnet-4-*` model IDs.

If either local constant is behind, note the bump. Anthropic has never shipped a `-latest` alias — do not invent one.

## 2. Dependency check

Run `pnpm outdated` from MAIN_REPO. Parse the table into two buckets:

- **Patch/minor bumps** (same major version) — safe to batch
- **Major bumps** (major version increment) — handle individually

## 3. Report & confirm

Present the findings to the user in this shape:

```
Model IDs:
- OPUS: claude-opus-4-X → claude-opus-4-Y  (or: up to date)
- SONNET: claude-sonnet-4-X → (up to date)

Patch bumps (safe):
- pkg-a: 1.2.3 → 1.2.7
- pkg-b: 2.4.11 → 2.4.12

Major bumps (need review):
- pkg-c: 1.13 → 2.1
- typescript: 5.9 → 6.0
```

Ask: apply patch bumps now + tackle majors one at a time? This is the default flow — don't batch majors unless the user explicitly says so.

## 4. Apply patch bumps

- Bump model IDs in `config.ts` if needed.
- Run `pnpm update <pkg-a> <pkg-b> ...` for the patch bucket.
- Run `pnpm test` and `pnpm check`. Abort if either fails — report to user before committing.
- Stage *only* the model/config + `package.json` + `pnpm-lock.yaml`. Do NOT `git add -A`.
- Commit with message body listing each bump + a **Why:** line explaining model drift (no `-latest` alias) when applicable.

## 5. Apply major bumps — one per commit

For each major bump:

1. Fetch the package's changelog / release notes (GitHub releases page, `CHANGELOG.md`, or the maintainer's blog). Identify breaking changes.
2. Grep the codebase for patterns the breaking changes would affect. Report: safe / needs edits (list) / major rewrite.
3. If safe or trivially fixable: apply the bump, make any required edits, run `pnpm test` + `pnpm check`, and if a hook-installing tool (like lefthook), reinstall hooks.
4. Commit with a **Why:** line summarizing why the upgrade is safe (what breaking changes don't apply here).
5. Move to the next major only after the previous commits cleanly.

If a major bump needs significant rework, stop and report. Do not try to land it as part of a routine refit — that's a proper work item for `/charter`.

## 6. Output

Summary:
- Model IDs: bumped X, already current Y
- Patch bumps: N packages, committed as `<sha>`
- Major bumps: M handled (`<sha>` each), K deferred (listed for charter)
- Tests: ✅/❌ after each stage

## Gotchas

- `pnpm outdated` returns non-zero exit when packages are outdated. Don't treat that as failure.
- Major version jumps in build-time-only tools (TypeScript, Biome) are usually safer than runtime deps. Still research them — don't skip the changelog read.
- If the repo has no `tsconfig.json` and `tsc` isn't in any script, TypeScript bumps are especially low-risk (tsx handles transpilation via swc).
- The autopilot pre-commit hook is scoped to `scripts/**/*.ts` — it won't block `package.json`-only commits but will run biome on any TS edits.
