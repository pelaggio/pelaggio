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

## Deferred (the credential / real-CLI leg — "cred later")

The probe uses a Node HTTP-over-unix-socket client. Real provider CLIs speak **TCP/HTTPS**, so the
unix-socket boundary needs a bridge — the design's **auth-termination mechanism choice**: (a) a
localhost re-originating endpoint the CLI is pointed at via `HTTPS_PROXY`, (b) MITM with an injected
CA + header rewrite, or (c) forcing SDK/ACP. Proving one end-to-end against a real CLI (with a
spend-capped API key) is the remaining spike-1 work.
