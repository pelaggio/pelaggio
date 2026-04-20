# Core Roadmap — claude-autopilot self-improvements

Real backlog for the autopilot tooling. These are items we've identified during the design + extraction but haven't implemented yet. Dogfooding target: run `pnpm autopilot --cycles N` against this list and let the pipeline work on its own codebase.

**Related:** [task-index.md](task-index.md)

> **Sequencing:** TOOL-6 validated the pipeline end-to-end. TOOL-7 (doc-only, XS) and TOOL-12 (stats, S) are good next cycles to keep validating while building real value. TOOL-4 (pipeline tests) unblocks the plugin refactors. Critical path to "usable for outfit-assembler": TOOL-7 → TOOL-8 → TOOL-12 → TOOL-4 → TOOL-11 → TOOL-13.

## Progress

**Open items:**

| Item | Depends on |
|------|-----------|
| ~~TOOL-1. Consistency check: task-index ↔ roadmap drift~~ | **Done** — Consistency check script + pnpm check:roadmap added (2026-04-18) |
| ~~TOOL-2. Dep graph visualization from roadmap files~~ | **Done** — Mermaid dep graph script + pnpm graph:roadmap added (2026-04-18) |
| ~~TOOL-3. Scope suggestion in /charter from description~~ | **Done** — Keyword heuristics for XS/S/M/L/XL scope inference added to /charter (2026-04-18) |
| ~~TOOL-4. pipeline.ts integration tests via SDK query mock~~ | **Done** — Pipeline integration tests + mock SDK query infrastructure added (2026-04-17) |
| ~~TOOL-5. Skill body linter (frontmatter validity, rubric references)~~ | **Done** — Skill body linter added, validates frontmatter + includes (2026-04-18) |
| ~~TOOL-6. Biome config for scripts/ + pre-commit hook~~ | **Done** — Biome config added, pre-commit hook wired (2026-04-11) |
| ~~TOOL-7. Document in-context vs out-of-context review + add Idioms section to rubric~~ | **Done** — Idioms rubric dimension + Review model docs (manual, 2026-04-18) |
| ~~TOOL-8. `.autopilot.yml` project config file + loader~~ | **Done** — `.autopilot.yml` config loader added (2026-04-17) |
| ~~TOOL-9. RoadmapSource abstraction + MarkdownRoadmap adapter~~ | **Done** — RoadmapSource interface + MarkdownRoadmap adapter added (2026-04-18) |
| ~~TOOL-10. GitHubIssuesRoadmap adapter via gh CLI~~ | **Done** — GitHubIssues roadmap adapter via gh CLI added (2026-04-18) |
| ~~TOOL-11. ShipTarget abstraction + 3 adapters~~ | **Done** — ShipTarget abstraction + 3 adapters added (2026-04-17) |
| ~~TOOL-12. Running totals — tokens + quality signals + stats dashboard~~ | **Done** — Stats command + token/quality tracking added (2026-04-17) |
| ~~TOOL-13. Package shape + git-dep consumption + `init` CLI~~ | **Done** — Package shape, init CLI, and library exports added (2026-04-18) |
| ~~TOOL-14. `sync` CLI — upgrade installed skills with diff prompts~~ | **Done** — sync CLI for skill upgrade with diff prompts added (2026-04-18) |
| ~~TOOL-15. LinearRoadmap adapter~~ | **Done** — LinearRoadmap adapter via @linear/sdk added (2026-04-18) |
| ~~TOOL-16. Split /refit → /bump-models + self-hosted Renovate~~ | **Done** — /refit replaced with /bump-models; Renovate + CI self-hosted workflows added (2026-04-18) |
| ~~TOOL-17. Pipeline pick-step test coverage (needs REPO injectability)~~ | **Done** — resolveWorktree injection seam + pick-step test coverage added (2026-04-18) |
| ~~TOOL-18. Public-npm publish hardening~~ | **Done** — npm publish hardening: files allowlist, secret scanner, publish workflow added (2026-04-18) |
| ~~TOOL-19. `orchestrate()` test coverage — resume, parallel, park-and-resume~~ | **Done** — orchestrate() test coverage for resume, parallel, and park-and-resume added (2026-04-18) |
| ~~TOOL-21. Tighten `/ship` phantom-guard wording + update `_rubric.md` phantom-guard bullet~~ | **Done** — `/ship` phantom-guard + rubric bullet tightened (manual, 2026-04-18) |
| ~~TOOL-23. Fix implement-step path resolution for worktree-relative deliverables~~ | **Done** — worktree path injected into implement prompt; pipeline.test.ts added (2026-04-18) |
| ~~TOOL-24. Skill extension points — product-context include + sync allowlist~~ | **Done** — _project-context.md extension point + sync allowlist + check-skills support added (2026-04-18) |
| ~~TOOL-25. Telemetry v2 — per-step file list, tool histogram, output tail, stats JSON~~ | **Done** — filesChanged/toolCounts/outputTail in StepResult, stats --json mode, recent-failures dashboard section (2026-04-18) |
| ~~TOOL-26. Share `node_modules` across worktrees to skip per-worktree `pnpm install`~~ | **Done** — symlink node_modules when lockfiles match, fall through to install on drift; worktree-deps.ts + step-runner guard + tests (2026-04-18) |
| ~~TOOL-27. Investigate silent Edit failures on skill files during implement~~ | **Done** — root cause: SDK hardcodes `.claude/skills/**` deny that survives bypassPermissions. Fix: canUseTool allow-all in step-runner (2026-04-18) |
| ~~TOOL-28. `worktree-deps` bin subcommand (consumer-friendly path)~~ | **Done** — exposed as `npx claude-autopilot worktree-deps` bin subcommand; pick/SKILL.md updated (2026-04-18) |
| ~~TOOL-29. Broaden `Bash(npx tsx:*)` → `Bash(npx:*)` in shakedown + ship~~ | **Done** — Broadened npx allowlist from tsx:* to npx:* in pick, shakedown, ship, shipwreck skills (2026-04-18) |
| ~~TOOL-30. Drop vendored script paths from skill prose~~ | **Done** — Removed stale `parseVerdict` path references from _review-logic.md and shakedown/SKILL.md (2026-04-18) |
| ~~TOOL-31. Rewire skill bodies through `RoadmapSource` (github-issues + linear)~~ | **Done** — skill bodies rewired via `npx claude-autopilot roadmap` CLI; gh/linear adapters wired to all subcommands; CLAUDE.md updated (2026-04-19) |
| ~~TOOL-32. `consumer: false` frontmatter flag — sync skips maintainer-only skills~~ | **Done** — `consumer: false` frontmatter filters maintainer-only skills from sync; `/bump-models` marked; summary line + check-skills lint added (2026-04-18) |
| ~~TOOL-33. Autopilot run-quality fixes from Fathom telemetry (ship budget/model, pick exit reasons, dynamic implement budget, edit-loop threshold)~~ | **Done** — ship turn limit raised to 60, pick rejection reasons tagged, dynamic implement budget from plan file-count, edit-loop threshold raised to 25 (2026-04-19) |
| ~~TOOL-34. Close charter→pick race — uncommitted charter rows invisible to worktree~~ | **Done** — `/charter` now commits roadmap + task-index edits; pick validates ID exists in HEAD before claiming (2026-04-19) |
| ~~TOOL-35. Fix `/pick` claiming parent ID when nested sub-items own worktrees~~ | **Done** — longest-match parseItemId + machine-readable pick-item marker |
| ~~TOOL-36. AbortController-based cancellation for in-flight SDK + exec calls~~ | **Done** — AbortController-based cancellation for in-flight SDK + exec calls |
| ~~TOOL-37. GitHub Issues bug → autopilot PR POC (no-worktree mode + CI workflow, dogfooded)~~ | **Done** — GitHub Issues bug-to-PR pipeline with no-worktree CI mode and autopilot-fix workflow |
| ~~TOOL-38. Convert repo to pnpm workspace monorepo (packages/autopilot + placeholder packages/server)~~ | **Done** — Convert repo to pnpm workspace monorepo |
| ~~TOOL-39. Autopilot control-plane daemon (local, tailnet-bound, Hono + systemd)~~ | **Done** — Autopilot control-plane daemon shipped |
| ~~TOOL-42. Autopilot control-plane web UI (Astro + React + Tailwind, mobile-responsive PWA)~~ | **Done** — Autopilot control-plane web UI shipped |
| ~~TOOL-43. Cloudflare Tunnel + bearer auth for off-tailnet control-plane access~~ | **Done** — cloudflare tunnel + bearer auth shipped |
| ~~TOOL-44. MarkdownRoadmap: read checkbox-format items (write/read parity)~~ | **Done** — checkbox-format read parity in MarkdownRoadmap |
| TOOL-45. Make autopilot-server.service pnpm discovery portable for node-version managers (fnm/nvm/volta) | — |
| TOOL-46. Fix AUTOPILOT_SERVER_WEB_DIST default for external consumers + startup log for UI mount | — |
| TOOL-47. Control-plane web UI: only prompt for token on 401, not on cold load when localStorage is empty | — |
---

