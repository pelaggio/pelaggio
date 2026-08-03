# Pelaggio control-plane server

A Hono daemon that exposes the pelaggio pipeline over HTTP. Runs as a systemd
user unit on the same box as pelaggio, binds to a tailnet IP, supervises
`pnpm pelaggio` subprocesses, and survives operator disconnects.

It replaces SSH-over-Tailscale kickoffs. Web UI (TOOL-42) and Cloudflare Tunnel
+ live bearer enforcement (TOOL-43) build on top of this.

## Architecture

```
HTTP client ──► Hono routes ──► Supervisor ──► child process (`pnpm pelaggio ...`)
                  │                  │              │
                  │                  ├──► StateStore ($XDG_STATE_HOME/pelaggio-server/state.json)
                  │                  └──► LogBroker (file tee + SSE fan-out)
                  ├──► Registry  ($XDG_CONFIG_HOME/pelaggio-server/repos.yml — slug → repo path)
                  └──► RoadmapCache → RoadmapSource / computeStats (per-repo, lazy)
```

Module boundaries (`packages/server/src/`):

| Module | Responsibility |
|---|---|
| `scripts/server.ts` | Entry: env → registry → `createApp(deps)` → `serve(...)`. |
| `src/app.ts` | Composition. `/healthz` is registered outside the auth chain. |
| `src/config.ts` | Env parsing. Refuses `AUTOPILOT_SERVER_HOST=0.0.0.0`. Fails closed: refuses to start when `CONTROL_PLANE_TOKEN` is unset **and** the host is non-loopback. XDG-aware defaults for registry/state/log paths. |
| `src/registry.ts` | Loads + validates `repos.yml`. `Registry.path(slug)` resolves slug → absolute repo path. |
| `src/roadmap-cache.ts` | Lazy `Map<slug, RoadmapSource>`; first hit per slug instantiates via injected factory. |
| `src/auth.ts` | Bearer middleware; constant-time compare via `crypto.timingSafeEqual`. No-op when token is undefined. |
| `src/state-store.ts` | Flat-JSON persistence. Atomic writes (temp file → `renameSync`). |
| `src/state-path-lock.ts` | Exclusive PID lock on `${statePath}.lock` at boot. Daemon-lifetime liveness only — not the expiring roadmap mutation lock. |
| `src/supervisor.ts` | `start` / `pause` / `resume` / `stop` / `bootReattach`. Resolves `start({ repo })` via registry. Spawn is DI for tests. |
| `src/log-broker.ts` | Per-run pubsub; tees child stdout/stderr to `${logDir}/${id}.log` and to live SSE subscribers. |
| `src/routes/*.ts` | Thin HTTP shells. No business logic. |

## API

All responses JSON unless noted. Errors: `{ error: string; code: string }` with HTTP 4xx/5xx.

### `POST /runs`
```jsonc
// body
{ "repo": "pelaggio", "item": "TOOL-1", "parallel": 2, "cycles": 3, "shipTarget": "pull-request" }
// 200
{ "id": "01HX...", "repo": "pelaggio", "item": "TOOL-1", "startedAt": "2026-04-19T...", "logPath": "/.../01HX....log" }
```
`repo` is a slug from the registry (`GET /repos`); unknown slugs → 400.
`shipTarget` ∈ `direct-push` | `pull-request` | `auto-merge-pr`.

### `GET /runs`
```jsonc
{ "runs": [{ "id", "repo", "item", "status", "startedAt", "endedAt"? }] }
```
`?repo=<slug>` filters to runs from that registry entry. Unknown slug returns `{ "runs": [] }`.

### `GET /runs/:id`
Full `PersistedRun` (see `src/types.ts`). 404 if unknown.

### `POST /runs/:id/pause`
Sends `SIGUSR2`. The pipeline's signal handler sets `parkSignal.parked = true; limitType = "paused"; resetsAt = 0` so the existing `parkExit()` checkpoint path runs at the next step boundary. 200 returns immediately; status update is async — poll the detail endpoint or watch SSE.

409 if the run is not `running`.

### `POST /runs/:id/resume`
Spawns a new child with `pnpm pelaggio --resume <item>`. Returns the *new* run record with `resumedFrom` pointing at the prior run id.

