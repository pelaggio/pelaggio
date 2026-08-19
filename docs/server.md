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
| `src/config.ts` | Env parsing. Refuses `AUTOPILOT_SERVER_HOST=0.0.0.0` and refuses to start without `CONTROL_PLANE_TOKEN`, including on loopback. XDG-aware defaults for registry/state/log paths. |
| `src/registry.ts` | Loads + validates `repos.yml`. `Registry.path(slug)` resolves slug → absolute repo path. |
| `src/roadmap-cache.ts` | Lazy `Map<slug, RoadmapSource>`; first hit per slug instantiates via injected factory. |
| `src/auth.ts` | Bearer middleware; constant-time compare via `crypto.timingSafeEqual`. Its input token is required by type. |
| `src/state-store.ts` | Flat-JSON persistence. Atomic writes (temp file → `renameSync`). |
| `src/state-path-lock.ts` | Exclusive PID lock on `${statePath}.lock` at boot. Daemon-lifetime liveness only — not the expiring roadmap mutation lock. |
| `src/supervisor.ts` | `start` / `pause` / `resume` / `stop` / `bootReattach`. Resolves `start({ repo })` via registry. Spawn is DI for tests. |
| `src/log-broker.ts` | Per-run pubsub; tees child stdout/stderr to `${logDir}/${id}.log` and to live SSE subscribers. |
| `src/routes/*.ts` | Thin HTTP shells. No business logic. |

## API

All responses JSON unless noted. Errors: `{ error: string; code: string }` with HTTP 4xx/5xx.

### `POST /runs`
```jsonc
// ordinary
{ "repo": "pelaggio", "item": "TOOL-1", "parallel": 2, "cycles": 3, "shipTarget": "pull-request", "verbose": true }
// continuous (issue #83) — omit item; mode is required
{ "repo": "pelaggio", "mode": "watch", "parallel": 2, "watchDailyBudget": 25 }
// 200
{ "id": "01HX...", "repo": "pelaggio", "item"?: "...", "mode"?: "drain"|"watch", "startedAt": "...", "logPath": "..." }
```
`repo` is a slug from the registry (`GET /repos`); unknown slugs → 400.
`shipTarget` ∈ `direct-push` | `pull-request` | `auto-merge-pr`.
`mode` ∈ `drain` | `watch` when present (omit for ordinary item runs). Continuous
forbids `item`; ordinary requires it. `watchDailyBudget` is a positive finite
number and only valid with `mode: "watch"`. `verbose` defaults off — omit or
`false` leaves argv without `--verbose`.

Supervisor argv:
- Ordinary: `--item <id>` (or `--resume` on pause-resume successor)
- Continuous: `--preset <mode>`; optional `--day-budget`, `--parallel`, `--cycles`, `--target`; never `--item`/`--resume`
- Correlation env on every spawn: `PELAGGIO_EXECUTION_ID` and `PELAGGIO_EVENT_STREAM_ID` = run ULID

### `GET /runs`
```jsonc
{ "runs": [{ "id", "repo", "item"?, "status", "startedAt", "endedAt"?, "mode"?, "activity"? }] }
```
`?repo=<slug>` filters to runs from that registry entry. Unknown slug returns `{ "runs": [] }`.

### `GET /runs/:id`
Full `PersistedRun` (see `src/types.ts`). Includes optional `mode`, `watchDailyBudget`,
`verbose`, and live `activity` (`active` | `watch-idle` | `budget-idle` | `parked`).
Activity is projected from `.dev/flow-events/<run.id>.jsonl` by the flow-event
tailer; terminal statuses clear it. 404 if unknown.

### `POST /runs/:id/pause`
Sends `SIGUSR2`. The pipeline's signal handler sets `parkSignal.parked = true; limitType = "paused"; resetsAt = 0` so the existing `parkExit()` checkpoint path runs at the next step boundary. 200 returns immediately; status update is async — poll the detail endpoint or watch SSE.

409 if the run is not `running`. Enabled for any live activity state (including watch-idle / budget-idle). When the child exits after pause, status stays `paused` (not overwritten to failed/completed).

### `POST /runs/:id/resume`
Spawns a new child reconstructing the **full original launch policy** (`mode`,
budget, parallel, cycles, shipTarget, verbose). Continuous resumes use
`--preset …` again — not `--resume` (no item claim). Ordinary resumes use
`--resume <item>`. Returns the *new* run record with `resumedFrom` pointing at
the prior run id.

### `POST /runs/:id/stop`
`SIGINT` → 5s grace → `SIGKILL`. Status becomes `abandoned`. Uncommitted diffs stay in the worktree for manual `/pickup` if the operator regrets. Stop is valid for `running` or `paused`.

### `GET /runs/:id/log`
Server-sent events. `data: <log line>\n\n` per line. For completed runs, replays the file and closes with `event: end\ndata: {"exitCode":N}\n\n`. For live runs, replay is subscribe-first: the broker captures a watermark via `bytesWritten`, replays bytes 0..watermark, then drains a buffered queue to dedup against newly-arrived lines — no race, no dropped lines.