## Items

### TOOL-1. Consistency check: task-index ↔ roadmap drift ✓

Completed. See git history for implementation details.

---

### TOOL-2. Dep graph visualization from roadmap files ✓

Completed. See git history for implementation details.

---

### TOOL-3. Scope suggestion in /charter from description ✓

Completed. See git history for implementation details.

---

### TOOL-4. pipeline.ts integration tests via SDK query mock ✓

Completed. See git history for implementation details.

---

### TOOL-5. Skill body linter (frontmatter validity, rubric references) ✓

Completed. See git history for implementation details.

---

### TOOL-6. Biome config for scripts/ + pre-commit hook ✓

Completed. See git history for implementation details.

---

### TOOL-7. Document in-context vs out-of-context review + add Idioms section to rubric ✓

Completed. See git history for implementation details.

---

### TOOL-8. `.autopilot.yml` project config file + loader ✓

Completed. See git history for implementation details.

---

### TOOL-9. RoadmapSource abstraction + MarkdownRoadmap adapter ✓

Completed. See git history for implementation details.

---

### TOOL-10. GitHubIssuesRoadmap adapter via gh CLI ✓

Completed. See git history for implementation details.

---

### TOOL-11. ShipTarget abstraction + DirectPush/PullRequest/AutoMergePR adapters ✓

