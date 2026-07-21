# Spike: contained-execution — isolation leg (#254, spike 1)

Proof-of-mechanism for the design in `docs/agent-context/contained-execution.md`. Validates the
**isolation half** of spike 1 (the credential/real-CLI leg is deferred — see below). Not production
code; the `broker.mjs` policy engine is the seed of the eventual host-side broker.

## What it proves

A rootless-Podman container run with **`--network=none`** and *only* a host **unix-socket broker**
mounted is airtight: the agent has no direct egress and no reusable credential, and reaches
providers only through a broker that terminates auth, enforces a request-shape policy, and strips
secrets from responses.

Run: `node spikes/contained-execution/run.mjs` (needs `podman` + the `node:20-alpine` image). It
starts a fake upstream + the broker on the host, then runs the hostile probe (`test.mjs`) inside a
`--network=none` container. Expected: **12/12 checks pass**.

| Check | Result |
|---|---|
| Raw TCP to `1.1.1.1:443` | blocked (`ENETUNREACH`) |
| Raw TCP to host upstream `127.0.0.1:9099` | blocked (`ECONNREFUSED`) |
| DNS resolution | blocked (`EAI_AGAIN`) |
| Credential files / host token in container | absent |
| `POST /v1/messages` (allowlisted) | 200 |
| `GET /v1/admin/keys`, `DELETE /v1/messages` (not allowed) | 403 |
| Host token echoed by upstream in body | redacted → `Bearer [REDACTED]` |
| `Set-Cookie` / redirect `Location` from upstream | stripped |
| Flood beyond the call cap | 429 (fail-closed) |

## Findings that feed the build

1. **`--network=none` + a mounted unix socket beats egress-filtering.** No rootless
   `pasta`/`slirp4netns` allowlist is needed — the container simply has no network, and its only
   path out is the socket. This resolves the reviewers' "egress allowlist is unenforceable under
   rootless Podman" blocker by avoiding the problem entirely.
2. **The broker must redact its *own injected* credential from response *bodies*, not just headers.**
   The upstream echoed the `Authorization` the broker injected (`sawAuth`); header-stripping alone
   would have leaked it. Redacting the known injected secret works; the general "provider reflects
   arbitrary repo content" body channel remains the acknowledged residual.
3. **`sockaddr_un.sun_path` is capped at 108 bytes** — the socket must live at a *short* host path
   (the session scratchpad path alone exceeds it and yields a bogus `EADDRINUSE`). Operational
   constraint for the real `run-contained`.

## Subscription-CLI leg — PROVEN end-to-end (no API key)

Second half of spike 1: a **real subscription grok**, in a `--network=none` container, making a
**real model call** through a host re-originating gateway. Per the product thesis (avoid API keys,
prefer subscription-backed), this uses grok's own subscription auth — no key, no MITM.

Files: `grok-broker.mjs` (host gateway → real `cli-chat-proxy.grok.com/v1`, path-allowlist +
`/responses` spend cap), `grok-e2e.mjs` (orchestrator), `grok-image/Containerfile` (alpine + `socat`
+ the static grok binary), `capture.mjs` / `grok-capture-acp.mjs` (request-shape probes).

Setup (one-time): build the image (`cp ~/.grok/bin/grok grok-image/grok && podman build -t
pelaggio-grok grok-image`), then authorize a **per-env** login into an isolated volume —
`podman volume create grok-auth && podman run --rm -v grok-auth:/root/.grok pelaggio-grok grok login
--device-auth` (device-code; auth lands in the volume, never `~/.grok`). Run: `npx tsx grok-e2e.mjs`.

Result: **PASS** — `stopReason: end_turn`, `answer: "PONG"`. Gateway log shows `ALLOW GET /models
→200`, `/settings→200`, `POST /responses→200` (the real model call) and **`DENY`** for grok's
non-allowlisted paths (`/mcp/tools/list`, `/sessions/*/signals`, `/sessions/*/turn-deltas`) — the
policy actively restricts what the contained CLI can reach on the provider.

### Findings

4. **grok accepts a plain-`http://` base URL** via `grok agent --cli-chat-proxy-base-url <url>` (the
   flag is on `grok agent`, *before* the `stdio` subcommand; top-level `grok -p` doesn't take it) —
   so the gateway needs **no TLS/MITM**. Env `GROK_CLI_CHAT_PROXY_BASE_URL` is the alternative.
5. **The real default base is `https://cli-chat-proxy.grok.com/v1`** — the override drops the `/v1`,
   so the gateway re-adds it when forwarding. grok's request shape: bootstrap `GET /models`,
   `/settings`, … then the model call is `POST /responses`.
6. **Subscription auth reconciles with the security review under `--network=none`.** grok holds its
   own token and sends it to the gateway; the gateway forwards to the real provider under a
   path-allowlist + caps. Because the container has no other egress, the token can reach *nothing*
   but the real provider — so a readable token is not exfil-able, and abuse is bounded by policy.
   API keys were the reviewers' shortcut; network isolation gets the same safety *with* subscription.
7. **The grok binary is a 147 MB fully-static ELF** → runs on any base (alpine used); the host drives
   grok's ACP over `podman -i` stdio, so no runtime is needed *inside* the container beyond `socat`.

### Remaining hardening (not spike blockers)
Tighten the gateway's provider-path allowlist (allow the telemetry/session paths grok actually needs
vs. deny by default); wire the gateway + `run-contained` into the real step-provider seam; per-env
subscription accounts; response-body redaction of any harness-injected secret (n/a here since grok
holds its own token).
