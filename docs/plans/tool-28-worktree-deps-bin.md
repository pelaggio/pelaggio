# TOOL-28 — `worktree-deps` bin subcommand

## Scope

Expose `scripts/autopilot/worktree-deps.ts` as a routed subcommand of the `claude-autopilot` CLI so `/pick`'s skill body can invoke a path-opaque command instead of `npx tsx "{MAIN_REPO}/scripts/autopilot/worktree-deps.ts"`. That absolute path only works in the upstream repo — consumer projects install the package under `node_modules/@cdhorne/claude-autopilot`, and the script has relative `./config.js` imports so it can't be copied standalone.

**Touches:** `bin/claude-autopilot.js`, `.claude/skills/pick/SKILL.md`.

**Does NOT touch:** `scripts/autopilot/worktree-deps.ts` internals, `scripts/autopilot/step-runner.ts` (still uses the in-process `ensureWorktreeDeps()` import — subcommand is for skill-body callers only), workspace-package symlinking (deferred), renaming the script, existing test file.

## Approach

Add a new route to the existing `routes` map in `bin/claude-autopilot.js`. The bin already does exactly this pattern for `init`, `sync`, `run`, `stats`: `routes[sub]` maps to a TS entry-point path, then `spawn(tsx, [resolve(pkgRoot, script), ...prefix, ...rest])` forwards argv.

`worktree-deps.ts` already handles direct invocation via the `isDirectInvocation` block at the bottom (`process.argv[2]` = worktree path, prints action type, exits). No script changes needed — the bin forward is sufficient. `pkgRoot` resolves to the installed package directory in both upstream (`<repo>`) and consumer (`<repo>/node_modules/@cdhorne/claude-autopilot`) contexts, and `REPO` inside the script uses `git rev-parse --show-toplevel` from the spawned cwd, which gives the consumer's main repo (inheriting `/pick`'s cwd) in either case.

### Alternative considered

Inline the worktree-deps logic into the bin so there's no `tsx` hop. Rejected — the script needs `REPO` from `config.ts` and the decision helpers, so duplicating or dual-importing adds surface area without meaningful win. The tsx hop cost is ~200ms, invoked once per `/pick`.

## Files to change

### `bin/claude-autopilot.js`

1. Add to the `routes` map:
   ```js
   "worktree-deps": ["scripts/autopilot/worktree-deps.ts"],
   ```

2. Add to the `HELP` block's Commands list:
   ```
     worktree-deps  Symlink/install node_modules for a worktree (called by /pick).
   ```

No other changes to the file — the existing `spawn(tsx, [resolve(pkgRoot, script), ...prefix, ...rest])` pipes `...rest` into the script, which is exactly the `<worktree-path>` arg the script already reads from `process.argv[2]`.

### `.claude/skills/pick/SKILL.md`

1. Step 3 — replace the command:
   - **Old:** `npx tsx "{MAIN_REPO}/scripts/autopilot/worktree-deps.ts" "$WORKTREE"`
   - **New:** `npx claude-autopilot worktree-deps "$WORKTREE"`
   - Update surrounding prose only to drop the `{MAIN_REPO}/scripts/autopilot/worktree-deps.ts` path reference. Keep the existing description of what the helper does (lockfile sha compare, symlink vs install fallback, printed action names).

2. Frontmatter `allowed-tools` — current line is:
   ```
   allowed-tools: Read Glob Grep Bash(git:*) Bash(pnpm:*) Bash(npx tsx:*)
   ```
   `Bash(npx tsx:*)` no longer matches the new command. Since step 3 is the only `npx` invocation in `/pick`, replace `Bash(npx tsx:*)` with the narrower `Bash(npx claude-autopilot:*)`. This is scope-separate from TOOL-29, which broadens shakedown/ship only.

## Test strategy

- **`npx tsx --test scripts/autopilot/__tests__/worktree-deps.test.ts`** — existing tests exercise `decideDepsAction` / `ensureWorktreeDeps` pure logic. Unchanged, must still pass.
- **Manual smoke in the worktree:** `node bin/claude-autopilot.js --help` should list `worktree-deps`. `node bin/claude-autopilot.js worktree-deps "$PWD"` from inside the current worktree should print `noop` (it already has a real `node_modules` — real-dir is left alone).
- **`pnpm check`** — Biome-clean.
- **`pnpm check:skills`** — validates `/pick`'s frontmatter + includes after the edit.
- No new unit test for the bin route: the `init`/`sync`/`run`/`stats` routes have no equivalent coverage and adding one here would require stubbing `spawn`. The behavior is a one-line dispatch table.

## Rubric self-check

- **Correct** — The key invariant to protect is that `REPO` inside `worktree-deps.ts` still resolves to the consumer's main repo, not the package's install dir. Verified: `resolveRepo()` uses `git rev-parse --show-toplevel` on the spawned process cwd (inherited from `/pick`'s session), and `spawn(tsx, ..., { env: process.env })` in the bin does not override cwd. No new paths are introduced that could hit worktree-isolation or plan-polish hooks (both are pipeline-only; `/pick` runs before the worktree exists and isn't under the hooks). No phantom-ship, rate-limit-park, or step-exhaustiveness surface touched.
- **Well-typed** — bin/claude-autopilot.js is intentionally untyped JS (mirrors `package.json#bin` convention). No new TS surface.
- **Well-factored** — Reuses the existing `routes` dispatch table. No new module, no new helper. `/pick`'s skill body becomes slightly simpler (no `{MAIN_REPO}` substitution in the command line).
- **Well-tested** — Pure decision logic already covered; integration is the same `spawn` shape used for 4 existing subcommands; manual smoke suffices. No coverage regression.
- **Concise** — Two lines added to the bin, one line edited in the skill body, one frontmatter token swapped. No scope creep toward TOOL-29 (shakedown/ship frontmatter) or monorepo workspace symlinking.

## Commit plan

Single commit: `feat: expose worktree-deps as claude-autopilot subcommand (TOOL-28)`.