Completed. See git history for implementation details.

---

### TOOL-12. Running totals — tokens + quality signals + `pnpm autopilot stats` ✓

Completed. See git history for implementation details.

---

### TOOL-13. Package shape + git-dep consumption + `init` CLI ✓

Completed. See git history for implementation details.
---

### TOOL-14. `sync` CLI — upgrade installed skills with diff prompts ✓

Completed. See git history for implementation details.

---

### TOOL-15. LinearRoadmap adapter ✓

Completed. See git history for implementation details.

---

### TOOL-16. Split /refit → /bump-models + self-hosted Renovate ✓

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

### TOOL-17. Pipeline pick-step test coverage (needs REPO injectability) ✓

Completed. See git history for implementation details.

---

### TOOL-18. Public-npm publish hardening ✓

Completed. See git history for implementation details.

---

### TOOL-19. `orchestrate()` test coverage — resume, parallel, park-and-resume ✓

Completed. See git history for implementation details.

---

### TOOL-20. Fix false-success on cycles that ship nothing ✓

Completed. See git history for implementation details.

---

### TOOL-21. Tighten `/ship` phantom-guard wording + update `_rubric.md` phantom-guard bullet ✓

Completed. See git history for implementation details.

---

### TOOL-23. Fix implement-step path resolution for worktree-relative deliverables ✓

Completed. See git history for implementation details.
---

### TOOL-22. Verify `/ship` actually merged — ghost-ship bug root cause ✓

Completed. See git history for implementation details.

---

### TOOL-24. Skill extension points — product-context include + sync allowlist ✓

Completed. See git history for implementation details.

---

### TOOL-26. Share `node_modules` across worktrees to skip per-worktree `pnpm install` ✓

Completed. See git history for implementation details.

---

### TOOL-25. Telemetry v2 — per-step file list, tool histogram, output tail, stats JSON ✓

Completed. See git history for implementation details.

---

### TOOL-27. Investigate silent Edit failures on skill files during implement ✓

Completed. See git history for implementation details.

---

### TOOL-28. `worktree-deps` bin subcommand (consumer-friendly path) ✓

Completed. See git history for implementation details.

---

### TOOL-29. Broaden `Bash(npx tsx:*)` → `Bash(npx:*)` in shakedown + ship ✓

Completed. See git history for implementation details.

---

### TOOL-30. Drop vendored script paths from skill prose ✓

Completed. See git history for implementation details.

---

### TOOL-31. Rewire skill bodies through `RoadmapSource` (github-issues + linear)

| What | Scope | Deps |
|------|-------|------|
| Both `GitHubIssuesRoadmap` (TOOL-10) and `LinearRoadmap` (TOOL-15) ship as "adapter-only" — the factory and config are wired, but `/pick`, `/plan`, `/ship`, `/charter`, `/status`, `/pickup`, `/shakedown`, and `/tidy` still read markdown directly. Set `roadmap.source: github-issues` or `linear` today and no end-to-end cycle runs. This ticket threads the `RoadmapSource` interface through each skill body so all three adapters reach parity. | L | TOOL-10, TOOL-15 |

**Deliverables:**
- Replace markdown-file reads in the skill bodies with `RoadmapSource` calls (`listOpenItems`, `claimItem`, `markDone`, `getItemPlan`, `parseItemId`, `isQuickScope`).
- Keep `MarkdownRoadmap` as the default; no behavior change for consumers not opting in.
- End-to-end smoke test against `github-issues` (fathom) and `linear` (pick a workspace) once wired.
- Remove the "adapter-only" caveat blocks from `docs/config.md` when shipped.

**Out of scope:**
- New adapters. This is a wiring-only ticket.

---

### TOOL-32. `consumer: false` frontmatter flag — sync skips maintainer-only skills ✓

Completed. See git history for implementation details.

---

### TOOL-33. Autopilot run-quality fixes from Fathom telemetry

| What | Scope | Deps |
|------|-------|------|
| A 2026-04-18 batch of ~25 cycles against fathom surfaced four recurring inefficiencies in the pipeline. Address them together so the next batch runs cleaner. | L | — |

