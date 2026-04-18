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
| ~~TOOL-4. pipeline.ts integration tests via SDK query mock~~ | **Done** — Pipeline integration tests + mock SDK query infrastructure added (2026-04-17) |
| TOOL-5. Skill body linter (frontmatter validity, rubric references) | — |
| ~~TOOL-6. Biome config for scripts/ + pre-commit hook~~ | **Done** — Biome config added, pre-commit hook wired (2026-04-11) |
| TOOL-7. Document in-context vs out-of-context review + add Idioms section to rubric | — |
| ~~TOOL-8. `.autopilot.yml` project config file + loader~~ | **Done** — `.autopilot.yml` config loader added (2026-04-17) |
| TOOL-9. RoadmapSource abstraction + MarkdownRoadmap adapter | — |
| TOOL-10. GitHubIssuesRoadmap adapter via gh CLI | TOOL-9 |
| TOOL-11. ShipTarget abstraction + 3 adapters | — |
| ~~TOOL-12. Running totals — tokens + quality signals + stats dashboard~~ | **Done** — Stats command + token/quality tracking added (2026-04-17) |
| TOOL-13. Package shape + git-dep consumption + `init` CLI | TOOL-11 |
| TOOL-14. `sync` CLI — upgrade installed skills with diff prompts | TOOL-13 |
| TOOL-15. LinearRoadmap adapter | TOOL-9 |
| TOOL-16. Split /refit → /bump-models + self-hosted Renovate | — |
| TOOL-17. Pipeline pick-step test coverage (needs REPO injectability) | TOOL-4 |
| TOOL-18. Public-npm publish hardening | TOOL-13 |
| TOOL-19. `orchestrate()` test coverage — resume, parallel, park-and-resume | TOOL-4 |
| TOOL-21. Tighten `/ship` phantom-guard wording + update `_rubric.md` phantom-guard bullet | — |

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

### TOOL-4. pipeline.ts integration tests via SDK query mock ✓

Completed. See git history for implementation details.

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

### TOOL-8. `.autopilot.yml` project config file + loader ✓

Completed. See git history for implementation details.

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

### TOOL-12. Running totals — tokens + quality signals + `pnpm autopilot stats` ✓

Completed. See git history for implementation details.

---

### TOOL-13. Package shape + git-dep consumption + `init` CLI

| What | Scope | Deps |
|------|-------|------|
| Shape `@cdhorne/claude-autopilot` as a consumable package — correct `bin`, `exports`, `main` fields; library exports for programmatic use; an `init` CLI that scaffolds `.claude/skills/`, `.autopilot.yml`, and example `docs/roadmap-*.md` in consumer projects. Fathom and subsequent early consumers install via **git dep** (`"@cdhorne/claude-autopilot": "github:cdhorne/claude-autopilot#<sha>"`) — repo stays private, no npm publish. Public-npm publishing is deferred to TOOL-18 until there's a second or third external consumer. | L | TOOL-8, TOOL-11 |

