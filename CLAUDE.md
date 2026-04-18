# claude-autopilot — Claude Context

Headless pipeline for running `@anthropic-ai/claude-agent-sdk` cycles on a per-item basis: pick → plan → shakedown-plan → implement → shakedown-code → ship. Worktree-based parallelism, rate-limit parking, cost tracking, per-step model profiles.

This repo contains the *tooling*, not any product code. Products consume it by cloning `.claude/skills/`, `scripts/autopilot/`, and (optionally) `.claude-templates/` into their own repos. The migration process lives in `.claude-templates/migration-checklist.md`.

## Orientation

- Skills: `.claude/skills/` — each is a markdown file with frontmatter, read by `expandSkill()` in the pipeline
- Pipeline: `scripts/autopilot/` — TypeScript, runs on tsx (no build step)
- Rubric for this repo: `.claude/skills/_rubric.md` — meta-rubric for the tooling itself
- Templates for new projects: `.claude-templates/` — do NOT confuse with `.claude/skills/`
- Entry point: `scripts/autopilot.ts` → `scripts/autopilot/main.ts`

## Data model shape

N/A — no persistent data. State is the git working tree + `.dev/autopilot-log.jsonl` append-only log.

## Key constraints

- **Step exhaustiveness**: `STEPS` in `config.ts` is the source of truth. Adding a new step requires updating `BUDGETS`, `TURN_LIMITS`, `EFFORT`, and every `MODEL_PROFILES[profile]` entry. Missing keys crash late.
- **Frontmatter stripping**: `expandSkill()` strips frontmatter before returning the skill body. Never leak frontmatter into SDK prompts.
- **Worktree isolation**: `step-runner` installs PreToolUse hooks blocking writes to `MAIN_REPO` paths when running in a worktree. This prevents sibling-worktree corruption. Don't bypass.
- **Rate-limit parking preserves work**: every pipeline exit path must call `parkExit()` (which checkpoints uncommitted work) before returning on rate-limit rejection.
- **No hardcoded model strings**: all model names live in `MODEL_PROFILES` in `config.ts`. No other file references `claude-opus-*` or `claude-sonnet-*` literals.

## Pipeline steps (the nautical vocabulary)

| Skill | Role |
|---|---|
| `/pick` | Select next item from `docs/task-index.md`, create branch + worktree |
| `/plan` | Generate implementation plan, write to `docs/plans/{slug}.md`, commit |
| `/shakedown` | Review against rubric + fix issues. Plan-review mode (before implement) or code-review mode (after implement) |
| `/charter` | Add new work item to a roadmap + task-index |
| `/ship` | Squash, merge, update docs, push, clean up worktree |
| `/shipwreck` | Recovery skill when `/ship` fails partway through |
| `/pickup` | Rebuild context for in-progress work — read plan, show progress, suggest next step |
| `/status` | Where am I (current branch, plan, uncommitted, commits ahead) |
| `/tidy` | Clean up stale worktrees and archived roadmap items |
| `/refit` | Refresh Claude model IDs + deps — scan, categorize by risk, bump in reviewed stages |

## Non-obvious conventions

- **Relative imports use `.js` extension** (ESM convention, required by tsx for resolution). e.g., `from "./config.js"` even though the file is `.ts`.
- **No formal build step**: everything runs via `tsx`. `pnpm autopilot` = `tsx scripts/autopilot.ts`.
- **Tests run via `node:test`**: `npx tsx --test scripts/autopilot/__tests__/helpers.test.ts`. No Jest, no Vitest — keeping dependencies minimal.
- **Frontmatter is NOT consumed by the pipeline**: `expandSkill()` strips it. Frontmatter's purpose is for inline Claude Code usage (where a human types `/shakedown`); the pipeline reads only the body.
- **`context: fork` in skill frontmatter is only meaningful inline**: the SDK `query()` call already spawns an isolated session, so frontmatter `context` is redundant for pipeline use.
- **Worktree prefix auto-derived from `basename(REPO)`**: override via `CLAUDE_AUTOPILOT_WORKTREE_PREFIX` env var if your directory name doesn't match your project slug.
- **Biome is scoped to `scripts/**/*.ts`** via `biome.json` at the repo root. Skill and template markdown is not linted. Run `pnpm check` to lint or `pnpm format` to auto-fix. A lefthook `pre-commit` hook auto-formats staged `scripts/**/*.ts` and re-stages the fixes (`pnpm install` installs the hooks via the `prepare` script); autopilot checkpoint commits bypass it via `--no-verify` in `helpers.ts`.

## Running things

```bash
pnpm install                                              # install dependencies
pnpm autopilot --dry-run --cycles 1                       # smoke test, no SDK calls
pnpm autopilot --cycles 1 --verbose                       # real cycle, verbose output
pnpm autopilot --item INFRA-1 --verbose                   # specific item
pnpm autopilot --cycles 3 --parallel 2 --verbose          # parallel cycles
pnpm autopilot --resume INFRA-1                           # resume a parked/failed cycle
npx tsx --test scripts/autopilot/__tests__/*.test.ts      # run unit tests
```

## Bug reporter — automated fix instructions

When fixing bugs from automated reports:
- Make minimal, surgical edits only
- Commit directly to main (solo workflow)
- Do not modify GitHub Actions workflow files
- Run the unit tests before shipping (`npx tsx --test scripts/autopilot/__tests__/helpers.test.ts`)
