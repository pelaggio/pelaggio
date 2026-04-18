# TOOL-26 — Share `node_modules` across worktrees

## Scope

Replace the unconditional `pnpm install --frozen-lockfile --silent` in every
new worktree with a conditional step: when the worktree's `pnpm-lock.yaml`
hash matches `MAIN_REPO/pnpm-lock.yaml`, symlink `<worktree>/node_modules → <MAIN_REPO>/node_modules`
instead of running an install. When it differs (or the symlink has gone stale
mid-cycle) fall through to `pnpm install`.

**In scope**
- `.claude/skills/pick/SKILL.md` Claim step.
- A new helper `scripts/autopilot/worktree-deps.ts` with a pure decision
  function + a tiny CLI wrapper invoked from the skill.
- A mid-cycle drift guard: call the same helper from `runStep` in
  `scripts/autopilot/step-runner.ts` at the top of every worktree-cwd step so
  a lockfile bump inside the branch is repaired before the next verification
  command runs.
- New unit tests `scripts/autopilot/__tests__/worktree-deps.test.ts` covering
  the decision matrix (no mocked `pnpm`).
- One-line update to `CLAUDE.md`'s Running-things / Non-obvious conventions
  section noting the optimization and its scope (root-only).

**Not in scope**
- Nested/workspace `node_modules` (document root-only limitation, per roadmap).
- Changing pnpm's `node-linker` mode globally.
- Non-pnpm consumers (yarn/npm) — they keep the existing `pnpm install`
  behavior via the fallback branch, but optimization only triggers when
  `pnpm-lock.yaml` exists.
- Caching `node_modules` across autopilot runs.

## Approach

A single helper module, `scripts/autopilot/worktree-deps.ts`, with a pure
decision function and a thin action applier:

```ts
export type DepsAction =
  | { type: "noop" }                        // symlink or real dir already valid
  | { type: "link"; target: string }        // create symlink
  | { type: "relink"; target: string }      // remove stale symlink, recreate
  | { type: "reinstall" }                   // remove stale symlink, run install
  | { type: "install" };                    // no symlink attempt (lockfile drift or missing main nm)

export function decideDepsAction(worktree: string, mainRepo: string): DepsAction;
export function ensureWorktreeDeps(worktree: string, mainRepo?: string): DepsAction;
```

`decideDepsAction` is pure (only reads fs + hashes) and fully unit-testable.
`ensureWorktreeDeps` performs the side effects: `fs.symlinkSync`,
`fs.unlinkSync`, and `execSync("pnpm install --frozen-lockfile --silent", { cwd: worktree })`
where applicable. It returns the action it took for telemetry / log use.

**Why this over alternatives**

- **Bash script (`.sh`)**: harder to unit-test from `node:test`; adds a second
  runtime alongside TS. Rejected.
- **Inline shell in `pick/SKILL.md`**: ~20 lines of conditional bash in a
  skill body is brittle — the agent's bash execution is non-deterministic
  about quoting and exit-code interpretation. A TS helper is deterministic.
- **Install-always, skip via `pnpm install --offline`**: still traverses
  every package and hits lockfile-hash verification; not as fast as a plain
  symlink and doesn't address I/O contention.
- **pnpm's `node-linker=hoisted` or a global store tweak**: per deliverable,
  too invasive.

**Symlink mechanics**
- Target: `<MAIN_REPO>/node_modules` (absolute path so `basename` resolution
  inside tools is unambiguous).
- Created with `fs.symlinkSync(target, link, "dir")`.
- Detected as "ours" purely by `lstatSync().isSymbolicLink()` — we never
  touch a real directory, so a user-managed `node_modules` is left alone
  (falls through to `noop` if it exists as a dir, `install` if absent).

**Mid-cycle guard**
Every step after `pick` runs with `cwd = worktree` in `step-runner.ts`.
Adding a single call to `ensureWorktreeDeps(opts.cwd, REPO)` near the top
of `runStep` (inside the existing `isWorktree` branch already computed
on line 57) re-evaluates the decision before the SDK query starts. If the
branch bumped `pnpm-lock.yaml`, the stale symlink is replaced by a real
install before `pnpm test` / `pnpm check` runs downstream. The check is
O(2 × sha256(lockfile)) — negligible overhead per step.

**Rubric cross-check before coding**
- *Correct — step exhaustiveness*: N/A, no new `Step`.
- *Correct — worktree isolation*: the helper reads + writes inside the
  worktree and reads `MAIN_REPO/pnpm-lock.yaml`; the symlink target is
  MAIN_REPO but we don't **write** there — safe under the existing hook
  contract (hook blocks Write/Edit/Bash writes to MAIN_REPO; creating a
  symlink *from* worktree *pointing at* MAIN_REPO is a worktree-local
  write). Verified by reading `step-runner.ts`'s hook — it matches
  `file_path` against MAIN_REPO, not link targets.
- *Correct — rate-limit parking*: helper is synchronous and not part of
  any rejection path; `parkExit()` paths unchanged.
- *Correct — frontmatter stripping*: only SKILL.md body edits, no
  frontmatter changes.
- *Well-tested*: decision function is pure; side-effect path is a trivial
  dispatcher and is exercised implicitly by `decideDepsAction` coverage.

## Files to change