**Evidence:** `/home/chris/workspace/fathom/.dev/autopilot-log.jsonl` (cycles after `2026-04-18T22:09`).

**Deliverables:**
- **Ship budget / model.** 9/25 cycles (36%) shipwrecked; every failing ship hit **exactly 41 turns** (budget exhaustion, not logic). Bump `TURN_LIMITS.ship` in `config.ts` to ~60 and/or switch `ship` in `MODEL_PROFILES` from Sonnet-4.6 to Opus-4.7. Measure shipwreck rate on the next fathom batch.
- **Distinguish pick rejection reasons.** Today every non-claim path returns `error: "nothing to pick"`. In yesterday's run this masked five distinct cases: item blocked on dep, unknown ID (typo), already completed, worktree already exists, ambiguous. Replace the single error string with tagged reasons (e.g. `blocked`, `unknown-id`, `already-done`, `worktree-exists`, `ambiguous`, `queue-empty`) surfaced from the `/pick` skill body and recorded in the JSONL. Lets `--item X` invocations fail loud on typos and lets `--parallel` batches distinguish transient from terminal.
- **Dynamic implement turn budget.** MAN-1 hit the static 201-turn wall on a 32-file scope, then succeeded at 79 turns on retry once scope was clearer. Scale `TURN_LIMITS.implement` from the plan's file-count (e.g. `max(100, 2 × fileCount + 60)`, capped at 250) instead of a fixed value. The plan is already on disk when `implement` starts, so the budget can be computed from it.
- **Relax edit-loop detector threshold.** COMP-12a tripped at 12 edits-per-file (0 turns, full abort), then succeeded in 44 turns on retry. Raise the threshold to ~20-25 edits per file per attempt, or make it relative to the attempt's total turn count.

