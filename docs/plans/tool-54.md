# TOOL-54 — Block worktree-side `pnpm install`: PreToolUse hook + proactive symlink restore

## Scope

Close the "agent runs `pnpm install` inside a worktree → MAIN_REPO `node_modules` symlinks corrupted" loop with two layers:

1. **Prevent**: PreToolUse hook in `step-runner.ts` blocks the install family of `pnpm`/`npm` invocations whenever the step's cwd is a sibling worktree (mirrors the shape of the existing MAIN_REPO write-block and `blockPlanPolish` hooks).
2. **Recover**: when the mid-cycle `ensureWorktreeDeps` guard sees the corruption signature (real `node_modules/` directory with a `.pnpm/` store inside), and lockfiles still match, replace it with a fresh symlink to MAIN_REPO. Logs the restore so it's visible.

### Out of scope

- Removing TOOL-52's ship-time repair (`repairMainNodeModules`). Defense in depth: ship-time stays as a third line behind hook + proactive restore.
- Blocking other `pnpm` subcommands (`test`, `exec`, `<script>`, `autopilot`). Only the install family touches `node_modules`.
- An opt-out / escape hatch on the block. Charter is explicit: no escape hatch needed; if a real use case emerges, add it then.
- Reverting or restructuring TOOL-52's `decideDepsAction` action types. The new variant is additive.
- Skill-body changes. The hook intercepts at the agent's Bash-tool layer; skill bodies are unaffected.

## Approach

### 1. PreToolUse hook helper (`blockWorktreeInstall`)

Extract a named, exported helper alongside `blockPlanPolish` in `step-runner.ts`. The helper is a pure function over `(input: HookInput) → HookJSONOutput`. The call-site in the existing PreToolUse closure invokes it under the same `isWorktree` guard that already governs the MAIN_REPO write-block.

Why a helper rather than inline:

- `blockPlanPolish` is precedent for "interesting branching logic gets a named export so it has unit tests."
- The match logic is regex-driven; rubric calls out that regex helpers (`parseResetTime`, `parseVerdict`, etc.) are failure-prone and need direct edge-case coverage.
- Keeps the PreToolUse closure short and readable.

Match logic — the charter specifies the exact regex:

```ts
const INSTALL_PATTERN =
    /\b(pnpm\s+(install|i|add|update|up|upgrade|remove|rm)|npm\s+(install|i|ci))\b/;
```

Single regex, anchored only by `\b` word boundaries — matches anywhere in the command so chained forms (`cd foo && pnpm install`) still trip it. The helper takes only `input`; cwd is irrelevant because the regex inspects the command string directly. The call site applies the `isWorktree` predicate.

Skip case: when the command contains both `worktree-deps` and `--repair-main`, allow it through. Naturally, the regex doesn't match the literal `npx @cdhorne/claude-autopilot worktree-deps --repair-main` invocation today (no `pnpm install` substring), but a chained agent command like `npx ... --repair-main && pnpm install` would match. Charter explicitly calls for the skip — implement it as `cmd.includes("worktree-deps") && cmd.includes("--repair-main")` and return `{}` (allow) before the install regex check fires.

The block reason explains the symlink share so the agent gets actionable feedback rather than just a refusal:

> Worktree-side `pnpm install` (or equivalent) is blocked: this worktree shares MAIN_REPO's `node_modules` via symlink, and a worktree-side install re-points the symlinks into the worktree's `.pnpm` store, which corrupts the main repo when the worktree is removed. If you genuinely need a dep change, raise it in your final message — dep updates are managed via Renovate / patch-bump cadence, not in-cycle.

Wiring at the call site (inside the existing `PreToolUse` closure, after the MAIN_REPO write-block branch and before `blockPlanPolish`):

```ts
if (isWorktree && tn === "Bash") {
    const out = blockWorktreeInstall(input);
    if (out.decision === "block") return out;
    // existing MAIN_REPO Bash-path check stays here
}
```

The existing `isWorktree && tn === "Bash"` block (which checks for absolute MAIN_REPO paths in the command string) stays untouched and runs after the install check; both can fire on the same command, but the install pattern is what the agent actually triggers in the corruption flow.

### 2. Proactive symlink restore — extend `decideDepsAction`

The current decision tree in `worktree-deps.ts:72-107`:

- Real dir at `worktree/node_modules` → `noop` (user-managed; never mutate)
- Symlink → `noop` / `relink` / `reinstall` based on target + lockfile match
- Absent → `link` / `install`

