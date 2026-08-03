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

`packages/pelaggio/scripts/pelaggio/step-runner.ts` exposes the `StepProvider` seam. The default registered provider is `claude`. Issue `#80` adds `codex`; `#136` adds `grok` (ACP), and `#137` adds `opencode` as a headless `run --format json` peer alongside Codex.

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
- Materialize is idempotent, including rematerializing a pelaggio-owned layer when MAIN gains entries after the worktree snapshot. The real-dir vs symlink test is `lstatSync().isSymbolicLink()`; the pnpm-store presence test is `isRealDir(.pnpm)` (lstat-based, **not** `existsSync`, which would follow the post-materialize symlink and falsely re-flag corruption). Real, user-managed `node_modules` without pelaggio's emitted shape is left alone.

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

## Effects Manifests

Step-boundary harness effects use `.dev/effects/<run-id>/<step>-<attempt>.json`. The manifest envelope includes `schemaVersion`, `runId`, `itemId`, `step`, `attempt`, `cwd`, `preSha`, and an ordered `effects` array. `effects.ts` validates the schema and rejects stale or foreign manifests by exact provenance match; `cwd` is compared by resolved path and `preSha` must match exactly, including `null`.

Current implemented kinds are `checkpoint` and `plan.publish`. Reserved vocabulary exists for `ship.ShipDecision`, `pick.explainSelection`, and `shakedown.deferredItems`, but those kinds have no handlers yet and therefore fail closed if emitted.

Confinement has two tiers. By default, main and sibling Git roots are snapshotted across the whole step. With `confinement.allow-dirty-main`, siblings retain that hard gate while main uses provider-specific protection for item-worktree steps: Claude brackets every allowed mutating tool with Git-state snapshots, and Codex's workspace-write sandbox excludes main. Attribution errors and tool-window deltas become `error_confinement`; unchanged operator dirtiness between windows is allowed. Main-cwd steps remain exempt from auditing their legitimate cwd. Simultaneous operator changes inside a tool window are conservatively attributed, and detached/background writes after the post hook are outside the attribution window.