| File | Change |
|---|---|
| `scripts/autopilot/worktree-deps.ts` | **New.** `decideDepsAction` + `ensureWorktreeDeps` + a CLI entry matching the established pattern in `check-skills.ts` / `init.ts` / `sync.ts`: `const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);` — takes `worktree` as argv[2] and prints the action type. |
| `.claude/skills/pick/SKILL.md` | Replace Claim step 3's `pnpm install --frozen-lockfile --silent` with `npx tsx "{MAIN_REPO}/scripts/autopilot/worktree-deps.ts" "$WORKTREE"`. Rewrite the explanatory sentence to cover the symlink-when-matches optimization. Also append `Bash(npx tsx:*)` to the frontmatter's `allowed-tools` list (matches the pattern in `ship`/`shakedown`). |
| `scripts/autopilot/step-runner.ts` | In `runStep`, inside the existing `isWorktree` branch, call `ensureWorktreeDeps(opts.cwd, REPO)` before the `query()` loop. Import from `./worktree-deps.js`. |
| `scripts/autopilot/__tests__/worktree-deps.test.ts` | **New.** `node:test` covering the seven decision cases below. |
| `CLAUDE.md` | Add one bullet to "Non-obvious conventions" section: worktrees share MAIN_REPO's `node_modules` via symlink when lockfiles match; root-only (workspace subpackages still install); guard re-checks before each step. |

## Test strategy

`scripts/autopilot/__tests__/worktree-deps.test.ts` — temp-dir harness in
the style of `helpers.test.ts`. Each test creates a main-repo dir and a
worktree dir with the specific fs shape, then asserts on
`decideDepsAction(worktree, main)`.

Decision matrix (seven cases):

| Main lockfile | Worktree lockfile | Main `node_modules` | Worktree `node_modules` | Expected |
|---|---|---|---|---|
| present | present, same hash | present | absent | `link` |
| present | present, same hash | present | symlink → main nm | `noop` |
| present | present, same hash | absent | absent | `install` |
| present | present, different hash | present | absent | `install` |
| present | present, different hash | present | symlink → main nm | `reinstall` |
| present | absent | present | absent | `install` |
| present | present, same hash | present | real dir (not symlink) | `noop` |
| present | present, different hash | present | real dir (not symlink) | `noop` |

Real directories are always left alone (`noop`) regardless of lockfile hash —
`lstatSync().isSymbolicLink()` is the sole "do we own this?" test, so a
user-managed `node_modules` is never mutated by this helper. Drift inside a
user-managed real dir is the user's problem to fix with `pnpm install`.

Also a single happy-path integration test for `ensureWorktreeDeps` with
the same-hash + link case (no `pnpm install` invocation happens on that
branch) — asserts the symlink exists and points at the right target.
Branches that would call `execSync("pnpm install …")` are not exercised
end-to-end (would require a real pnpm + network) — the decision function
test is sufficient coverage per the rubric ("pipeline integration is
harder to test … acceptable to leave until a mocking approach emerges").

Run the suite with:
```bash
npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/worktree-deps.test.ts
```

Full regression:
```bash
npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/*.test.ts
pnpm check
pnpm check:skills
```

## Smoke test (manual, after tests pass)

1. In a clean main repo: `ls -la node_modules` → real dir.
2. `pnpm autopilot --item TOOL-X --dry-run --cycles 1 --verbose` — verify
   the pick step reports `linked` rather than a wall of pnpm install output.
3. Pick a real item, cd into worktree, `ls -la node_modules` → symlink → main.
4. `pnpm test` inside worktree passes (via symlinked deps).
5. Induce drift: edit `pnpm-lock.yaml` in the worktree, re-run the pipeline
   for another step (e.g. via `--resume`), observe the `reinstall` action
   and verify `node_modules` becomes a real directory.

## Self-review

Re-reading against rubric dimensions (Correct, Well-typed, Well-factored,
Well-tested, Concise — `/shakedown` owns Idioms):

- **Correct**: The one subtle interaction is the step-runner guard. The
  current worktree-isolation hook (`step-runner.ts` ~line 57 onward) blocks
  writes to MAIN_REPO paths; `ensureWorktreeDeps` runs *before* the
  hook-protected SDK session, from the orchestrator's own node process,
  so it isn't subject to that hook. It writes only inside the worktree
  (creating/removing `<worktree>/node_modules`). Target resolution reads
  from MAIN_REPO but doesn't mutate it. ✓
- Phantom-ship, rate-limit-parking, and step-exhaustiveness invariants
  are untouched. ✓
- **Well-typed**: `DepsAction` is a discriminated union; no `any`.
  Exported functions have explicit return types. ✓
- **Well-factored**: All logic lives in one new module. `step-runner.ts`
  grows by 2 lines (import + call); `pick/SKILL.md` gets one line
  changed; no cross-cutting changes. Decision function is pure; side-effect
  function is a trivial dispatcher. ✓
- **Well-tested**: Pure decision function has seven-case matrix coverage
  plus one integration test on the symlink happy path. `install` branch
  isn't integration-tested — acceptable per rubric (SDK/shell integration
  can stay manual). ✓
- **Concise**: The helper file is ~80 lines. No new config knobs — the
  optimization is automatic and silent when it doesn't apply. No new
  `.autopilot.yml` keys. ✓

**Revisions during self-review**: none — the plan is internally
consistent.

**Shakedown revisions (plan-review pass)**:
- CLI entry guard now uses the `fileURLToPath(import.meta.url)` pattern
  already established in `check-skills.ts` / `init.ts` / `sync.ts` rather
  than the ad-hoc `'file://' + process.argv[1]` form.
- Skill invocation is `npx tsx` (matches `allowed-tools: Bash(npx tsx:*)`
  in `ship` / `shakedown`) and `pick/SKILL.md`'s `allowed-tools` gets that
  entry added — the current declaration only lists `Bash(pnpm:*)`.
- Decision matrix now explicitly documents that real (non-symlink)
  `node_modules` is always `noop` — symlink-presence is the sole
  ownership test, so user-managed dirs are never mutated regardless of
  lockfile hash.
