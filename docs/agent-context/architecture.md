# Architecture Context

`pelaggio` is a pnpm workspace. It contains the pelaggio tooling itself, not consumer product code.

## Packages

- `packages/pelaggio/`: published package `pelaggio`. The CLI entry is `packages/pelaggio/bin/pelaggio.js`, which runs `scripts/pelaggio.ts` through `tsx`.
- `packages/server/`: private Hono daemon. It supervises `pnpm pelaggio` subprocesses, exposes run control endpoints, streams logs over SSE, persists state under `.dev/server-state.json`, and stores run logs under `.dev/server-logs/`.
- `packages/web/`: private Astro 5 + React 19 static UI, built with `base: "/ui/"` and mounted by the daemon in production.
- `packages/site/`: private Astro static marketing site. Public landing; not mounted by the daemon.

## Root Assets

- `.claude/skills/`: canonical workflow skills for dogfooding and package publishing.
- `.agents/skills`: Codex-visible alias for `.claude/skills`.
- `.claude-templates/`: consumer bootstrap templates.
- `.pelaggio.yml`: dogfooding config. This repo uses GitHub issues as the roadmap source and PRs as the ship target.
- `biome.json`, `lefthook.yml`, `tsconfig.base.json`, `pnpm-workspace.yaml`: shared tooling.

## Publishing Shape

`packages/pelaggio/scripts/pack-prepare.ts` copies `.claude/skills/`, `.claude-templates/`, and `LICENSE` from the repo root into `packages/pelaggio/` during `prepack`. `pack-cleanup.ts` removes those copied paths during `postpack`. Both copied paths are listed in `packages/pelaggio/.gitignore` so the working copy stays single-sourced. `check-publish` imports `copySkillsIn`/`cleanSkillsOut` directly and runs `npm pack --dry-run --ignore-scripts` (synthesizing the prepack tree while keeping `postpack` from firing mid-inspection, since the secret scan still reads the copied files after `npm pack` returns).

Do not move the canonical skill tree without updating:

- package `files`
- `pack-prepare.ts`
- `pack-cleanup.ts`
- `check-publish.ts`
- sync behavior in `packages/pelaggio/scripts/pelaggio/sync.ts`

## Supply-Chain Invariant

Never add `preinstall`, `install`, or `postinstall` scripts to any `package.json`. `packages/pelaggio/scripts/check-publish.ts` (run via `pnpm check:publish` and in the publish workflow) fails the build if any appear. They run on every consumer `npm install` and are the standard supply-chain attack surface.

## State

Persistent state is mostly the git working tree plus `.dev/pelaggio-log.jsonl`. Server state is separate and lives under `.dev/`.
