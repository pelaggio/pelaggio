# TOOL-29 — Broaden skill `allowed-tools` npx allowlist

## Scope

Collapse the enumerated `Bash(npx tsx:*) Bash(npx biome:*) [Bash(npx jest:*)]` grants in skill frontmatter to a single `Bash(npx:*)`, so consumer projects that invoke different `npx <tool>` subcommands (jest, drizzle-kit, renovate, etc.) don't need per-subcommand edits to the copied skills.

Affected files (four frontmatter lines only):

| File | Current (npx portion) | After |
|---|---|---|
| `.claude/skills/pick/SKILL.md` | `Bash(npx tsx:*)` | `Bash(npx:*)` |
| `.claude/skills/ship/SKILL.md` | `Bash(npx tsx:*) Bash(npx biome:*)` | `Bash(npx:*)` |
| `.claude/skills/shakedown/SKILL.md` | `Bash(npx tsx:*) Bash(npx biome:*)` | `Bash(npx:*)` |
| `.claude/skills/shipwreck/SKILL.md` | `Bash(npx jest:*) Bash(npx biome:*)` | `Bash(npx:*)` |

Also: add a "Recently done" row for TOOL-29 to `docs/roadmap-core.md` and a `TOOL-29 ✓` line to `docs/task-index.md` during ship. The item was not chartered up front, so the roadmap row is added here rather than deferred.

## Why this, not alternatives

- **`allowed-tools` governs inline (human-invoked) permission prompts only.** The pipeline bypasses it via `canUseTool: () => ({ behavior: "allow" })` in `step-runner.ts:155` (TOOL-27). So this is purely about the consumer-side slash-command UX.
- **Per-subcommand grants don't travel well between consumers.** `shipwreck` already carries a stale `Bash(npx jest:*)` from an earlier template import — this repo has no jest, so the grant is dead; meanwhile, `npx tsx` (which shipwreck's body actually uses for `pnpm test` fallbacks) is missing. Every narrow grant is a future drift source.
- **Precedent from the user's own env.** `~/.claude/settings.json` already grants `Bash(npx:*)` globally. Skills have been narrower than the user's actual trust boundary; broadening aligns them.
- **Alternative considered: keep narrow, enumerate per skill.** Rejected — every consumer would need a matching per-tool edit on first run, defeating the point of the `sync` CLI.
- **Alternative considered: add a `check-skills` rule forbidding sub-enumerated `Bash(npx <x>:*)` patterns.** Rejected — premature. Four instances, all fixed in this patch; adding a rule for a problem we're eliminating is YAGNI.

## Non-goals

- Broadening non-npx patterns (`Bash(pnpm:*)`, `Bash(gh pr:*)`, `Bash(git:*)`) — already broad or deliberately narrow.
- Pipeline permission changes — `canUseTool` allow-all stays.
- `check-skills.ts` schema changes — `allowed-tools` remains a required non-empty string, content-unchecked.
- Touching `plan`, `status`, `pickup`, `charter`, `bump-models`, `tidy` frontmatter — they don't invoke npx.
- `.claude-templates/` — it doesn't ship skill files; skills live under `.claude/skills/`.

## Files to change

1. `.claude/skills/pick/SKILL.md` line 6 — frontmatter `allowed-tools`.
2. `.claude/skills/ship/SKILL.md` line 6 — frontmatter `allowed-tools`.
3. `.claude/skills/shakedown/SKILL.md` line 8 — frontmatter `allowed-tools`.
4. `.claude/skills/shipwreck/SKILL.md` line 6 — frontmatter `allowed-tools`.
5. `docs/roadmap-core.md` — add a `~~TOOL-29. Broaden skill npx allowlist~~ | **Done** — ... (2026-04-18)` row to the Recently-done block, mirroring the TOOL-27 format at line 39.
6. `docs/task-index.md` — add `- TOOL-29 ✓` to Recently completed (ship step).

## Test strategy

- **`pnpm check:skills`** — confirms frontmatter still parses, `allowed-tools` stays a non-empty string, no drift. Existing test suite (`scripts/autopilot/__tests__/check-skills.test.ts`) covers the schema.
- **`npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/*.test.ts`** — full existing unit suite, smoke check.
- **Grep assertion (manual, during shakedown):** `rg 'Bash\(npx [a-z]' .claude/skills` returns zero hits after the patch.
- **No new unit tests.** The field is a free-form string; content validation would be scope creep (explicitly rejected above).

## Rubric self-check

- **Correct** — `allowed-tools` is consumer-inline UX only; pipeline uses `canUseTool` allow-all, so no pipeline invariant (step exhaustiveness, frontmatter stripping, worktree isolation, rate-limit parking, phantom ship guard) is touched. `expandSkill()` strips frontmatter before the SDK ever sees it. ✓
- **Well-typed** — No TypeScript changes. N/A. ✓
- **Well-factored** — Single-concept change across four files; no cross-module impact; no helper duplication. ✓
- **Well-tested** — Existing `check:skills` + test suite cover the surface. Adding a test for free-form-string content would be overfitting. ✓
- **Concise** — Four one-line edits plus two doc rows at ship. No new files, no abstractions, no shims. ✓
- **Idioms** — Deferred to `/shakedown` (out-of-context pass).

## Self-review notes (in-context pass)

- **Charter gap.** TOOL-29 was never chartered in `roadmap-core.md` or `task-index.md`; the branch appears to have been created ad-hoc. For a four-line change, retro-adding a "Recently done" row at ship is lower-cost than backfilling a full charter + running `/charter`. Flagged here so `/shakedown` can push back if this is the wrong call.
- **No-op guard for `shipwreck`.** Replacing `Bash(npx jest:*)` with `Bash(npx:*)` drops a stale grant and adds a live one simultaneously — not a semantic equivalence. The dead `jest` grant is the actual bug; confirmed this repo has no jest via `rg '"jest"' package.json` (absent). Consumers who *do* use jest still get it under `Bash(npx:*)`.
- **Security framing.** `Bash(npx:*)` permits downloading and running arbitrary registry packages. This matches the user's existing global allow; skill-level grants are a hint, not a sandbox boundary — the real trust decision happens at the Claude Code settings layer. Documenting this here so a future reviewer doesn't mistake the skill frontmatter for a security control.
- **Ship target.** `.autopilot.yml`'s `ship.target` governs merge vs PR; unrelated to this change. No ship-adapter code touched.

## Output order for `/implement`

1. Edit `.claude/skills/pick/SKILL.md`, `ship/SKILL.md`, `shakedown/SKILL.md`, `shipwreck/SKILL.md` frontmatter.
2. `pnpm check:skills` → expect exit 0.
3. `npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/*.test.ts` → expect all pass.
4. `rg 'Bash\(npx [a-z]' .claude/skills` → expect zero hits.
5. Commit. Roadmap + task-index rows land in the ship step per repo convention.
