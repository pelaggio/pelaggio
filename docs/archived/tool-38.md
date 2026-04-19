# TOOL-38 — Convert repo to pnpm workspace monorepo

Split the single-package repo into a pnpm workspace with two packages: `packages/autopilot` (the published pipeline, today's `scripts/autopilot/` + CLI) and `packages/server` (a placeholder stub that TOOL-39 fills in). Hoist dev tooling to the root, keep repo-wide artifacts (`.claude/skills/`, `.claude-templates/`, `docs/`, `.dev/`) at the root, and preserve dogfooding — `pnpm autopilot` at the root must still drive the pipeline against this repo.

## Scope

**In scope**
- New top-level layout: `pnpm-workspace.yaml`, `tsconfig.base.json`, root `package.json` becomes workspace root with dev-only deps and proxy scripts.
- Move `scripts/autopilot/**`, `scripts/autopilot.ts`, `bin/**`, and `scripts/check-publish.ts` into `packages/autopilot/`. Runtime deps (`@anthropic-ai/claude-agent-sdk`, `diff`, `tsx`, `yaml`, `@linear/sdk` peer) move with the package.
- `packages/server/` created with `package.json` (`@cdhorne/claude-autopilot-server`, `private: true`, no runtime deps) and a `README.md` pointing at TOOL-39. No server code.
- Keep at root: `.claude/skills/`, `.claude-templates/`, `docs/`, `.dev/autopilot-log.jsonl`, `CLAUDE.md`, `renovate.json`, `.github/workflows/`, `lefthook.yml`, `biome.json`. Repo-wide scripts (`scripts/check-roadmap.ts`, `scripts/roadmap-graph.ts`) stay at root because they operate on `docs/`.
- Teach `packages/autopilot` to publish with skills + templates included: a `prepack` script copies `../../.claude/skills/` → `packages/autopilot/.claude/skills/` and `../../.claude-templates/` → `packages/autopilot/.claude-templates/`, and a `postpack` removes them. Both paths are listed in `packages/autopilot/.gitignore` so the working copy isn't tracked twice.
- Package-root resolution in `init.ts` and `sync.ts` switches from a hardcoded `../..` to a small helper that walks up to the nearest directory containing `.claude/skills/`. That directory is the monorepo root during dogfood and the published-package root after `prepack` copy, so both call sites resolve correctly without branching.
- Smoke: `pnpm install`, `pnpm autopilot --dry-run --cycles 1`, `pnpm -r test`, `pnpm -r check`, `pnpm check:roadmap`, `pnpm check:skills`, `npm pack --dry-run` in `packages/autopilot/` (after prepack) all succeed.

**Out of scope**
- Adding the server itself (TOOL-39).
- Extracting `.claude/skills/` into its own package (possible later; `sync` CLI UX stays unchanged).
- End-to-end npm publish dry run beyond what `check-publish` already covers (TOOL-18 owns that).
- Changing `sync`'s consumer UX — install destination is still `./.claude/skills/` in the consumer's repo.
- Migrating repo-wide scripts (`check-roadmap`, `roadmap-graph`) into a package.

## Approach

### Why a workspace now, not later

TOOL-39 and TOOL-42 both need a second package (daemon, web UI). Doing the split once, cleanly, before the daemon lands, avoids a mid-feature refactor. The alternative — living with `scripts/autopilot/` + `packages/server/` side by side — leaves the pipeline as a second-class citizen under `scripts/`, which is awkward once it imports into `packages/server/` code.

### Where the skills live at publish time

`.claude/skills/` and `.claude-templates/` are consumer-facing artifacts — `init` and `sync` copy them out of the package into a consumer's repo. They must therefore be inside the published tarball for `@cdhorne/claude-autopilot`. But the roadmap is explicit: they stay at the monorepo root for dogfooding ergonomics (the skills are read by the pipeline from `REPO/.claude/skills/`, where `REPO` is `git rev-parse --show-toplevel` → the monorepo root).

The cleanest bridge is a `prepack` copy: before `npm pack` runs, duplicate the two dirs into the package folder; after pack, delete them. The copies are `.gitignore`d.

**Wrinkle — `check-publish` uses `--ignore-scripts`.** The current `npmPackDryRun()` invokes `npm pack --dry-run --json --ignore-scripts` (`scripts/check-publish.ts:78`), so `prepack` would not fire and the allowlist check would see a package with no skills — silently passing. Fix: drop `--ignore-scripts` from that invocation. It was originally a defensive habit; since the package only has `prepack`/`postpack` hooks we own (no `preinstall`/`install`/`postinstall`, and `check-publish` itself enforces that invariant), letting our own lifecycle run is safe. `postpack` restores the clean state; wrap the pack call in `try/finally` that force-deletes the copied dirs on the off chance `postpack` didn't run (CI belt-and-braces).

Alternatives rejected:
- **Symlinks**: `npm pack` refuses to follow symlinks in `files`.
- **Move skills into `packages/autopilot/`**: breaks dogfooding, because the pipeline reads skills from `REPO/.claude/skills/`. Would require either changing that contract (violates the "skills live at repo root" convention documented in CLAUDE.md) or a reverse symlink from root into the package.
- **A second `npm pack` wrapper that tars the skills in externally**: more moving parts; `prepack` is the idiomatic npm hook.

### Package root resolution

Both `init.ts` and `sync.ts` today compute `PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")`. From `packages/autopilot/scripts/autopilot/init.ts` that resolves to `packages/autopilot/`, which is correct for installed packages (where `prepack` put the skills) but wrong for dogfood (where skills live at the monorepo root two levels up).

Replace the constant with a helper `resolveArtifactRoot()` that walks up from the module URL until it finds a directory containing **both** `.claude/skills/` **and** a sibling `package.json`. The `package.json` anchor matters for pathological parent layouts (e.g. a consumer clones into a parent dir that itself happens to have a `.claude/skills/` fixture) — the walk stops at the first directory that looks like a package root. Dogfood: walks past `packages/autopilot/` (no skills there in the working tree) up to the monorepo root, which has both. Installed: finds skills + `package.json` at the package root immediately. Single rule, no environment branching, no special cases for test harnesses. The existing sync test `smoke: real PKG_ROOT against itself reports all-identical` continues to work because the repo root is the first ancestor matching the rule.

### Dogfood entry points

Root `package.json` keeps a short list of scripts that proxy into the package so muscle-memory invocations survive:

```json
"scripts": {
  "autopilot": "pnpm --filter @cdhorne/claude-autopilot autopilot",
  "test": "pnpm -r test",
  "check": "biome check",
  "check:skills": "pnpm --filter @cdhorne/claude-autopilot check:skills",
  "check:publish": "pnpm --filter @cdhorne/claude-autopilot check:publish",
  "check:roadmap": "tsx scripts/check-roadmap.ts",
  "graph:roadmap": "tsx scripts/roadmap-graph.ts",
  "format": "biome check --write",
  "prepare": "lefthook install"
}
```

Why `pnpm --filter <name> <script>` and not `pnpm -C packages/autopilot run <script>`: filter-by-name is stable across directory moves and survives future renames (TOOL-39 might rename `packages/server` or introduce a third package). One call site per script, no path fragility.

Why `biome check` (not `pnpm -r check`) for the root lint script: Biome is a single-config tool — one `biome.json` at the root already covers the whole workspace via its widened `includes`. Running it once at the root matches how Biome expects to be invoked and avoids per-package `check` scripts that each re-run the same linter on a subset. `pnpm -r test` is still right because tests do live inside the package.

### MAIN_REPO + worktree semantics

`config.ts` resolves `REPO` via `git rev-parse --show-toplevel`, which returns the monorepo root in both dogfood and worktree cases. `WORKTREE_PREFIX` is derived from `basename(REPO)` — the monorepo root is still called `claude-autopilot` or whatever the user cloned it as, so `claude-autopilot-tool-38` worktrees still match. No changes needed in `config.ts`, `step-runner.ts`, or the MAIN_REPO-write-blocking hook.

The plan-polish hook matches `/docs/plans/` relative to `cwd`. `docs/plans/` lives at the monorepo root regardless of the refactor, and `cwd` is the worktree root. No change.

### Verification scripts — which stay at root

- `scripts/check-roadmap.ts` — reads `docs/task-index.md` + `docs/roadmap-*.md`. Repo-wide. **Stays at root.**
- `scripts/roadmap-graph.ts` — reads `docs/roadmap-*.md`, writes `docs/dep-graph.md`. Repo-wide. **Stays at root.**
- `scripts/check-publish.ts` — operates on the package tarball for publish. Package-local. **Moves to `packages/autopilot/scripts/check-publish.ts`.**
- `scripts/autopilot/check-skills.ts` — reads `.claude/skills/` at the monorepo root. It already uses `findRepoRoot()`, so it'll keep working from either location. Keeping it inside the package (unchanged) is simplest — skills linting is part of the autopilot workflow, and it moves with the rest of `scripts/autopilot/**`.

### Biome, lefthook

`biome.json`:
```json
{
  "files": { "includes": ["packages/*/scripts/**/*.ts", "scripts/**/*.ts"] }
}
```

`lefthook.yml`:
```yaml
pre-commit:
  parallel: true
  commands:
    biome:
      glob: "{packages/*/scripts/**/*.ts,scripts/**/*.ts}"
      run: pnpm exec biome check --write --no-errors-on-unmatched {staged_files}
      stage_fixed: true
```

One Biome at the root, not one per package — Biome is happy with a single root config covering the whole workspace, and this keeps the formatting policy singular.

### Workspace + tsconfig

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`tsconfig.base.json` at the root holds strict compiler options (target ES2024, module NodeNext, strict true, noUncheckedIndexedAccess true, etc.). Each package's `tsconfig.json` extends it. These configs are for IDE support only — there is no `tsc` build in this repo; tsx handles transpilation.

### CI

`.github/workflows/ci.yml` becomes:
```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm -r test
- run: pnpm -r check
- run: pnpm check:skills
- run: pnpm check:roadmap
```

`.github/workflows/publish.yml` changes the publish step to run inside the package:
```yaml
- run: pnpm --filter @cdhorne/claude-autopilot check:publish
- run: npm publish --provenance --access public
  working-directory: packages/autopilot
```

## Files to change

### New files

- `pnpm-workspace.yaml` — lists `packages/*`.
- `tsconfig.base.json` — shared compiler options.
- `packages/autopilot/package.json` — moved + renamed root package.
- `packages/autopilot/tsconfig.json` — extends base.
- `packages/autopilot/.gitignore` — ignores `.claude/skills/` and `.claude-templates/` (prepack-copied only).
- `packages/autopilot/README.md` — minimal; points back to root README.
- `packages/server/package.json` — `@cdhorne/claude-autopilot-server`, `private: true`, no code.
- `packages/server/tsconfig.json` — extends base.
- `packages/server/README.md` — stub pointing at TOOL-39.

### Moved (git mv, unchanged content except as noted)

- `scripts/autopilot/**` → `packages/autopilot/scripts/autopilot/**`
- `scripts/autopilot.ts` → `packages/autopilot/scripts/autopilot.ts`
- `bin/claude-autopilot.js` → `packages/autopilot/bin/claude-autopilot.js`
- `scripts/check-publish.ts` → `packages/autopilot/scripts/check-publish.ts`

### Edited

- Root `package.json` — reduced to workspace root: `private: true`, name `claude-autopilot-workspace`, devDeps (`biomejs`, `lefthook`, `tsx`, `typescript`, `@anthropic-ai/claude-code`), proxy scripts above, no `dependencies`, no `bin`, no `files`, no `main`, no `exports`, no `peerDependencies`.
- `packages/autopilot/package.json` — takes over name `@cdhorne/claude-autopilot`, version, runtime deps, `bin`, `main`, `exports`, `files`, `peerDependencies` (+ `peerDependenciesMeta.@linear/sdk.optional`), `packageManager`, and the package-local scripts: `autopilot` (`tsx scripts/autopilot.ts`), `test` (`tsx --test scripts/autopilot/__tests__/*.test.ts`), `check:publish`, `check:skills`, plus the new `prepack`/`postpack` hooks. No `check` / `format` / `prepare` / `check:roadmap` / `graph:roadmap` here — those are root-scoped (biome single-config, lefthook, repo-wide scripts). `files` stays:
  ```json
  ["scripts/autopilot.ts", "scripts/autopilot/**", ".claude/skills/**", ".claude-templates/**", "bin/**", "!scripts/autopilot/__tests__/**", "!scripts/autopilot/**/*.test.ts"]
  ```
  (unchanged — paths are package-relative and resolve correctly after prepack copy).
- `packages/autopilot/scripts/autopilot/init.ts` — swap `PKG_ROOT` constant for `resolveArtifactRoot()` helper (inline or in a tiny shared module).
- `packages/autopilot/scripts/autopilot/sync.ts` — same swap.
- `packages/autopilot/scripts/check-publish.ts` — `findRepoRoot()` is already `../..` from `scripts/check-publish.ts`, which is now `packages/autopilot/scripts/` → `packages/autopilot/`. Paths in `ALLOWED_PREFIXES` remain package-internal and valid. **Two substantive changes:** (1) drop `--ignore-scripts` from the `npm pack --dry-run --json` call in `npmPackDryRun()` so `prepack` fires and the allowlist check runs against the real published tree; (2) wrap the pack call in `try/finally` that force-removes `packages/autopilot/.claude/skills/` and `packages/autopilot/.claude-templates/` — defensive cleanup if `postpack` ever fails to run.
- `biome.json` — widen `includes` as above.
- `lefthook.yml` — widen glob as above.
- `.github/workflows/ci.yml` — switch to `pnpm -r test` / `pnpm -r check`.
- `.github/workflows/publish.yml` — run `check:publish` via filter, `npm publish` with `working-directory: packages/autopilot`.
- `CLAUDE.md` — update the Orientation section to show the new layout:
  ```
  - Pipeline package: packages/autopilot/scripts/autopilot/ — TypeScript, runs on tsx
  - Server package (placeholder): packages/server/ — filled in by TOOL-39
  - Skills: .claude/skills/ (root) — shared, read by expandSkill() with REPO = monorepo root
  - Templates: .claude-templates/ (root) — copied into consumers by `init` / `sync`
  - Root: pnpm-workspace.yaml, biome.json, lefthook.yml, tsconfig.base.json, docs/
  - Entry point: `pnpm autopilot` → proxies to packages/autopilot
  ```
  Also update the "Running things" snippets (no semantic change — `pnpm autopilot --dry-run --cycles 1` still works) and add a one-liner under "Non-obvious conventions" describing the `prepack` skill copy.
- `docs/config.md` — if it references absolute paths like `scripts/autopilot/config.ts`, update to `packages/autopilot/scripts/autopilot/config.ts` or (better) make the reference relative to the package.
- Test fixture *string literals* in `__tests__/check-publish.test.ts` and `__tests__/check-skills.test.ts` encode `scripts/autopilot/foo.ts` as package-internal paths, which remain valid package-relative paths after the move. No change required there.
- Test files that walk upward to a "repo root" — **these need edits**. Today `scripts/autopilot/__tests__/` is three directories below repo root, so they use `"../../.."`. After the move to `packages/autopilot/scripts/autopilot/__tests__/` they are five directories below the monorepo root, so the walk becomes `"../../../../.."`:
  - `__tests__/sync.test.ts` (`REAL_PKG_ROOT`) — wants the directory containing `.claude/skills/` (monorepo root in dogfood). Switch to `resolveArtifactRoot(import.meta.url)` for symmetry with the production helper; avoids another stale `../` count later.
  - `__tests__/check-skills.test.ts` (`REAL_REPO_ROOT`) — same: points at the monorepo root to lint real skills. Also use `resolveArtifactRoot`.
  - `__tests__/init.test.ts` (`PKG_ROOT`) — same.
  - `__tests__/roadmap-graph.test.ts` (`REPO_ROOT`) + `__tests__/check-roadmap.test.ts` (`REPO_ROOT`) — used as `cwd` for `execFileSync("npx", ["tsx", "scripts/roadmap-graph.ts", ...])`. The scripts stay at the monorepo root, so `REPO_ROOT` must resolve to the monorepo root. Use `resolveArtifactRoot` here too.
  - Import lines in `__tests__/roadmap-graph.test.ts` and `__tests__/check-roadmap.test.ts` referencing `"../../check-roadmap.js"` / `"../../roadmap-graph.js"`: these scripts stay at monorepo root (`scripts/check-roadmap.ts`, `scripts/roadmap-graph.ts`), so imports become `"../../../../../scripts/check-roadmap.js"` (five ups from `__tests__/` to monorepo root, then into `scripts/`). Ugly but correct. Alternative: introduce a `packages/autopilot/scripts/autopilot/__tests__/_root.ts` tiny shim that re-exports via `resolveArtifactRoot` + dynamic import — overkill for two files.
  - Import line in `__tests__/check-publish.test.ts` referencing `"../../check-publish.js"`: after move, `check-publish.ts` lives at `packages/autopilot/scripts/check-publish.ts`, so `"../../check-publish.js"` from `packages/autopilot/scripts/autopilot/__tests__/` still resolves correctly. No change.
- `.claude/skills/_rubric.md` and `.claude/skills/bump-models/SKILL.md` — already reference `scripts/autopilot/config.ts`. After the move, they should reference `packages/autopilot/scripts/autopilot/config.ts`. Update both, plus the verification commands in `_rubric.md`:
  ```
  pnpm -r test --test-reporter=dot
  npx tsx -e "import('./packages/autopilot/scripts/autopilot/config.ts')"
  ```
  Also widen the `check-skills.ts` "scripts/autopilot/*.ts" reference guard to match the new location.

## Test strategy

Existing tests keep running via `pnpm -r test`, which is now the canonical way to exercise the suite. Add:

1. **Prepack smoke test** — `packages/autopilot/scripts/autopilot/__tests__/prepack.test.ts`: in a temp dir, invoke the `prepack` script, assert that `packages/autopilot/.claude/skills/_rubric.md` + `.claude-templates/docs/roadmap-example.md` exist, invoke `postpack`, assert they're gone. Uses `child_process.execFileSync` to run the npm scripts. Add a companion assertion that `check-publish` with `--ignore-scripts` dropped completes end-to-end: the pack output must include at least one file under `.claude/skills/` — the regression test for the `--ignore-scripts`/`prepack` interaction described in the Approach.
2. **`resolveArtifactRoot` unit** — new helper gets a small unit test covering both layouts: (a) fixture tree with `.claude/skills/` two levels up, asserts it's found; (b) fixture tree with `.claude/skills/` in the same dir, asserts it's found.
3. **`check-publish` allowlist** — the existing fixture test keeps working; add a case asserting `.claude/skills/shipwreck/SKILL.md` (a path that will only exist after prepack) passes the allowlist.
4. **Dogfood smoke** — manually (not automated): `pnpm install && pnpm autopilot --dry-run --cycles 1` from the workspace root must complete without errors. `--dry-run` avoids SDK calls, verifying pipeline wiring end-to-end.
5. **CI workflow** — after merge, the CI job must succeed on the self-hosted runner. Rate-limit parking behavior is unchanged (same pipeline code), so the first PR run is the regression check.

## Rubric self-check

- **Correct** — Load-bearing invariants:
  - **Step exhaustiveness**: untouched. `STEPS`, `BUDGETS`, `TURN_LIMITS`, `EFFORT`, `MODEL_PROFILES` remain in `config.ts`; no new step introduced.
  - **Frontmatter stripping**: `expandSkill()` unchanged. Skill files move on disk (prepack copy), not inside the pipeline.
  - **Worktree isolation**: `step-runner`'s MAIN_REPO-write hook keys off `resolve(REPO)` vs `resolve(opts.cwd)`. `REPO` stays the monorepo root post-refactor. Hook behavior is identical.
  - **Plan-polish block**: matches `/docs/plans/` relative to `cwd`. `docs/plans/` stays at the monorepo root. Unchanged.
  - **Rate-limit parking**: no pipeline changes — parkExit paths untouched.
  - **Phantom ship guard**: `hasDeliverableCommits` tests against `main`; no branch or path semantics change.
  - **No hardcoded model strings**: `claude-opus-*` / `claude-sonnet-*` literals stay only in `packages/autopilot/scripts/autopilot/config.ts`. The `bump-models` skill guard (`rg 'claude-(opus|sonnet|haiku)-' packages/autopilot/scripts/`) must be updated to match the new path.
  - **No install-script hooks**: `packages/autopilot/package.json` gains `prepack` + `postpack`, which are pack-time, not install-time. `preinstall`/`install`/`postinstall` remain absent; `check-publish.ts`'s `INSTALL_SCRIPTS` list already excludes pack hooks. Verify test coverage still asserts `install` scripts are forbidden.

- **Well-typed** — Refactor is path-level, not type-level. No new `any`. `resolveArtifactRoot()` returns `string`. No `as` casts.

- **Well-factored** — Module boundaries preserved. New package boundary is the only structural change, and it follows the repo's stated "strict module boundaries" rubric one level up (workspace → package → module).

- **Well-tested** — Covered above. The prepack and `resolveArtifactRoot` cases exercise the two new moving parts; everything else is an import-path or fs-path rename that the existing tests + CI will catch.

- **Concise** — No new helpers beyond `resolveArtifactRoot()` (~10 lines) and the prepack/postpack scripts (~5 lines each, inline in package.json). Root `package.json` gets shorter, not longer. No abstraction added for the hypothetical third package — TOOL-39 can extend `pnpm-workspace.yaml` when needed.

- **Idioms** — Deferring to `/shakedown` per the plan protocol, but flagging the two choices a reviewer will probably poke at: (1) `prepack` + `postpack` is the standard npm lifecycle — no clever tooling invented; (2) `pnpm --filter <name>` rather than `-C <path>` for workspace delegation — pnpm docs call this out as the preferred form for name-stable dispatch.

## Risks

- **`prepack` copies pollute the working tree if a run aborts.** Mitigation: `.gitignore` the paths inside the package; `postpack` removes them; add a `git status` check in the publish workflow as defense-in-depth. Worst case: a developer sees untracked `packages/autopilot/.claude/skills/`, deletes it, moves on.
- **Biome's glob widening silently catches a file we didn't intend.** Mitigation: `pnpm check` run before merge surfaces any newly-in-scope lint errors.
- **`resolveArtifactRoot` matches the wrong directory in a pathological layout** (e.g. consumer's CI clones into a parent that also has `.claude/skills/`). The helper's primary definition (above) already requires `.claude/skills/` **and** a sibling `package.json`, without binding to a specific package name — this risk is noted here for completeness. Unit-test both shapes (workspace root during dogfood, installed package inside `node_modules`).
- **`pnpm -r test` doesn't pick up the repo-wide scripts at the root.** The two repo-wide scripts (`check-roadmap`, `roadmap-graph`) and their tests live in/under `packages/autopilot/` so `pnpm -r test` covers them. Only the *subject* files stay at monorepo root; the *tests* stay in the package to preserve a single `pnpm -r test` entrypoint. Confirmed acceptable by the Verification section of `_rubric.md` (`pnpm test` at the root is the one-stop command).

---

Run `/shakedown` for an independent review, or say **go** to start building. When done, run `/shakedown` again to review the code.