SSE is an optional verbose diagnostic; **live idle/park state comes from activity
polling** (RunList/RunDetail 5s `getRun`), not log markers.

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

### `GET /repos/:slug/config`
```jsonc
{ "watchDailyBudget": 25 | null }
```
Narrow projection of `watch.daily-budget` from the repo's `.pelaggio.yml` for
StartForm prefill. `null` means unlimited / unset. 404 on unknown slug; 500 when
the YAML fails to load (fail visible — do not pretend unlimited).

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
CONTROL_PLANE_TOKEN=...                       # REQUIRED on every bind; bearer-gates every authority-bearing API route
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

## Review-evidence signer (harness-attested adjudication)

Signed local review evidence (#511) lets `pelaggio pr-adjudicate` clear a
findings-terminal PR after a narrow local fix by verifying a detached Ed25519
signature over the exact fleet + adjudication-source record bytes — instead of
trusting a self-servable on-disk record. **Signed auto-adjudication is a
supervised/daemon-deployment feature.** A dev-laptop run without the signer
still works: it simply posts an *unsigned* red, and `pr-adjudicate` falls back to
manual operator adjudication (the status quo before #511).

### Why an out-of-process signer

The pipeline runs Claude/Codex/Grok workers **same-UID** with an allow-all shell
and no OS isolation. A prompt-injected step can therefore walk `/proc` to a
harness ancestor's `environ` and read anything the harness holds — so if the
harness held the Ed25519 **private** key, the attacker could forge the very
evidence this feature makes unforgeable. Scrubbing the *child* env does not help;
the attacker reads the *harness* process's own `environ`.

So the harness **never holds the private key**. The key lives only in a separate
`pelaggio evidence-signer` process, reached over a unix domain socket. That
process must run **as a different UID** from the harness and its workers — that
UID boundary is what stops a same-UID peer from `ptrace`-ing the signer or
reading its `environ`. The signer signs **only** a canonical, domain-bound
evidence payload it reconstructs itself, so a caller can never get arbitrary
bytes signed. Socket reachability is **not** sufficient: every request must
present a shared authenticator the harness loads into memory from a one-shot
file (never from harness `environ`). Verification stays in the harness (the
**public** key is not secret).

### 1. Generate the keypair

```bash
# PKCS#8 Ed25519 private key (signer only) + SPKI public key (harness verify).
openssl genpkey -algorithm ed25519 -out evidence-signer.key
openssl pkey -in evidence-signer.key -pubout -out evidence-signer.pub
chmod 0400 evidence-signer.key          # signer UID must be the sole reader
# Request authenticator: signer keeps a durable copy; the harness gets a
# one-shot copy it will unlink after load (see step 3).
openssl rand -hex 32 > evidence-signer.token
chmod 0400 evidence-signer.token
```

Install `evidence-signer.key` and the signer's durable `evidence-signer.token`
readable **only** by the signer UID (the CLI refuses any key/token file with
group/other access). Keep both off the harness-visible env entirely. The
harness-readable token copy is provisioned separately at harness start and
must not be the durable signer file.

### 2. Run `evidence-signer` as a separate UID

```ini
# /etc/systemd/system/pelaggio-evidence-signer.service
[Unit]
Description=pelaggio review-evidence signing oracle
After=network.target

[Service]
Type=simple
User=pelaggio-signer                 # SEPARATE UID from the pelaggio daemon/workers
Group=pelaggio-signer                # add the harness UID to this group for socket access
StateDirectory=pelaggio-signer       # /var/lib/pelaggio-signer; persists while this unit is down
StateDirectoryMode=0750
UMask=0007
ExecStartPre=/bin/rm -f /var/lib/pelaggio-signer/evidence-signer.sock
ExecStart=/usr/bin/npx pelaggio evidence-signer \
  --socket /var/lib/pelaggio-signer/evidence-signer.sock \
  --key-file /etc/pelaggio/evidence-signer.key \
  --token-file /etc/pelaggio/evidence-signer.token
Restart=on-failure
# Belt-and-braces: keep the key and token out of the environment block;
# pass them via --key-file / --token-file.

[Install]
WantedBy=default.target
```

The signer loads the key from `--key-file` (mode 0400/0600) or, if omitted, from
its own `PELAGGIO_REVIEW_EVIDENCE_PRIVATE_KEY` env, and the request token from
`--token-file` or its own `PELAGGIO_REVIEW_EVIDENCE_SIGNER_TOKEN` env. It
refuses to start without both. It listens on the socket and returns a
base64url signature per authenticated request; SIGINT/SIGTERM close the
socket and unlink the socket file.

### 3. Point the harness at the socket + publish the pubkey

On the **pelaggio harness/daemon** side (never the signer's key or durable token
here). A root `ExecStartPre` must install a **one-shot** harness-readable copy
of the token (`+` prefix so it runs as root) that the harness UID cannot also
read from the durable signer path:

```bash
# pelaggio.service ExecStartPre (the `+` runs this as root):
#   +/usr/bin/install -m 0400 -o pelaggio /etc/pelaggio/evidence-signer.token \
#     /run/pelaggio/evidence-signer.token

# ~/.config/pelaggio-server.env  (or the harness's environment)
PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET=/var/lib/pelaggio-signer/evidence-signer.sock
PELAGGIO_REVIEW_EVIDENCE_SIGNER_TOKEN_FILE=/run/pelaggio/evidence-signer.token
# EnvironmentFile does not perform shell substitution. Paste the public PEM as
# one double-quoted, multiline value; systemd preserves the embedded newlines.
PELAGGIO_REVIEW_EVIDENCE_PUBKEY="-----BEGIN PUBLIC KEY-----
<base64 body from /etc/pelaggio/evidence-signer.pub>
-----END PUBLIC KEY-----"
```

Replace the placeholder line with the base64 body from the generated public-key
file. The quotes and real line breaks are part of the `EnvironmentFile` value;
do not replace it with `$(cat ...)`, because systemd does not run a shell while
parsing `EnvironmentFile`.

The harness must be able to **connect** to the socket (grant the harness UID
access via the socket's group and directory permissions) but never needs the
key. It reads the token file into memory during harness initialization, before
any worker starts, and **unlinks** it so the value is not in `environ` and does
not remain on a same-UID-readable path while workers exist. With the socket and
token set, a completed local red review posts a signed red status; without
either, the review posts an unsigned red and adjudication stays manual.
If the token-file variable is present but the file is missing, accessible to
group/other, unreadable, too short, or cannot be unlinked, harness startup aborts
before any worker starts; remove the variable to opt out of signing.

The socket's **parent directory must continue to exist while the signer is
stopped**. Do not substitute systemd `RuntimeDirectory=` here: systemd removes
runtime directories when their unit stops. Claude confinement preflight
validates the configured socket-parent mount before every Claude seat; a
missing parent therefore produces `error_confinement` for every Claude step,
not merely an unavailable signer. `StateDirectory=` is persistent across unit
stops, so signer downtime keeps Claude usable and degrades only evidence
signing (unsigned red, then manual adjudication).

**Known limitation (#568):** the harness token file is one-shot. A long-lived
daemon does not currently mint a fresh per-run authenticator: its first pipeline
child loads and unlinks the file, and every later run posts unsigned evidence
until an operator reprovisions the file. Those later red reviews remain blocking
and require manual adjudication. #568 tracks the durable token/per-run brokering
design; do not treat the one-shot file as multi-run daemon provisioning.

`PELAGGIO_REVIEW_EVIDENCE_PRIVATE_KEY` and
`PELAGGIO_REVIEW_EVIDENCE_SIGNER_TOKEN` belong to the **signer process only**.
They remain in the harness's `HARNESS_ONLY_ENV_DENY` deny-list (and the Claude
subprocess env scrub) as defense-in-depth, but that scrubbing is **no longer
load-bearing** for the private key — the harness simply has no key to leak.
The socket path and token-file path are withheld from worker subprocesses for
the same defense-in-depth reason. The load-bearing controls are: the signer
refuses unauthenticated or non-canonical requests, and the record store the
signature binds to is harness-write-guarded.

## Bearer-token auth

`loadServerConfig()` **fails closed** whenever `CONTROL_PLANE_TOKEN` is unset,
including on loopback. Every authority-bearing API route requires
`Authorization: Bearer <token>`; `/healthz`, the public trust manifest, and the
static UI shell carry no run authority and remain public. The middleware's
token parameter is also required by type, so alternate app-factory callers
cannot instantiate an unauthenticated API. Live deployments can bind the daemon
to a tailnet-only interface and front it with Cloudflare Tunnel (see below).
Comparison uses `crypto.timingSafeEqual` and rejects length mismatches before
the compare so attackers can't probe length via timing.

Rotate the token by editing `~/.config/pelaggio-server.env` and running
`systemctl --user restart pelaggio-server`. SSE streams reconnect with the
new token on the next page load.

## Tailnet bind

`AUTOPILOT_SERVER_HOST=0.0.0.0` (and its IPv6 wildcard equivalent `::`) is
rejected at startup. The intent is that deploy environments specify the
tailnet interface explicitly. Local dev can use `127.0.0.1`.

Every bind, including loopback (`127.0.0.1`, `localhost`, `::1`), requires
`CONTROL_PLANE_TOKEN`. There is deliberately no unauthenticated local-dev flag:
a hostile webpage can reach a loopback HTTP endpoint, and this daemon can spawn
credential-inheriting autonomous runs. Set a development token before starting
the daemon and enter the same token in the web UI.

## Serving the web UI

The daemon optionally serves `@pelaggio/web` from the same
process. `AUTOPILOT_SERVER_WEB_DIST` (default `${repo}/packages/web/dist`) names
the build output. If the path is missing, the daemon boots without the static
handler — pre-build deploys still come up.

Static serving is unauthenticated but bounded to the configured `webDist`
directory: pointing `AUTOPILOT_SERVER_WEB_DIST` at a broader directory would
publish those files without auth (operator-controlled).

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