**Out of scope:**
- Batch-runner saturation / rate-limit backoff (not observed in yesterday's scoped window; earlier signal was from pre-change runs).
- Broader telemetry changes — `TOOL-25` already gives us what we need to measure this.

---

### TOOL-34. Close charter→pick race — uncommitted charter rows invisible to worktree ✓

Completed. See git history for implementation details.

---

### TOOL-35. Fix `/pick` claiming parent ID when nested sub-items own worktrees

| What | Scope | Deps |
|------|-------|------|
| Filed as GitHub issue #1 by the fathom consumer. On hierarchical item IDs (`COMP-11` → `COMP-11c-ii`), the pipeline claims the parent ID then errors `worktree missing` because three interacting layers all misbehave: `parseItemId` is greedy and stops at the first numeric group, pick-claim detection in `pipeline.ts` fuzzy-matches the word "successfully" in discursive replies, and `_resolveWorktree` doesn't cross-reference `git worktree list`. Observed in 2/14 cycles on 2026-04-19 against fathom. | S | — |

**Deliverables:**
- **Prefer longest-match in `parseItemId`** (`scripts/autopilot/roadmap/markdown.ts`): resolve branch-form slugs against the known open-items list and pick the longest ID whose normalized form is a prefix of the slug, instead of returning the shortest regex hit.
- **Machine-readable claim marker in `/pick`**: have the skill body emit `CLAIMED: <ID>` on a line by itself on success; tighten the detection regex in `pipeline.ts:166` to match that marker instead of keyword-scanning for `claimed|worktree add|successfully`.
- **Cross-reference `listWorktrees()` before erroring** (`pipeline.ts:171-175`): if `_resolveWorktree(itemId)` fails, scan in-flight worktrees for branches whose slug extends `itemId`; if exactly one matches, use it; if multiple or none, abort with a clearer error naming the in-flight children.
- **Test coverage**: extend `parseItemId` tests for hierarchical IDs (`FOO-1` vs `FOO-1a-ii`); add a pipeline test that simulates a pick reply naming a blocked parent while a sub-item worktree exists.

**Out of scope:**
- Changing the roadmap hierarchy format itself — consumers with nested IDs are a supported shape.
- Reworking `/pick`'s disambiguation prose — the marker is structural; the prose around it can evolve independently.

---

### TOOL-36. AbortController-based cancellation for in-flight SDK + exec calls

| What | Scope | Deps |
|------|-------|------|
| The SIGINT handler in `pipeline.ts:811` only tears down the status bar before exiting — long-running SDK queries and child `exec` calls are not aborted, so Ctrl-C can leave orphaned subprocesses or hang waiting for a fetch response that the user has already given up on. Thread an `AbortController` through `runOrchestrator` and the step runner so SIGINT aborts the controller and every cancellable async caller observes the signal. Originally surfaced as a deferred slice of fathom DX-2; chartered here because autopilot is the right home. | S | — |

**Deliverables:**
- A single `AbortController` constructed at process top in `pipeline.ts`; signal threaded into `runOrchestrator(flags, opts, statusBar, signal)`.
- SDK `query()` calls and any `execFile`/`spawn` invocations in step-runner accept the signal and pass it through (SDK clients already support `AbortSignal`).
- SIGINT handler calls `controller.abort()` before exit; replace `process.exit(130)` with a graceful path that waits up to 2s for in-flight work to settle, then exits 130.
- New test in `pipeline.test.ts` simulates SIGINT mid-step and asserts the in-flight mock is aborted and the process exits within the budget.

**Out of scope:**
- Resumable cancellation (i.e. "abort the current step, continue with the next"). One-shot teardown only.
- Changing the exit code semantics for non-SIGINT failures.

---

### TOOL-37. GitHub Issues bug → autopilot PR POC (no-worktree mode + CI workflow, dogfooded)

| What | Scope | Deps |
|------|-------|------|
| First end-to-end proof-of-concept for CI-triggered autopilot: a GitHub Issue labeled `autopilot:fix` fires a workflow that runs autopilot headlessly in the ephemeral runner's clone (no sibling worktree), which produces a PR resolving the issue. Dogfood it on this repo — replace the current "bug reporter commits to main" flow in `CLAUDE.md` with this autopilot PR flow. Proves out the ephemeral-container execution model and unblocks adoption in other orgs. | L | TOOL-10, TOOL-11, TOOL-31 (partial) |

**Deliverables:**
- `--no-worktree` CLI flag (or auto-detect via `CI=true` / `CLAUDE_AUTOPILOT_SINGLE_SHOT=1`) that sets `worktree = REPO` and skips sibling-path creation. Only valid with `--parallel 1 --cycles 1 --item <ID>` (explicit item required; no `/pick next` from roadmap).
- Skill guards: `/pick` skips `git worktree add` when in no-worktree mode; `/ship` skips `git worktree remove`. Both still create/check out the feature branch in place.
- `step-runner.ts`'s existing `isWorktree = resolve(cwd) !== resolve(REPO)` already self-disables the MAIN_REPO-write guard — verify this stays correct, add a test.
- `.github/workflows/autopilot-fix.yml`: triggers on `issues.labeled` with `autopilot:fix`, runs on the self-hosted runner, checks out the repo fresh, installs deps, invokes `pnpm autopilot --item <issue-number> --no-worktree --ship-target pull-request`, reports back to the issue on success/failure. Needs `ANTHROPIC_API_KEY` + `GH_TOKEN` secrets.
- `ship.target: pull-request` override path when invoked via workflow (CLI flag can override `.autopilot.yml`).
- Dogfood: rewrite the "Bug reporter — automated fix instructions" section in `CLAUDE.md`. Replace "commit directly to main" guidance with "file a GitHub issue with `autopilot:fix` label; autopilot produces a PR; human reviews and merges." Keep the original guidance as a fallback for cases where autopilot declines the work.
- Smoke-test on a real bug in this repo's issue tracker end-to-end before marking done.
- Docs: add a `docs/ci-integration.md` section covering the workflow setup, required secrets, label conventions, and known limits (single-shot only, explicit item required).

**Out of scope:**
- Linear webhook trigger (needs TOOL-31 fully landed for `/pick`/`/ship` Linear parity; file as a follow-up once TOOL-37 proves the pattern).
- `parallel > 1` support in no-worktree mode (ephemeral runner is already isolation; fan-out happens at the workflow-job level).
- Post-merge finalizer (closing the issue, archiving plan) — rely on GitHub's "close issue" linked-PR behavior for the POC; revisit if insufficient.
- Webhook-to-workflow glue for non-GitHub sources (Linear, Jira, etc.) — separate charter.

---

### TOOL-38. Convert repo to pnpm workspace monorepo (packages/autopilot + placeholder packages/server)

| What | Scope | Deps |
|------|-------|------|
| Prerequisite refactor for TOOL-39. The pipeline lives in `scripts/autopilot/` today as a single package. Split the repo into a pnpm workspace with `packages/autopilot` (the pipeline, published as `@cdhorne/claude-autopilot`) and a placeholder `packages/server` (filled in by TOOL-39). Hoist shared tooling (biome, lefthook, tsconfig base) to the root. Keep dogfooding intact — `pnpm autopilot` at repo root must still work end-to-end against this codebase. | L | — |

**Deliverables:**
- `pnpm-workspace.yaml` at repo root listing `packages/*`.
- Move `scripts/autopilot/`, `scripts/autopilot.ts`, `bin/`, and package-scoped configs into `packages/autopilot/`. Update `main`/`exports`/`files`/`bin` paths in `packages/autopilot/package.json` accordingly.
- Keep at repo root (dogfood + repo-wide artifacts): `.claude/skills/`, `.claude-templates/`, `docs/`, `.dev/autopilot-log.jsonl`, `CLAUDE.md`, `renovate.json`, `.github/workflows/`.
- Root `package.json` becomes workspace root with dev-only tooling (biome, lefthook, tsx) and convenience scripts that proxy to `packages/autopilot` (e.g. `pnpm autopilot` = `pnpm --filter @cdhorne/claude-autopilot autopilot`).
- `tsconfig.base.json` at root, extended by each package.
- `biome.json` stays at root; extend its `include` to cover `packages/**/src/**`.
- Update `lefthook.yml` globs for the new paths.
- Update `scripts/check-*.ts` (roadmap, skills, publish, graph-roadmap) — decide per-script whether it's repo-wide (stays at root) or package-local (moves into `packages/autopilot/scripts/`).
- `worktree-deps.ts`: verify the lockfile-sha comparison still works with a workspace root lockfile.
- Update `step-runner.ts`'s MAIN_REPO resolution + skill path resolution for the new layout. The `.claude/skills/` path stays root-relative; verify `expandSkill()` + `canUseTool` paths are unaffected.
- `.github/workflows/ci.yml` updated to `pnpm -r test` / `pnpm -r check`.
- `CLAUDE.md` updated with the new layout diagram (Orientation section).
- Smoke test: `pnpm autopilot --dry-run --cycles 1` + `pnpm test` + `pnpm check` + `pnpm check:roadmap` all pass from the new workspace root.
- `packages/server/` directory created with a stub `package.json` (`@cdhorne/claude-autopilot-server`, `private: true`) and a README placeholder pointing at TOOL-39. No server code yet.

**Out of scope:**
- Extracting `.claude/skills/` into its own `@cdhorne/claude-autopilot-skills` package (possible future split; skills remain consumer-sync'd artifacts in the current layout).
- Changing `sync` CLI's consumer-facing UX (install path is still `./.claude/skills/` in the consumer's repo).
- Adding the server itself — that's TOOL-39. This ticket ships the placeholder only.
- Re-verifying the npm publish end-to-end (publish hardening handled by TOOL-18; keep the allowlist coverage correct).

---

### TOOL-39. Autopilot control-plane daemon (local, tailnet-bound, Hono + systemd)

| What | Scope | Deps |
|------|-------|------|
| A long-lived Hono daemon running as a systemd user unit on the beefy box where autopilot already executes. Binds to the tailnet IP so a Tailscale-enabled phone or laptop can start/pause/resume/stop runs and watch live logs over SSE without a public internet surface. Replaces SSH-over-Tailscale kickoffs and the "runs lost on disconnect" failure mode. Deliberately co-located with the execution plane — runs need the repo state, worktree paths, and Claude SDK credentials that already live on this box, so putting the daemon anywhere else just forces an extra SSH hop. Web UI and public-tunnel access are separate tickets (TOOL-42, TOOL-43). | L | TOOL-38 |

**Deliverables:**
- Fill in the `packages/server/` placeholder landed by TOOL-38 with a Hono daemon. Stack matches fathom's `apps/server`: Hono for HTTP, ulid for run IDs. Drizzle + libSQL only if the run-state store needs it — a flat JSON file is likely sufficient since the data is small and non-critical (systemd restart repopulates from live children).
- HTTP API (tailnet-bound by default):
  - `POST /runs` — start a cycle (`{ item, parallel?, cycles?, shipTarget? }`). Spawns `pnpm autopilot` as a supervised child, returns a run ID.
  - `GET /runs` — list active + recent runs with status, started-at, current step, budget consumed.
  - `GET /runs/:id` — detail: current step, plan path, filesChanged, tool counts, output tail (TOOL-25 telemetry fields).
  - `POST /runs/:id/pause` — checkpoint-and-exit at next safe step boundary (reuses `parkExit()` semantics).
  - `POST /runs/:id/resume` — spawns `pnpm autopilot --resume <item>` against the parked checkpoint.
  - `POST /runs/:id/stop` — SIGTERM with `parkExit()` graceful shutdown; abandons rather than parks if already parked.
  - `GET /runs/:id/log` — SSE stream of child stdout + structured events tailed from `.dev/autopilot-log.jsonl`. Supports tail-and-follow for completed runs.
  - `GET /stats` — proxy `pnpm autopilot stats --json` (TOOL-25 output).
  - `GET /roadmap` — resolve the configured `RoadmapSource` and return open items (powers the UI's "start run" picker, landed in TOOL-42).
- Process supervisor: tracks run IDs → child PIDs → status. Systemd keeps the daemon alive; this layer keeps run metadata coherent across daemon restarts (reattaches to live PIDs where possible, marks dead ones `abandoned`).
- Auth: bind explicitly to the tailnet IP (not `0.0.0.0`). Bearer-token middleware present but no-op by default — TOOL-43 flips it on when the tunnel lands. Document the bind address in `docs/server.md`.
- Deployment:
  - `infra/systemd/autopilot-server.service` — user unit on the beefy box. `EnvironmentFile=` for secrets (`ANTHROPIC_API_KEY`, `GH_TOKEN`, `LINEAR_API_KEY`); file path documented but file itself not committed.
  - `.github/workflows/deploy-server.yml` — on push to main, self-hosted runner pulls, `pnpm --filter @cdhorne/claude-autopilot-server build`, restarts the systemd unit. Mirrors fathom's self-hosted-runner deploy pattern. No Hetzner, no Terraform — the runner already lives on the target box.
- Local dev: `pnpm --filter @cdhorne/claude-autopilot-server dev` hot-reloads via `tsx watch` (matches fathom's server dev command).
- Docs: `docs/server.md` covering API reference, systemd setup, pause/resume semantics, tailnet bind address, and the bearer-token hook reserved for TOOL-43.
- End-to-end smoke test: deploy via the workflow, `curl` a cycle start against this repo, pause it, resume it, watch the SSE log stream, confirm `/stats` updates.

**Out of scope:**
- Web UI — TOOL-42.
- Public / off-tailnet access via Cloudflare Tunnel — TOOL-43.
- Push notifications on run events — separate follow-up if polling the UI isn't enough.
- Multi-user / multi-tenant auth — single operator, tailnet ACL is sufficient.
- Metrics export (Prometheus, OpenTelemetry) — reserve for follow-up.
- Moving `.dev/autopilot-log.jsonl` schema — the server reads it as a public interface.
- Horizontal scaling / multi-machine coordination — one beefy box, many child processes.
- Replacing the CLI — `pnpm autopilot` remains ground truth; the server is a control plane on top.

**Open questions for `/plan`:**
- Pause semantics: reuse `parkExit()` signal path, or add a new "pause at next step boundary" flag? Former is simpler but couples pause to the rate-limit code path.
- Run-state store: flat JSON vs. libSQL + Drizzle. Probably flat JSON — tiny data, no schema migration overhead, matches the "ephemeral state is the git tree + JSONL log" ethos in CLAUDE.md.
- Log streaming: pipe child stdout directly (live, no persistence overhead) vs. tail `autopilot-log.jsonl` + outputTail fields. Probably both — live for active runs, persisted for completed.

---

### TOOL-42. Autopilot control-plane web UI (Astro + React + Tailwind, mobile-responsive PWA)

| What | Scope | Deps |
|------|-------|------|
| Mobile-responsive web UI served by the TOOL-39 daemon — live run list, per-run detail with streaming log viewer, stats dashboard, and a "start run" button backed by the roadmap picker. Stack matches fathom's `apps/web`: Astro 5 + React 19 + Tailwind v4. PWA manifest so the phone can install it to the home screen and treat it as an app surface over Tailscale. Desktop is a first-class target too; nothing is mobile-only. | M | TOOL-39 |

**Deliverables:**
- `packages/web/` workspace with Astro + React + Tailwind (mirror `apps/web` conventions from fathom: scripts, biome config, tsconfig).
- Routes / views:
  - `/` — live run list, auto-refreshing. Columns: item, step, started-at, budget. Row click → detail.
  - `/runs/:id` — detail page. Shows plan path (with a "view plan" link), filesChanged, tool counts, output tail. SSE-driven live log pane. Buttons: pause, resume, stop (with confirm).
  - `/start` — roadmap picker (consumes `GET /roadmap`) + form (parallel, cycles, shipTarget override). Submits to `POST /runs`.
  - `/stats` — TOOL-25 dashboard view: tokens, quality signals, recent failures.
- Mobile-responsive layout throughout. Touch targets ≥ 44px. SSE works over the Tailscale tunnel on cellular (tested on iOS Safari + Android Chrome).
- PWA: `manifest.webmanifest`, icons, `theme_color`, "Add to Home Screen" tested on iOS + Android. No service worker caching of API responses — the UI is thin and always hits the daemon live.
- Dev proxy: `astro dev` proxies `/api/*` + `/runs/:id/log` (SSE) to the daemon on the tailnet IP during local development. Document the setup in `docs/server.md`.
- Build artifacts served by the Hono daemon (static-file handler mounted at `/`) — no separate Cloudflare Pages deploy for the UI; it ships alongside the daemon so tailnet access is enough.
- End-to-end smoke test: from the beefy box, load the UI on a phone over Tailscale, kick off a run, watch the log stream, pause and resume, confirm stats update.

**Out of scope:**
- Off-tailnet public access — TOOL-43.
- Push notifications — separate follow-up.
- Multi-operator UX (shared sessions, per-user state) — single operator.
- Theming / dark mode polish — ship with a minimal, readable default.
- Replacing the CLI — the UI wraps the daemon, the daemon wraps the CLI.

**Open questions for `/plan`:**
- Astro server islands vs. pure client React for the live-updating views — SSE + React hooks probably wins over server islands' polling semantics.
- Auth UX when TOOL-43 lands: bearer in localStorage on first load, or a login form posting to a `/auth/token` exchange? Former is lighter; latter is less scary to paste into.

---

### TOOL-43. Cloudflare Tunnel + bearer auth for off-tailnet control-plane access

| What | Scope | Deps |
|------|-------|------|
| `cloudflared` tunnel exposing the TOOL-39 daemon at a stable hostname so the operator can reach the UI from a device that isn't on the tailnet (borrowed laptop, phone with Tailscale disabled, etc.). The daemon's bearer-token middleware (plumbed in TOOL-39, no-op by default) flips on when this ships. Reuses fathom's existing `infra/cloudflare/` Terraform scaffolding for DNS and Tunnel config. | S | TOOL-39 |

**Deliverables:**
- `infra/cloudflare/tunnel.tf` — Cloudflare Tunnel + DNS record for a hostname like `autopilot.{domain}`. Matches the shape of fathom's Cloudflare Terraform.
- `infra/systemd/cloudflared.service` — user unit on the beefy box running `cloudflared tunnel run`, tunnel credentials loaded from an `EnvironmentFile` (not committed).
- Bearer-token enforcement in the Hono daemon: when `CONTROL_PLANE_TOKEN` env is set, middleware requires `Authorization: Bearer <token>` on every request. When unset, middleware is a pass-through (preserves tailnet-only UX for TOOL-39-only deployments).
- Web UI (TOOL-42) gains a minimal token-entry flow: on 401, prompt for token, store in `localStorage`, attach to fetch + EventSource requests. No login page; just a modal.
- Docs: append to `docs/server.md` — tunnel setup, token rotation, how to run tailnet-only vs. tunnel-exposed. Call out that the token is the only thing between the public internet and your beefy box.
- End-to-end smoke test: from cellular-only phone with Tailscale off, hit the tunnel hostname, enter the token, start a run, watch the log stream.

**Out of scope:**
- OAuth / SSO — overkill for one operator.
- Multiple tokens / per-device revocation — single token, rotate by editing the env file and restarting the daemon.
- Rate limiting beyond what Cloudflare WAF provides by default — revisit if abused.
- Automatic token provisioning / 1Password integration — operator pastes the token once per device.

---

### TOOL-44. MarkdownRoadmap: read checkbox-format items (write/read parity)

| What | Scope | Deps |
|------|-------|------|
| The markdown adapter has a write/read asymmetry: `createItem` writes checkbox rows (`- [ ] **ID. Title** — ...`) when the target file is checkbox-formatted, but `listItems` / `listOpenItems` / `getItem` only parse `\| Item \| Depends on \|` tables. Any item chartered into a checkbox-format roadmap file becomes invisible to `/pick` → `pick-result: unknown-id`. Fix: teach the list/get path to also parse checkbox rows, so the adapter reads back what it writes. | S | — |

**Deliverables:**
- `scripts/autopilot/roadmap/markdown.ts` — extend `parseOpenTableRows` (or add a `parseCheckboxRows` sibling invoked from the same list loop) to extract ID, title, and deps from lines matching `^-\s+\[([ x])\]\s+\*\*([A-Z]+-?\d[\dA-Z-]*)\.\s*(.+?)\*\*(?:\s+—\s+.*?)?(?:\s+Depends on\s+(.+?)\.)?\s*$`. Treat `[x]` as done, `[ ]` as open. Support `blocked:` in the deps span if present.
- `listItems` and `listOpenItems` emit both formats' rows uniformly — same `RoadmapItem` / `RoadmapItemStatus` shape.
- `getItem`, `markDone`, `strikethroughRoadmapRow` / `moveToCompleted` gain a checkbox branch: marking done rewrites `- [ ]` → `- [x]` with the `ctx.note` appended in the same row (or moves to a "Completed" section if one exists).
- The task-index update path in `createItem` currently resolves `docs/task-index.md`; on repos where the file is named `docs/roadmap-task-index.md` (e.g. fathom) the update is silently skipped. Either detect either name, or make it configurable via `.autopilot.yml`.
- Tests: `scripts/__tests__/markdown-roadmap.test.ts` — fixture with a checkbox-format roadmap file, assert list/get/markDone round-trip. Add a regression fixture for the fathom case (release-roadmap-style file with A-54/55/56).

**Out of scope:**
- Migrating existing checkbox files to tables — both formats remain supported.
- Ordering / grouping changes in checkbox files — new rows still append at EOF like today.

---

## Scope legend

- **XS** — 1-2 files, <1 hour of work
- **S** — 2-4 files, 1-3 hours
- **M** — 4-10 files, half day to full day
- **L** — 10+ files, multi-day, probably needs a plan
- **XL** — major feature, definitely needs a plan + shakedown-plan pass

Autopilot detects scope from the `scope: X` hint in the item text. XS/S items skip the planning step and go straight to implementation.

