# Pipeline Context

The pipeline sequence is:

```text
pick -> plan -> shakedown-plan -> implement -> shakedown-code -> ship
```

`shipwreck` and `pr-review` are first-class configured steps but are not normal pipeline stages. Both live in `Step`/`ALL_STEPS` and every `Record<Step, T>` map, yet are absent from `STEPS`/`PipelineStep`, so they carry first-class budget/turns/effort/model config without affecting pipeline sequencing.

## Step Configuration

`STEPS`, `ALL_STEPS`, defaults, model profiles, effort, turn limits, budgets, and providers are defined in `packages/pelaggio/scripts/pelaggio/config.ts`.

`STEPS` is the source of truth. Adding a step requires updating every step-indexed map — `BUDGETS`, `TURN_LIMITS`, `EFFORT`, and every `MODEL_PROFILES[profile]` entry — plus the relevant tests. Missing keys crash late, so fail loudly.

No model strings live outside `MODEL_PROFILES`. No other file references `claude-opus-*` / `claude-sonnet-*` literals; skill and template markdown are linted for pinned IDs by `check-skills` (`model-id.hardcoded`, matching the closed `claude-(opus|sonnet|haiku|fable)-<digit>` family). `bump-models` is exempt wholesale because documenting those IDs is its purpose.

## Step Providers

`packages/pelaggio/scripts/pelaggio/step-runner.ts` exposes the `StepProvider` seam. The default registered provider is `claude`. Issue `#80` adds `codex`.

Important contracts:

- `runStep` is the dispatcher.
- Providers normalize their backend into `StepResult`.
- `StepResult.subtype` remains telemetry; pipeline control flow should use classification helpers for closed decision sets.
- Provider selection resolves per step from `.pelaggio.yml` model profiles.

## Worktree Isolation

Normal cycles run in sibling git worktrees. Mutating operations must target the worktree, not the main repo.

`step-runner` installs PreToolUse hooks that block writes to `MAIN_REPO` paths when running in a worktree, preventing sibling-worktree corruption. Do not bypass this.

Claude currently gets SDK hook enforcement plus system prompt guidance. Codex support must preserve the invariant through its sandbox and post-step checks.

### Worktree dependency sharing

Worktrees share `MAIN_REPO`'s `node_modules` when lockfiles match — by symlink for external deps, by materialized real-dir for workspace-internal deps. `worktree-deps.ts` owns that layout and repair logic; `/pick`'s Claim step and a mid-cycle guard at the top of every worktree-cwd step call it. Do not run package installs casually inside a worktree.

- If `<worktree>/pnpm-lock.yaml` sha256 matches `<MAIN_REPO>/pnpm-lock.yaml` **and** MAIN's `node_modules` has workspace-internal entries, the worktree gets a real `node_modules/` whose entries are absolute symlinks: workspace packages → `<worktree>/<pkg>` (so cross-package source edits resolve to the worktree copy), everything else (`.pnpm/`, `.bin/`, external deps) → `<MAIN>/node_modules/...` (preserving the shared store). Same shape applies per subpackage.
- Without workspace entries, the simpler symlink-the-whole-dir path runs (`<worktree>/node_modules → <MAIN_REPO>/node_modules`).
- On drift or missing main `node_modules`, it falls through to `pnpm install --frozen-lockfile --silent`.
- Materialize is idempotent. The real-dir vs symlink test is `lstatSync().isSymbolicLink()`; the pnpm-store presence test is `isRealDir(.pnpm)` (lstat-based, **not** `existsSync`, which would follow the post-materialize symlink and falsely re-flag corruption). Real, user-managed `node_modules` without pelaggio's emitted shape is left alone.

## Plan-Polish Guard

During `implement`, files under `docs/plans/` are read-only. The step must execute the plan by changing code or docs outside the plan artifact. Only `plan` and `shakedown-plan` may write there.

Claude enforces this with a PreToolUse hook (`blockPlanPolish`) rejecting Write/Edit under `docs/plans/`. Codex support needs a provider-compatible backstop that also catches committed changes.

### Self-referential roadmap guard (#74)

The review-time sibling of plan-polish lives in `/shakedown`'s code-review mode: a soft flag (fix-now, not a hard block) on any implement diff that edits the item's **own** row in `docs/roadmap-*.md` / `docs/task-index.md`. That row's lifecycle is owned by ship's mutation-lock-serialized `markDone`, so an implement-time strike-through signals premature completion and would no-op the ship-tail bookkeeping. It is a soft flag rather than a hook because the offending edit may arrive via a committed feature-branch commit, and it needs the item's own ID to distinguish self-bookkeeping from a legitimate `create-item` row for a *different* item.

## Hook Reachability (Claude SDK)

- **PreToolUse hooks don't see Task tools** (`@anthropic-ai/claude-agent-sdk` ≥ 0.3.142): `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` bypass PreToolUse + PostToolUse entirely. The guardrails above only govern filesystem-mutating tools (Write/Edit/Bash), so the bypass is benign — but do not assume a hook can reach Task tools.
- **Permission mode is `canUseTool` allow-all, not `bypassPermissions`**: the SDK hardcodes a deny for writes to `.claude/skills/**` that survives `permissionMode: "bypassPermissions"` and `allowDangerouslySkipPermissions: true`. Only a `canUseTool` callback unlocks skill edits (TOOL-27). `step-runner` uses `canUseTool: () => ({ behavior: "allow" })`; PreToolUse hooks still fire after the allow, so isolation/plan-polish guardrails are unaffected. See `docs/notes/tool-27-silent-edit-failures.md`.

## Phantom-Ship Guard

`pipeline.ts` calls `hasDeliverableCommits()` before invoking `ship`. A cycle whose branch only touches `docs/plans/` (the `/plan` artifact with no implementation) is flagged `completed: false` with a "nothing to ship" error, and ship is never invoked. Doc-only work outside `docs/plans/` (rubric, skill bodies, README, roadmap edits) is still deliverable. The identical guard inside `/ship`'s SKILL.md is defense in depth for inline use.

## Parking

Every pipeline exit path must call `parkExit()` (which checkpoints uncommitted work) before returning on rate-limit rejection, so work is checkpointed before the process exits or waits. This matters for subscription-backed providers whose retry windows are outside the pipeline's control.

Issue `#80` relies on conservative rate-limit waits when Codex does not report an exact reset time.

**Sustained SDK outage (#128)**: a single `"transient sdk error"` cycle (retries exhausted, see #127) stays recoverable so the worker keeps pulling — a blip shouldn't stall a run. `runOrchestrator` tracks consecutive `"transient sdk error"` cycle outcomes (reset by any other outcome); at `CONSECUTIVE_TRANSIENT_ERROR_LIMIT` in a row it relabels the tripping cycle's error to `"parked"` (`limitType: "sdk-outage"`, `resetsAt: 0`) so it pages and flows through the same park-and-resume path as a rate-limit park. `resetsAt: 0` means it can't auto-resume by time — like a manual `SIGUSR2` pause, it hands back with a `--resume` hint instead of waiting.
