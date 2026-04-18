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
- **Plan-polish block**: during the `implement` step, `step-runner` installs a PreToolUse hook (`blockPlanPolish`) that rejects Write/Edit to any path under `docs/plans/`. The implement step must EXECUTE the plan by writing code elsewhere, not edit the plan document. Only `plan` and `shakedown-plan` may write to `docs/plans/`.
- **Permission mode is `canUseTool` allow-all, not `bypassPermissions`**: the SDK hardcodes a deny for writes to `.claude/skills/**` that survives both `permissionMode: "bypassPermissions"` and `allowDangerouslySkipPermissions: true`. The only knob that unlocks skill edits is a `canUseTool` callback (TOOL-27). `step-runner` uses `canUseTool: () => ({ behavior: "allow" })`; PreToolUse hooks still fire after the allow, so worktree-isolation and plan-polish guardrails are unaffected. See `docs/notes/tool-27-silent-edit-failures.md`.
- **Rate-limit parking preserves work**: every pipeline exit path must call `parkExit()` (which checkpoints uncommitted work) before returning on rate-limit rejection.
- **No hardcoded model strings**: all model names live in `MODEL_PROFILES` in `config.ts`. No other file references `claude-opus-*` or `claude-sonnet-*` literals.
- **Phantom ship guard**: `pipeline.ts` calls `hasDeliverableCommits()` before invoking `ship` — cycles whose branch only touches `docs/plans/` (i.e. only the `/plan` artifact with no implementation) are flagged `completed: false` with a "nothing to ship" error, and ship is never invoked. Doc-only work outside `docs/plans/` (rubric, skill bodies, README, roadmap edits) is still deliverable. The identical guard inside `/ship`'s SKILL.md is defense in depth for inline (non-pipeline) use.
- **Ship target is config-driven**: `/ship`'s merge vs PR behavior is selected by `ship.target` (`.autopilot.yml`) and dispatched via adapters in `scripts/autopilot/ship/`. The skill body branches on the `--target` arg; don't hardcode merge logic in TS. `/shipwreck` recovery only runs for `direct-push` — PR modes never merge in-session, so a ship failure there is reported as-is.
- **No install-script hooks in `package.json`**: never add `preinstall`, `install`, or `postinstall`. `scripts/check-publish.ts` (run via `pnpm check:publish` and in the publish workflow) fails the build if any of these appear. They run on every `npm install` of a consumer and are the standard supply-chain attack surface.

## Configuration

Optional `.autopilot.yml` at the repo root overrides defaults. All keys are
optional; missing file or empty file = defaults. Parsed once at startup by
`loadConfig()` in `config.ts` — parse errors fail loudly with the file path.

Live keys (consumed today): `worktree.prefix`, `budgets.*`, `turn-limits.*`,
`effort.*`, `models.profiles.<name>.*`, `ship.target`, `roadmap.source`.
Unknown top-level keys (e.g. `project`, `docs`) are silently ignored for
forward-compatibility as future TOOLs extend the schema.

Precedence for worktree prefix: `CLAUDE_AUTOPILOT_WORKTREE_PREFIX` env >
`worktree.prefix` in yml > `${basename(REPO)}-`. The env var is the
pre-existing escape hatch and still wins.

See `docs/config.md` for the annotated schema. The `.autopilot.yml` file is
intentionally **not** checked into this repo — defaults live in `DEFAULTS`
inside `config.ts` and the example lives in the doc.

## Review model

Two review passes with deliberately different context shapes:

- **`/plan`'s self-review — in-context.** Same session that wrote the plan. Sees the reasoning trail. Best at catching the **Correct** dimension (step exhaustiveness, frontmatter stripping, phantom ship guard, rate-limit parking, worktree isolation) because those were top-of-mind while planning.
- **`/shakedown`'s forked review — out-of-context.** Fresh SDK session, reads the artifact cold. Best at catching the **Idioms** dimension (convention drift, cleverness-over-simplicity, outdated framework patterns) because bias from the authoring session is absent.

Don't fold shakedown back into plan to save a cycle — the context-shape difference is the whole point.

## Pipeline steps (the nautical vocabulary)

| Skill | Role |
|---|---|
| `/pick` | Select next item from `docs/task-index.md`, create branch + worktree |
| `/plan` | Generate implementation plan, write to `docs/plans/{slug}.md`, commit |
| `/shakedown` | Review against rubric + fix issues. Plan-review mode (before implement) or code-review mode (after implement) |
| `/charter` | Add new work item to a roadmap + task-index |
| `/ship` | Squash, then one of: direct-push (merge → update docs → clean up) \| pull-request (push + `gh pr create`) \| auto-merge-pr (PR + `gh pr merge --auto`). Target picked by `ship.target`. |
| `/shipwreck` | Recovery skill when `/ship` fails partway through |
| `/pickup` | Rebuild context for in-progress work — read plan, show progress, suggest next step |
| `/status` | Where am I (current branch, plan, uncommitted, commits ahead) |
| `/tidy` | Clean up stale worktrees and archived roadmap items |
| `/bump-models` | Refresh Claude model IDs when Anthropic ships new Opus/Sonnet versions. Package deps are Renovate-managed. |
| `sync` (CLI) | `npx claude-autopilot sync` — diff installed `.claude/skills/<name>/SKILL.md` against the package and prompt overwrite/skip/merge per file. Not a pipeline step. |

