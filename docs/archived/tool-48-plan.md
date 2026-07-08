# TOOL-48. Multi-repo control plane

## Scope

Today the server pins to a single `AUTOPILOT_REPO`. `ServerConfig.repo`
threads through `loadConfig({ repo })`, `getRoadmapSource({ repo })`,
`StateStore(cfg.statePath)`, `Supervisor({ repoCwd, logDir })`, and all
routes. One daemon instance = one repo, so dogfooding autopilot *on*
autopilot while the daemon points at a consumer repo needs a second
instance on a different port.

**In scope:**

- Parse `AUTOPILOT_REPOS` as a comma-separated list of `slug=path` or bare
  `path` entries (basename → slug when bare). Keep `AUTOPILOT_REPO` working
  as a single-entry fallback.
- One `StateStore`, `Supervisor`, `RoadmapSource`, and autopilot
  `loadConfig` per configured repo, held in a `RepoRegistry` keyed by slug.
  Per-repo state files and log dirs (`${repo}/.dev/server-state.json`,
  `${repo}/.dev/server-logs`) — the existing convention extended per repo.
- Route-level repo resolution: `?repo=<slug>` query param or
  `X-Autopilot-Repo` header. When exactly one repo is configured, omitting
  the selector resolves to that repo (backwards compat). When zero or
  multiple match and nothing is supplied, respond `400 repo-required`.
- New `GET /repos` endpoint returning `{ repos: [{ slug, path }] }` for the
  UI switcher. Bearer-protected like the rest.
- UI repo switcher in `Base.astro` nav: fetch `/repos`, persist selected
  slug in `localStorage`, inject `X-Autopilot-Repo` on every API call.
- Backwards compat: untouched env (`AUTOPILOT_REPO` only) behaves
  identically to today — same state path, same log dir, no slug in URLs.

**Out of scope:**

