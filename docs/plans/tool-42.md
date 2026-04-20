# TOOL-42 — Autopilot control-plane web UI (Astro + React + Tailwind, mobile-responsive PWA)

**Depends on:** TOOL-39 (shipped on `main` as `packages/server/`). This branch was cut from `main` before TOOL-39 merged, so **step 0 is to rebase `feat/tool-42` onto `main`** to pick up the daemon. Nothing here is buildable until that's done.

## Scope

**In:**
- New `packages/web/` workspace: Astro 5 + React 19 + Tailwind v4 + TypeScript, static output.
- Four live views — run list, run detail (with SSE log pane + pause/resume/stop), start form (roadmap picker), stats dashboard.
- PWA manifest (no service worker — deliverable explicitly forbids caching).
- Dev proxy so `astro dev` forwards API calls to the tailnet daemon.
- A thin change to `packages/server/` to serve the built UI from the daemon (Hono `serveStatic` mounted after API routes).
- One new server types export entry so web can `import type { PersistedRun, RunSummary }` without importing runtime.
- Root config widening (biome, CI, deploy, `.gitignore`) and a docs update.

**Out:**
- Bearer-token entry flow — TOOL-43. Design fetch/SSE wrappers so bearer attachment is a one-line change, but ship without token UX.
- Push notifications — separate follow-up.
- Theming / dark-mode polish — minimal readable default only.
- Multi-operator UX.
- Touching the pipeline, step list, `config.ts`, or any skill body. None needed.

## Approach

### Stack rationale

- **Astro 5 for the shell, React 19 islands for live views.** Open question in the charter: "Astro server islands vs. pure client React for live-updating views." Server islands poll on an interval, which is the wrong semantics for SSE-driven content. Pure client React islands with `client:load` own the live state; Astro just hosts the routing and layout. That matches the charter's "SSE + React hooks probably wins."
- **Tailwind v4** — CSS-first, no `tailwind.config.ts`. One `@import "tailwindcss";` in `src/styles/global.css` and the Vite plugin. One less config file than v3.
- **No state manager, no React Query.** Four views, simple data flow, plain hooks + fetch. The rubric's **Concise** dimension rejects configurability nobody asked for.
- **Fetch-based SSE reader, not browser `EventSource`.** Browser `EventSource` can't attach an `Authorization` header, which TOOL-43 requires. Using a small fetch + `ReadableStream` reader from the start avoids a rewrite. ~40 lines in `src/lib/sse.ts`.

### URL namespace: web under `/ui/`

The daemon's API routes (`/runs`, `/runs/:id`, `/stats`, `/roadmap`) collide with what would be natural web page paths. Hono matches in registration order, so without a prefix, `GET /runs/:id` and `GET /stats` return JSON and the web pages never render. Two fixes considered: (a) rename API routes under `/api/*` — breaks TOOL-39's already-shipped contract; (b) mount the web under `/ui/*`. We pick (b): zero API churn, self-scoping PWA, trivial to reason about.