## Roadmap sources

The pipeline reads roadmap + task-index data through a `RoadmapSource`
interface (`scripts/autopilot/roadmap/index.ts`). Today the only adapter is
`MarkdownRoadmap` (parses `docs/roadmap-*.md` + `docs/task-index.md`).
`getRoadmapSource(name, { repo })` is the factory; the resolved name comes
from `roadmap.source` in `.autopilot.yml` (default `"markdown"`). Adding a
new adapter (GitHub Issues, Linear) means adding a file under
`scripts/autopilot/roadmap/`, widening the `RoadmapSourceName` union in
`roadmap/types.ts`, and extending the factory `switch`. The `/pick` and
`/ship` skill bodies are still markdown-aware — wiring them through the
adapter is TOOL-10's scope.

## Non-obvious conventions

- **Relative imports use `.js` extension** (ESM convention, required by tsx for resolution). e.g., `from "./config.js"` even though the file is `.ts`.
- **No formal build step**: everything runs via `tsx`. `pnpm autopilot` = `tsx scripts/autopilot.ts`.
- **Tests run via `node:test`**: `npx tsx --test scripts/autopilot/__tests__/helpers.test.ts`. No Jest, no Vitest — keeping dependencies minimal.
- **Frontmatter is NOT consumed by the pipeline**: `expandSkill()` strips it. Frontmatter's purpose is for inline Claude Code usage (where a human types `/shakedown`); the pipeline reads only the body.
- **`context: fork` in skill frontmatter is only meaningful inline**: the SDK `query()` call already spawns an isolated session, so frontmatter `context` is redundant for pipeline use.
- **Worktree prefix auto-derived from `basename(REPO)`**: override via `CLAUDE_AUTOPILOT_WORKTREE_PREFIX` env var if your directory name doesn't match your project slug.
- **`_project-context.md` is the consumer-side extension point** for the three review skills (`plan`, `shakedown`, `ship`). They read it opt-in via `!cat .claude/skills/_project-context.md 2>/dev/null`, so the file is deliberately absent from this repo — autopilot itself is the generic baseline, and exercising the fallback path keeps the graceful include honest. Upstream `claude-autopilot sync` never touches it (the underscore-prefix skip in `planSync()` + the `ALLOWED_DEST` regex in `applyAction()` cover both `_project-context.md` and `.example`); consumers copy `.claude/skills/_project-context.md.example` to get started. `check-skills.ts` treats the `2>/dev/null` suffix as "dangling is fine" via the second capture group on `INCLUDE_RE`.
- **Worktrees share MAIN_REPO's `node_modules` via symlink when lockfiles match.** `/pick`'s Claim step (and a mid-cycle guard at the top of every worktree-cwd step in `step-runner.ts`) calls `scripts/autopilot/worktree-deps.ts`: if `<worktree>/pnpm-lock.yaml` sha256 matches `<MAIN_REPO>/pnpm-lock.yaml`, it symlinks `<worktree>/node_modules → <MAIN_REPO>/node_modules`; on drift or missing main `node_modules`, falls through to `pnpm install --frozen-lockfile --silent`. Root-only — workspace subpackages still install normally. Real (non-symlink) `node_modules` in the worktree is always left alone (user-managed). Ownership test is `lstatSync().isSymbolicLink()`.
- **Biome is scoped to `scripts/**/*.ts`** via `biome.json` at the repo root. Skill and template markdown is not linted. Run `pnpm check` to lint or `pnpm format` to auto-fix. A lefthook `pre-commit` hook auto-formats staged `scripts/**/*.ts` and re-stages the fixes (`pnpm install` installs the hooks via the `prepare` script); autopilot checkpoint commits bypass it via `--no-verify` in `helpers.ts`.

## Running things

```bash
pnpm install                                              # install dependencies
pnpm autopilot --dry-run --cycles 1                       # smoke test, no SDK calls
pnpm autopilot --cycles 1 --verbose                       # real cycle, verbose output
pnpm autopilot --item INFRA-1 --verbose                   # specific item
pnpm autopilot --cycles 3 --parallel 2 --verbose          # parallel cycles (auto-pick from queue)
pnpm autopilot --item A-1,A-2,A-3 --parallel 2 --verbose  # targeted multi-item batch (cycles auto-sized to list length)
pnpm autopilot --resume INFRA-1                           # resume a parked/failed cycle
pnpm check:roadmap                                        # verify task-index ↔ roadmap consistency (--fix adds missing index rows)
pnpm graph:roadmap                                        # regenerate docs/dep-graph.md (Mermaid) from roadmap-*.md; --stdout to pipe
npx tsx --test scripts/autopilot/__tests__/*.test.ts      # run unit tests
npx claude-autopilot sync --dry-run                       # preview skill-upgrade plan (consumer-side CLI)
```

## Bug reporter — automated fix instructions

When fixing bugs from automated reports:
- Make minimal, surgical edits only
- Commit directly to main (solo workflow)
- Do not modify GitHub Actions workflow files
- Run the unit tests before shipping (`npx tsx --test scripts/autopilot/__tests__/helpers.test.ts`)
