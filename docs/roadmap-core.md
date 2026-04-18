# Core Roadmap — claude-autopilot self-improvements

Real backlog for the autopilot tooling. These are items we've identified during the design + extraction but haven't implemented yet. Dogfooding target: run `pnpm autopilot --cycles N` against this list and let the pipeline work on its own codebase.

**Related:** [task-index.md](task-index.md)

> **Sequencing:** TOOL-6 validated the pipeline end-to-end. TOOL-7 (doc-only, XS) and TOOL-12 (stats, S) are good next cycles to keep validating while building real value. TOOL-4 (pipeline tests) unblocks the plugin refactors. Critical path to "usable for outfit-assembler": TOOL-7 → TOOL-8 → TOOL-12 → TOOL-4 → TOOL-11 → TOOL-13.

## Progress

**Open items:**

| Item | Depends on |
|------|-----------|
| TOOL-1. Consistency check: task-index ↔ roadmap drift | — |
| TOOL-2. Dep graph visualization from roadmap files | — |
| TOOL-3. Scope suggestion in /charter from description | — |
| TOOL-4. pipeline.ts integration tests via SDK query mock | — |
| TOOL-5. Skill body linter (frontmatter validity, rubric references) | — |
| ~~TOOL-6. Biome config for scripts/ + pre-commit hook~~ | **Done** — Biome config added, pre-commit hook wired (2026-04-11) |
| TOOL-7. Document in-context vs out-of-context review + add Idioms section to rubric | — |
| TOOL-8. `.autopilot.yml` project config file + loader | — |
| TOOL-9. RoadmapSource abstraction + MarkdownRoadmap adapter | TOOL-4, TOOL-8 |
| TOOL-10. GitHubIssuesRoadmap adapter via gh CLI | TOOL-9 |
| TOOL-11. ShipTarget abstraction + 3 adapters | TOOL-4, TOOL-8 |
| TOOL-12. Running totals — token counts + stats dashboard | — |
| TOOL-13. Publish as `@cdhorne/claude-autopilot` on npm + `init` CLI | TOOL-8, TOOL-11 |
| TOOL-14. `sync` CLI — upgrade installed skills with diff prompts | TOOL-13 |
| TOOL-15. LinearRoadmap adapter | TOOL-9 |
| TOOL-16. Split /refit → /bump-models + self-hosted Renovate | — |

---

## Items

### TOOL-1. Consistency check: task-index ↔ roadmap drift

| What | Scope | Deps |
|------|-------|------|
| Script that verifies every open item in a `roadmap-*.md` has a matching row in `task-index.md`, and vice versa. Flags missing/extra rows and ID collisions. Run as a standalone command or as a pre-commit hook. | S | — |

**Deliverables:**
- `scripts/check-roadmap.ts` — reads all `docs/roadmap-*.md`, extracts open items, cross-checks against `docs/task-index.md`
- Exit 0 when consistent, exit 1 with actionable diff when not
- Optional `--fix` flag that adds missing task-index rows from roadmaps (roadmaps are source of truth)
- Wire into `pnpm` scripts as `pnpm check:roadmap`
- Unit tests for the parser

**Out of scope:**
- Bidirectional sync (roadmaps are source of truth, task-index is derived)
- Detecting semantic drift (title changed in one file but not the other) — only structural presence/absence

---

### TOOL-2. Dep graph visualization from roadmap files

| What | Scope | Deps |
|------|-------|------|
| Parse `Depends on` columns across all roadmaps and emit a Mermaid flowchart that can be dropped into docs. | S | — |

**Deliverables:**
- `scripts/roadmap-graph.ts` — walks all `docs/roadmap-*.md`, builds a dep graph, emits Mermaid `flowchart LR` syntax to stdout
- `pnpm graph:roadmap` script that writes the output to `docs/dep-graph.md`
- Distinguishes open (box) vs blocked (rounded) vs completed (dashed) items
- Fails cleanly if a dep references an unknown ID

**Out of scope:**
- Interactive graph (Mermaid is enough)
- Priority-weighted layout
- Cross-repo deps (one repo at a time)

---

### TOOL-3. Scope suggestion in /charter from description

| What | Scope | Deps |
|------|-------|------|
| When `/charter` is called without `--scope`, infer XS/S/M/L/XL from the description using keyword heuristics. Report the inferred scope + a one-line rationale. | S | — |

