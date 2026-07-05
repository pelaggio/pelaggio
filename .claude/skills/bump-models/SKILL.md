---
name: bump-models
description: Refresh Claude model IDs in packages/autopilot/scripts/autopilot/config.ts when Anthropic ships new Opus/Sonnet versions
allowed-tools: Read Edit Bash(pnpm:*) Bash(git:*) Bash(rg:*) WebFetch
consumer: false
---

# /bump-models — Claude model ID refresh

Manual, low-frequency. Anthropic doesn't ship `-latest` aliases, so the `OPUS` and `SONNET` constants in `packages/autopilot/scripts/autopilot/config.ts` must be bumped by hand. Package deps are Renovate-managed — this skill does not touch them.

## 1. Fetch current model IDs

Prefer `https://api.anthropic.com/v1/models` (requires `ANTHROPIC_API_KEY`); if unset, fall back to `https://platform.claude.com/docs/en/about-claude/models/overview.md`. Identify the newest `claude-opus-4-*` and `claude-sonnet-4-*` IDs. Never invent a `-latest` suffix.

## 2. Compare and edit

Read `packages/autopilot/scripts/autopilot/config.ts`. The `OPUS` and `SONNET` constants live around line 43-44. If either is behind, edit in place.

## 3. Rubric guard

Run `rg 'claude-(opus|sonnet|haiku)-' packages/autopilot/scripts/ .claude/skills/ .claude-templates/ --glob '!**/__tests__/**' --glob '!**/bump-models/SKILL.md'` — it must match **only** `packages/autopilot/scripts/autopilot/config.ts`. Any other match means the "No hardcoded model strings" invariant is breaking — a stale model ID leaked into production source, a skill body, or a template; stop and investigate. Excluded by design: `__tests__/` fixtures legitimately pin literal IDs, and this skill's own `bump-models/SKILL.md` names `claude-opus-4-*` / `claude-sonnet-4-*` as glob patterns.

## 4. Verify

Run `pnpm test && pnpm check`. Abort on failure before committing.

## 5. Commit

Stage only `packages/autopilot/scripts/autopilot/config.ts`. Commit with a **Why:** line naming the drift (e.g. "Anthropic shipped Opus 4.8; no `-latest` alias exists, so the literal must be bumped"). Both constants can share one commit.
