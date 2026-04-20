# @cdhorne/claude-autopilot-web

Mobile-responsive web UI for the autopilot control-plane daemon. Astro 5 + React 19 + Tailwind v4. Static output, served by the daemon at `/ui/`. Manifest-based PWA — install to home screen on iOS/Android, no service worker.

## Develop

```bash
# Daemon must be running on a tailnet IP (default http://127.0.0.1:7777).
AUTOPILOT_SERVER_URL=http://127.0.0.1:7777 \
  pnpm --filter @cdhorne/claude-autopilot-web dev
```

`astro dev` listens at `http://localhost:4321/ui/`. Vite proxies `/runs`, `/roadmap`, `/stats`, and `/healthz` to the daemon — SSE works through the proxy.

## Build & deploy

```bash
pnpm --filter @cdhorne/claude-autopilot-web build
```

Builds to `packages/web/dist/`. Restart the daemon (or set `AUTOPILOT_SERVER_WEB_DIST=$PWD/packages/web/dist`) to pick up the new bundle. The daemon redirects `/` → `/ui/` when `webDist` is set.

## Test

```bash
pnpm --filter @cdhorne/claude-autopilot-web test
pnpm --filter @cdhorne/claude-autopilot-web check:types
```

UI components are exercised via the manual smoke flow in `docs/plans/tool-42.md`. Pure helpers (api, format, sse) have unit tests under `__tests__/`.
