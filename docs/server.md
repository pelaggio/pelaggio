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

## Bearer-token auth

`bearerAuth(token)` is a no-op when `CONTROL_PLANE_TOKEN` is unset, so the
middleware ships dormant. Live deployments bind the daemon to a tailnet-only
interface, front it with Cloudflare Tunnel (see below), and set
`CONTROL_PLANE_TOKEN` in the env file — everything except `/healthz` then
requires `Authorization: Bearer <token>`. Comparison uses
`crypto.timingSafeEqual` and rejects length mismatches before the compare so
attackers can't probe length via timing.

Rotate the token by editing `~/.config/autopilot-server.env` and running
`systemctl --user restart autopilot-server`. SSE streams reconnect with the
new token on the next page load.

## Tailnet bind

`AUTOPILOT_SERVER_HOST=0.0.0.0` is rejected at startup. The intent is that
deploy environments specify the tailnet interface explicitly. Local dev can
use `127.0.0.1`.

## Serving the web UI

The daemon optionally serves `@cdhorne/claude-autopilot-web` from the same
process. `AUTOPILOT_SERVER_WEB_DIST` (default `${repo}/packages/web/dist`) names
the build output. If the path is missing, the daemon boots without the static
handler — pre-build deploys still come up.

URL layout:

| Path | Handler |
|---|---|
| `/runs`, `/roadmap`, `/stats`, `/healthz` | API routes (JSON) |
| `/ui/*` | Astro static (`dist/...`); the `/ui` prefix is stripped before resolving |
| `/` | 302 → `/ui/` (only when `webDist` is set) |

The web build emits all internal links under `/ui/...` via Astro's `base`
option, so dev (`astro dev` proxying to the daemon) and prod (daemon serving
`dist/`) resolve the same URLs.

For dev: run the daemon on its tailnet IP, then
`AUTOPILOT_SERVER_URL=http://127.0.0.1:7777 pnpm --filter @cdhorne/claude-autopilot-web dev`.
Vite proxies the API paths (incl. SSE) to the daemon and serves the UI at
`http://localhost:4321/ui/`.

## Deploy workflow

`.github/workflows/deploy-server.yml` runs on `[self-hosted, autopilot]` (the
target box). Triggers on `push` to `main` touching `packages/server/**`,
`packages/autopilot/**`, or the workspace lockfile. Steps: install →
`pnpm --filter @cdhorne/claude-autopilot-server build` (parse-check via
`tsx -e "import('./src/app.ts')"` — matches repo ethos of no formal build) →
`systemctl --user restart autopilot-server`. `concurrency` prevents
overlapping deploys; `timeout-minutes: 10` bounds stuck jobs.

## Cloudflare Tunnel setup

The tailnet bind keeps the daemon unreachable from the public internet; a
Cloudflare Tunnel provides off-tailnet access (mobile, cellular, etc.)
without opening inbound ports. `cloudflared` runs on the same box, dials out
to Cloudflare, and proxies `https://<hostname>/*` to the local daemon.

### 1. Provision the tunnel

Terraform config lives under `infra/cloudflare/`. One-time state is local
(upgrade to R2 when a second infra target joins the repo).

```bash
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars   # fill in account/zone/domain
terraform init
terraform apply
terraform output -raw tunnel_token             # copy into env file, next step
```

The applied config creates: a `cloudflare_zero_trust_tunnel_cloudflared`
resource, a `..._config` with ingress mapping `<tunnel_name>.<domain>` →
`http://127.0.0.1:7777` (override via `tunnel_target`), and a proxied
`cloudflare_dns_record` CNAME to `<tunnel-id>.cfargotunnel.com`.

### 2. Install cloudflared as a user unit

```bash
# one-time: install cloudflared from https://pkg.cloudflare.com/
mkdir -p ~/.config
cat > ~/.config/cloudflared.env <<EOF
TUNNEL_TOKEN=<paste from terraform output above>
EOF
chmod 600 ~/.config/cloudflared.env

cp infra/systemd/cloudflared.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cloudflared
journalctl --user -u cloudflared -f             # confirm "Connection registered"
```

The unit mirrors `autopilot-server.service` conventions: user-level,
`EnvironmentFile` for the token, `Restart=on-failure`, journal logging.
Keeping cloudflared on its own unit means server redeploys
(`.github/workflows/deploy-server.yml`) don't interrupt the tunnel.

### 3. Enable the bearer token

Edit `~/.config/autopilot-server.env`:

```bash
CONTROL_PLANE_TOKEN=$(openssl rand -hex 32)
```

Then `systemctl --user restart autopilot-server`. The web UI will prompt for
the token on first load and on any 401. The token is stored in browser
`localStorage` under the key `autopilot-token` — any XSS on the UI would
expose it. Roadmap out-of-scope to harden further; if that changes, an
httpOnly cookie + server-side session is the upgrade path.

### 4. Rotate the tunnel token (rare)

Cloudflare regenerates the `tunnel_token` when the underlying tunnel
resource is replaced (e.g., `terraform taint` + apply). Sequence:

```bash
terraform -chdir=infra/cloudflare apply
terraform -chdir=infra/cloudflare output -raw tunnel_token > ~/.config/cloudflared.env.new
# edit to keep TUNNEL_TOKEN=... format, then atomic swap
mv ~/.config/cloudflared.env.new ~/.config/cloudflared.env
systemctl --user restart cloudflared
```

### Operator acceptance checklist (manual smoke test)

The roadmap's end-to-end test is inherently out-of-tailnet and has no CI
path. Run it after any tunnel or auth change:

- [ ] Tailscale off on the client device (phone, cellular data).
- [ ] Open `https://<tunnel_name>.<domain>/ui/`.
- [ ] Token modal appears; paste the `CONTROL_PLANE_TOKEN`.
- [ ] Runs list loads.
- [ ] Start a small cycle (e.g., `--dry-run`).
- [ ] Run detail page streams SSE log without disconnect.
- [ ] Pause/resume/stop buttons each return 200 and reflect in the UI.
- [ ] `clear token` in the nav clears `localStorage` and re-prompts.