### `POST /runs/:id/stop`
`SIGINT` → 5s grace → `SIGKILL`. Status becomes `abandoned`. Uncommitted diffs stay in the worktree for manual `/pickup` if the operator regrets.

### `GET /runs/:id/log`
Server-sent events. `data: <log line>\n\n` per line. For completed runs, replays the file and closes with `event: end\ndata: {"exitCode":N}\n\n`. For live runs, replay is subscribe-first: the broker captures a watermark via `bytesWritten`, replays bytes 0..watermark, then drains a buffered queue to dedup against newly-arrived lines — no race, no dropped lines.

The supervisor spawns every child with `PELAGGIO_PLAIN=1` in its env, so tee'd log files and SSE streams are ANSI-free: no spinner repaints, no scroll-region escapes, no color bytes. Auto-detection via non-TTY stderr already covers piped stdio, but the explicit env var is defensive against wrapper shims that might allocate a pty. Humans piping `pnpm pelaggio` output outside the server (`pnpm pelaggio … 2>&1 | tee`, `| less`, etc.) can set the same env var to opt in to plain lines.

### `GET /repos`
```jsonc
{ "repos": [{ "slug": "pelaggio", "path": "/abs/path", "exists": true }, ...] }
```
Lists registry entries in insertion order; `exists` reflects whether the path resolves on disk.

### `GET /repos/:slug/roadmap`
```jsonc
{ "source": "markdown" | "github-issues" | "linear", "items": RoadmapItem[] }
```
Open items only. 404 on unknown slug.

### `GET /repos/:slug/stats`
Pure `computeStats({ logPath: <repo>/.dev/pelaggio-log.jsonl })` from pelaggio — same shape as the CLI's `stats` subcommand. 404 on unknown slug.

### `GET /healthz`
`{ "ok": true }`. Bypasses bearer auth — uptime probing.

## Repo registry

The daemon is repo-agnostic; it learns about repos from a YAML file at
`$XDG_CONFIG_HOME/pelaggio-server/repos.yml` (override:
`AUTOPILOT_SERVER_REGISTRY=/abs/path`). See
`infra/pelaggio-server/repos.yml.example` for the format. Restart the daemon
after editing — there is no hot-reload.

```yaml
repos:
  pelaggio: /home/USER/workspace/pelaggio
  fathom: /home/USER/workspace/fathom
```

Each `PersistedRun` carries its own `repo` slug; the supervisor resolves
`start({ repo })` via the registry and uses the resolved path as the spawn
`cwd` and `PELAGGIO_REPO`. Unknown slugs surface as
`SupervisorError(code: "unknown-repo")` → HTTP 400.

If two registry paths share the same `basename(path)`, pelaggio's
worktree-prefix detection (`listWorktrees()` filters by basename) can
misattribute branches across the repos. The daemon emits a single
`console.warn` at boot and continues — operator decides whether to rename.

## Persisted state

`PersistedRun` is the canonical shape. Stored as `{ runs: PersistedRun[] }` at
`AUTOPILOT_SERVER_STATE_PATH` (default
`$XDG_STATE_HOME/pelaggio-server/state.json`, fallback
`~/.local/state/pelaggio-server/state.json`). Per-run logs default to
`$XDG_STATE_HOME/pelaggio-server/logs/<id>.log`
(override: `AUTOPILOT_SERVER_LOG_DIR`). The supervisor is the single writer;
writes are atomic (temp file → `renameSync`). On startup, `bootReattach()`
walks every `running`/`paused` entry and probes its PID with
`process.kill(pid, 0)`. Dead PIDs are marked `abandoned` with
`error: "daemon restart lost stream"`. Live PIDs keep their metadata; the
in-memory subscriber set starts empty (clients reconnect via SSE).

