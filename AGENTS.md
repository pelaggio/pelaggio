# claude-autopilot Agent Guide

This repo contains the tooling for running autonomous development cycles, not consumer product code. It currently supports Claude Code and is being expanded to support Codex as a second development driver.

Keep this file short. Put always-needed rules here; put detailed architecture, workflow, and historical context in `docs/agent-context/`.

## Orientation

- Workspace: pnpm monorepo with three packages.
- `packages/autopilot/`: published CLI package `@cdhorne/claude-autopilot`. TypeScript runs through `tsx`; there is no build step.
- `packages/server/`: private Hono control-plane daemon for supervised autopilot runs.
- `packages/web/`: private Astro/React static UI served by the daemon under `/ui/`.
- Root `.claude/skills/`: canonical workflow skills. They are copied into the published package during `prepack`.
- Root `.agents/skills`: Codex-visible alias for the same skills.
- Root `.claude-templates/`: consumer bootstrap templates.

## Commands

```bash
pnpm install
pnpm autopilot --dry-run --cycles 1
pnpm autopilot --cycles 1 --verbose
pnpm autopilot --item 80 --verbose
pnpm autopilot --resume 80
pnpm -r test
pnpm check
pnpm check:skills
pnpm check:publish
```

Run targeted tests with `npx tsx --test <test-file>`. Tests use `node:test`, not Jest or Vitest.

## Project Invariants

- `STEPS` in `packages/autopilot/scripts/autopilot/config.ts` is the source of truth for pipeline steps. Adding a step requires updating every step-indexed config map.
- `expandSkill()` strips skill frontmatter before sending skill bodies to the SDK. Do not rely on frontmatter inside pipeline prompts.
- Skill bodies must call `npx @cdhorne/claude-autopilot ...`, never bare `npx claude-autopilot` or `pnpm autopilot <subcommand>`.
- Model IDs live in `MODEL_PROFILES` in `config.ts`; skill/template bodies must not pin Claude model IDs.
- Worktree isolation is load-bearing. Do not bypass guards that prevent writes to the main repo from sibling worktrees.
- During `implement`, plan documents under `docs/plans/` are read-only. The implement step executes the plan; it does not polish the plan.
- Rate-limit paths must park through `parkExit()` so uncommitted work is checkpointed.
- `ship.target` owns direct-push vs PR behavior. Do not hardcode merge behavior in TypeScript or skills.
- Claims are git-native (`feat/<id>` branch); roadmap mutations self-serialize on `.dev/roadmap-mutation.lock`. Don't add call-site locking or a claims registry.
- Access the roadmap via `npx @cdhorne/claude-autopilot roadmap ...`; skills never read roadmap storage or issue trackers directly.
- `.agents/skills` must stay a symlink to the canonical `.claude/skills` tree so Codex sees the same skills without drift.
- No `preinstall`, `install`, or `postinstall` scripts in package manifests.

Each invariant above is a one-line index; the full rationale lives in the routed detail docs below.

## Agent Context Routing

Read only the detail docs needed for the task:

- `docs/agent-context/architecture.md`: package layout, data/state, publishing shape, supply-chain invariant.
- `docs/agent-context/pipeline.md`: pipeline steps, step-provider seam, worktree isolation + dep sharing, plan-polish and self-referential roadmap guards, hook reachability, phantom-ship guard, rate-limit parking.
- `docs/agent-context/roadmap-and-ship.md`: roadmap adapters + CLI bridge, claims, ship targets, direct-push bookkeeping, PR review and revise loops.
- `docs/agent-context/skills.md`: skill layout, canonical tree, bilingual substrate, frontmatter, includes, project-context extension point.
- `docs/agent-context/testing-and-quality.md`: test commands, lint rules, rubric, review-shape rationale.
- `docs/config.md`: `.autopilot.yml` schema.
- `docs/server.md`: daemon and web UI setup.
- `docs/pr-review.md`: PR review and revise behavior.

## Coding Conventions

- Prefer existing local helpers and patterns over new abstractions.
- Keep changes scoped to the requested behavior; avoid opportunistic refactors.
- Use relative imports with `.js` extensions in TypeScript ESM files.
- Keep comments sparse and useful; explain non-obvious invariants, not syntax.
- Preserve user work in dirty trees. Do not revert unrelated changes.

## Chartering Work

- The configured roadmap source is GitHub issues via `.autopilot.yml`.
- Use `npx @cdhorne/claude-autopilot roadmap ...` rather than reading/writing roadmap storage directly.
- Ambiguous work should be scoped at least `M` so it receives a plan step.
- For issue `#80` and later Codex work, treat context-substrate changes as a prerequisite: the provider implementation should not depend on a 28 KiB startup document.
