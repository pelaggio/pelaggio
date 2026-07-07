---
name: bump-models
description: Refresh Claude model IDs in packages/autopilot/scripts/autopilot/config.ts when Anthropic ships new Opus/Sonnet/Haiku versions or new model families
allowed-tools: Read Edit Bash(pnpm:*) Bash(git:*) Bash(rg:*) WebFetch
consumer: false
---

# /bump-models — Claude model ID refresh

Manual, low-frequency. Anthropic doesn't ship `-latest` aliases, so the `OPUS` and `SONNET` constants in `packages/autopilot/scripts/autopilot/config.ts` must be bumped by hand. Package deps are Renovate-managed — this skill does not touch them.

## 1. Fetch current model IDs

Prefer `https://api.anthropic.com/v1/models` (requires `ANTHROPIC_API_KEY`); if unset, fall back to `https://platform.claude.com/docs/en/about-claude/models/overview.md`. Identify the newest API IDs in the families this repo pins — currently Opus and Sonnet (matching `claude-[a-z]+-[0-9]+(?:-[0-9]+)?`, e.g. `claude-opus-4-8`, `claude-sonnet-5`). Version numbers don't follow a fixed family scheme — Sonnet jumped 4.6 → 5, skipping a 4.x continuation — so take whatever the API/docs report as newest rather than assuming the next ID just increments the current suffix. New family names (e.g. `claude-fable-5`) ship occasionally; check **availability in the user's jurisdiction** before recommending them — some models are export-restricted. Never invent a `-latest` suffix.

## 2. Compare and edit

Read `packages/autopilot/scripts/autopilot/config.ts`. The `OPUS` and `SONNET` constants live around line 43-44. If either is behind, edit in place. If a new family is being adopted, add a parallel constant and wire it through `MODEL_PROFILES` rather than reusing `OPUS`/`SONNET`, and extend `MODEL_ID_RE` in `packages/autopilot/scripts/autopilot/check-skills.ts` with the new family name so the skills/templates lint keeps catching pinned IDs.

## 3. Rubric guard

Run `rg 'claude-[a-z]+-[0-9]' packages/autopilot/scripts/ .claude/skills/ .claude-templates/ --glob '!**/__tests__/**' --glob '!**/bump-models/SKILL.md'` — it must match **only** `packages/autopilot/scripts/autopilot/config.ts`. The pattern catches any current or future Anthropic family ID (Opus / Sonnet / Haiku / Fable / Mythos / …); any other match means the "No hardcoded model strings" invariant is breaking — a stale model ID leaked into production source, a skill body, or a template; stop and investigate. Excluded by design: `__tests__/` fixtures legitimately pin literal IDs, and this skill's own `SKILL.md` names model-ID patterns in its instructions.

## 4. Verify

Run `pnpm test && pnpm check`. Abort on failure before committing.

## 5. Commit

Stage only `packages/autopilot/scripts/autopilot/config.ts`. Commit with a **Why:** line naming the drift (e.g. "Anthropic shipped Opus 4.8; no `-latest` alias exists, so the literal must be bumped"). Both constants can share one commit.
