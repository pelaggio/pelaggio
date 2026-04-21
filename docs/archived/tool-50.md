# TOOL-50 — Skill CLI invocation is collision-vulnerable; pipeline entry accepts unknown positional args (recursion risk)

## Problem

Two compounding issues caused observed infinite recursion on 2026-04-19 (12–17 parallel `claude` processes per incident, two occurrences).

1. **Skill bodies shell out via `npx claude-autopilot roadmap …`** — 27 occurrences across 9 files. `npx` resolves a **bare package name** in this order: local `node_modules/.bin/`, then the npm registry, then — critically — the **`~/.npm/_npx/*` cache of previously fetched public packages**. On any machine where `npx claude-autopilot` ever ran once against the unrelated public `claude-autopilot` package (which exists — it's a different project: "TDD-driven autonomous build system for Claude Code"), the cached copy stays usable indefinitely. I reproduced this at plan time: `npx claude-autopilot --help` silently ran the cached public package and printed *its* help. `npx --no-install claude-autopilot` was my first instinct, but I verified it happily uses the npx cache too — `--no-install` only blocks fresh registry fetches, not cache hits.
   When the skill receives that package's `Unknown command: roadmap` error, the agent substitutes `pnpm autopilot roadmap …` as a plausible-looking alternative.

2. **The pipeline entry point silently accepts unknown positional args.** `scripts/autopilot.ts` → `main.ts` runs `parseArgs({ allowPositionals: true })` and only dispatches on `positionals[0] === "stats"`. Any other positional tokens are ignored and `orchestrate(values as Flags)` is called. So `pnpm autopilot roadmap get TOOL-1 --json` starts a fresh cycle, whose `/pick` reads a skill body that again shells out to `npx claude-autopilot …`, which again resolves to the cached public package, which again fails, which again substitutes `pnpm autopilot …`, ad infinitum.

## Scope

In scope:
- Pipeline entry rejects unknown positional args (defense that breaks recursion regardless of skill-side failure mode).
- Skill bodies invoke the CLI under a name that **cannot** resolve to an unrelated package — even from a cache hit.
- A lint check that fails on any skill reintroducing a collision-prone invocation form.
- Unit tests for the arg-validation branch and the skill-body scan.

Out of scope:
- Re-architecting how skills reach adapter logic (env var plumbed through `query()`, template substitution at init time, rewriting skills to call TS directly). The charter lists those as alternatives; they add complexity without stronger safety than scoped-name + pipeline guard.
- Docs/README non-skill mentions of `claude-autopilot` — those describe consumer-side UX and aren't read by the pipeline.

## Approach

Three layers, each independently breaks the observed recursion. Shipped together because each also fixes a symptom the others miss.

### A. Pipeline hard-rejects unknown positional args

Primary fix — recursion is impossible at this layer even if every other layer regresses.

Factor argv parsing out of `main.ts` into a pure, exported `parseCli(argv: string[]): CliIntent` where `CliIntent` is a discriminated union of `{ kind: "run"; flags: Flags }`, `{ kind: "stats"; json: boolean }`, `{ kind: "error"; message: string; exitCode: number }`. Unknown positionals — anything that isn't `stats` as the first token, or extra tokens after `stats` — produce an `"error"` intent whose message names the offending tokens and (when the shape looks like a subcommand call) points at the right binary: `"unknown positional args: [roadmap, get, TOOL-1]. The pipeline entry (\`pnpm autopilot\`) only accepts flags and the \`stats\` subcommand; subcommands like \`roadmap\` live on the CLI (\`npx @cdhorne/claude-autopilot roadmap …\`)."`.

The thin `main.ts` top-level keeps its existing shape: parse, dispatch, `process.exit`. `parseCli` is the unit under test.

Why a function rather than inline branching: `main.ts` today runs on module load (`import` triggers `parseArgs` + `orchestrate`). Subprocess tests give coarse assertions (exit code + stderr blob). Factoring yields a clean unit test and makes future subcommand additions mechanical.

### B. Skill bodies invoke via the scoped package name

Root fix — the substitution precondition (registry/cache hit) is removed.

Replace every `npx claude-autopilot …` in `.claude/skills/**/SKILL.md` (and `_review-logic.md`) with `npx @cdhorne/claude-autopilot …`. The scoped form is resolved by npm differently from a bare name:

- Local resolution: npm looks up `node_modules/@cdhorne/claude-autopilot`. In consumer repos the package is installed under that scoped path by `npm install @cdhorne/claude-autopilot`. In this dogfood workspace, pnpm only auto-symlinks workspace packages into a directory's `node_modules/@<scope>/` when that directory's `package.json` declares the dep — so the **root `package.json` must add `"@cdhorne/claude-autopilot": "workspace:*"` as a `devDependency`** (verified at plan time: without that entry, `node_modules/@cdhorne/` does not exist at the worktree/main-repo root, only inside `packages/server/` and `packages/web/` which declare the dep). With the root dep in place, `pnpm install` symlinks `node_modules/@cdhorne/claude-autopilot → packages/autopilot` (and creates `node_modules/.bin/claude-autopilot` as a side benefit).
- Registry fallback: even on a cache miss and without the local package installed, npm can only fetch from the `@cdhorne` scope, which is **owned by a single npm user**. npm scope takeover is not a thing — no one else can publish `@cdhorne/claude-autopilot`. So the worst possible substitution is "this package, from npm" (and today, since the package isn't published, the worst case is a clean 404 — never a foreign package execution).
- Cache: even if a stale `~/.npm/_npx/*/node_modules/@cdhorne/claude-autopilot` exists, it is still *our* package. The recursion precondition (an unrelated package pretending to be us) cannot occur.

27 occurrences, single deterministic rewrite. Also applies to the two `npx claude-autopilot worktree-deps …` calls in `pick/SKILL.md` — same surface.

### C. Lint to prevent regression

Long-term guard — failure surface is contained the next time a skill is rewritten or synced.

Extend `scripts/autopilot/check-skills.ts` with two forbidden-pattern checks over the post-frontmatter skill body:

- `/\bnpx\s+(?:--\S+\s+)*claude-autopilot\b/` (bare-name invocation, scope missing) → rule `skill.npx-bare-autopilot`, message: `"use 'npx @cdhorne/claude-autopilot' — the bare 'claude-autopilot' name collides with a public package and can recurse the pipeline"`.
- `/\bpnpm\s+autopilot\s+(?:roadmap|worktree-deps)\b/` (the exact shape the agent substituted during the recursion incident) → rule `skill.pnpm-autopilot-subcommand`, message: `"pnpm autopilot is the pipeline entry; subcommands go through 'npx @cdhorne/claude-autopilot' (see TOOL-50)"`.

Violations fail `pnpm check:skills`, which the publish workflow already invokes via `check:publish`. Long-term: future rewrites, sync-back loops, or accidental regressions are caught before they ship.

## Files to change

**Pipeline entry (A)**

- `packages/autopilot/scripts/autopilot/main.ts` — extract `parseCli`, add the error branch with a non-zero exit and a helpful stderr message. `run` / `stats` branches behave identically to today.
- `packages/autopilot/scripts/autopilot/__tests__/main.test.ts` (new) — 6–8 `parseCli` cases: empty args → `run`; `stats` / `stats --json` → `stats`; `roadmap get TOOL-1 --json` → `error` naming the tokens and mentioning the CLI path; unknown single positional → `error`; extra tokens after `stats` → `error`; known flags (`--cycles 2 --parallel 3`) round-trip into `flags`.

**Skill bodies (B)**

Rewrite `npx claude-autopilot` → `npx @cdhorne/claude-autopilot` in:

- `.claude/skills/pick/SKILL.md` (6)
- `.claude/skills/plan/SKILL.md` (4)
- `.claude/skills/ship/SKILL.md` (4)
- `.claude/skills/status/SKILL.md` (3)
- `.claude/skills/shakedown/SKILL.md` (3)
- `.claude/skills/pickup/SKILL.md` (3)
- `.claude/skills/charter/SKILL.md` (2)
- `.claude/skills/tidy/SKILL.md` (1)
- `.claude/skills/_review-logic.md` (1)

Total: 27 replacements (matches the charter count). Purely mechanical; no semantics change.

No edits to `docs/**` or `README.md`. Those describe consumer UX and aren't consumed by the pipeline. The lint rule in C scopes its checks to `.claude/skills/**`, not docs — consistent with how `check-skills.ts` is already scoped.

**Lint (C)**

- `packages/autopilot/scripts/autopilot/check-skills.ts` — add two named regexes and two lint branches after the existing body-scan loop. Reuse `Violation` / `lineOf` / the `rel` path computation already in the file.
- `packages/autopilot/scripts/autopilot/__tests__/check-skills.test.ts` — add fixtures: a body containing `npx claude-autopilot …` flags the first rule; swapping to `npx @cdhorne/claude-autopilot` clears it; a body containing `pnpm autopilot roadmap get …` flags the second rule.

**Workspace dep (B prerequisite)**

- `package.json` (root) — add `"@cdhorne/claude-autopilot": "workspace:*"` to `devDependencies`. Without this, pnpm doesn't expose `node_modules/@cdhorne/claude-autopilot` at the workspace root, and `npx @cdhorne/claude-autopilot` from the worktree CWD would hit the registry (404 today, since the package isn't published — pipelines would fail, not recurse, but still fail). Run `pnpm install` so the lockfile picks up the new workspace edge; the existing worktree-deps sha256 check will detect the lockfile drift and re-symlink/re-install on next `/pick`.
- This change is dogfood-only. Consumer repos already get `node_modules/@cdhorne/claude-autopilot/` from their own `npm install @cdhorne/claude-autopilot`.

**Docs**

- `CLAUDE.md` — one bullet under "Non-obvious conventions": skill bodies invoke the CLI via the scoped name `@cdhorne/claude-autopilot`; the bare `claude-autopilot` collides with a public package and caused a recursion incident (cross-reference TOOL-50). One sentence, matching the concision of neighbouring bullets.

## Test strategy

Unit (new):

- `main.test.ts` — `parseCli` covers the recursion-inducing positional shape (`["roadmap", "get", "TOOL-1", "--json"]`) and the nearby negative tokens. Positive cases for `stats` + `run` guard the refactor from reshaping argv semantics.
- `check-skills.test.ts` — fixture-driven: bare `npx claude-autopilot` is flagged; scoped form passes; `pnpm autopilot roadmap` is flagged. Runs under the existing `pnpm -r test` harness.

Unit (updated): none. `orchestrator.test.ts`, `pipeline.test.ts`, `stats.test.ts` don't import `main.ts`.

Integration (manual, not scripted):

- After the root `package.json` change + `pnpm install`: `ls node_modules/@cdhorne/claude-autopilot` from worktree root resolves (symlink to `packages/autopilot`).
- `npx @cdhorne/claude-autopilot roadmap get TOOL-50 --json` from worktree root → clean JSON (depends on the workspace dep being in place).
- `pnpm autopilot roadmap get TOOL-1 --json` → non-zero exit, "unknown positional args" message, no cycle start (layer A).
- `pnpm autopilot --dry-run --cycles 1` → normal dry-run still works (regression guard for the `main.ts` refactor).

Publish gate: `pnpm check:skills` is already wired into `check:publish` (per `packages/autopilot/scripts/check-publish.ts`). Adding rules to the checker means the publish workflow enforces the new invariants automatically; no workflow edits needed.

## Rubric self-check

**Correct.** Preserves all named pipeline invariants: `STEPS` / `BUDGETS` / `TURN_LIMITS` / `EFFORT` / `MODEL_PROFILES` untouched; `expandSkill()` frontmatter stripping unaffected (body rewrite is post-frontmatter); worktree-isolation and plan-polish hooks untouched; phantom-ship guard unaffected; rate-limit parking paths unaffected. The new `parseCli` error branch runs **before** `orchestrate`, so it's not reachable from a cycle in flight — correctly, because a CLI misuse is not a rate-limit condition.

**Well-typed.** `CliIntent` is a discriminated union with exhaustive narrowing. `Flags` passes through unchanged. No `any` casts beyond the existing `values as Flags` at the dispatch site. The two new regexes in `check-skills.ts` are `const` / module-scoped alongside the existing `FRONTMATTER_RE` / `INCLUDE_RE`.

**Well-factored.** Smallest edit in each file. `main.ts` gains one exported function, loses nothing. `check-skills.ts` gains two regexes and two branches that reuse the existing `Violation` scaffolding. No new modules, no new abstractions. The single root-`package.json` line (workspace devDep on `@cdhorne/claude-autopilot`) is the minimum change needed for pnpm to expose the scoped path at the workspace root — no other config edits required.

**Well-tested.** Two new test files, each scoped to the change it guards. The `parseCli` test is the defense-in-depth coverage the charter explicitly asked for. The `check-skills` test locks the new lint rules so a later mechanical pass can't silently regress them.

**Concise.** ~35 lines added to `main.ts`, ~25 lines to `check-skills.ts`, ~45 lines of tests, 27 near-identical skill edits. No new concepts introduced.

**Idioms.** Deferred to `/shakedown`, per the plan skill's instructions.

## Self-review notes

Two revisions during drafting:

1. **First pass:** proposed plumbing an `AUTOPILOT_CLI` env var from `step-runner.ts` into the SDK `query()` so skills could use `"$AUTOPILOT_CLI"` unconditionally. Dropped — it doesn't help inline (human-typed) skill use where no pipeline process sets the var, requires a shell-fallback anyway, and adds a new invariant (env propagates across SDK query + Bash tool) without making the fix stronger.
2. **Second pass:** `npx --no-install claude-autopilot`. I tested this empirically at plan time and found it still runs the cached public package: `--no-install` only blocks fresh registry fetches, not `~/.npm/_npx/*` cache hits. The observed failure on 2026-04-19 was almost certainly a cache hit — the public package was fetched at some earlier point, persisted in the cache, and has been silently hijacking `npx claude-autopilot` ever since. Dropped in favor of the scoped-name approach, which is immune to the cache-hit class of failure because only the `@cdhorne` scope owner can publish `@cdhorne/claude-autopilot` — there is no cross-package cache that can impersonate it.

3. **Third pass:** I initially asserted the root `package.json` needed no change because pnpm "auto-symlinks workspace packages into `node_modules/@<scope>/`". Shakedown empirically refuted that: `node_modules/@cdhorne/` only exists inside `packages/server/` and `packages/web/` (which declare the dep). The workspace root has no such symlink, so `npx @cdhorne/claude-autopilot` from the worktree CWD would 404 against the registry. Corrected by adding the workspace devDep to the root `package.json` (one-line change; lockfile picks it up on next `pnpm install`).