Whole-step Git snapshot **execution** may be retried a fixed number of times as confirmation of transient audit interference (shared `index.lock`, WSL2 races). Only runner/Git throws are retried — a successful dirty porcelain is never re-polled away as "maybe transient." A forbidden root proven **absent**, or proven to be only a **non-repository directory shell** (Git's explicit `fatal: not a git repository` diagnostic **and** no `<root>/.git` entry — e.g. `worktree remove` left an empty path), maps to the typed `FORBIDDEN_ROOT_GONE` sentinel at either snapshot endpoint and is skipped by the endpoint-aware diff (#330, #339). All other failures on a still-present root — including the identical non-repository diagnostic when `.git` still exists (permissions / residual gitdir) — retain bounded retry and become `error_confinement`, distinct from a proven status delta (`forbidden root changed during …`). The cycle step log carries the pipeline-selected diagnosis independently of verbose transcript output: `errorDetail` holds the full text (root list / Git stderr), and `outputTail` holds the bounded first-200-char display form used by `finish()` detail and `/stats` recent-failures.

Under `--parallel` (#131), concurrent cycles overlap their audit windows, so one cycle's whole-tree snapshot would otherwise flag a *peer's* legitimate self-write. A run-scoped **active-worktree registry** (`PipelineOpts.activeWorktrees`, threaded from `runOrchestrator` alongside `pickMutex`) resolves this without serialization: each cycle registers its resolved worktree path once the tree is known and deregisters on every `finish()` exit, and `forbiddenRootsForStep` exempts every registered peer. Forbidden roots therefore reduce to `mainRepo` (still hard-gated, subject only to `allow-dirty-main`) plus *inactive/stale* sibling worktrees. This is a deliberate trade-off: the whole-tree snapshot cannot detect one active cycle corrupting another active peer's tree — cross-tree writes are the capability/write-set boundary's job, not the snapshot's. Serial runs and direct `runPipeline()` callers get no in-memory registry (no in-process peers to exempt).

**Cross-process peers (#369):** a separate gitignored session-record registry under `MAIN_REPO/.dev/sessions/` covers concurrent pelaggio *invocations* (not just `--parallel` workers in one process). Each cycle writes an atomic record `{sessionId, claimedItem, claimBranch, worktreePath, pid, expiresAt}` once the item worktree is known; Claude refreshes `pid` to the SDK child via `spawnClaudeCodeProcess` and heartbeats expiry independently of step cadence; Codex/Grok still register so inventory fallback works, but do not manufacture unverifiable binding PIDs. At each step start the evaluator resolves eligible peers with one fail-closed predicate: Git claim validation (registered worktree + exact claim branch attributing to the item via `claimedIds`-style prefix rules) plus either (a) Linux `/proc` binding — child cwd inside the worktree and kernel `starttime` jiffies before the evaluator's captured `/proc/self/stat` watermark — or (b) exact immutable identity match against the run-start inventory (pid/expiry refresh does not disqualify). At diff time the same predicate revalidates a changed sibling: still-eligible peers warn and suppress; missing/expired/identity-mutated/later-started decoys park. `mainRepo` is filtered twice (resolver + `forbiddenRootsForConfinement`) and never exempt via records. Compensating semantic hook `blockForeignRootWrite` denies Write/Edit into main and every known foreign worktree root (including from main-cwd shipwreck when `ownWorktree` is threaded) and always denies `.dev/sessions/` so agents cannot forge evidence; Bash remains outside the semantic hook (existing main-repo string guard only). Threat model: exclusions prove a pre-existing same-user process is resident in a claimed worktree (or a pre-start inventory match), not ownership. `/tidy` sweeps content-expired orphans via `npx pelaggio sessions-sweep`.

Timing has two tiers. Checkpoint effects preserve work on any non-confinement outcome, including `error_max_turns` and park paths, so retries continue from committed disk state. Stateful effects such as `plan.publish` dispatch only after a successful, non-parked, non-dry-run step. For migrated plan/implement behavior the harness synthesizes the manifest from declared effects, validates it, dispatches handlers in order, and deletes it after dispatch.

Manifest **validation** is fail-closed: an unknown kind, a provenance/`preSha` mismatch, or a malformed manifest raises `EffectsManifestError`, surfaces as `error_effects_manifest`, and leaves the manifest on disk for diagnosis — never a silent skip. An individual **handler**, by contrast, owns its own failure policy. `plan.publish` is best-effort (#98 parity): the plan is already committed locally and the implement prompt reads it from disk, so a missing file or a transient roadmap/API error is logged and the step still succeeds. An *unexpected* exception from any handler still fails closed (`error_effects_manifest`, manifest retained).

## Parking

Every pipeline exit path must call `parkExit()` (which checkpoints uncommitted work) before returning on rate-limit rejection, so work is checkpointed before the process exits or waits. This matters for subscription-backed providers whose retry windows are outside the pipeline's control.

Driver assignment is decided in the harness before `plan`, `implement`, and
their ordinary shakedown reviews execute. Ordered pools rotate deterministically
within a cycle; readiness is preflight-only, and an in-flight failure still uses
the normal checkpoint-and-park path rather than failing over. Every new step log
records the realized provider and effective provider-specific model. Downstream
reviews exclude the recorded artifact author; resumed reviews reconstruct that
identity from successful item log entries and fail closed when legacy logs do
not contain attribution. The adversarial authoring loop keeps its separate
role-bearing reviewer and Judge configuration.

Issue `#80` relies on conservative rate-limit waits when Codex does not report an exact reset time.

**Sustained SDK outage (#128)**: a single `"transient sdk error"` cycle (retries exhausted, see #127) stays recoverable so the worker keeps pulling — a blip shouldn't stall a run. `runOrchestrator` tracks consecutive `"transient sdk error"` cycle outcomes (reset by any other outcome); at `CONSECUTIVE_TRANSIENT_ERROR_LIMIT` in a row it relabels the tripping cycle's error to `"parked"` (`limitType: "sdk-outage"`, `resetsAt: 0`) so it pages and flows through the same park-and-resume path as a rate-limit park. `resetsAt: 0` means it can't auto-resume by time — like a manual `SIGUSR2` pause, it hands back with a `--resume` hint instead of waiting.

## Continuous mode (#82)

Auto-pick campaigns can run past a fixed `--cycles` count via drain/watch presets (`--continuous` / `--preset drain|watch`). Before each pick the orchestrator **free-probes** the ready queue (`listItems` + FlowPolicy — no pick agent): **drain** exits on empty; **watch** sleeps `--probe-interval` and re-probes. A `--day-budget` hard-stops calendar-day spend. Continuous mode re-runs the local revise sweep **per iteration** (not only at campaign start). Serial auto-pick only (no `--item` / `--resume` / `--parallel > 1`). Server/UI surface is #83. See `docs/config.md` § Continuous mode.
