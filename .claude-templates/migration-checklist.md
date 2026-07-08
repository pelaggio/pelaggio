# Migration Checklist

Per-project playbook for bootstrapping a new Expo/TypeScript repo with the full scaffold. Follow in order — each step unblocks the next.

Estimated time: **2–3 hours** for an experienced operator. Most of it is thinking (writing the rubric + philosophy), not typing.

---

## Step 1 — Create the empty repo

```bash
pnpm create expo-app@latest my-project --template default
cd my-project
git init && git add . && git commit -m "chore: expo template"
```

Verify you're on pnpm + TypeScript + the latest Expo SDK. If not, stop and fix before proceeding.

## Step 2 — Install Biome as the linter

```bash
pnpm add -D -w @biomejs/biome
pnpm exec biome init
```

Edit `biome.json` to match your formatting preferences (tab width, quote style, etc.). Remove any default ESLint/Prettier config that Expo's template ships with — one linter, not two.

Add to `apps/mobile/package.json` scripts (or root package.json if not yet a monorepo):

```json
"check": "biome check ./src",
"typecheck": "tsc --noEmit"
```

## Step 3 — Copy the pelaggio + skills infrastructure

From the source project (Fathom or a prior scaffold-based project):

```bash
# From the source project root
cp -r .claude/skills /path/to/my-project/.claude/
cp -r scripts/pelaggio /path/to/my-project/scripts/
cp scripts/pelaggio.ts /path/to/my-project/scripts/
```

Add to root `package.json`:

```json
"pelaggio": "tsx scripts/pelaggio.ts",
"typecheck": "pnpm -r typecheck",
"check": "pnpm -r exec biome check ./src"
```

Install runtime deps:

```bash
pnpm add -D -w tsx @anthropic-ai/claude-agent-sdk @anthropic-ai/claude-code
```

## Step 4 — Sanitize the copied files

Find and replace in your new repo:

| Old | New |
|---|---|
| `fathom` (in strings, paths, worktree prefix) | `{{your-project-slug}}` |
| `fathom-` (worktree prefix in `scripts/pelaggio/helpers.ts:resolveWorktree`) | `{{slug}}-` |
| `apps/mobile` verification paths (if you have a different monorepo layout) | your paths |
| Fathom-specific component names in `.claude/skills/shakedown/SKILL.md` plan-review examples | your shared components (or delete the specific examples) |

**Search for leftover references:**
```bash
grep -r fathom .claude/ scripts/ --exclude-dir=node_modules
```

Should be zero hits after sanitization.

## Step 5 — Author the rubric (the most important step)

Copy `_rubric.md` from the scaffold templates to `.claude/skills/_rubric.md`. Fill in the six dimensions **before writing any code**.

The "Correct" section is where you encode your project's soul. Spend 20–30 minutes on it. Ask yourself:

- What's the 3–5 invariants that, if violated, corrupt the data model?
- What's the one mistake a new contributor would make that senior contributors would immediately flag?
- What's the difference between a bug and a data integrity regression for this project?

Write those as bullets under "Correct." Everything else in the project will be measured against them.

**Don't skip this.** A generic rubric produces generic code. The rubric is the cheapest lever in the system.

## Step 6 — Author the scaffolded docs

Copy each template from `.claude-templates/docs/` to `docs/` in the new project. Fill in the prompts. In order of priority:

1. **`CLAUDE.md`** — orientation primer. 10 minutes to draft a rough version; refine later.
2. **`docs/philosophy.md`** — the "why." 30 minutes if you know the product; multiple sessions if still discovering.
3. **`docs/architecture.md`** — C4 level 1 (system context) and level 2 (containers). Skip levels 3+ until you have code.
4. **`docs/conventions-ui.md`** — already Expo-opinionated; prune what doesn't apply, add project-specific components as you build them.
5. **`docs/decisions.md`** — list the open architectural decisions you haven't resolved yet (stack choices, auth model, etc.).
6. **`docs/tone.md`** — if the product has a user-facing voice. Skip for infrastructure/tooling.
7. **`docs/build.md`** — fill in EAS project ID + first-build commands.
8. **`docs/task-index.md`** — start empty; will populate as you add roadmap items.
9. **`docs/roadmap-{track}.md`** — at least one track with 3–5 initial items so `/pick` has something to work with.

## Step 7 — First commit with scaffolding landed

```bash
git add .claude/ scripts/ docs/ CLAUDE.md biome.json package.json
git commit -m "chore: scaffold project structure (pelaggio + skills + docs)"
```

## Step 8 — Verify pelaggio loads

Smoke test without running a full cycle:

```bash
pnpm pelaggio --dry-run --cycles 1
```

Should report "no items to pick" (your roadmap is empty) but load without errors. If it errors on SKILL.md parsing or script imports, fix before proceeding.

## Step 9 — Add your first real roadmap item

Use `/charter` (the pelaggio skill) or hand-edit `docs/roadmap-{track}.md` and `docs/task-index.md` to add one item. Pick something small (scope S or XS) for the first real cycle.

## Step 10 — Run the first cycle

```bash
pnpm pelaggio --cycles 1 --verbose
```

Watch it work through pick → plan → shakedown-plan → implement → shakedown-code → ship. First cycle will expose whatever you got wrong in the rubric or conventions — that's fine, iterate on those files rather than fighting the output.

---

## Common issues

**`/shakedown` reviews the wrong thing inline.** Make sure you're on a feature branch (not main) and have either uncommitted code changes or a plan file at `docs/plans/{branch-slug}.md`. If neither exists, the skill has nothing to dispatch on.

**Pelaggio's `/pick` fails with "nothing to pick."** Your `docs/task-index.md` is empty or every item is blocked. Add an open item with `Deps: —`.

**Typecheck fails on copied pelaggio scripts.** You probably forgot to install `@anthropic-ai/claude-agent-sdk`. The pipeline imports from it directly.

**Pre-commit hooks don't fire.** Fathom uses `lefthook`. If you want the same behavior, `pnpm add -D -w lefthook` and copy the `lefthook.yml` from the source project.

## After your first cycle

Note what was different from the scaffold expectations. Any of:

- Rubric bullets that were wrong for your domain
- Convention patterns that don't fit your stack
- Skill body examples that referenced Fathom components you don't have
- Step budgets/turn limits that were too tight or loose for your code size

Update the scaffold templates in the source project (or your private scaffold copy) so the next project benefits. This is how the templates earn their keep — each project refines them a little.
