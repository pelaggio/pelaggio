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
| TOOL-31. Rewire skill bodies through `RoadmapSource` (github-issues + linear) | TOOL-10, TOOL-15 |
| ~~TOOL-32. `consumer: false` frontmatter flag — sync skips maintainer-only skills~~ | **Done** — `consumer: false` frontmatter filters maintainer-only skills from sync; `/bump-models` marked; summary line + check-skills lint added (2026-04-18) |
| ~~TOOL-33. Autopilot run-quality fixes from Fathom telemetry (ship budget/model, pick exit reasons, dynamic implement budget, edit-loop threshold)~~ | **Done** — ship turn limit raised to 60, pick rejection reasons tagged, dynamic implement budget from plan file-count, edit-loop threshold raised to 25 (2026-04-19) |
| ~~TOOL-34. Close charter→pick race — uncommitted charter rows invisible to worktree~~ | **Done** — `/charter` now commits roadmap + task-index edits; pick validates ID exists in HEAD before claiming (2026-04-19) |

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

## Scope legend

- **XS** — 1-2 files, <1 hour of work
- **S** — 2-4 files, 1-3 hours
- **M** — 4-10 files, half day to full day
- **L** — 10+ files, multi-day, probably needs a plan
- **XL** — major feature, definitely needs a plan + shakedown-plan pass

Autopilot detects scope from the `scope: X` hint in the item text. XS/S items skip the planning step and go straight to implementation.