Extend the real-dir branch to detect the corruption signature and return a new `restore` action when it's safe to recover:

```ts
if (isRealDir(worktreeNm)) {
    const hasPnpmStore = existsSync(join(worktreeNm, ".pnpm"));
    if (hasPnpmStore && lockfilesMatch && mainNmReady) {
        return { type: "restore", target: mainNm };
    }
    return { type: "noop" };
}
```

The signature `real dir + .pnpm/ + lockfiles match + main nm ready` is precise:

- `.pnpm/` confirms it's a pnpm-managed install (not a user's manually-curated `node_modules` of unrelated content).
- `lockfilesMatch` confirms a symlink to MAIN_REPO/node_modules will yield functionally equivalent deps.
- `mainNmReady` confirms the symlink target exists.

When any of those fail (no `.pnpm/`, lockfile drift, or main missing), keep the current `noop` semantics — leave the dir alone, fall through to the existing mid-cycle warning.

Add a corresponding case in the `ensureWorktreeDeps` switch:

```ts
case "restore":
    rmSync(worktreeNm, { recursive: true, force: true });
    symlinkSync(action.target, worktreeNm, "dir");
    return action;
```

`rmSync` recursive is the load-bearing dangerous call; the comment on the case clause documents that the only path that reaches it requires the `.pnpm/` store presence (from `decideDepsAction`) — i.e. we're only deleting pnpm-managed dirs, never user data.

#### Known semantics change

If a user manually runs `pnpm install` inside an autopilot worktree (e.g. for local testing), the next mid-cycle guard pass will silently replace their install with a symlink. Their deps remain functionally equivalent (lockfiles matched → same `node_modules` content via symlink), so no data is lost — but the dir is no longer "theirs." Accept this: autopilot worktrees are short-lived and agent-owned by design; the user-driven install case is rare and the outcome is equivalent.

### 3. Mid-cycle guard wiring (`step-runner.ts:82-104`)

Update the existing block to surface the new action type:

```ts
const action = ensureWorktreeDeps(opts.cwd, REPO);
if (action.type === "restore") {
    emit({
        type: "sdk_error",
        message: "worktree node_modules was a real directory with .pnpm/ — restored symlink to MAIN_REPO (lockfiles match; recovered from worktree-side pnpm install)",
    });
}
if (action.type === "noop") {
    // Existing lockfile-drift detection: real dir + .pnpm/ but lockfiles
    // diverged, so restore isn't safe. Keep the existing warning.
    const wtNm = resolve(opts.cwd, "node_modules");
    try {
        const s = lstatSync(wtNm);
        if (s.isDirectory() && !s.isSymbolicLink() && existsSync(join(wtNm, ".pnpm"))) {
            emit({
                type: "sdk_error",
                message: "worktree node_modules became a real directory mid-cycle (pnpm install re-installed locally) and lockfile drift prevents safe restore; main repo will be repaired at ship time",
            });
        }
    } catch {}
}
```

Re-using `sdk_error` for both restore-success and lockfile-drift-warning matches the existing precedent on the same code path (the original "became a real directory mid-cycle" line already uses `sdk_error`, as does `worktree-deps guard failed`). There is no `info` event type today, and adding one is out of scope.

### Why this layering

- **Hook (prevent)** stops 99% of cases at source — the agent never gets to run the install.
- **Proactive restore (recover)** catches the residual cases where some indirect path (a Makefile target, a script that shells out via Node, a third-party tool) bypasses the hook. Cheap and silent when lockfiles still match.
- **TOOL-52's ship-time repair (last resort)** stays as defense in depth for the case where lockfiles drifted *and* the hook was bypassed.

## Files to change

