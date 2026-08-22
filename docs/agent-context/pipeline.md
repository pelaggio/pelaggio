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

### Claude SDK seat isolation (#557)

Every Claude `query()` call preflights a host `bwrap` and then supplies an unconditional `spawnClaudeCodeProcess` adapter. The SDK child starts under `--unshare-pid` plus a fresh `/proc`, `--new-session`, and `--dev-bind / /`, with each configured harness-only socket parent (`HARNESS_ONLY_SOCKET_ENVS`, initially `PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET`) masked by `--tmpfs`. The detached session prevents access through the harness controlling terminal while piped SDK stdio remains intact. The device-capable root bind preserves required nodes such as `/dev/null` and `/dev/urandom`; Bubblewrap's ordinary `--bind / /` would remount them `nodev`. The host network namespace stays shared so the CLI can reach Anthropic. Missing Bubblewrap, a non-Linux host, a malformed or wide locator, or a namespace setup failure refuses the step as `error_confinement`. There is no unisolated fallback.

The #369 session record binds the **outer** Bubblewrap PID (host-visible, `comm=bwrap`, Node-spawn cwd = SDK cwd), not the namespaced child. Do not bypass this adapter, gate it on `onChildSpawn`, or report an inner PID. This wrapper is not Landlock and is not the ADR-0023 contained-execution jail.

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

## PR-only pre-ship tail (#424)

After the phantom-ship guard and only for `pull-request` / `auto-merge-pr` (never `direct-push`, never dry-run), the pipeline runs two bounded tail phases that are **not** additions to `STEPS` or the step-indexed config maps:

1. **Freshness.** `preparePrShipFreshness()` fetches `origin/main` and classifies the claim worktree. Outcomes are `up-to-date` / `merged` / `content-integrated` / `conflicted` / `failed`. A parked unresolved merge is dirty-with-`MERGE_HEAD`; resume treats that as `conflicted`, not generic dirty `failed`. The merge is never aborted or cleaned; the only reset is the harness rolling back its own failed-probe `ours` merge commit (below). When plumbing `diff-tree` (`-r --name-only -z --no-renames`, unique merge-base) proves the complete net-upstream write-set is already tree-entry equivalent at `HEAD`, the harness records ancestry with a tree-preserving `-s ours` merge — the whole proof and every probe bound to the HEAD commit OID captured up front and executed with replace refs disabled (`GIT_NO_REPLACE_OBJECTS`, so a planted `refs/replace/*` entry cannot fake equivalence) — then requires the merge commit to sit exactly on the captured OID (first parent), carry the fetched OID as its second parent, preserve the captured tree, and make the fetched OID an ancestor. That is `content-integrated`, and it skips `shakedown-code` (the proven feature tree did not change). A failed post-merge probe fails closed AND rolls the branch back to the merge's own first parent (`reset --keep`, only when HEAD is recognizably the harness's own ours merge), so a resume cannot launder the refused ancestry through `up-to-date`. Incomplete proof (ambiguous base, unreadable diff-tree) skips the shortcut and uses the ordinary host merge rather than failing the cycle. Only genuine content differences take that ordinary merge; both `merged` and `conflicted` route through the realized implementation author (`runImplementationAuthorRepair`) — `merged` once to verify the auto-merge, while a genuine `conflicted` state gets **one** max-turns attempt per cycle. The harness then runs `pnpm typecheck:ratchet` and `verifyPrShipFreshness()` (clean, no `MERGE_HEAD`, fetched `origin/main` OID ancestor of `HEAD`). A red typecheck, failed verification, post-`ours` tree/ancestry failure, incomplete one-pass conflict repair, refusal, or confinement ends the cycle without ship. Rate limits use `parkExit()` so conflicted/resolved work is checkpointed — and `checkpoint()` itself refuses to conclude an open `MERGE_HEAD` whose to-be-committed files still carry conflict-marker lines (the mid-repair `git add`-then-rate-limit interleave): the tree parks dirty-with-`MERGE_HEAD` instead, which is the documented resume contract. Gate completion is recorded per head SHA, but that trust is **in-process only** (#511): the on-disk `.dev/freshness-gate-records/` store is observability, and a cross-process resume always re-runs the deterministic gates.
2. **Cold pre-flight.** The real `runPrReviewGate()` core runs from per-invocation detached seats (`prepareAuthoringReviewSeat`, unique `seatId` per driver/verify call) over `origin/main...<artifact-sha>` with `skillArguments: "--preflight"` and no comment/status callbacks. A valid survivor BLOCK (`ok`, `survivorCount > 0`, `consensus-block`/`disagreement`) gets one author revision — followed by a re-run of the deterministic `typecheck:ratchet` backstop, so a type-breaking revision cannot open the PR — and one newly SHA-bound recheck. Remaining findings or an infrastructure-invalid BLOCK are advisory — the PR may still open; the required forge gate is the merge authority. Pre-flight `review.cost` is added once per gate call; nested discovery/verify `step()` rows log but do not double-count. Seat SHAs are cleaned on PASS, BLOCK, throw, and park. `startFrom: "ship"` reconstructs the implementation author (log, else static fallback) before these repairs.

Cold-seat confinement matches `#269` and is read-only end to end: the gate's diff source (harness inspection diff + the seats' trusted local context) is its own detached data-only checkout of the reviewed SHA — never the live claim worktree — reviewer seats carry **no** own-worktree Write/Edit grant over the claim worktree (it stays a denied foreign root), and each gate call is bracketed by a claim-worktree HEAD `rev-parse` compare that fails the cycle on any movement (a clean commit is invisible to the porcelain confinement snapshot). The adapter fail-closes a seat-prepare error as a typed failed `StepResult`, and a diff-source prepare error as an advisory infra BLOCK, rather than reviewing the live worktree.

