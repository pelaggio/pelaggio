# TOOL-39 — Autopilot control-plane daemon (Hono + systemd)

## Scope

Fill in the `packages/server/` placeholder with a Hono daemon that exposes the autopilot pipeline as an HTTP control plane. The daemon runs as a systemd user unit on the beefy box where autopilot already lives, binds to the tailnet IP, and supervises `pnpm autopilot` children. It replaces SSH-over-Tailscale kickoffs and makes runs survive operator disconnects.

**In scope:**
- `packages/server/` filled in: Hono app, supervisor, flat-file state store, SSE log streaming, `infra/systemd/autopilot-server.service`, `.github/workflows/deploy-server.yml`, `docs/server.md`.
- Pipeline change: one additional signal handler in `runOrchestrator()` so `SIGUSR2` parks via the existing `parkSignal` path. Small, surgical, unit-tested.
- Re-export `getRoadmapSource` and a pure `computeStats` from `@cdhorne/claude-autopilot` so the server consumes them without shelling out or duplicating logic.

**Out of scope (owned by later tickets):**
- Web UI (TOOL-42).
- Cloudflare Tunnel + bearer enforcement (TOOL-43). The middleware *hook* lands here as a no-op-unless-env-set, but no tunnel infra and no live token yet.
- Push notifications, metrics export, multi-user auth, cross-machine coordination, JSONL schema changes.

---

## Approach

### Why a dedicated long-running process instead of a one-shot CGI-style handler

Autopilot cycles run for minutes-to-hours. The daemon needs to retain child PIDs, broadcast stdout live to multiple SSE subscribers, and track run state across HTTP requests. A long-lived Hono process on systemd is the simple, boring, production-proven shape — matches fathom's `apps/server` and what the existing `.github/workflows/autopilot-fix.yml` already sets up.

### Why shell out to `pnpm autopilot`, not import `run()` in-process

The daemon's responsibilities (HTTP, supervision, log fan-out) differ from the pipeline's (SDK streaming, checkpointing, worktree ops). Running cycles as subprocesses keeps:
- Signal isolation — daemon can SIGUSR2/SIGINT a single run without disturbing others or itself.
- Parallelism — `--parallel` already works as a child flag; the daemon doesn't re-invent concurrency.
- Crash isolation — a bad SDK state in one cycle can't topple the control plane.
- Log capture — child stdout is already the canonical live-output surface.

The daemon still *imports* pure helpers from `@cdhorne/claude-autopilot` (`loadConfig`, `getRoadmapSource`, `computeStats`) for operations that don't need a subprocess.

### Why flat JSON state, not libSQL

CLAUDE.md calls out: "ephemeral state is the git tree + JSONL log." Run metadata is tiny (ulid, pid, item, timestamps, log path, exit code — ~200 bytes per run) and non-critical: systemd restart + PID liveness check rebuilds it. Drizzle + libSQL would be schema-migration overhead for no win. A single JSON file at `.dev/server-state.json` with atomic write (temp + rename) is sufficient.

### Why SIGUSR2 for pause, SIGINT for stop

The open question asked: reuse `parkExit()` or add a new pause flag? Reuse `parkExit()`. The pipeline already has a battle-tested work-preserving exit path driven by `parkSignal.parked`. A new handler inside `runOrchestrator()` catches `SIGUSR2`, sets the same three fields the rate-limit handler sets (with `limitType: "paused"`, `resetsAt: 0`), and the existing step-boundary `parkExit()` call checkpoints and returns `error: "parked"`. The orchestrator's "waitMs ≤ 0 → exit 1" branch then returns — no new wait loop, no duplicated checkpoint logic.

Stop is the opposite: *abandon* uncommitted work and die. The existing `SIGINT` handler already does exactly this (abort AbortController → 2s grace → `process.exit(130)`). The daemon sends SIGINT; after a 5s guard, SIGKILL. Marks the run `abandoned`. Uncommitted diffs stay in the worktree for manual `/pickup` if the operator regrets.

### Why tee child stdout through a per-run file + in-process pubsub

SSE needs live fan-out to N subscribers (UI auto-refresh, curl smoke-tests, multiple tabs). Daemon restarts drop in-memory streams, so persisted files are the recovery surface. Simple model: child stdout → newline-buffered → write append to `${LOG_DIR}/${runId}.log` AND fan-out to a `Set<(line: string) => void>` of active subscribers. The broker owns the partial-line buffer so SSE framing (`data: <line>\n\n`) gets whole records, never split chunks.