- Per-repo auth tokens — single `CONTROL_PLANE_TOKEN` continues to gate all
  repos (matches TOOL-43's model; a future TOOL can split them).
- Cross-repo aggregation (e.g. "list runs across all repos"). Every route
  stays scoped to one repo.
- Migration of existing single-repo `server-state.json` — file location
  doesn't change in the backwards-compat path, so existing deployments keep
  running untouched.
- Multi-repo deployment automation (systemd unit file changes beyond
  documenting the new env var). The unit already sources
  `~/.config/autopilot-server.env`; that file just needs `AUTOPILOT_REPOS=`
  instead of `AUTOPILOT_REPO=` and we're done.

## Approach

**Config parsing — comma-sep with optional slugging.** Syntax:

```
AUTOPILOT_REPOS="/path/to/repo-a,/path/to/repo-b"          # slug = basename
AUTOPILOT_REPOS="autopilot=/path/one,consumer=/path/two"   # explicit slug
```

Slugs validated against `/^[a-z0-9][a-z0-9-]{0,62}$/`. Duplicate slugs
(whether auto-derived or explicit) → fail at startup with the offending
paths listed. `AUTOPILOT_REPO` is accepted only when `AUTOPILOT_REPOS` is
absent; the two together is a hard error to avoid ambiguity. Exactly one
of the two must be set.

**Why not JSON or a config file?** The only value we need per entry is
`slug + path`. Comma-separated with `=` matches the existing
`AUTOPILOT_REPO` ergonomic (single env var, no extra file), and the syntax
is short enough for a systemd `EnvironmentFile`.

**ServerConfig shape.** Replace singular `repo`/`statePath`/`logDir` with
`repos: RepoEntry[]` where `RepoEntry = { slug, path, statePath, logDir }`.
`webDist` stays singular — UI bundle is server-level, not per-repo. Default
resolution walks the repo list and uses the first `${repo}/packages/web/dist`
that exists, matching today's "dogfood from the autopilot repo" behavior.
Explicit `AUTOPILOT_SERVER_WEB_DIST` still wins.

The single-repo env overrides `AUTOPILOT_SERVER_STATE_PATH` and
`AUTOPILOT_SERVER_LOG_DIR` only apply when exactly one repo is configured
(their historical contract). In multi-repo mode they're rejected at
startup with a clear error pointing at per-repo defaults.

**RepoRegistry.** A thin holder keyed by slug:

```ts
interface RepoServices {
  entry: RepoEntry;
  store: StateStore;
  supervisor: Supervisor;
  roadmap: RoadmapSource;
  computeStats: () => Stats;
}
class RepoRegistry {
  get(slug: string): RepoServices | null;
  list(): RepoServices[];
  default(): RepoServices | null; // returns the sole entry or null when >1
  bootReattachAll(): void;
}
```

Built once in `scripts/server.ts`. Each entry constructs its own
`StateStore`, `Supervisor`, autopilot `loadConfig({ repo })`, and
`getRoadmapSource(...)`. The per-repo `computeStats` is
`() => computeStats({ logPath: resolve(entry.path, ".dev", "autopilot-log.jsonl") })`
— we already expose `opts.logPath` on `computeStats` (stats.ts:303), so no
changes needed in the autopilot package.

**Routing — middleware.** One middleware registered on the guarded router
(after auth) extracts the repo slug:

1. `X-Autopilot-Repo` header wins over `?repo=` (header is what the UI will
   set; query param is the curl-friendly escape hatch).
2. If neither is present and `registry.list().length === 1`, use that one.
3. Otherwise return `400 {error: "repo selector required", code: "repo-required"}`.
4. If slug is provided but unknown, `400 repo-unknown`.
5. On success, attach `c.set("services", services)` so each route reads
   `c.get("services")` to reach its repo-scoped dependencies.

Hono's `c.var` typing via generics keeps this well-typed:
`type AppEnv = { Variables: { services: RepoServices } }`.

**Routes.** Every existing route swaps its closure-captured dependency for
`c.get("services").{supervisor,roadmap,computeStats}`. Signatures:

```ts
registerRunRoutes(app);          // was: (app, supervisor)
registerStatsRoutes(app);        // was: (app, deps)
registerRoadmapRoutes(app);      // was: (app, deps)
registerReposRoute(app, registry); // new — lists configured repos for the switcher
```

`/repos` sits behind auth like the others but does not require a repo
selector, since its whole purpose is to tell the client what slugs exist.
It's the only route registered on `guarded` *outside* the repo-resolver
middleware — same pattern as `/healthz` sitting outside auth.

**Supervisor unchanged.** It's already single-repo-scoped. Registry just
holds one instance per entry. `bootReattachAll()` iterates and calls
`supervisor.bootReattach()` on each.

**Run-ID ambiguity avoided.** `ulid()` keeps IDs globally unique, but each
`StateStore` only knows about its own runs. `GET /runs/:id` (scoped by the
resolved repo) won't accidentally see another repo's run. No cross-repo
lookup path.

**Web UI repo switcher.**

- `lib/repos.ts` (new): `getSelectedRepo()` / `setSelectedRepo(slug)` —
  wraps localStorage key `autopilot-repo`. Returns `null` when unset.
- `lib/api.ts`: `doFetch` reads the selected slug and, when present, adds
  `X-Autopilot-Repo: <slug>`. If the server returns `400 repo-required`,
  trigger the selector prompt (analogous to 401→token prompt flow).
- `lib/api.ts`: new `listRepos()` → `GET /repos`.
- `components/RepoSwitcher.tsx` (new): React island that fetches `/repos`
  on mount, renders a `<select>` in the nav, persists selection, and
  forces a page reload on change (same pattern as `clear-token` reloading
  to re-pull scoped data).
- `layouts/Base.astro`: add `<RepoSwitcher client:load />` before the
  `clear-token` button. When only one repo exists, render nothing (keeps
  single-repo deployments visually identical).

**Single-repo backwards-compat path.** Verified by these behaviors:

1. `AUTOPILOT_REPO=/x` (old shape) parses to a single-entry registry with
   slug = `basename("/x")`. State file and log dir resolve to exactly the
   same paths as today.
2. No `?repo=` or `X-Autopilot-Repo` on requests → middleware falls through
   to the single entry.
3. UI sees one repo in `/repos`, renders no switcher, omits the header.
4. `AUTOPILOT_SERVER_STATE_PATH` / `AUTOPILOT_SERVER_LOG_DIR` still honored
   when exactly one repo is configured.

**Alternatives considered:**

- *Single StateStore with `repoSlug` field on each run.* Simpler on paper
  but (a) conflates repos in one file — deleting a repo from the env leaves
  orphan rows, (b) makes per-repo ops (`list()`, `bootReattach()`) require
  a filter argument and leak the registry concept into StateStore itself,
  (c) changes the on-disk schema for existing single-repo users. Per-repo
  files preserve the backcompat contract and keep `StateStore` free of
  repo awareness.
- *Per-repo daemon processes behind a reverse proxy.* Matches the current
  "spin a second instance" workaround. Wastes a port per repo, doesn't fix
  the UX, and the charter explicitly asks for a single daemon.
- *Repo in the URL path (`/r/<slug>/runs`).* RESTful but doubles the route
  table and complicates the static `/ui/*` mount. Query param + header
  keeps the existing route tree intact.

## Files to change

**Server (`packages/server/src/`):**

- `config.ts` — replace `repo` field with `repos: RepoEntry[]`. New
  `parseRepos(env)` helper. Keep `AUTOPILOT_REPO` as single-entry fallback;
  reject `AUTOPILOT_REPO` + `AUTOPILOT_REPOS` together. Reject
  `AUTOPILOT_SERVER_STATE_PATH` / `AUTOPILOT_SERVER_LOG_DIR` in multi-repo
  mode. Slug validation + collision detection.
- `repo-registry.ts` — new. `RepoRegistry` class + `RepoServices`
  interface. Builds per-repo `StateStore`, `Supervisor`, `RoadmapSource`,
  `computeStats` closure.
- `app.ts` — take `RepoRegistry` instead of singular `supervisor` + `roadmap`
  + `computeStats`. Register `/repos` outside the repo-resolver middleware
  but inside auth. Apply resolver middleware to the guarded subrouter.
- `routes/repo-resolver.ts` — new middleware. Extract slug from header /
  query / default; 400 on ambiguous or unknown; store `services` on `c.var`.
- `routes/repos.ts` — new. `GET /repos → { repos: [{ slug, path }] }`.
- `routes/runs.ts`, `routes/stats.ts`, `routes/roadmap.ts` — drop
  closure-captured deps; read from `c.get("services")`. Update function
  signatures to take just `(app)`.
- `types.ts` — add `RepoEntry` (slug, path, statePath, logDir).

**Server entry (`packages/server/scripts/`):**

- `server.ts` — construct `RepoRegistry` from `cfg.repos`. Call
  `registry.bootReattachAll()`. Log listening line includes repo count and
  slugs. Pass registry to `createApp`.

**Server tests (`packages/server/__tests__/`):**

- `config.test.ts` — extended fixtures:
  - `AUTOPILOT_REPO=/p` still works, yields one-entry `repos`.
  - `AUTOPILOT_REPOS=/a,/b` yields two entries with basename slugs.
  - `AUTOPILOT_REPOS=foo=/a,bar=/b` yields explicit slugs.
  - Duplicate slug → throws.
  - Invalid slug chars → throws.
  - Both `AUTOPILOT_REPO` and `AUTOPILOT_REPOS` set → throws.
  - `AUTOPILOT_SERVER_STATE_PATH` with multi-repo → throws.
  - Neither set → throws (current behavior, still required).
- `app.test.ts` — `setup` now builds a registry with one or two repos.
  New assertions:
  - Single-repo: existing tests keep passing without any header.
  - Multi-repo + missing selector → 400 `repo-required`.
  - Multi-repo + unknown slug → 400 `repo-unknown`.
  - `X-Autopilot-Repo: slugB` routes to repo B's supervisor (assert
    by observing the supervisor's `repoCwd`/`logDir` on the started run).
  - `?repo=slugB` equivalent behavior.
  - Header beats query when both present and differ.
  - `GET /repos` returns the configured list; behind auth.
- `supervisor.test.ts` — no functional change expected; smoke-run still
  passes.

**Web (`packages/web/src/`):**

- `lib/api.ts` — `listRepos()`; `doFetch` injects `X-Autopilot-Repo`; on
  `400 repo-required` trigger switcher prompt (analog of 401 → token).
- `lib/repos.ts` — new. localStorage wrappers for selected slug.
- `components/RepoSwitcher.tsx` — new React island.
- `layouts/Base.astro` — mount `<RepoSwitcher client:load />` in nav.
- `types/index.d.ts` (if present) — no-op; types flow through
  `@cdhorne/claude-autopilot-server/types`.

**Docs & ops:**

- `docs/server.md` — document `AUTOPILOT_REPOS` syntax, per-repo state
  location, `?repo=`/`X-Autopilot-Repo` selector, `GET /repos`, single-repo
  backcompat note.
- `infra/systemd/autopilot-server.service` — comment updated to reference
  both env vars; no code change needed (EnvironmentFile already loads
  whatever's there).
- `CLAUDE.md` — update the `packages/server/` bullet under **Orientation**
  to mention the registry model and selector semantics in one sentence.

## Test strategy

**Server unit tests** via `node:test` (tsx --test --reporter=dot) — adding
~10 cases to `config.test.ts` and ~6 to `app.test.ts` per the list above.
Registry-level behavior (bootReattachAll, per-repo stats logPath) is
covered indirectly through app tests plus one direct registry test in a
new file `repo-registry.test.ts` (two tests: `list()` returns entries in
declaration order; `get(unknown)` returns null).

**Key invariants to pin down:**

- *Per-repo isolation at the state level*: a run started via `?repo=a`
  does not appear in `?repo=b`'s `GET /runs`. Assert by starting a run on
  repo A, listing on repo B, expecting `runs: []`.
- *Route-resolver error ordering*: auth first (401 for no token beats
  400 for no repo selector). Matches the existing bearer-first contract.
- *Default resolution*: single-repo deployments without selector resolve
  to the sole repo. Multi-repo deployments without selector get 400.
- *No silent wrong-repo routing*: unknown slug never falls back to the
  default — always 400. Prevents the "typoed slug writes to default repo"
  failure mode.

**Web UI** is unit-test-free today (no web tests exist); verify manually
per `CLAUDE.md` — dev-proxy against a two-repo daemon, switch repos via
the nav dropdown, confirm runs/stats/roadmap pages re-fetch under the new
scope.

**Backwards-compat smoke test** (manual, documented in the shakedown-code
plan review): boot the daemon with only `AUTOPILOT_REPO=` set, confirm
`/runs`, `/stats`, `/roadmap` all respond as before with no selector, and
confirm the UI renders no switcher.

## Rubric self-check

**Correct** — Backwards-compat path is the only non-obvious invariant:
`AUTOPILOT_REPO` alone must yield exactly today's `statePath` and
`logDir`. Enforced by keeping the same defaults in `parseRepos()` and
verified by a dedicated test in `config.test.ts`. No new interactions with
autopilot pipeline invariants (step exhaustiveness, plan-polish block,
frontmatter stripping, phantom ship guard) — this change is entirely
server-side. `computeStats({ logPath })` is the one autopilot-package API
we touch, and its signature already supports the override we need
(stats.ts:303).

**Well-typed** — New `RepoEntry`, `RepoServices` interfaces in `types.ts`
/ `repo-registry.ts`. Hono typed `Variables: { services: RepoServices }`
on the guarded subrouter so `c.get("services")` is non-nullable inside
repo-scoped routes. No `any`. The resolver middleware narrows the union
(undefined → 400 exit or typed value set) before any route sees the
context.

**Well-factored** — `RepoRegistry` isolates the "one-instance-per-repo"
concept. `StateStore` and `Supervisor` stay ignorant of multi-repo.
Resolver middleware is the single place that interprets header/query,
matching the existing pattern of `bearerAuth` owning all token logic.
Routes shrink (no more `deps` closures) — they just read `c.var`.

**Well-tested** — 10 new config tests, 6 new app tests, 2 new registry
tests. Existing tests keep running unchanged for the single-repo path.
The key negative paths (ambiguous selector, unknown slug, duplicate slug,
mixed env vars) all have dedicated cases.

**Concise** — New code concentrates in one new file (`repo-registry.ts`,
~60 LoC) and one new middleware (`repo-resolver.ts`, ~30 LoC) plus the
`/repos` route (~10 LoC) and a React island (~30 LoC). Every existing
route file *shrinks* because deps move to `c.var`. No compat shims in the
data model — we rely on `parseRepos()` collapsing `AUTOPILOT_REPO` into
the new shape.

**Idioms** — deferred to `/shakedown`. Hono `c.var` typing and Astro
island conventions are the main things to stress-test with fresh eyes.

---

**Self-review revisions:** during drafting I first considered keyed
state-file partitioning (single file, `repoSlug` column). Rejected in the
"Alternatives considered" section above because it breaks the
backwards-compat path — existing deployments would need an on-disk
migration. Per-repo files preserve the contract with zero migration.

Also initially considered putting the repo selector in the URL path
(`/r/<slug>/...`). Rejected because it doubles the route tree and
complicates `/ui/*` static mounting. Header + query keeps the URL scheme
flat.