**Deliverables:**
- Update `.claude/skills/charter/SKILL.md` with a "Scope inference" section listing the heuristics
- Heuristics: "fix" / "typo" / "rename" → XS; "add X" / "one file" → S; "new screen" / "new hook" → M; "new system" / "new engine" → L; "migration" / "rewrite" / "schema change" → XL
- The skill already has `--scope` override — don't break that path
- Report: `"Inferred scope: M (new screen/component)"`

**Out of scope:**
- ML-based scope estimation — keyword heuristics are fine
- Changing the XS/S/M/L/XL taxonomy

---

### TOOL-4. pipeline.ts integration tests via SDK query mock

| What | Scope | Deps |
|------|-------|------|
| Add integration tests for `pipeline.ts` that mock the `claude-agent-sdk` `query()` generator to simulate step outcomes without real API calls. | M | — |

**Deliverables:**
- `scripts/autopilot/__tests__/pipeline.test.ts` with at least 4 scenarios:
  - Happy path: pick → plan → shakedown-plan (APPROVE) → implement → shakedown-code → ship all succeed
  - RETHINK verdict on plan review aborts the cycle cleanly
  - Implement turn exhaustion retries once, then commits a checkpoint
  - Rate limit parking preserves state for resume
- Mock infrastructure for `query()` — a generator factory that yields configured `SDKAssistantMessage` / `SDKResultMessage` events
- Tests run via `npx tsx --test`
- No real SDK calls, no real git operations (use a temp directory)

**Out of scope:**
- E2E tests with real SDK (too expensive)
- UI testing for `tui.ts`

---

### TOOL-5. Skill body linter (frontmatter validity, rubric references)

| What | Scope | Deps |
|------|-------|------|
| Lint all `.claude/skills/*/SKILL.md` files for: valid frontmatter, required fields, consistent `!cat` includes, no dangling references to removed skills or files. | S | — |

**Deliverables:**
- `scripts/check-skills.ts` — reads all SKILL.md files, parses frontmatter, validates against a schema
- Required fields: `name`, `description`, `allowed-tools`
- Optional fields: `argument-hint`, `context`, `agent`, `effort`, `disable-model-invocation`
- Flags unknown frontmatter fields
- Validates `!cat .claude/skills/X.md` references point at real files
- Flags `$ARGUMENTS` usage where `argument-hint` is missing
- Wire into `pnpm` as `pnpm check:skills`

**Out of scope:**
- Validating skill prose content (too subjective)
- Markdown linting (defer until/if biome supports MD)

---

### TOOL-6. Biome config for scripts/ + pre-commit hook ✓

Completed. See git history for implementation details.

---

### TOOL-7. Document in-context vs out-of-context review + add Idioms section to rubric

| What | Scope | Deps |
|------|-------|------|
| Codify the two-pass review model the pipeline already runs: `/plan`'s self-review is in-context (sees the reasoning that produced the artifact), `/shakedown`'s forked review is out-of-context (reads cold, no bias). Add an "Idioms" section to `_rubric.md` for framework-time best practices, design patterns, and simplicity. The out-of-context pass is responsible for stress-testing Idioms because it has the fresh eyes needed to catch convention drift. | XS | — |

**Deliverables:**
- Update `.claude/skills/_rubric.md` with a new "Idioms" section covering: current-framework-version idioms (name the version), well-established design patterns, simplicity over cleverness, consistency with industry conventions
- Update `.claude/skills/shakedown/SKILL.md` to note that the forked out-of-context review is primarily responsible for the Idioms section
- Update `.claude/skills/plan/SKILL.md` self-review section to note it's the in-context pass focused on project invariants (not Idioms)
- Update `CLAUDE.md` with a "Review model" section documenting the in/out-of-context distinction

**Out of scope:**
- Implementing a separate idioms file (we decided single file is fine)
- Any code changes — this is doc-only

---

### TOOL-8. `.autopilot.yml` project config file + loader

| What | Scope | Deps |
|------|-------|------|
| Extract every hardcoded path, budget, turn limit, model profile, and step constant from `config.ts` into a declarative YAML config at the repo root. `config.ts` becomes defaults + a loader that merges `.autopilot.yml` on top. Consuming projects override what they need; unspecified fields fall through to defaults. | M | — |