- **Astro `base: "/ui/"`** in `astro.config.mjs`. Astro keeps output at `dist/` but emits all internal links / asset URLs as `/ui/...`. Pages live at `/ui/`, `/ui/runs/:id`, `/ui/start`, `/ui/stats`.
- **PWA manifest** `scope: "/ui/"`, `start_url: "/ui/"` — home-screen install opens the namespaced root.
- **Daemon static mount** (below) uses `/ui/*` with a path-rewrite that strips the prefix before resolving against `dist/`.
- **Root `/`** returns 404 (or a 302 to `/ui/` — cheap one-liner, we'll include it for operator ergonomics).

### Serving in prod vs. dev

- **Prod:** Astro builds to `packages/web/dist/`. Hono's `serveStatic` (from `@hono/node-server/serve-static`, already a transitive dep) is mounted in `src/app.ts` **after** every API route as `app.get("/ui/*", serveStatic({ root: webDist, rewriteRequestPath: (p) => p.replace(/^\/ui/, "") || "/" }))`. API routes (`/runs`, `/roadmap`, `/stats`, `/healthz`) are registered first and live outside `/ui/`; no path overlap, no ordering fragility. SPA-style fallback to `/index.html` for unknown paths is Astro static's default behavior (every route has its own generated `.html`), so no manual rewrite beyond the prefix strip.
- **Dev:** `astro dev` at port 4321 with `base: "/ui/"` (so dev URLs match prod) and `vite.server.proxy` forwarding `/runs`, `/roadmap`, `/stats`, `/healthz` to the tailnet daemon's `AUTOPILOT_SERVER_HOST:AUTOPILOT_SERVER_PORT`. SSE works over the Vite proxy out of the box (Vite uses `http-proxy` which passes through `text/event-stream`).

### Daemon contract (already on `main`)

Verified by reading `main:packages/server/src/routes/*.ts` and `main:docs/server.md`:

- `GET /runs` → `{ runs: RunSummary[] }` — `{ id, item, status, startedAt, endedAt? }`.
- `GET /runs/:id` → full `PersistedRun`.
- `POST /runs` → body `{ item, parallel?, cycles?, shipTarget? }`, returns `{ id, item, startedAt, logPath }`.
- `POST /runs/:id/pause|resume|stop` — 200 with `{ id, status, ... }`, 409 on wrong state.
- `GET /runs/:id/log` — SSE, `data: <line>\n\n`, ends with `event: end; data: {"exitCode":N}` for completed runs.
- `GET /roadmap` → `{ source, items: RoadmapItem[] }` (open items).
- `GET /stats` → `Stats` (shape in `packages/autopilot/scripts/autopilot/stats.ts`).
- `GET /healthz` — unauthenticated.

Types (`RunSummary`, `PersistedRun`, `RunStatus`, `ShipTargetName`) live in `packages/server/src/types.ts`. `RoadmapItem` and `Stats` are already exported from `@cdhorne/claude-autopilot`. Server types aren't currently exported through the package's `exports` map; that's a one-line addition (see "Files to change").

## Files to change

### New — `packages/web/`

- **`package.json`** — `@cdhorne/claude-autopilot-web`, `private: true`, `type: "module"`. Dependencies: `astro`, `@astrojs/react`, `@tailwindcss/vite`, `tailwindcss`, `react`, `react-dom`. Dev deps: `tsx`, `@types/react`, `@types/react-dom`, `@resvg/resvg-js` (icon rasterization at build time; zero runtime cost). Workspace deps (type-only, imported via `import type`): `"@cdhorne/claude-autopilot-server": "workspace:*"`, `"@cdhorne/claude-autopilot": "workspace:*"`. Scripts: `dev` (`astro dev`), `build` (`tsx scripts/gen-icons.ts && astro build`), `test` (`tsx --test __tests__/*.test.ts`), `check:types` (`astro check`).
- **`astro.config.mjs`** — output `static`, `base: "/ui/"`, `trailingSlash: "always"` (matches Astro static's `*/index.html` output so dev and prod resolve identically), integrations `[react()]`, Vite plugins `[tailwindcss()]`, `server.proxy` populated from env (`AUTOPILOT_SERVER_URL` default `http://127.0.0.1:7777`).
- **`tsconfig.json`** — extends `../../tsconfig.base.json`; adds `"jsx": "react-jsx"` and `"lib": ["ES2024", "DOM", "DOM.Iterable"]`.
- **`src/layouts/Base.astro`** — HTML shell, `<link rel="manifest">`, `<meta name="theme-color">`, viewport meta, imports global CSS. Nav component.
- **`src/pages/index.astro`** — mounts `<RunList client:load />`.
- **`src/pages/runs/[id].astro`** — reads `Astro.params.id`, mounts `<RunDetail id={...} client:load />`.
- **`src/pages/start.astro`** — mounts `<StartForm client:load />`.
- **`src/pages/stats.astro`** — mounts `<StatsView client:load />`.
- **`src/components/RunList.tsx`** — `useEffect` polls `GET /runs` every 5s; table with item, step (via `lastStep`), status badge, started-at, ended-at. Row `<a href="/runs/${id}">`. Touch targets ≥ 44px via Tailwind utilities (`py-3` rows, `min-h-[44px]` on links).
- **`src/components/RunDetail.tsx`** — fetches `/runs/:id`, renders fields, mounts `<LogStream id={id} />`, shows action buttons (`pause` if `running`, `resume` if `paused|parked`, `stop` if `running|paused`). Buttons confirm via `window.confirm` (deliberate — simple, avoids modal lib). Post-action, refetches detail.
- **`src/components/StartForm.tsx`** — fetches `/roadmap` on mount, renders `<select>` of open items (label `ID — title`), optional inputs for `parallel`/`cycles`/`shipTarget`, POSTs to `/runs`, redirects to `/runs/:id` on success.
- **`src/components/StatsView.tsx`** — fetches `/stats`, renders totals (cost, tokens, cache-hit ratio), per-step tables (avg retries, rethink rate, cost), recent failures, items delivered.
- **`src/components/LogStream.tsx`** — mounts `<pre>` + virtualized-ish tail (last 500 lines kept in a ring buffer to cap DOM). Uses `sse.ts` to subscribe; renders "connection lost" + retry button on stream close when `exitCode` is undefined. Auto-scrolls unless user has scrolled up (detect via `scrollTop + clientHeight < scrollHeight - 20`).
- **`src/lib/api.ts`** — typed endpoint functions (`listRuns`, `getRun`, `startRun`, `pauseRun`, `resumeRun`, `stopRun`, `getRoadmap`, `getStats`). Wraps `fetch` with a `fetchJson<T>(path, init)` helper that throws a typed `ApiError` for non-2xx. Types imported from `@cdhorne/claude-autopilot-server` (via new `./types` export entry) and `@cdhorne/claude-autopilot` (existing `Stats`, `RoadmapItem`).
- **`src/lib/format.ts`** — pure formatters: `formatDate`, `formatDuration`, `formatUsd`, `formatTokens`, `statusBadgeClass(status)`.
- **`src/lib/sse.ts`** — `subscribeSse(url, { onLine, onEnd, onError, signal })`. Fetches with `Accept: text/event-stream`, reads `response.body` via `ReadableStream.getReader()`, buffers text, splits on `\n\n`, parses `data:` / `event:` lines. Honors `signal` for cancellation. Exposes a seam — an optional `headers` argument so TOOL-43 can inject `Authorization: Bearer ...` without rewriting.
- **`src/styles/global.css`** — `@import "tailwindcss";` plus a handful of base element resets.
- **`public/manifest.webmanifest`** — `name`, `short_name`, `display: "standalone"`, `theme_color`, `background_color`, `scope: "/ui/"`, `start_url: "/ui/"`, `icons` (192 + 512 PNGs plus an SVG fallback).
- **`public/icon.svg`** — single-letter monochrome source icon (checked in; operator can swap).
- **`scripts/gen-icons.ts`** — rasterizes `public/icon.svg` to `public/icon-192.png`, `public/icon-512.png`, and `public/apple-touch-icon.png` using `@resvg/resvg-js`. Runs as the first step of the `build` script (`tsx scripts/gen-icons.ts && astro build`). PNGs are gitignored — generated deterministically at build time so the implement step only needs to write the SVG source and the script (text files), never binaries.
- **`__tests__/api.test.ts`** — mock `globalThis.fetch`; assert URL construction, JSON body handling, `ApiError` on 4xx/5xx.
- **`__tests__/format.test.ts`** — unit tests for every formatter: edge cases on empty/zero/large values.
- **`__tests__/sse.test.ts`** — mock fetch with a streamed body; assert line splitting across chunk boundaries, `event: end` handling, `signal` abort.
- **`README.md`** — quickstart: `pnpm --filter @cdhorne/claude-autopilot-web dev`, `AUTOPILOT_SERVER_URL` env var, build + serve via daemon.

### Modified — `packages/server/`

- **`src/app.ts`** — add `webDist?: string` to `AppDeps`. After the guarded routes are attached, if `webDist` is set: `app.get("/ui/*", serveStatic({ root: webDist, rewriteRequestPath: (p) => p.replace(/^\/ui/, "") || "/" }))`, plus `app.get("/", (c) => c.redirect("/ui/", 302))` for operator ergonomics. Import `serveStatic` from `@hono/node-server/serve-static`. Keep `/healthz` outside the guarded group unchanged.
- **`src/config.ts`** — read `AUTOPILOT_SERVER_WEB_DIST` (optional). If unset, default to `resolve(repo, "packages/web/dist")`. Emit it as `webDist: string | undefined` — `undefined` means "UI not built yet, skip static handler" so pre-build deploys don't 500. Add a one-line unit test.
- **`scripts/server.ts`** — pass `webDist: cfg.webDist` into `createApp`.
- **`package.json`** — add an `exports` map: `{ "./types": { "types": "./src/types.ts", "default": "./src/types.ts" } }`. Package is `private: true` so no `files` key is needed; the subpath export is purely for TypeScript resolution under NodeNext from the web workspace.
- **`__tests__/app.test.ts`** — add tests: (a) static handler returns `dist/index.html` when hit at `/ui/` with `webDist` pointing at a fixture dir; (b) API routes stay JSON (GET `/runs` returns JSON, GET `/stats` returns JSON — confirming no collision); (c) GET `/` returns a 302 to `/ui/` when `webDist` is set; (d) no static handler and no redirect when `webDist` is `undefined` (daemon boots pre-build).

### Modified — root

- **`pnpm-workspace.yaml`** — no change needed (already `packages/*`).
- **`biome.json`** — widen `files.includes` to `["packages/*/scripts/**/*.ts", "packages/*/src/**/*.{ts,tsx}", "packages/*/__tests__/**/*.{ts,tsx}", "packages/*/*.config.{ts,mjs,js}", "scripts/**/*.ts"]`. Drive-by fix: current config misses `packages/server/src/**` too — fixing that here is in scope because the widening is a single-line change touching an already-modified line.
- **`.github/workflows/ci.yml`** — after `pnpm -r test`, add `pnpm --filter @cdhorne/claude-autopilot-web build` so the Astro build is verified in CI. Also ensure `pnpm check:types` runs if added.
- **`.github/workflows/deploy-server.yml`** — add `packages/web/**` to the `paths:` filter so UI-only changes still trigger a deploy (otherwise the tailnet UI silently goes stale when server+autopilot are untouched). Between install and systemctl restart, run `pnpm --filter @cdhorne/claude-autopilot-web build` so the daemon restart picks up the latest UI. No new systemd unit for the web package.
- **`.gitignore`** — add `packages/web/dist/`, `packages/web/.astro/`, `packages/web/public/icon-*.png`, `packages/web/public/apple-touch-icon.png` (generated at build time from `icon.svg`), and `packages/*/node_modules/` (if not already covered).
- **`docs/server.md`** — append "Serving the web UI" subsection: `AUTOPILOT_SERVER_WEB_DIST` env (default), dev-proxy setup, how the static handler interacts with API routes.
- **`CLAUDE.md`** — Orientation section: mention `packages/web/` (Astro 5 + React 19 + Tailwind v4, static output served by the daemon). One new line under the package list; no other edits.

### `.autopilot.yml` / `config.ts` — **no changes**

TOOL-42 adds no pipeline steps, no model profiles, no budgets, no skill changes. The rubric's step-exhaustiveness invariant is untouched.

## Test strategy

Unit (runs in CI via `pnpm -r test`):

- `packages/web/__tests__/api.test.ts` — endpoint URL + body + error mapping.
- `packages/web/__tests__/format.test.ts` — all pure formatters.
- `packages/web/__tests__/sse.test.ts` — chunk-boundary line splits, `end` event, abort.
- `packages/server/__tests__/app.test.ts` — static handler + API-precedence + `webDist: undefined` fallback.

Build verification (CI):

- `pnpm --filter @cdhorne/claude-autopilot-web build` — catches Astro / React / Tailwind regressions.
- `pnpm check` — biome over new TS/TSX.
- `pnpm check:skills`, `pnpm check:roadmap`, `pnpm check:publish` — unchanged; should stay green.

UI component tests are **deliberately out of scope**. Rubric scope today is "TypeScript CLI pipeline ... No UI, no user-facing surface." Extending to UI testing would require adopting a headless-DOM lib (jsdom, happy-dom, testing-library) — a meaningful new dependency surface that nobody has asked for. Pure helpers get unit tests; UI correctness is covered by the smoke test.

Manual smoke (recorded in plan, not automated):

1. Rebase branch onto `main`, `pnpm install`.
2. Start daemon locally: `AUTOPILOT_SERVER_HOST=127.0.0.1 AUTOPILOT_SERVER_PORT=7777 AUTOPILOT_REPO=$PWD pnpm --filter @cdhorne/claude-autopilot-server start`.
3. `pnpm --filter @cdhorne/claude-autopilot-web dev`, hit `http://localhost:4321/`.
4. Start a run from `/start`, navigate to `/runs/:id`, verify SSE lines stream in, pause, resume, stop.
5. Hit `/stats`, verify values match `pnpm autopilot stats --json`.
6. Build web, restart daemon with `AUTOPILOT_SERVER_WEB_DIST=$PWD/packages/web/dist`, load the daemon URL at `/ui/` directly — same flows work without the dev proxy. Also confirm `curl $DAEMON/runs` still returns JSON (no collision with `/ui/*`) and `curl -L $DAEMON/` 302s to `/ui/`.
7. On a phone over Tailscale: install to home screen from Safari/Chrome (via `/ui/`), verify PWA shell, run the same flows on touch.

## Rubric self-check

**Well-typed** — No `any`. Endpoint types come from `@cdhorne/claude-autopilot-server` via a new `./types` export entry; `Stats` and `RoadmapItem` come from `@cdhorne/claude-autopilot`'s existing public surface. `fetchJson<T>` generic; `ApiError` is a discriminated type. Component props and state fully typed. TSC via `astro check` or an explicit `tsc --noEmit` script catches drift.

**Well-tested** — Pure helpers (API client, formatters, SSE reader) have unit tests. UI correctness is covered by manual smoke — matches the rubric's stance that integration is fair to leave uncovered when the surface is hard to mock.

**Well-factored** — Clean module boundaries: `src/pages/` thin, `src/components/` own views, `src/lib/` pure. Server changes are confined to `app.ts` / `config.ts` / `scripts/server.ts` / `package.json`; no cross-cutting refactor. Types flow one direction (server → web) via the new export entry; web never imports server runtime.

**Idiomatic** — Biome-clean (tabs, double quotes, trailing commas), `useImportType`, no default exports, `.js` relative imports, named exports only. React 19 function components + hooks, no legacy lifecycle. Astro 5 islands via `client:load`. Tailwind v4 CSS-first (no config file).

**Idioms** — Defer to `/shakedown`. Flagging for its review: the fetch-based SSE reader (chosen over `EventSource` for TOOL-43 compat — is the tradeoff right given we pay ~40 lines upfront?); the Astro islands vs. server-islands pick; `window.confirm` over a confirm modal.

**Correct** — Load-bearing invariants:
- **Step exhaustiveness** — N/A, no pipeline touch.
- **Frontmatter stripping** — N/A, no skill touch.
- **Worktree isolation** — N/A, no step-runner touch.
- **Plan-polish block** — this plan itself is the only `docs/plans/` write; `/implement` will write code elsewhere.
- **Phantom ship guard** — not a doc-only cycle; we add code in `packages/web/` and `packages/server/`.
- **URL namespace separation** — API is at bare roots (`/runs`, `/stats`, `/roadmap`); web is confined to `/ui/*` via Astro `base` + Hono static mount. Prevents both directions of collision (API eating web pages, static eating API). Verified by test (b) above.
- **Static handler must not swallow API routes** — static is registered with `app.get("/ui/*", ...)` after `app.route("/", guarded)`; the `/ui/` prefix guarantees no overlap with any current or plausibly-added API route.
- **Daemon must boot when UI isn't built yet** — `webDist: undefined` skips the static handler (CI deploy order is install → test → build web → restart; any restart between those steps must still come up).
- **No hardcoded model strings** — N/A, no model touch.
- **No install-script hooks in `package.json`** — `check:publish` still enforces; we add none.
- **Tailnet bind stays intact** — server `config.ts` still refuses `0.0.0.0`; we only add one new env.

**Concise** — No state lib, no React Query, no Zustand, no confirm-modal lib, no toast lib. Four views, four components, three lib files. PWA is a manifest, not a service worker. Server change is ~15 lines across four files.

## Assumptions

- TOOL-39's daemon API on `main` is frozen; this plan reads it as a public contract. If TOOL-39 changes shape during rebase, the web API client needs a matching edit — cheap, localized to `src/lib/api.ts`.
- `@hono/node-server` already in the daemon's dep tree exports `serveStatic` via `@hono/node-server/serve-static`. Verified against v1.13 docs; pin the existing version.
- PWA install on iOS Safari works without a service worker. Apple's "Add to Home Screen" has worked without one since iOS 16.4; we ship a manifest + icons and rely on that. No offline story.
- Tailwind v4 Vite plugin is the supported path; no PostCSS config needed. Verified against Tailwind v4.x release notes.
- React 19 + Astro 5 `@astrojs/react` integration supports `client:load` with `use()` and modern hooks.

## Open questions (flagged, not blockers)

- **Auto-refresh cadence for `/`**: 5s feels right for a tailnet-local dashboard; heavier than `/stats` which can poll 30s. If the daemon starts to feel the polling load when many runs exist, switch `/` to an SSE `/runs/events` stream — but that's a daemon-side change, out of scope for TOOL-42.
- **Icons**: I'll generate minimal monochrome placeholders. Operator is expected to drop in real artwork if they care; the PWA flow doesn't depend on art quality.

---

When the plan is approved: rebase onto `main`, then `/implement`.
