# @pelaggio/server

The control-plane daemon for supervised Pelaggio runs — a private, unpublished workspace
package.

A [Hono](https://hono.dev/) service that starts, watches, and steers pipeline runs, and
serves the static web UI (`packages/web`) under `/ui/`. The daemon is an authenticated
authority boundary: `CONTROL_PLANE_TOKEN` is required on every bind, **including
loopback** — only non-authority surfaces (health, the public trust manifest at
`/.well-known/pelaggio.trust.json`, and the static UI shell) bypass bearer auth.

Setup, API, and deployment: [`docs/server.md`](../../docs/server.md).