**Deliverables:**
- `package.json` with `name: @cdhorne/claude-autopilot`, correct `bin`, `exports`, `main` fields (no `files` allowlist yet — that's a TOOL-18 concern, since git-dep clones the whole repo)
- `bin/claude-autopilot.js` — CLI entry point with subcommands: `init`, `sync`, `run`, `stats`
- `init` subcommand: copies `.claude/skills/` templates into consuming project (non-destructive — skip if files exist unless `--force`), creates stub `.autopilot.yml`, wires `pnpm autopilot` script in consuming project's package.json
- Library exports: `run(options)`, `loadConfig()`, individual pipeline functions for programmatic use
- README updated with **git-dep install instructions** (`pnpm add github:cdhorne/claude-autopilot#<sha>`) plus a one-line note pointing at TOOL-18 for public-npm plans
- End-to-end smoke test: install this package into fathom as a git dep, run `npx claude-autopilot init`, and verify the scaffolded state is usable

**Out of scope:**
- npm publish / registry presence — deferred to TOOL-18
- Sync command (TOOL-14)
- Semver stability — consumers pin by SHA until publish
- `.npmignore` / `files` allowlist — not load-bearing for git-dep

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

### TOOL-17. Pipeline pick-step test coverage (needs REPO injectability)

| What | Scope | Deps |
|------|-------|------|
| Scoped out of TOOL-4: exercising the pick step in a unit test would force sibling-of-real-repo directory creation because `resolveWorktree(itemId)` is rooted at the real `REPO/..`. Make `REPO` injectable (likely via the same `PipelineDeps` pattern or a module-level override) so tests can redirect to a temp parent directory, then add coverage for pick. | S | TOOL-4 |

**Deliverables:**
- Either a `repo?: string` field on `PipelineDeps` OR a `resolveWorktree` injection seam that tests can redirect
- New scenario(s) in `pipeline.test.ts`: pick success (claim + worktree add detected), "nothing to pick", "no item ID parsed", "worktree missing"
- Verify the existing worktree-prefix detection in `runPipeline` still works against the injected REPO

**Out of scope:**
- Refactoring all uses of `REPO` across the codebase — keep the surface minimal

---

### TOOL-18. Public-npm publish hardening

| What | Scope | Deps |
|------|-------|------|
| Safeguards required before flipping `@cdhorne/claude-autopilot` from private (git-dep) to public npm. Intentionally deferred until there's a second or third external consumer — until then, git-dep keeps the blast radius small and avoids the publish surface area entirely. This item captures the checklist so the flip is deliberate, not ad-hoc. | S | TOOL-13 |

**Deliverables:**
- Strict `files` allowlist in `package.json` (allowlist, not denylist): `scripts/autopilot/`, `.claude/skills/`, `.claude-templates/`, `README.md`, `LICENSE`, `bin/`. Explicitly exclude `docs/`, `.dev/`, `biome.json`, `lefthook.yml`, tests, `CLAUDE.md`.
- `scripts/check-publish.ts` — runs `npm publish --dry-run`, greps the packed file list against the allowlist, greps packed file contents for secret patterns (`sk-ant-`, `ghp_`, `AKIA`, `BEGIN PRIVATE KEY`, etc.), **fails the publish** if anything leaks. Wired as `pnpm check:publish`.
- Git history audit before first publish: run `gitleaks detect --source .` (or `trufflehog git file://.`). Document the scan result in `docs/publish-audit.md` before flipping the repo to public. If secrets are found, rewrite history with `git filter-repo` and redo the scan.
- npm account hardening:
  - 2FA enabled at `auth-and-writes` level on the publishing npm account
  - Granular automation token scoped to publish only, stored as a GitHub Actions secret used by the self-hosted runner
  - `--provenance` attestation enabled via GitHub Actions publish workflow
  - Package-level setting: require 2FA for every publish
- `.github/workflows/publish.yml` (runs-on: self-hosted): runs `pnpm check:publish`, signs the release tag (ssh-signed), invokes `npm publish --provenance`. Triggered on tag push (e.g. `v0.1.0`).
- `CLAUDE.md` note: never add `preinstall`/`install`/`postinstall` scripts. The publish check should also grep `package.json` for these and fail.
- Repo visibility flip: convert `cdhorne/claude-autopilot` from private to public as the final deliverable, after all other safeguards are in place.

**Out of scope:**
- Sigstore or alternate signing schemes beyond npm provenance
- Alternative registries (GitHub Packages) — we either stay private via git-dep or go public via npm, not both
- Automated semver / changeset release management — manual tag-push publish is fine for alpha
- Stripping historical commits beyond whatever gitleaks flags

---

### TOOL-19. `orchestrate()` test coverage — resume, parallel, park-and-resume

| What | Scope | Deps |
|------|-------|------|
| Scoped out of TOOL-4: only `runPipeline` is mocked and tested. The outer `orchestrate()` loop has meaningful branching (resume mode, parallel workers via `createMutex`, park-and-resume wait logic with `parseWaitFlag`/`fmtWait`) that isn't exercised. Add targeted tests that inject a fake `runPipeline` (or keep using the mocked `runStep` deps) to cover these paths. | M | TOOL-4 |

**Deliverables:**
- Either export `orchestrate()` with injectable `runPipeline` or restructure so the branching logic can be unit-tested
- Scenarios: resume flow uses `detectResumeStep` + starts from the correct step; parallel workers serialize through `pickMutex`; park-and-resume respects `--max-wait`; weekly-limit message variant
- Timer control via Node test mocks (`mock.timers`) so the wait path doesn't actually sleep

**Out of scope:**
- Real SDK integration (still mocked)
- Signal-handler testing (`SIGINT` cleanup)

---

### TOOL-20. Fix false-success on cycles that ship nothing ✓

Completed. See git history for implementation details.

---

### TOOL-21. Tighten `/ship` phantom-guard wording + update `_rubric.md` phantom-guard bullet

| What | Scope | Deps |
|------|-------|------|
| Update `.claude/skills/ship/SKILL.md` phantom-guard wording to "abort immediately" (not "stop and report") and note the pipeline pre-check is primary; update the matching bullet in `.claude/skills/_rubric.md` Correct section to reference `hasDeliverableCommits()` in `pipeline.ts`. | XS | — |

**Why:** TOOL-20 added the pipeline-level pre-check in `pipeline.ts` but the paired wording edits to `/ship`'s SKILL.md and `_rubric.md`'s Correct-section bullet (specified in the TOOL-20 plan) were not applied during the code-review shakedown — edits were denied. Defense-in-depth + docs/code-level consistency still wants both updated.

---

## Scope legend

- **XS** — 1-2 files, <1 hour of work
- **S** — 2-4 files, 1-3 hours
- **M** — 4-10 files, half day to full day
- **L** — 10+ files, multi-day, probably needs a plan
- **XL** — major feature, definitely needs a plan + shakedown-plan pass

Autopilot detects scope from the `scope: X` hint in the item text. XS/S items skip the planning step and go straight to implementation.