| File | Change |
|---|---|
| `packages/autopilot/scripts/autopilot/worktree-deps.ts` | Add `existsSync` and `rmSync` to the `node:fs` import; extend `DepsAction` with `\| { type: "restore"; target: string }`; extend the `isRealDir` branch in `decideDepsAction` to return `restore` under the corruption-signature; add `case "restore"` to the `ensureWorktreeDeps` switch (rmSync + symlinkSync). |
| `packages/autopilot/scripts/autopilot/step-runner.ts` | Add and export `blockWorktreeInstall(input: HookInput): HookJSONOutput`; wire it into the existing `PreToolUse` closure under the `isWorktree && tn === "Bash"` branch; update the mid-cycle guard to log on `restore` and keep the existing warning on `noop`-with-corruption-signature. |
| `packages/autopilot/scripts/autopilot/__tests__/worktree-deps.test.ts` | Extend `makeSetup` with an optional `worktreePnpmStore?: boolean` to plant `.pnpm/` inside `worktree/node_modules`; add `decideDepsAction` cases (restore on corruption + lockfiles match; noop on corruption + lockfile drift; noop on real dir without `.pnpm/`); add an `ensureWorktreeDeps` test that asserts the dir is removed and the symlink recreated on `restore`. |
| `packages/autopilot/scripts/autopilot/__tests__/step-runner.test.ts` | Add a `describe("blockWorktreeInstall")` block covering: (a) blocks each pnpm install-family subcommand (install / i / add / update / up / upgrade / remove / rm); (b) blocks each npm install-family subcommand (install / i / ci); (c) allows `npx @cdhorne/claude-autopilot worktree-deps --repair-main`; (d) allows the chained escape `npx ... --repair-main && pnpm install`; (e) allows non-install pnpm/npm subcommands (`pnpm test`, `pnpm exec`, `pnpm autopilot`, `pnpm check`, `npm test`); (f) allows non-Bash tools; (g) handles missing `command` field gracefully; (h) blocks chained forms (`cd foo && pnpm install`). |

No changes to: skill bodies, config.ts, pipeline.ts, types.ts (the `restore` variant rides under the existing `DepsAction` union — pure widening), or any roadmap/doc files beyond this plan.

## Test strategy

`npx tsx --test --test-reporter=dot packages/autopilot/scripts/autopilot/__tests__/{worktree-deps,step-runner}.test.ts` covers the new logic. Existing tests in those files stay green — both changes are additive (new `DepsAction` variant, new exported helper).

The hook helper tests are pure-function calls — no fs setup. The `decideDepsAction` and `ensureWorktreeDeps` extensions reuse the existing `makeSetup` pattern with one new option.

The "hook allows `pnpm install` from MAIN_REPO cwd" property called out in the charter is enforced at the call site (`if (isWorktree && tn === "Bash")`), already covered by the existing `isWorktreePath` tests, and `blockWorktreeInstall` itself is correctly cwd-agnostic. No additional integration test is needed.

Verification commands (per rubric):

```bash
npx tsx --test --test-reporter=dot packages/autopilot/scripts/autopilot/__tests__/*.test.ts
npx tsx -e "import('./packages/autopilot/scripts/autopilot/step-runner.ts')"
npx tsx -e "import('./packages/autopilot/scripts/autopilot/worktree-deps.ts')"
pnpm check
```

## Rubric self-check

- **Well-typed**: `DepsAction` widened with a fully-typed variant; the `ensureWorktreeDeps` switch stays exhaustive (TS catches a missing case). `blockWorktreeInstall` has explicit `(HookInput) → HookJSONOutput` signature. No `any`, no casts.
- **Well-tested**: Helper has edge-case unit coverage (every subcommand in the regex, escape hatch, false-positive-prone scripts like `pnpm install:foo` accepted as known limitation). Restore decision and side effect both tested against fs setup.
- **Well-factored**: Decision in `decideDepsAction` (pure), side effect in `ensureWorktreeDeps` (impure) — preserves existing module split. Hook helper in `step-runner.ts` — same place as `blockPlanPolish`. No new files; no skill changes; no config changes.
- **Concise**: ~25 lines of production code, ~70 lines of tests. No new abstractions, no future-proofing config knobs, no event-type additions.
- **Correct**:
  - Worktree isolation invariant: hook only fires under existing `isWorktree && tn === "Bash"` guard. ✓
  - Plan-polish and MAIN_REPO write-block hooks unaffected (additive insertion). ✓
  - Restore action's deletion is gated by the `.pnpm/` signature in `decideDepsAction`, so `rmSync` only ever targets a pnpm-managed dir. ✓
  - Step exhaustiveness, frontmatter stripping, phantom ship guard, rate-limit parking — none touched. ✓
  - No hardcoded model strings. ✓
- **Idioms**: deferred to `/shakedown` per repo convention.

### Self-review changes

(none — the first draft survived self-review without revisions)

### Shakedown-plan changes

- Dropped the unused `cwd` parameter from `blockWorktreeInstall`. The "shape parity with `blockPlanPolish`" justification doesn't hold — `blockPlanPolish` uses cwd to resolve relative file paths, but the install helper inspects the command string directly and has no need for cwd. Carrying an unused arg violates the Concise dimension's YAGNI guidance. New signature: `blockWorktreeInstall(input: HookInput): HookJSONOutput`. Call site simplifies to `blockWorktreeInstall(input)`.
