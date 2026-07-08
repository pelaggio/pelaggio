# Testing And Quality Context

## Tests

Run all tests:

```bash
pnpm -r test
```

Run one autopilot test:

```bash
npx tsx --test packages/autopilot/scripts/autopilot/__tests__/<file>.test.ts
```

The project uses `node:test`. Do not add Jest or Vitest.

## Checks

```bash
pnpm check
pnpm check:skills
pnpm check:publish
```

`pnpm check:skills` (`check-skills.ts`) validates, across `.claude/skills/**/SKILL.md` and `.claude-templates/**`:

- skill frontmatter shape (`frontmatter.*`) and `argument-hint` presence (`arguments.no-hint`);
- skill includes resolve, treating a `2>/dev/null` suffix as "dangling is fine" (`include.dangling`);
- no bare `claude-autopilot` npx calls or `pnpm autopilot <subcommand>` (`skill.npx-bare-autopilot`, `skill.pnpm-autopilot-subcommand`);
- no pinned Claude model IDs (`model-id.hardcoded`);
- the bilingual agent context substrate — `AGENTS.md`/`CLAUDE.md`/`docs/agent-context/`/`.agents/skills` (`agent-context.*`).

`pnpm check:publish` (`check-publish.ts`) forbids install-script hooks and runs a dry-run pack + secret scan (see `architecture.md`).

## Lint And Format

Biome is scoped via one root `biome.json` (`includes: ["packages/*/scripts/**/*.ts", "scripts/**/*.ts"]`); skill/template markdown is not linted. `pnpm check` lints, `pnpm format` auto-fixes. A lefthook `pre-commit` hook auto-formats staged TypeScript and re-stages it (installed by the `prepare` script on `pnpm install`); autopilot checkpoint commits bypass it via `--no-verify` in `helpers.ts`.

## Review Rubric

Use `.claude/skills/_rubric.md` for detailed review criteria. In short, changes should be:

- correct
- well-typed
- well-factored
- well-tested
- concise
- idiomatic for this repo

Two review passes with deliberately different context shapes: `/plan`'s self-review is **in-context** (same session that wrote the plan — strongest at project invariants like step exhaustiveness and the phantom-ship guard) and `/shakedown`'s forked review is **out-of-context** (fresh session reading the artifact cold — strongest at convention drift and cleverness-over-simplicity). Don't fold shakedown into plan to save a cycle; the context-shape difference is the point.
