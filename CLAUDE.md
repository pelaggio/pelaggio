# claude-autopilot — Claude Context

Headless pipeline for running `@anthropic-ai/claude-agent-sdk` cycles on a per-item basis: pick → plan → shakedown-plan → implement → shakedown-code → ship. Worktree-based parallelism, rate-limit parking, cost tracking, per-step model profiles.

This repo contains the *tooling*, not any product code. Products consume it by cloning `.claude/skills/`, `packages/autopilot/scripts/autopilot/`, and (optionally) `.claude-templates/` into their own repos. The migration process lives in `.claude-templates/migration-checklist.md`.

## Orientation

This is a pnpm workspace. Three packages today:

- `packages/autopilot/` — the published pipeline (`@cdhorne/claude-autopilot`). All TypeScript runs on tsx; no build step.
  - Pipeline modules: `packages/autopilot/scripts/autopilot/` (read by `expandSkill()` in the pipeline)
  - Entry points: `packages/autopilot/scripts/autopilot.ts` → `…/autopilot/main.ts`; `packages/autopilot/bin/claude-autopilot.js` for the published CLI.
- `packages/server/` — control-plane daemon (`@cdhorne/claude-autopilot-server`, private). Hono HTTP service that supervises `pnpm autopilot` subprocesses, exposes them over `POST /runs`, `POST /runs/:id/{pause,resume,stop}`, `GET /runs/:id/log` (SSE), `GET /stats`, `GET /roadmap`, `GET /healthz`. State persists to `${repo}/.dev/server-state.json`; per-run stdout tees to `${repo}/.dev/server-logs/${id}.log`. Also serves `packages/web/dist/` under `/ui/*` when `AUTOPILOT_SERVER_WEB_DIST` resolves. Deployed as a systemd user unit (`infra/systemd/autopilot-server.service`); deploy workflow at `.github/workflows/deploy-server.yml`. See `docs/server.md` for API + setup.
- `packages/web/` — mobile-responsive control UI (`@cdhorne/claude-autopilot-web`, private). Astro 5 + React 19 islands + Tailwind v4, `output: "static"`, `base: "/ui/"`. Dev: `pnpm --filter @cdhorne/claude-autopilot-web dev` proxies API calls to the daemon. Prod: `astro build` → daemon static-mounts `dist/`. Manifest-based PWA, no service worker.

Repo root holds shared assets and dev tooling:

