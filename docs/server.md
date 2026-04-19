# Autopilot control-plane server

A Hono daemon that exposes the autopilot pipeline over HTTP. Runs as a systemd
user unit on the same box as autopilot, binds to a tailnet IP, supervises
`pnpm autopilot` subprocesses, and survives operator disconnects.

It replaces SSH-over-Tailscale kickoffs. Web UI (TOOL-42) and Cloudflare Tunnel
+ live bearer enforcement (TOOL-43) build on top of this.

## Architecture

```
HTTP client ──► Hono routes ──► Supervisor ──► child process (`pnpm autopilot ...`)
                  │                  │              │
                  │                  ├──► StateStore (.dev/server-state.json)
                  │                  └──► LogBroker (file tee + SSE fan-out)
                  └──► RoadmapSource / computeStats (pure helpers reused from @cdhorne/claude-autopilot)
```

Module boundaries (`packages/server/src/`):

| Module | Responsibility |
|---|---|
| `scripts/server.ts` | Entry: env → `createApp(deps)` → `serve(...)`. |
| `src/app.ts` | Composition. `/healthz` is registered outside the auth chain. |
| `src/config.ts` | Env parsing. Refuses `AUTOPILOT_SERVER_HOST=0.0.0.0`. |
| `src/auth.ts` | Bearer middleware; constant-time compare via `crypto.timingSafeEqual`. No-op when token is undefined. |
| `src/state-store.ts` | Flat-JSON persistence. Atomic writes (temp file → `renameSync`). |
| `src/supervisor.ts` | `start` / `pause` / `resume` / `stop` / `bootReattach`. Spawn is DI for tests. |
| `src/log-broker.ts` | Per-run pubsub; tees child stdout/stderr to `${logDir}/${id}.log` and to live SSE subscribers. |
| `src/routes/*.ts` | Thin HTTP shells. No business logic. |

## API

All responses JSON unless noted. Errors: `{ error: string; code: string }` with HTTP 4xx/5xx.

### `POST /runs`
```jsonc
// body
{ "item": "TOOL-1", "parallel": 2, "cycles": 3, "shipTarget": "pull-request" }
// 200
{ "id": "01HX...", "item": "TOOL-1", "startedAt": "2026-04-19T...", "logPath": "/.../01HX....log" }
```
`shipTarget` ∈ `direct-push` | `pull-request` | `auto-merge-pr`.

### `GET /runs`
```jsonc
{ "runs": [{ "id", "item", "status", "startedAt", "endedAt"? }] }
```

### `GET /runs/:id`
Full `PersistedRun` (see `src/types.ts`). 404 if unknown.

### `POST /runs/:id/pause`
Sends `SIGUSR2`. The pipeline's signal handler sets `parkSignal.parked = true; limitType = "paused"; resetsAt = 0` so the existing `parkExit()` checkpoint path runs at the next step boundary. 200 returns immediately; status update is async — poll the detail endpoint or watch SSE.

409 if the run is not `running`.

### `POST /runs/:id/resume`
Spawns a new child with `pnpm autopilot --resume <item>`. Returns the *new* run record with `resumedFrom` pointing at the prior run id.

### `POST /runs/:id/stop`
`SIGINT` → 5s grace → `SIGKILL`. Status becomes `abandoned`. Uncommitted diffs stay in the worktree for manual `/pickup` if the operator regrets.

### `GET /runs/:id/log`
Server-sent events. `data: <log line>\n\n` per line. For completed runs, replays the file and closes with `event: end\ndata: {"exitCode":N}\n\n`. For live runs, replay is subscribe-first: the broker captures a watermark via `bytesWritten`, replays bytes 0..watermark, then drains a buffered queue to dedup against newly-arrived lines — no race, no dropped lines.

### `GET /stats`
Pure `computeStats()` from autopilot — same shape as the CLI's `stats` subcommand.