## Effects Manifests

Step-boundary harness effects use `.dev/effects/<run-id>/<step>-<attempt>.json`. The manifest envelope includes `schemaVersion`, `runId`, `itemId`, `step`, `attempt`, `cwd`, `preSha`, and an ordered `effects` array. `effects.ts` validates the schema and rejects stale or foreign manifests by exact provenance match; `cwd` is compared by resolved path and `preSha` must match exactly, including `null`.

Current implemented kinds are `checkpoint` and `plan.publish`. Reserved vocabulary exists for `ship.ShipDecision`, `pick.explainSelection`, and `shakedown.deferredItems`, but those kinds have no handlers yet and therefore fail closed if emitted.

Confinement has two tiers. By default, main and sibling Git roots are snapshotted across the whole step. With `confinement.allow-dirty-main`, siblings retain that hard gate while main uses provider-specific protection for item-worktree steps: Claude brackets every allowed mutating tool with Git-state snapshots, and Codex's workspace-write sandbox excludes main. Attribution errors and tool-window deltas become `error_confinement`; unchanged operator dirtiness between windows is allowed. Main-cwd steps remain exempt from auditing their legitimate cwd. Simultaneous operator changes inside a tool window are conservatively attributed, and detached/background writes after the post hook are outside the attribution window.