- Skills: `.claude/skills/` — markdown with frontmatter; lives at root for dogfooding (`REPO` from `git rev-parse --show-toplevel` is the workspace root). Copied into `packages/autopilot/.claude/skills/` by the package's `prepack` lifecycle so the published tarball includes them.
- Templates for consumers: `.claude-templates/` — same `prepack` treatment.
- Rubric: `.claude/skills/_rubric.md` — meta-rubric for the tooling itself.
- Workspace config: `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `lefthook.yml`.

`pnpm autopilot` at the root proxies into the package via `pnpm --filter @cdhorne/claude-autopilot autopilot`.

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
- **Ship target is config-driven**: `/ship`'s merge vs PR behavior is selected by `ship.target` (`.autopilot.yml`) and dispatched via adapters in `packages/autopilot/scripts/autopilot/ship/`. The skill body branches on the `--target` arg; don't hardcode merge logic in TS. `/shipwreck` recovery only runs for `direct-push` — PR modes never merge in-session, so a ship failure there is reported as-is.
- **No install-script hooks in `package.json`**: never add `preinstall`, `install`, or `postinstall`. `packages/autopilot/scripts/check-publish.ts` (run via `pnpm check:publish` and in the publish workflow) fails the build if any of these appear. They run on every `npm install` of a consumer and are the standard supply-chain attack surface.

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
| `/pick` | Select next item from the configured `RoadmapSource`, create branch + worktree |
| `/plan` | Generate implementation plan, write to `docs/plans/{slug}.md`, commit |
| `/shakedown` | Review against rubric + fix issues. Plan-review mode (before implement) or code-review mode (after implement) |
| `/charter` | Add new work item via the configured `RoadmapSource` (markdown roadmap + task-index, GitHub issue, or Linear issue) |
| `/ship` | Squash, then one of: direct-push (merge → update docs → clean up) \| pull-request (push + `gh pr create`) \| auto-merge-pr (PR + `gh pr merge --auto`). Target picked by `ship.target`. |
| `/shipwreck` | Recovery skill when `/ship` fails partway through |
| `/pickup` | Rebuild context for in-progress work — read plan, show progress, suggest next step |
| `/status` | Where am I (current branch, plan, uncommitted, commits ahead) |
| `/tidy` | Clean up stale worktrees and archived roadmap items |
| `/bump-models` | Refresh Claude model IDs when Anthropic ships new Opus/Sonnet versions. Package deps are Renovate-managed. |
| `sync` (CLI) | `npx claude-autopilot sync` — diff installed `.claude/skills/<name>/SKILL.md` against the package and prompt overwrite/skip/merge per file. Not a pipeline step. |

## Roadmap sources

The pipeline reads roadmap + task-index data through a `RoadmapSource`
interface (`packages/autopilot/scripts/autopilot/roadmap/index.ts`). Adapters today:
`MarkdownRoadmap` (parses `docs/roadmap-*.md` + `docs/task-index.md`),
`GitHubIssuesRoadmap` (via `gh` CLI), and `LinearRoadmap` (via `@linear/sdk`).
`getRoadmapSource(name, { repo })` is the factory; the resolved name comes
from `roadmap.source` in `.autopilot.yml` (default `"markdown"`). Adding a
new adapter means adding a file under `packages/autopilot/scripts/autopilot/roadmap/`, widening
the `RoadmapSourceName` union in `roadmap/types.ts`, and extending the
factory `switch`. Skill bodies access the adapter via the `roadmap` CLI
subcommand (see below), so no skill edits are needed.

## Non-obvious conventions

- **Skill → adapter bridge is `npx @cdhorne/claude-autopilot roadmap <subcommand>`.** Skill bodies never read roadmap files or issue trackers directly — they shell out to the `roadmap` CLI (`packages/autopilot/scripts/autopilot/roadmap-cli.ts`), which dispatches to the configured `RoadmapSource`. Subcommands: `list`, `get`, `claim`, `plan-path`, `publish-plan`, `mark-done`, `create-item`, `archive-plan`, `source`. Same idiom as `worktree-deps`. Adding a new adapter requires no skill edits.
- **Always use the scoped name `@cdhorne/claude-autopilot` in skill bodies** — never the bare `claude-autopilot`. The bare name collides with an unrelated public npm package that stays cached under `~/.npm/_npx/`; a cached hit caused an observed pipeline recursion (TOOL-50) where the agent substituted `pnpm autopilot <subcommand>` and re-entered the pipeline. The root `package.json` carries `@cdhorne/claude-autopilot: workspace:*` so pnpm exposes `node_modules/@cdhorne/claude-autopilot` at the workspace root; `check-skills` lint (`skill.npx-bare-autopilot`, `skill.pnpm-autopilot-subcommand`) enforces this. The pipeline entry (`packages/autopilot/scripts/autopilot/cli.ts`) rejects unknown positional args as defense-in-depth.
- **Relative imports use `.js` extension** (ESM convention, required by tsx for resolution). e.g., `from "./config.js"` even though the file is `.ts`.
- **No formal build step**: everything runs via `tsx`. `pnpm autopilot` at the root proxies to `pnpm --filter @cdhorne/claude-autopilot autopilot`, which runs `tsx scripts/autopilot.ts` inside the package.
- **Tests run via `node:test`**: `pnpm -r test` from the root, or `npx tsx --test packages/autopilot/scripts/autopilot/__tests__/helpers.test.ts` for a single file. No Jest, no Vitest — keeping dependencies minimal.
- **Frontmatter is NOT consumed by the pipeline**: `expandSkill()` strips it. Frontmatter's purpose is for inline Claude Code usage (where a human types `/shakedown`); the pipeline reads only the body.
- **`context: fork` in skill frontmatter is only meaningful inline**: the SDK `query()` call already spawns an isolated session, so frontmatter `context` is redundant for pipeline use.
- **Worktree prefix auto-derived from `basename(REPO)`**: override via `CLAUDE_AUTOPILOT_WORKTREE_PREFIX` env var if your directory name doesn't match your project slug.
- **`_project-context.md` is the consumer-side extension point** for the three review skills (`plan`, `shakedown`, `ship`). They read it opt-in via `!cat .claude/skills/_project-context.md 2>/dev/null`, so the file is deliberately absent from this repo — autopilot itself is the generic baseline, and exercising the fallback path keeps the graceful include honest. Upstream `claude-autopilot sync` never touches it (the underscore-prefix skip in `planSync()` + the `ALLOWED_DEST` regex in `applyAction()` cover both `_project-context.md` and `.example`); consumers copy `.claude/skills/_project-context.md.example` to get started. `check-skills.ts` treats the `2>/dev/null` suffix as "dangling is fine" via the second capture group on `INCLUDE_RE`.
- **Worktrees share MAIN_REPO's `node_modules` when lockfiles match — by symlink for external deps, by materialized real-dir for workspace-internal deps.** `/pick`'s Claim step (and a mid-cycle guard at the top of every worktree-cwd step in `step-runner.ts`) calls `packages/autopilot/scripts/autopilot/worktree-deps.ts`: if `<worktree>/pnpm-lock.yaml` sha256 matches `<MAIN_REPO>/pnpm-lock.yaml` AND MAIN's `node_modules` contains workspace-internal entries (e.g. `@scope/pkg → <MAIN>/packages/pkg`), the worktree gets a real `node_modules/` directory whose entries are absolute symlinks: workspace packages → `<worktree>/<pkg>` (so cross-package source changes resolve to the worktree's own copy), everything else (`.pnpm/`, `.bin/`, `.modules.yaml`, external deps) → `<MAIN>/node_modules/...` (preserving the shared content store). Same `materialize` shape applies per workspace subpackage's `node_modules`. Without workspace entries the simpler symlink-the-whole-dir path runs (`<worktree>/node_modules → <MAIN_REPO>/node_modules`); on drift or missing main `node_modules`, falls through to `pnpm install --frozen-lockfile --silent` at the worktree root, which provisions every subpackage in one pass. Materialize is idempotent: a correctly-materialized layer (workspace symlinks resolving into the worktree, `.pnpm` is a symlink not a real dir) returns `noop`. Real (non-symlink) `node_modules` without autopilot's emitted shapes (no workspace-into-MAIN symlinks, no real `.pnpm/` corruption signature) is left alone (user-managed). The per-subpackage `restore` / `materialize` branch only fires when the root just decided to restore/materialize (coupled corruption recovery). Real-dir vs symlink test is `lstatSync().isSymbolicLink()`; pnpm-store presence test is `isRealDir(.pnpm)` (lstat-based — *not* `existsSync`, which would follow the post-materialize symlink and falsely re-flag corruption).
- **Biome is scoped via one root `biome.json`** with `includes: ["packages/*/scripts/**/*.ts", "scripts/**/*.ts"]`. Skill and template markdown is not linted. Run `pnpm check` to lint or `pnpm format` to auto-fix. A lefthook `pre-commit` hook auto-formats staged TypeScript and re-stages the fixes (`pnpm install` installs the hooks via the `prepare` script); autopilot checkpoint commits bypass it via `--no-verify` in `helpers.ts`.
- **Skills + templates ship via `prepack`.** The published `@cdhorne/claude-autopilot` tarball needs `.claude/skills/` and `.claude-templates/`, but those live at the monorepo root for dogfooding. The package's `prepack` script (`packages/autopilot/scripts/pack-prepare.ts`) copies them in before `npm pack`; `postpack` (`pack-cleanup.ts`) removes them; both paths are listed in `packages/autopilot/.gitignore` so the working copy is single-sourced. `check-publish` imports `copySkillsIn` / `cleanSkillsOut` directly and runs `npm pack --dry-run --ignore-scripts` — the manual copy synthesizes the prepack tree while keeping `postpack` from firing mid-inspection (the secret scan still needs to read the copied files after `npm pack` returns).

## Running things

```bash
pnpm install                                              # install dependencies
pnpm autopilot --dry-run --cycles 1                       # smoke test, no SDK calls
pnpm autopilot --cycles 1 --verbose                       # real cycle, verbose output
pnpm autopilot --item INFRA-1 --verbose                   # specific item
pnpm autopilot --cycles 3 --parallel 2 --verbose          # parallel cycles (auto-pick from queue)
pnpm autopilot --item A-1,A-2,A-3 --parallel 2 --verbose  # targeted multi-item batch (cycles auto-sized to list length)
pnpm autopilot --resume INFRA-1                           # resume a parked/failed cycle
pnpm -r test                                              # run unit tests across the workspace
npx claude-autopilot sync --dry-run                       # preview skill-upgrade plan (consumer-side CLI)
```

## Bug reporter — automated fix instructions

**Primary flow (preferred):** File a GitHub issue describing the bug and apply the `autopilot:fix` label. The `.github/workflows/autopilot-fix.yml` workflow triggers automatically, runs autopilot headlessly, and opens a PR. Review and merge the PR when satisfied.

**Fallback (when autopilot declines or the fix requires human judgement):**
- Make minimal, surgical edits only
- Commit directly to main (solo workflow)
- Do not modify GitHub Actions workflow files
- Run the unit tests before shipping (`pnpm -r test`)