### `GET /roadmap`
```jsonc
{ "source": "markdown" | "github-issues" | "linear", "items": RoadmapItem[] }
```
Open items only.

### `GET /healthz`
`{ "ok": true }`. Bypasses bearer auth — uptime probing.

## Persisted state

`PersistedRun` is the canonical shape. Stored as `{ runs: PersistedRun[] }` at
`AUTOPILOT_SERVER_STATE_PATH` (default `<repo>/.dev/server-state.json`). The
supervisor is the single writer; writes are atomic (temp file → `renameSync`).
On startup, `bootReattach()` walks every `running`/`paused` entry and probes
its PID with `process.kill(pid, 0)`. Dead PIDs are marked `abandoned` with
`error: "daemon restart lost stream"`. Live PIDs keep their metadata; the
in-memory subscriber set starts empty (clients reconnect via SSE).

## Pause / resume / stop semantics

- **Pause** — sends `SIGUSR2`. The pipeline's `runOrchestrator()` registers a
  one-line handler that sets `parkSignal` exactly the way the rate-limit
  handler does. `parkExit()` checkpoints work at the next step boundary; the
  child exits with code 1 via the existing "waitMs ≤ 0" branch. The supervisor
  then sees the `failed` exit but the `paused` status is preserved as the
  in-memory record. State on disk reflects `paused` until the child exits.
- **Resume** — `pnpm autopilot --resume <item>` in a new subprocess. New ulid;
  `resumedFrom` points at the prior run.
- **Stop** — abandons uncommitted work. `SIGINT` → 5s → `SIGKILL`. Marks
  `abandoned`. Worktree diffs survive for manual recovery.

## systemd setup

Unit lives at `infra/systemd/autopilot-server.service`. Install for the
operator user:

```bash
mkdir -p ~/.config/systemd/user
cp infra/systemd/autopilot-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now autopilot-server
```

`EnvironmentFile=%h/.config/autopilot-server.env` — operator-managed, **not
committed**:

```bash
# ~/.config/autopilot-server.env
ANTHROPIC_API_KEY=sk-ant-...
GH_TOKEN=ghp_...
LINEAR_API_KEY=lin_api_...                    # optional, only if roadmap.source=linear
AUTOPILOT_SERVER_HOST=100.x.x.x               # tailnet IP (NOT 0.0.0.0 — server refuses to start)
AUTOPILOT_SERVER_PORT=7777
AUTOPILOT_REPO=/home/USER/workspace/claude-autopilot
CONTROL_PLANE_TOKEN=...                       # optional; bearer-gates everything except /healthz
```

`StandardOutput=journal` — tail with `journalctl --user -u autopilot-server -f`.

## Bearer-token hook (TOOL-43 reservation)

`bearerAuth(token)` is a no-op when `CONTROL_PLANE_TOKEN` is unset, so the
middleware ships dormant. The expected TOOL-43 deployment binds the daemon to
a tailnet-only interface, fronts it with Cloudflare Tunnel, and turns the
token on. Comparison uses `crypto.timingSafeEqual` and rejects length
mismatches before the compare so attackers can't probe length via timing.

## Tailnet bind

`AUTOPILOT_SERVER_HOST=0.0.0.0` is rejected at startup. The intent is that
deploy environments specify the tailnet interface explicitly. Local dev can
use `127.0.0.1`.

## Deploy workflow

`.github/workflows/deploy-server.yml` runs on `[self-hosted, autopilot]` (the
target box). Triggers on `push` to `main` touching `packages/server/**`,
`packages/autopilot/**`, or the workspace lockfile. Steps: install →
`pnpm --filter @cdhorne/claude-autopilot-server build` (parse-check via
`tsx -e "import('./src/app.ts')"` — matches repo ethos of no formal build) →
`systemctl --user restart autopilot-server`. `concurrency` prevents
overlapping deploys; `timeout-minutes: 10` bounds stuck jobs.
