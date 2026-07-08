# Architecture Context

`claude-autopilot` is a pnpm workspace. It contains the autopilot tooling itself, not consumer product code.

## Packages

- `packages/autopilot/`: published package `@cdhorne/claude-autopilot`. The CLI entry is `packages/autopilot/bin/claude-autopilot.js`, which runs `scripts/autopilot.ts` through `tsx`.
- `packages/server/`: private Hono daemon. It supervises `pnpm autopilot` subprocesses, exposes run control endpoints, streams logs over SSE, persists state under `.dev/server-state.json`, and stores run logs under `.dev/server-logs/`.
- `packages/web/`: private Astro 5 + React 19 static UI, built with `base: "/ui/"` and mounted by the daemon in production.

## Root Assets

- `.claude/skills/`: canonical workflow skills for dogfooding and package publishing.
- `.agents/skills`: Codex-visible alias for `.claude/skills`.
- `.claude-templates/`: consumer bootstrap templates.
- `.autopilot.yml`: dogfooding config. This repo uses GitHub issues as the roadmap source and PRs as the ship target.
- `biome.json`, `lefthook.yml`, `tsconfig.base.json`, `pnpm-workspace.yaml`: shared tooling.

## Publishing Shape

`packages/autopilot/scripts/pack-prepare.ts` copies `.claude/skills/`, `.claude-templates/`, and `LICENSE` from the repo root into `packages/autopilot/` during `prepack`. `pack-cleanup.ts` removes those copied paths during `postpack`. Both copied paths are listed in `packages/autopilot/.gitignore` so the working copy stays single-sourced. `check-publish` imports `copySkillsIn`/`cleanSkillsOut` directly and runs `npm pack --dry-run --ignore-scripts` (synthesizing the prepack tree while keeping `postpack` from firing mid-inspection, since the secret scan still reads the copied files after `npm pack` returns).

Do not move the canonical skill tree without updating:

- package `files`
- `pack-prepare.ts`
- `pack-cleanup.ts`
- `check-publish.ts`
- sync behavior in `packages/autopilot/scripts/autopilot/sync.ts`

## Supply-Chain Invariant

Never add `preinstall`, `install`, or `postinstall` scripts to any `package.json`. `packages/autopilot/scripts/check-publish.ts` (run via `pnpm check:publish` and in the publish workflow) fails the build if any appear. They run on every consumer `npm install` and are the standard supply-chain attack surface.

## State

Persistent state is mostly the git working tree plus `.dev/autopilot-log.jsonl`. Server state is separate and lives under `.dev/`.