**Deliverables:**
- `.autopilot.yml` schema with keys: `project`, `docs.{rubric,philosophy,architecture,task-index}`, `roadmap.{source,glob,plans}`, `ship.{target,main-branch,squash}`, `models.profiles.{standard,quick}.*`, `budgets.*`, `turn-limits.*`, `worktree.prefix`
- `scripts/autopilot/config.ts` refactored: DEFAULTS export (current values), `loadConfig()` function that reads `.autopilot.yml` and deep-merges with defaults, exports `BUDGETS`, `TURN_LIMITS`, etc. as resolved values
- YAML parser: use `yaml` npm package (small, well-known)
- Backward compat: if `.autopilot.yml` is absent, current defaults apply unchanged — no existing behavior breaks
- Document the schema in `CLAUDE.md` and optionally in a new `docs/config.md`
- Unit tests: loader handles missing file, partial override, invalid YAML

**Out of scope:**
- Runtime reload (config is read once at pipeline start)
- JSON Schema validation — defer until needed
- Secret handling — there are no secrets in config today

---

### TOOL-9. RoadmapSource abstraction + MarkdownRoadmap adapter

| What | Scope | Deps |
|------|-------|------|
| Define a `RoadmapSource` interface with `listOpenItems`, `claimItem`, `markDone`, `getItemPlan`. Factor all markdown-specific code currently in `helpers.ts` (findPlanFile, findPlanPath, parseItemId, isQuickScope, plus the ship skill's mark-done logic) into a `MarkdownRoadmap` adapter class. Pipeline reads `roadmap.source` from config and instantiates the right adapter. | M | TOOL-4, TOOL-8 |

**Deliverables:**
- `scripts/autopilot/roadmap/index.ts` — interface + factory
- `scripts/autopilot/roadmap/markdown.ts` — MarkdownRoadmap adapter, wraps existing helpers
- Refactor pipeline.ts to call `roadmap.claimItem(id)` instead of hardcoded markdown functions
- Refactor `/ship` skill body to call a provided mark-done function (or keep ship markdown-aware for now — document in the adapter interface what ship needs)
- Integration tests via mock RoadmapSource
- `pnpm autopilot --dry-run` still works with the default markdown source

**Out of scope:**
- Additional adapters (TOOL-10, TOOL-15)
- Changing the markdown format — existing `roadmap-*.md` + `task-index.md` behavior is preserved

---

### TOOL-10. GitHubIssuesRoadmap adapter via gh CLI

| What | Scope | Deps |
|------|-------|------|
| Implement `RoadmapSource` backed by GitHub Issues. Items = issues with a configurable label (default `autopilot`). Plans stored as issue comments (or PR descriptions once `/ship` creates a PR). Uses `gh` CLI rather than a raw GitHub API client to avoid adding octokit as a dependency. | M | TOOL-9 |

**Deliverables:**
- `scripts/autopilot/roadmap/github-issues.ts` — adapter implementing `RoadmapSource`
- Config schema: `roadmap.source: github-issues`, `roadmap.github.repo`, `roadmap.github.label`, `roadmap.github.plan-location: issue-comment | pr-description`
- `listOpenItems`: `gh issue list --label <label> --state open --json number,title,labels,body`
- `claimItem`: mark issue as "in progress" (add label or assign), create branch + worktree
- `markDone`: close issue with a comment linking the merged PR/commit
- `getItemPlan`: fetch issue comment matching a specific tag (e.g. `<!-- autopilot-plan -->`)
- Graceful failure when `gh` CLI is not installed or not authenticated
- Tests with `gh` CLI mocked at the shell level

**Out of scope:**
- Bidirectional sync — GH Issues is the source, no local cache
- Multi-repo issue sources — one repo per autopilot instance

---

### TOOL-11. ShipTarget abstraction + DirectPush/PullRequest/AutoMergePR adapters

| What | Scope | Deps |
|------|-------|------|
| Define `ShipTarget` interface with `ship(branch, metadata) → ShipResult`. Factor `/ship` skill's merge/push logic into three adapters: `DirectPush` (current default: merge locally, push main), `PullRequest` (push branch, create PR via `gh pr create`, stop), `AutoMergePR` (push branch, create PR with auto-merge enabled). Pipeline reads `ship.target` from config. | M | TOOL-4, TOOL-8 |

**Deliverables:**
- `scripts/autopilot/ship/index.ts` — interface + factory
- `scripts/autopilot/ship/direct-push.ts` — wraps current `/ship` merge+push flow
- `scripts/autopilot/ship/pull-request.ts` — push + `gh pr create` + stop
- `scripts/autopilot/ship/auto-merge-pr.ts` — push + PR + `gh pr merge --auto`
- Refactor `/ship` skill to delegate to the configured target
- Merge conflict handling stays adapter-local (each target knows how to resolve its own)
- Integration tests for all three targets

**Out of scope:**
- Multi-target ship (pick one per repo, not mix-and-match)
- Custom conflict resolution strategies beyond the built-ins

---

### TOOL-12. Running totals — token counts + stats JSON + `pnpm autopilot stats`

| What | Scope | Deps |
|------|-------|------|
| The `claude-agent-sdk` `SDKResultMessage` exposes `usage` (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens). Capture these per step, append to `.dev/autopilot-stats.json` after each cycle, and add a `pnpm autopilot stats` subcommand that prints a dashboard. | S | — |

**Deliverables:**
- Read `usage` from `SDKResultMessage` in `step-runner.ts`, thread into `StepResult`
- `.dev/autopilot-stats.json` append-only with fields: totalCycles, completedCycles, failedCycles, totalCostUsd, totalInputTokens, totalOutputTokens, cacheReadTokens, itemsDelivered (array with id, title, date, cost), costByProfile, costByStep
- `scripts/autopilot/stats.ts` — reads the JSON, renders a dashboard via `tui.ts`
- `autopilot.ts` entry point routes `stats` subcommand to the dashboard
- `README.md` updated with a dashboard screenshot / example

**Out of scope:**
- Per-day / per-week aggregations (dashboard is cumulative + last-N-items)
- Exporting stats to external dashboards (Grafana, etc.)
- Per-token cost breakdown by model (just by step for now)

---

### TOOL-13. Publish as `@cdhorne/claude-autopilot` on npm + `init` CLI

| What | Scope | Deps |
|------|-------|------|
| Package the pipeline runtime + skill templates as a publishable npm package. Consuming projects install via `pnpm add -D @cdhorne/claude-autopilot` and run `npx claude-autopilot init` to scaffold `.claude/skills/`, `.autopilot.yml`, and example `docs/roadmap-*.md`. Package exports pipeline as a library so consuming projects can wrap it with custom logic if needed. | L | TOOL-8, TOOL-11 |

**Deliverables:**
- `package.json` with `name: @cdhorne/claude-autopilot`, correct `files`, `bin`, `exports` fields
- `bin/claude-autopilot.js` — CLI entry point with subcommands: `init`, `sync`, `run`, `stats`
- `init` subcommand: copies `.claude/skills/` templates into consuming project (non-destructive — skip if files exist unless `--force`), creates stub `.autopilot.yml`, wires `pnpm autopilot` script in consuming project's package.json
- Library exports: `run(options)`, `loadConfig()`, individual pipeline functions for programmatic use
- `.npmignore` to exclude `.dev/`, `docs/plans/`, `scripts/autopilot/__tests__/`
- Published version 0.1.0 (alpha, unstable)
- README updated with installation + usage instructions

**Out of scope:**
- Sync command (TOOL-14)
- Semver stability — this is alpha, breaking changes expected
- Publishing automation (manual `pnpm publish` for first release)

---

### TOOL-14. `sync` CLI — upgrade installed skills with diff prompts

| What | Scope | Deps |
|------|-------|------|
| `npx claude-autopilot sync` diffs the consuming project's `.claude/skills/*/SKILL.md` against the package's versions and prompts per-file: overwrite, skip, merge. Never touches `_rubric.md`, `docs/`, `plans/`, or any project-specific content. Handles the upgrade case cleanly so projects can pull autopilot improvements without losing customizations. | M | TOOL-13 |

**Deliverables:**
- `sync` subcommand in `bin/claude-autopilot.js`
- Diff computation using `diff` npm package (standard)
- Interactive prompts via `@clack/prompts` or similar (small, cross-platform)
- `--dry-run` flag previews without applying
- `--force` flag overwrites without prompting (for CI)
- Explicit allowlist of files the sync touches (SKILL.md in named skill directories) — everything else is off-limits
- Merge strategy: show diff, user decides; no auto-merge of conflicts

**Out of scope:**
- Downgrades
- Syncing `scripts/autopilot/` (that's a package upgrade, not a sync operation)

---

### TOOL-15. LinearRoadmap adapter

| What | Scope | Deps |
|------|-------|------|
| Implement `RoadmapSource` backed by Linear. Lower priority than TOOL-10 — defer until actually using Linear. | M | TOOL-9 |

**Deliverables:**
- `scripts/autopilot/roadmap/linear.ts` — adapter implementing `RoadmapSource`
- Uses Linear GraphQL API via `@linear/sdk`
- Config: `roadmap.source: linear`, `roadmap.linear.{workspace-id,team-id,label}`
- API key handling via `LINEAR_API_KEY` env var (never committed)
- `listOpenItems`, `claimItem`, `markDone`, `getItemPlan` symmetrical to GitHub adapter

**Out of scope:**
- Same as TOOL-10 — single workspace per instance

---

### TOOL-16. Split /refit → /bump-models + self-hosted Renovate

| What | Scope | Deps |
|------|-------|------|
| The current `/refit` skill bundles two concerns: Anthropic model ID drift (legitimately manual — no `-latest` alias) and package dependency drift (redundant with Renovate/Dependabot and has fragile `pnpm outdated` parsing). Shrink the skill to model-IDs-only, and delegate package bumps to self-hosted Renovate running on the existing self-hosted runner (same machine as `../fathom`). Keeps everything in-repo, zero GitHub-hosted Actions minutes consumed. | M | — |

**Deliverables:**
- Replace `.claude/skills/refit/SKILL.md` with `.claude/skills/bump-models/SKILL.md` (~20 lines): fetches current Opus/Sonnet IDs (prefer `https://api.anthropic.com/v1/models` when `ANTHROPIC_API_KEY` is set, fall back to docs page), edits the `OPUS`/`SONNET` constants in `scripts/autopilot/config.ts`, runs `pnpm test && pnpm check`, commits with a clear `Why:` line
- Rubric guard in the skill: `rg 'claude-(opus|sonnet|haiku)-' scripts/` must only match `scripts/autopilot/config.ts` — skill fails loudly otherwise
- `.github/workflows/ci.yml` with `runs-on: self-hosted`, triggered on `pull_request` to main + `push` to main, running `pnpm install --frozen-lockfile && pnpm test && pnpm check`. Mirror fathom's `ci.yml` structure
- `.github/workflows/renovate.yml` with `runs-on: self-hosted` and a weekly cron (e.g. Monday 06:00), running the Renovate CLI directly (`npx renovate` or the official `renovatebot/github-action`) — no Mend GitHub App install
- `renovate.json` at repo root: `extends: ["config:recommended", ":automergeMinor", ":automergePatch"]`, `schedule: ["before 6am on monday"]`, `packageRules` with `dependencyDashboardApproval: true` for major updates
- Delete `.claude/skills/refit/` and its row in the `CLAUDE.md` skill table; add `/bump-models` row
- Update `~/.claude/projects/-home-chris-workspace-claude-autopilot/memory/feedback_dependency_bumps.md` to note deps are Renovate-managed; only the bump-models flow remains manual
- Verify the Renovate workflow runs end-to-end once (trigger manually via `workflow_dispatch`) before considering this done

**Out of scope:**
- Migrating fathom to Renovate (separate charter if desired)
- Renovate's Mend app — explicitly rejected in favor of self-hosted
- Changing autopilot's self-hosted runner config — reuse the existing runner as-is
- Handling secrets for Renovate (PAT scope): out of scope if the default `GITHUB_TOKEN` suffices; if not, document the required PAT scope but don't commit one

---

## Scope legend

- **XS** — 1-2 files, <1 hour of work
- **S** — 2-4 files, 1-3 hours
- **M** — 4-10 files, half day to full day
- **L** — 10+ files, multi-day, probably needs a plan
- **XL** — major feature, definitely needs a plan + shakedown-plan pass

Autopilot detects scope from the `scope: X` hint in the item text. XS/S items skip the planning step and go straight to implementation.