Whole-step Git snapshot **execution** may be retried a fixed number of times as confirmation of transient audit interference (shared `index.lock`, WSL2 races). Only runner/Git throws are retried — a successful dirty porcelain is never re-polled away as "maybe transient." A forbidden root proven **absent**, or proven to be only a **non-repository directory shell** (Git's explicit `fatal: not a git repository` diagnostic **and** no `<root>/.git` entry — e.g. `worktree remove` left an empty path), maps to the typed `FORBIDDEN_ROOT_GONE` sentinel at either snapshot endpoint and is skipped by the endpoint-aware diff (#330, #339). All other failures on a still-present root — including the identical non-repository diagnostic when `.git` still exists (permissions / residual gitdir) — retain bounded retry and become `error_confinement`, distinct from a proven status delta (`forbidden root changed during …`). The cycle step log carries the pipeline-selected diagnosis independently of verbose transcript output: `errorDetail` holds the full text (root list / Git stderr), and `outputTail` holds the bounded first-200-char display form used by `finish()` detail and `/stats` recent-failures.

**Probe timing (#388).** A before-phase audit problem (root enumeration or snapshot execution failure) fails closed **before the provider ever runs** — no step spend is incurred classifying a tree that is already untrustworthy as a clean baseline. While the provider call is in flight, a periodic prober (`CONFINEMENT_PROBE_INTERVAL_MS`, default 15s, `PipelineDeps.confinementProbeIntervalMs` in tests) re-snapshots the same forbidden roots and applies the identical #369 eligibility classification the end-of-step diff uses — a probe never trips on a write the end-of-step diff would have excluded as a live peer. A real (non-excluded) mid-step violation cancels the in-flight provider call through a step-scoped `AbortController` composed with (not replacing) the external SIGINT signal — the same signal/driver boundary every provider already tears its child process down through — and the pipeline awaits confirmed settlement of that call before classifying. This bounds a mid-step violation's cost to roughly one probe interval instead of the whole step (previously observed as high as ~$39). A mid-step trip is a fail-closed **early abort**, never `parkExit()`: `error_confinement` is already outside `RECOVERABLE_ERRORS` (see Parking below), and a park's checkpoint would durably commit a tree already proven contaminated, with `--resume` re-entering "fresh" onto it per [ADR-0019](../decisions/0019-checkpoint-restart-not-replay.md) — auto-resume would re-burn spend against state already known compromised. A declared write-set (#173, design-only — see `coordination-spine.md`) must only ever *attribute* a root's mutation for diagnostics if it lands; it must never *exempt* a root from this snapshot — the precedent is that authoring-review seats are deliberately passed without `ownWorktree` for the identical reason (an exempted write-set would recreate the same blind spot).

Under `--parallel` (#131), concurrent cycles overlap their audit windows, so one cycle's whole-tree snapshot would otherwise flag a *peer's* legitimate self-write. A run-scoped **active-worktree registry** (`PipelineOpts.activeWorktrees`, threaded from `runOrchestrator` alongside `pickMutex`) resolves this without serialization: each cycle registers its resolved worktree path once the tree is known and deregisters on every `finish()` exit, and `forbiddenRootsForStep` exempts every registered peer. Forbidden roots therefore reduce to `mainRepo` (still hard-gated, subject only to `allow-dirty-main`) plus *inactive/stale* sibling worktrees. This is a deliberate trade-off: the whole-tree snapshot cannot detect one active cycle corrupting another active peer's tree — cross-tree writes are the capability/write-set boundary's job, not the snapshot's. Serial runs and direct `runPipeline()` callers get no in-memory registry (no in-process peers to exempt).

**Cross-process peers (#369):** a separate gitignored session-record registry under `MAIN_REPO/.dev/sessions/` covers concurrent pelaggio *invocations* (not just `--parallel` workers in one process). Each cycle writes an atomic record `{sessionId, claimedItem, claimBranch, worktreePath, pid, expiresAt}` once the item worktree is known; Claude refreshes `pid` to the outer Bubblewrap wrapper (host-visible, `comm=bwrap`, cwd is the SDK worktree) via the unconditional `spawnClaudeCodeProcess` seat adapter and heartbeats expiry independently of step cadence; Codex/Grok still register so inventory fallback works, but do not manufacture unverifiable binding PIDs. At each step start the evaluator resolves eligible peers with one fail-closed predicate: Git claim validation (registered worktree + exact claim branch attributing to the item via `claimedIds`-style prefix rules) plus either (a) Linux `/proc` binding — child cwd inside the worktree and kernel `starttime` jiffies before the evaluator's captured `/proc/self/stat` watermark — or (b) exact immutable identity match against the run-start inventory (pid/expiry refresh does not disqualify). At diff time the same predicate revalidates a changed sibling: still-eligible peers warn and suppress; missing/expired/identity-mutated/later-started decoys park. `mainRepo` is filtered twice (resolver + `forbiddenRootsForConfinement`) and never exempt via records. Compensating semantic hook `blockForeignRootWrite` denies Write/Edit into main and every known foreign worktree root (including from main-cwd shipwreck when `ownWorktree` is threaded) and always denies `.dev/sessions/` so agents cannot forge evidence; Bash remains outside the semantic hook (existing main-repo string guard only). Threat model: exclusions prove a pre-existing same-user process is resident in a claimed worktree (or a pre-start inventory match), not ownership. `/tidy` sweeps content-expired orphans via `npx pelaggio sessions-sweep`.

Timing has two tiers. Checkpoint effects preserve work on any non-confinement outcome, including `error_max_turns` and park paths, so retries continue from committed disk state. Stateful effects such as `plan.publish` dispatch only after a successful, non-parked, non-dry-run step. For migrated plan/implement behavior the harness synthesizes the manifest from declared effects, validates it, dispatches handlers in order, and deletes it after dispatch.

Manifest **validation** is fail-closed: an unknown kind, a provenance/`preSha` mismatch, or a malformed manifest raises `EffectsManifestError`, surfaces as `error_effects_manifest`, and leaves the manifest on disk for diagnosis — never a silent skip. An individual **handler**, by contrast, owns its own failure policy. `plan.publish` is best-effort (#98 parity): the plan is already committed locally and the implement prompt reads it from disk, so a missing file or a transient roadmap/API error is logged and the step still succeeds. An *unexpected* exception from any handler still fails closed (`error_effects_manifest`, manifest retained).

## Parking

Every pipeline exit path must call `parkExit()` (which checkpoints uncommitted work) before returning on rate-limit rejection, so work is checkpointed before the process exits or waits. This matters for subscription-backed providers whose retry windows are outside the pipeline's control.

Parks come in two families and the cycle log records both. *Signal-driven* parks
(rate limit, operator `SIGUSR2` pause, sustained SDK outage) carry a structured
`parkSignal.limitType`; *review-loop* parks pass an explicit reason string to
`parkExit(reason)`. Only the former used to reach the log, so every review-gate
park persisted `parkReason: null` and a park's cause was unrecoverable after the
fact. `parkExit()` now retains the reason and the log record carries both the
free-form `parkReason` detail and a closed `parkClass` (`classifyParkReason` in
`helpers.ts`) that `pelaggio stats` groups on. `limitType` wins when present.
Records written before classification existed report as `unrecorded` in stats
rather than being folded into a real class.

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

Auto-pick campaigns can run past a fixed `--cycles` count via drain/watch presets (`--continuous` / `--preset drain|watch`). Before each pick the orchestrator **free-probes** the ready queue (`listItems` + FlowPolicy — no pick agent) under a **continuous gate** (serial probe/revise/idle; gate released before paid cycles so `--parallel N` can overlap work): **drain** exits on empty; **watch** sleeps `--probe-interval` and re-probes. Day-budget precedence: CLI `--day-budget` > `watch.daily-budget` > unlimited. Drain hard-stops on day-budget exhaustion; watch budget-idles until local midnight then wakes. Day spend is durable without a state file (#398): on every continuous **process start** the tracker is seeded by summing today's local-calendar `total_cost` from the `.dev/pelaggio-log.jsonl` cycle log (`sumDaySpendFromLog`), and local-review charges append a `budgetCharge` receipt line (filtered from `/stats`) so review spend survives a restart. Lifecycle events (`watch-idle|wake`, `budget-idle|wake`, catalog `suspended|resumed`) write to `.dev/flow-events/`. Continuous mode re-runs the local revise sweep **per iteration**. No `--item` / `--resume` / `--no-worktree`. Server/UI: #83. See `docs/config.md` § Continuous mode.