**State-path exclusivity.** Before constructing the store, the daemon claims
`${statePath}.lock` (e.g. `…/state.json.lock`) with an `O_EXCL` write of
`${pid}:${token}`. A second live instance exits at startup with an error that
names the holding PID and the state path. Dead-PID residue (and residue that
names this process's PID after a crash + PID recycle) is reclaimed
automatically. Unreadable or malformed lock content fails closed — the
operator must inspect or remove the file. This is a daemon-lifetime
PID-liveness lock, **not** the expiring `.dev/roadmap-mutation.lock` used for
short roadmap critical sections; the two policies must not be merged.

## Pause / resume / stop semantics

- **Pause** — sends `SIGUSR2`. The pipeline's `runOrchestrator()` registers a
  one-line handler that sets `parkSignal` exactly the way the rate-limit
  handler does. `parkExit()` checkpoints work at the next step boundary; the
  child exits with code 1 via the existing "waitMs ≤ 0" branch. The supervisor
  then sees the `failed` exit but the `paused` status is preserved as the
  in-memory record. State on disk reflects `paused` until the child exits.
- **Resume** — `pnpm pelaggio --resume <item>` in a new subprocess. New ulid;
  `resumedFrom` points at the prior run.
- **Stop** — abandons uncommitted work. `SIGINT` → 5s → `SIGKILL`. Marks
  `abandoned`. Worktree diffs survive for manual recovery.

## systemd setup

Unit lives at `infra/systemd/pelaggio-server.service`. Install for the
operator user:

```bash
mkdir -p ~/.config/systemd/user
cp infra/systemd/pelaggio-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pelaggio-server
```

**Why the wrapper script?** systemd user instances boot with a minimal `PATH`
that excludes the bin directories used by fnm / nvm / volta. The unit's
`ExecStart=` points at `infra/systemd/pelaggio-server-exec.sh`, which sources
the right init hook for whichever manager is installed (falling through cleanly
when none is) and then `exec`s `pnpm --filter @pelaggio/server
start`. Signal handling, journal tees, and `Restart=on-failure` are unchanged.
If your setup isn't covered, you have two options:

1. Add `PATH=/your/bin:$PATH` to `~/.config/pelaggio-server.env`. systemd
   reads `EnvironmentFile` before `ExecStart`, so the wrapper inherits it.
2. Drop a `~/.config/systemd/user/pelaggio-server.service.d/override.conf`
   with a custom `ExecStart=` that points at your own launcher.

`EnvironmentFile=%h/.config/pelaggio-server.env` — operator-managed, **not
committed**:

```bash
# ~/.config/pelaggio-server.env
ANTHROPIC_API_KEY=sk-ant-...
GH_TOKEN=ghp_...
LINEAR_API_KEY=lin_api_...                    # optional, only if roadmap.source=linear
AUTOPILOT_SERVER_HOST=100.x.x.x               # tailnet IP (NOT 0.0.0.0 or :: — server refuses to start)
AUTOPILOT_SERVER_PORT=7777
# AUTOPILOT_SERVER_REGISTRY=/abs/path/repos.yml  # optional override; default $XDG_CONFIG_HOME/pelaggio-server/repos.yml
CONTROL_PLANE_TOKEN=...                       # bearer-gates everything except /healthz; REQUIRED on a non-loopback (tailnet) host — server refuses to start without it
```

The repo registry itself lives separately at
`~/.config/pelaggio-server/repos.yml` — see
`infra/pelaggio-server/repos.yml.example`.

`StandardOutput=journal` — tail with `journalctl --user -u pelaggio-server -f`.

### Cutover from single-repo to registry

If you're upgrading a host that previously ran the daemon with `AUTOPILOT_REPO=…`,
state moves out of `<repo>/.dev/server-state.json` and into XDG, and routes
move from `/roadmap` and `/stats` to `/repos/:slug/...`. There is no
migration code — perform the cutover manually:

```bash
# 1. Drop the old single-repo env line
sed -i '/^AUTOPILOT_REPO=/d' ~/.config/pelaggio-server.env

# 2. Create the registry (one-time)
mkdir -p ~/.config/pelaggio-server
cp infra/pelaggio-server/repos.yml.example ~/.config/pelaggio-server/repos.yml
$EDITOR ~/.config/pelaggio-server/repos.yml

# 3. Wipe pre-cutover state (in-flight runs from the old layout cannot be
#    resumed under the new schema — `repo` becomes a required field).
rm -f <old_repo>/.dev/server-state.json
rm -f ~/.local/state/pelaggio-server/state.json    # in case a prior boot wrote here

# 4. Restart
systemctl --user restart pelaggio-server
```

## Bearer-token auth

`bearerAuth(token)` is a no-op when `CONTROL_PLANE_TOKEN` is unset, so the
middleware ships dormant. To keep that dormant path from ever exposing the
run-spawning endpoints on a routable interface, `loadServerConfig()` **fails
closed**: it refuses to start when the token is unset *and* the host is
non-loopback (anything other than `127.0.0.0/8`, `localhost`, or `::1`). The
token-less no-op is therefore only ever reachable on a loopback bind. Live
deployments bind the daemon to a tailnet-only interface, front it with
Cloudflare Tunnel (see below), and set `CONTROL_PLANE_TOKEN` in the env file —
everything except `/healthz` then requires `Authorization: Bearer <token>`.
Comparison uses `crypto.timingSafeEqual` and rejects length mismatches before
the compare so attackers can't probe length via timing.

Rotate the token by editing `~/.config/pelaggio-server.env` and running
`systemctl --user restart pelaggio-server`. SSE streams reconnect with the
new token on the next page load.

## Tailnet bind

`AUTOPILOT_SERVER_HOST=0.0.0.0` (and its IPv6 wildcard equivalent `::`) is
rejected at startup. The intent is that deploy environments specify the
tailnet interface explicitly. Local dev can use `127.0.0.1`.

Binding a non-loopback host (a tailnet `100.x` IP, a LAN address) additionally
**requires** `CONTROL_PLANE_TOKEN`: the daemon refuses to start token-less on
any routable interface, because an unauthenticated control plane there lets any
reachable peer spawn pelaggio runs. Loopback binds (`127.0.0.1`, `localhost`,
`::1`) stay allowed without a token for local dev — `scripts/server.ts` emits
one `console.warn` at boot so the safe-but-open posture is loud rather than
silent. There is deliberately no escape-hatch flag: loopback + no-token is
already permitted, and non-loopback + no-token is forbidden absolutely, so a
flag would unlock nothing.

## Serving the web UI

The daemon optionally serves `@pelaggio/web` from the same
process. `AUTOPILOT_SERVER_WEB_DIST` (default `${repo}/packages/web/dist`) names
the build output. If the path is missing, the daemon boots without the static
handler — pre-build deploys still come up.

URL layout:

| Path | Handler |
|---|---|
| `/runs`, `/repos`, `/repos/:slug/roadmap`, `/repos/:slug/stats`, `/healthz` | API routes (JSON) |
| `/ui/*` | Astro static (`dist/...`); the `/ui` prefix is stripped before resolving |
| `/` | 302 → `/ui/` (only when `webDist` is set) |

The web build emits all internal links under `/ui/...` via Astro's `base`
option, so dev (`astro dev` proxying to the daemon) and prod (daemon serving
`dist/`) resolve the same URLs.

For dev: run the daemon on its tailnet IP, then
`AUTOPILOT_SERVER_URL=http://127.0.0.1:7777 pnpm --filter @pelaggio/web dev`.
Vite proxies the API paths (incl. SSE) to the daemon and serves the UI at
`http://localhost:4321/ui/`.

## Deploy workflow

`.github/workflows/deploy-server.yml` runs on `[self-hosted, pelaggio]` (the
target box). Triggers on `push` to `main` touching `packages/server/**`,
`packages/pelaggio/**`, or the workspace lockfile. Steps: install →
`pnpm --filter @pelaggio/server build` (parse-check via
`tsx -e "import('./src/app.ts')"` — matches repo ethos of no formal build) →
`systemctl --user restart pelaggio-server`. `concurrency` prevents
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

The unit mirrors `pelaggio-server.service` conventions: user-level,
`EnvironmentFile` for the token, `Restart=on-failure`, journal logging.
Keeping cloudflared on its own unit means server redeploys
(`.github/workflows/deploy-server.yml`) don't interrupt the tunnel.

### 3. Enable the bearer token

Edit `~/.config/pelaggio-server.env`:

```bash
CONTROL_PLANE_TOKEN=$(openssl rand -hex 32)
```

Then `systemctl --user restart pelaggio-server`. The web UI will prompt for
the token on first load and on any 401. The token is stored in browser
`localStorage` under the key `pelaggio-token` — any XSS on the UI would
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