**Replay-vs-live race.** Naïve "replay from offset 0, then attach" loses any line written between the read end and the subscribe call. Subscribe-first ordering: register the subscriber (its closure pushes onto a private queue), `fs.statSync().size` to capture the current EOF, stream file bytes 0..eof, then drain + dedup the queue against `eof` (each line carries its source offset). For completed runs the broker has no live producer, so a single sequential file read is sufficient — return the file as one read, then `event: end`.

Structured events from `.dev/autopilot-log.jsonl` are *cycle-completion-only* records — they fire after the cycle returns, not continuously. Exposing them via the detail endpoint (`GET /runs/:id`) rather than SSE matches their cadence. No need for a parallel tail.

### Why not add a build step

Repo ethos: "No formal build step: everything runs via `tsx`." Hono runs fine under tsx. The server's `build` script is `tsc --noEmit` — a typecheck pass that matches the roadmap deliverable wording without producing `dist/` output. systemd runs `tsx scripts/server.ts` directly. `typescript@^6` is already a root devDep (workspace-hoisted), so `tsc --noEmit` resolves without adding a per-package dep.

---

## Files to change

| Path | Action | Notes |
|---|---|---|
| `packages/server/package.json` | replace | add `hono`, `ulid`, workspace dep on `@cdhorne/claude-autopilot`; scripts: `dev` (tsx watch), `start` (tsx), `build` (tsc --noEmit), `test` (node:test) |
| `packages/server/tsconfig.json` | leave | already extends base |
| `packages/server/scripts/server.ts` | new | entry: read env, construct app, listen on `${HOST}:${PORT}` (refuses `0.0.0.0`) |
| `packages/server/src/app.ts` | new | Hono app factory `createApp(deps): Hono` — injects supervisor + roadmap + stats for testability |
| `packages/server/src/config.ts` | new | parse env (`AUTOPILOT_SERVER_HOST`, `AUTOPILOT_SERVER_PORT`, `AUTOPILOT_REPO`, `CONTROL_PLANE_TOKEN`, `AUTOPILOT_SERVER_STATE_PATH`, `AUTOPILOT_SERVER_LOG_DIR`); fail loudly on missing required or `0.0.0.0` |
| `packages/server/src/auth.ts` | new | `bearerAuth(token)` middleware; no-op when `token` is undefined; constant-time compare via `timingSafeEqual` |
| `packages/server/src/state-store.ts` | new | `StateStore` over flat JSON: `list()`, `get(id)`, `upsert(run)`, `remove(id)`; atomic `writeFileSync` → `rename` |
| `packages/server/src/supervisor.ts` | new | `Supervisor`: `start(opts)`, `pause(id)`, `resume(id)`, `stop(id)`, `get(id)`, `list()`, `attachLog(id, subscriber)`, `bootReattach()` |
| `packages/server/src/log-broker.ts` | new | per-run fan-out: subscribers `Set<(chunk: string) => void>`, tee child pipe → file append + broadcast |
| `packages/server/src/routes/runs.ts` | new | POST /runs, GET /runs, GET /runs/:id, POST /runs/:id/pause, POST /runs/:id/resume, POST /runs/:id/stop, GET /runs/:id/log (SSE) |
| `packages/server/src/routes/stats.ts` | new | GET /stats → `computeStats()` JSON |
| `packages/server/src/routes/roadmap.ts` | new | GET /roadmap → `roadmap.listOpenItems()` |
| `packages/server/src/routes/health.ts` | new | GET /healthz → 200 (bypasses auth) |
| `packages/server/__tests__/state-store.test.ts` | new | roundtrip, atomic write on crash-simulate, concurrent upsert |
| `packages/server/__tests__/auth.test.ts` | new | no-op without token, reject wrong token, accept right token, timing-safe path |
| `packages/server/__tests__/supervisor.test.ts` | new | mocked `spawn`: start → state running, SIGUSR2 → pause, SIGINT → abandon; bootReattach marks dead PIDs abandoned |
| `packages/server/__tests__/app.test.ts` | new | route integration via `app.request()` with mocked supervisor |
| `packages/autopilot/scripts/autopilot/stats.ts` | edit | extract `computeStats(opts?: { logPath?: string }): Stats` from `runStatsCommand`; the CLI wrapper delegates to it |
| `packages/autopilot/scripts/autopilot/index.ts` | edit | re-export `computeStats`, `getRoadmapSource`, `type RoadmapSource`, `type RoadmapItem` |
| `packages/autopilot/scripts/autopilot/pipeline.ts` | edit | inside `runOrchestrator`, install a `process.on("SIGUSR2", ...)` that sets `parkSignal.parked = true; parkSignal.limitType = "paused"; parkSignal.resetsAt = 0` (≤6 lines); removed on completion like the existing SIGINT handler guidance |
| `packages/autopilot/scripts/autopilot/__tests__/pipeline.test.ts` | extend (or add) | unit-test the SIGUSR2 handler parks on the next step boundary |
| `infra/systemd/autopilot-server.service` | new | user unit; EnvironmentFile=%h/.config/autopilot-server.env; ExecStart=pnpm --filter … start; Restart=on-failure |
| `.github/workflows/deploy-server.yml` | new | self-hosted runner; on push to main touching server/autopilot/lockfile; install + build + `systemctl --user restart` |
| `docs/server.md` | new | architecture, API reference, systemd setup, pause/resume semantics, bearer-token hook, tailnet bind, TOOL-43 reservation |
| `docs/roadmap-core.md` | edit | mark TOOL-39 done (via `/ship` + roadmap adapter's `markDone`, not by hand) |
| `CLAUDE.md` | edit | add one paragraph under "Orientation" pointing at `packages/server/` now that it's alive; add `docs/server.md` to the reference list |
| `.claude/skills/_rubric.md` | edit | extend the Verification block: (a) add a second test glob `npx tsx --test --test-reporter=dot packages/server/__tests__/*.test.ts` so `/shakedown` exercises the new suites under the same forked-review path that already covers autopilot, and (b) add parse-check `npx tsx -e "import('./packages/server/src/app.ts')"`. Without (a), supervisor / state-store / auth tests run only via `pnpm -r test` (used by CI) but not under the rubric loop the shakedown skill consults — silent test drift waiting to happen. |

Nothing under `packages/autopilot/` changes contract — the edits are additive exports and one signal handler.

---

## API shape (source of truth for the plan)

```ts
// POST /runs
// body: { item: string; parallel?: number; cycles?: number; shipTarget?: "direct-push"|"pull-request"|"auto-merge-pr" }
// 200: { id: string; item: string; startedAt: string; logPath: string }

// GET /runs
// 200: { runs: RunSummary[] }  // RunSummary: id, item, status, startedAt, endedAt?, lastStep?, lastCost?

// GET /runs/:id
// 200: { id, item, status, startedAt, endedAt?, pid, logPath, shipTarget, parallel, cycles,
//        latestCycle?: CycleLogEntry, tokenTotals?, toolCounts? }
// Pulls latestCycle from .dev/autopilot-log.jsonl filtered by item + started-at window.

// POST /runs/:id/pause
// sends SIGUSR2 → child parks at next step boundary
// 200: { id, status: "paused" }    (returns immediately; status update is async — poll or SSE)
// 409 if already parked/paused/completed

// POST /runs/:id/resume
// spawns `pnpm autopilot --resume <item>` in a new subprocess; new run ID with resumedFrom = old ID
// 200: { id: newId, item, status: "running", resumedFrom: oldId }

// POST /runs/:id/stop
// SIGINT → 5s grace → SIGKILL; marks status "abandoned"
// 200: { id, status: "abandoned" }

// GET /runs/:id/log
// Content-Type: text/event-stream
// data: <log line>\n\n
// live-tails the per-run log file; for completed runs, streams file contents and closes
// closes on `event: end\ndata: {"exitCode":N}\n\n`

// GET /stats
// 200: Stats JSON (existing shape from stats.ts)

// GET /roadmap
// 200: { source: "markdown"|"github-issues"|"linear"; items: RoadmapItem[] }
// Open items only; filtered + ordered by the adapter.

// GET /healthz
// 200: { ok: true }  (bypasses bearer auth — uptime probing)
```

All responses JSON unless noted. Errors: `{ error: string; code: string }` with HTTP 4xx/5xx.

---

## Persisted state model

```ts
interface PersistedRun {
  id: string;                    // ulid
  item: string;
  status: "running" | "completed" | "failed" | "parked" | "paused" | "abandoned";
  pid: number | null;            // null after exit
  startedAt: string;             // ISO
  endedAt?: string;              // ISO
  exitCode?: number;
  error?: string;                // e.g. "parked", "aborted", "plan failed"
  shipTarget?: ShipTargetName;
  parallel?: number;
  cycles?: number;
  logPath: string;               // absolute path to per-run stdout capture
  cwd: string;                   // repo path passed to child
  resumedFrom?: string;          // prior run ID when this is a /resume
}
```

Stored as `{ runs: PersistedRun[] }` at `${STATE_PATH}`. Atomic writes: write temp file → `renameSync`. Ordering guaranteed because the supervisor is the single writer.

`bootReattach()` on startup:
1. Read state.
2. For each run with `status ∈ {running, paused}`: if `pid` alive (`process.kill(pid, 0)` — `ESRCH` ⇒ dead), keep metadata; subscriber list starts empty (clients reconnect).
3. If dead: set `status = "abandoned"`, `error = "daemon restart lost stream"`, persist. Surface in `GET /runs`.

---

## Supervisor contract

```ts
interface SupervisorDeps {
  store: StateStore;
  broker: LogBroker;
  repoCwd: string;
  logDir: string;
  spawn?: typeof childProcessSpawn;   // injectable for tests
  now?: () => Date;                    // injectable for tests
}

interface StartOpts {
  item: string;
  parallel?: number;
  cycles?: number;
  shipTarget?: ShipTargetName;
}

class Supervisor {
  start(opts: StartOpts): PersistedRun                    // sync; returns seed record
  pause(id: string): PersistedRun                         // sends SIGUSR2; throws if no such run / wrong state
  resume(id: string): PersistedRun                        // spawns new --resume run; returns new record
  stop(id: string): Promise<PersistedRun>                 // SIGINT → 5s → SIGKILL
  get(id: string): PersistedRun | null
  list(): PersistedRun[]
  attachLog(id, subscriber): () => void                   // returns unsubscribe
  bootReattach(): void
}
```

Child argv construction:
```ts
const args = [
  "--filter", "@cdhorne/claude-autopilot", "autopilot",
  "--item", opts.item,
  ...(opts.parallel ? ["--parallel", String(opts.parallel)] : []),
  ...(opts.cycles ? ["--cycles", String(opts.cycles)] : []),
  ...(opts.shipTarget ? ["--target", opts.shipTarget] : []),
  "--verbose",
];
```
Spawn `pnpm` with those args, `cwd: repoCwd`, `env: { ...process.env, CLAUDE_AUTOPILOT_REPO: repoCwd }`, `stdio: ["ignore", "pipe", "pipe"]`. Pipe stdout + stderr through `broker.tee(id, logPath)`.

On `child.exit(code)`:
- Read the last JSONL entry for this run's item to disambiguate parked vs. failed vs. completed.
- Update status accordingly; persist; broadcast SSE `event: end`.

---

## Pipeline change (surgical)

Inside `runOrchestrator()` in `packages/autopilot/scripts/autopilot/pipeline.ts`, immediately after `const parkSignal: ParkSignal = { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };`:

```ts
const onPause = (): void => {
  parkSignal.parked = true;
  parkSignal.limitType = "paused";
  parkSignal.resetsAt = 0;
};
process.on("SIGUSR2", onPause);
```

Register a single `process.off("SIGUSR2", onPause)` in the same cleanup path that `orchestrate()` uses to remove SIGINT handling at exit (add a cleanup arm; see existing `cleanup()` closure). No other pipeline logic changes — the existing `parkExit()` call sites already handle the `parked` state correctly, and the orchestrator's "waitMs ≤ 0" branch already exits with code 1 without attempting to wait.

**Why this is safe:** `parkSignal` is already mutated asynchronously by the SDK rate-limit handler (see `step-runner.ts`). Adding a second async writer with the same write-set (three fields) is a structural no-op. No new code paths, no new data structures.

---

## systemd unit (committed verbatim; operator overrides via EnvironmentFile)

```ini
[Unit]
Description=Claude Autopilot control-plane daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/workspace/claude-autopilot
EnvironmentFile=%h/.config/autopilot-server.env
ExecStart=/usr/bin/env pnpm --filter @cdhorne/claude-autopilot-server start
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

`%h/.config/autopilot-server.env` (not committed; documented in `docs/server.md`) contains `ANTHROPIC_API_KEY`, `GH_TOKEN`, `LINEAR_API_KEY`, `AUTOPILOT_SERVER_HOST=<tailnet-ip>`, `AUTOPILOT_SERVER_PORT=7777`, `AUTOPILOT_REPO=%h/workspace/claude-autopilot`, optional `CONTROL_PLANE_TOKEN=…`.

---

## Deploy workflow (`.github/workflows/deploy-server.yml`)

```yaml
name: deploy-server
on:
  push:
    branches: [main]
    paths:
      - "packages/server/**"
      - "packages/autopilot/**"
      - "pnpm-lock.yaml"
      - "pnpm-workspace.yaml"
      - ".github/workflows/deploy-server.yml"
concurrency:
  group: deploy-server
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: [self-hosted, autopilot]
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @cdhorne/claude-autopilot-server build
      - run: systemctl --user restart autopilot-server
```

`concurrency` prevents overlapping deploys; `timeout-minutes` bounds stuck jobs. No Terraform, no Hetzner — the runner lives on the target box (same pattern as `.github/workflows/autopilot-fix.yml`).

---

## Test strategy

Unit tests live in `packages/server/__tests__/` and run under `node:test` via the same `pnpm -r test` invocation that already covers autopilot.

**`state-store.test.ts`**
- Roundtrip: upsert → read → same shape.
- Atomic write survives a simulated crash (write temp → don't rename → reload yields previous).
- Concurrent upserts with same id produce the last-write-wins record.

**`auth.test.ts`**
- `bearerAuth(undefined)` → every request passes.
- `bearerAuth("secret")` with no header → 401.
- Wrong token → 401.
- Correct token → continues.
- Uses `crypto.timingSafeEqual` on equal-length buffers.

**`supervisor.test.ts`** (spawn injected)
- `start()` records `status: "running"`, constructs the expected argv, pipes stdout into the broker.
- `pause(id)` sends `SIGUSR2` to the mock child and returns a `PersistedRun`. Polling → status reflects eventual park once the mock child exits.
- `stop(id)` sends `SIGINT` first; after 5s without exit, sends `SIGKILL`. Status becomes `abandoned`.
- `resume(id)` starts a *new* child with `--resume` args, records `resumedFrom`.
- `bootReattach()` marks dead-PID running runs as `abandoned`.

**`app.test.ts`** (Hono `app.request()` — no network)
- POST /runs happy path, invalid body 400, unknown shipTarget 400.
- GET /runs lists current + historical.
- GET /runs/:id 404 for missing; returns latestCycle for known.
- POST /runs/:id/pause → 200 + mocked pause invocation; 409 if wrong state.
- GET /runs/:id/log SSE: assert response headers + first chunk.
- GET /stats → computeStats() JSON.
- GET /roadmap → listOpenItems() JSON.
- Bearer gate: when `CONTROL_PLANE_TOKEN` set, all except `/healthz` demand auth.

**`pipeline.test.ts` addition**
- SIGUSR2 sent to the orchestrator parks at next boundary: assert `parkSignal.parked === true && parkSignal.limitType === "paused"` after handler fires.

No end-to-end test of the daemon against real Claude — that's the roadmap's manual smoke test item. The deploy workflow's presence means the smoke test runs post-merge.

---

## Rubric self-check

**Well-typed** — every exported function has an explicit return type. `PersistedRun.status` is a literal union; adding a variant requires updating the state transition switch. No `any`. Hono `Context` typed via `Hono<{ Variables: { run?: PersistedRun } }>`. `StepTargetName` reused from autopilot's `types.ts`.

**Well-tested** — supervisor (injected spawn), state-store (fs round-trip), auth (middleware with both paths), routes (via `app.request()`). Pipeline's SIGUSR2 handler gets a focused unit test. Live SDK sessions remain manual (matches autopilot's existing posture per the rubric).

**Well-factored** — strict module boundaries mirror autopilot's:
- `config.ts` — env parsing only.
- `state-store.ts` — persistence only.
- `log-broker.ts` — fan-out only.
- `supervisor.ts` — process lifecycle.
- `routes/*.ts` — HTTP shape only; business logic lives in supervisor/helpers.
- `app.ts` — composition (dependency injection).
- `scripts/server.ts` — entry (arg/env → app → listen).
- `auth.ts` — one middleware.

No cross-imports from `routes/*` to each other. No business logic in `auth.ts`. Stats + roadmap reuse pure helpers from `@cdhorne/claude-autopilot` — no duplicated reducers, no re-exec of the CLI.

**Correct** — load-bearing invariants audited:
- **Step exhaustiveness**: unaffected. No new steps.
- **Frontmatter stripping**: unaffected.
- **Worktree isolation**: unaffected. Daemon never runs SDK calls; it spawns the existing autopilot binary which installs the isolation hook itself.
- **Rate-limit parking**: *preserved and extended*. The SIGUSR2 handler mutates the same `parkSignal` fields as the rate-limit handler. `parkExit()` is unchanged. Any future exit path added to the pipeline must still call `parkExit()`; this plan doesn't add such paths.
- **Phantom ship guard**: unaffected.
- **`listWorktrees()` prefix filter**: unaffected.
- **`detectResumeStep`**: unaffected; resume goes through `pnpm autopilot --resume` which already uses it.
- **No hardcoded model strings**: server never names a model.
- **No install-script hooks**: server `package.json` has no `preinstall`/`install`/`postinstall`. `check-publish` already guards this for autopilot; will add a parallel assertion or rely on convention review (decision: rely on the existing guard in autopilot; server is `private: true` so not published).
- **Bind address**: fail-loud on `0.0.0.0` or missing `AUTOPILOT_SERVER_HOST` — no accidental public exposure pre-TOOL-43.

**Concise** — no premature abstractions. No "configurable state backend" — flat JSON, period. No "pluggable spawn strategy" — one way to start a child. The supervisor is ~150 LoC; the state store is ~60; the log broker is ~80; routes are thin shells over the supervisor. `app.ts` is the only composition surface and takes deps as an argument (idiomatic DI for testability, not abstraction-for-its-own-sake).

**Idioms (deferred to `/shakedown`)** — written in the same style as existing autopilot code: tabs, double quotes, `.js` relative imports, named exports, `satisfies` for the route table, discriminated unions for state transitions.

---

## Open questions — resolved

- **Pause semantics**: SIGUSR2 sets `parkSignal` fields; reuses the checkpointing exit path. Preferred over a sidecar flag or a new polling loop.
- **Run-state store**: flat JSON with atomic write. Drizzle/libSQL deferred until there's a reason.
- **Log streaming**: child stdout → per-run file + in-process pubsub → SSE. Structured JSONL events surface on the detail endpoint, not SSE — they fire at cycle granularity, not line granularity.
- **Build vs. tsx**: no compiled build. `build` script is `tsc --noEmit` (typecheck only). systemd runs tsx.

---

## Revisions during self-review

Two changes from the first draft:

1. **Dropped a proposed `events/` directory.** Originally planned to split pubsub + log-tail into their own submodule. One file (`log-broker.ts`) is enough — the tail and the broadcaster share state. Splitting was abstraction for its own sake. (Concise.)

2. **Added a `bootReattach()` step to the supervisor contract and its test.** Originally only described in the reattachment paragraph. Without it, a daemon restart could leave `status: "running"` entries pointing at dead PIDs, and `GET /runs` would lie. Now explicit in the API, tested, and called from `createApp()`. (Correct.)

## Revisions during shakedown-plan

3. **Rubric Verification block must run server tests, not just parse-check the entry.** Originally the `_rubric.md` edit only added an `import('./packages/server/src/app.ts')` parse-check. Forked-context shakedown reads the rubric to decide what to verify, so omitting the test glob would leave supervisor / state-store / auth tests outside the inner-loop verification surface (they'd still run under `pnpm -r test` in CI, but not under shakedown's fix-and-reverify cycle). Updated the file table to add the second test glob. (Correct.)

4. **Made the SSE replay-vs-live race explicit.** First draft said "replay file from offset 0, then switch to live subscription" — the well-known tail race. Added subscribe-first + offset-snapshot + drain-and-dedup as the broker contract, and called out newline-buffering for SSE framing. (Correct.)

5. **Confirmed `tsc --noEmit` works without a server-package devDep.** Root already hoists `typescript@^6`. Noted inline. (Concise — avoids a redundant per-package install.)
