# TOOL-43 — Cloudflare Tunnel + bearer auth for off-tailnet control-plane access

Ship the public access story for the TOOL-39 daemon: cloudflared tunnel in front, bearer token on, web UI learns to carry the token. Roadmap entry at `docs/roadmap-core.md:470`.

## Scope

**In**
- Web UI (`packages/web/`): persistent token store, `Authorization: Bearer` injection on every API + SSE request, a one-off token-entry modal that appears on 401 and on first load when no token is stored.
- Infra: `infra/cloudflare/` Terraform scaffolding that provisions the Cloudflare Tunnel + DNS record; `infra/systemd/cloudflared.service` user unit.
- Docs: new "Cloudflare Tunnel setup" section appended to `docs/server.md` (tunnel provisioning, token rotation, tailnet-only vs. tunnel-exposed).

**Out**
- The bearer middleware itself — `packages/server/src/auth.ts` already ships timing-safe compare, 401 JSON, and `/healthz` bypass with full test coverage (`packages/server/__tests__/auth.test.ts`). No daemon code changes required to flip it on; setting `CONTROL_PLANE_TOKEN=...` in the deployed env file is enough.
- Touching `deploy-server.yml` to also bounce cloudflared — the tunnel is a separate lifecycle (edit once, rarely redeploy), and coupling restarts to every server push would interrupt log streams for no benefit. Tunnel install is a documented one-time operator step.
- Automated e2e smoke test — the "cellular device, Tailscale off, hit tunnel hostname" test called out in the roadmap is inherently manual (needs out-of-tailnet network egress that CI doesn't have). Keep it as an operator runbook step in `docs/server.md`.
- OAuth/SSO, multi-token, per-device revocation, rate limiting — roadmap out-of-scope. One token, rotate by editing the env file.

## Approach

**Why this shape.** The middleware is already dormant in the daemon; the web UI has already-seam-ed fetch + SSE wrappers (`api.ts:34`, `sse.ts:29` both pass `headers`) expressly for this ticket (see `docs/archived/tool-42.md:80`). So the delta is: (a) one place to read/write the token, (b) inject the header at both seams, (c) modal to capture the token on 401. The rest is infra + docs.

**Token storage strategy.** Single bearer token, `localStorage["autopilot-token"]`. On first load, if unset, show the modal. On any 401 response, invalidate and re-prompt. The roadmap weighed localStorage-vs-login-page in the TOOL-42 open questions and the former won on the "less infra" axis; keep it.

**Modal-vs-global-context tradeoff.** The web app is Astro pages each hosting a top-level React island (`RunList`, `RunDetail`, etc.). Wrapping everything in a single React provider would require restructuring the layout to be a root island, which fights Astro's grain. Instead: a tiny pub/sub in `lib/token.ts` that `fetchJson` / `subscribeSse` poke when they hit 401, and a `<TokenPrompt client:load />` island mounted in `Base.astro` alongside `<slot />` that subscribes to the pub/sub and renders a `<dialog>` when the token is missing. The modal and the fetchers don't share a tree; they share a module. That matches how `fetchJson` and `subscribeSse` already share their header seam (module-level, no provider).

**Mount-order race.** Both the API-making island and the `<TokenPrompt>` island are `client:load`, so mount order isn't guaranteed. If a 401 fires before `TokenPrompt`'s `registerPromptHandler()` runs, the prompt call must still resolve once the modal eventually mounts. Handled by stashing any unsatisfied `promptForToken()` call as a pending flag: when `registerPromptHandler()` is called, if a prompt is already pending, fire the newly-registered handler immediately. Covered by the token-module test.

**Why not a React context at all.** Two module-level mutations (`localStorage` + the in-memory cache) plus one event target is ~40 lines; a full provider + hook + island wiring would triple that for the same behavior. Keep the cleverness budget for the tunnel Terraform.

**SSE 401-retry shape.** `subscribeSse` currently calls `fetch()` once; on 401 it reports the error and ends the stream. Wrap the existing single-shot in a retry loop that, on status 401, awaits `promptForToken()` and tries again (max one retry — if the second attempt also 401s, surface as an error). Don't add backoff; the modal is the gate.

**Infra: cloudflared runs local to the daemon box.** The tunnel connects outbound from the beefy box to Cloudflare; the daemon can stay bound to the tailnet IP (or `127.0.0.1`) and `cloudflared` proxies to it. No change to `AUTOPILOT_SERVER_HOST` bind logic (`packages/server/src/config.ts:22-25`). The fail-loud-on-`0.0.0.0` check stays — it's still correct; we want the daemon unreachable except via tunnel or tailnet.

**Terraform shape.** Roadmap references fathom's `infra/cloudflare/` as a template. Fathom's layout is: `main.tf` (provider + backend), `variables.tf`, resource-per-file (`dns.tf`, `kv.tf`, `pages.tf`, ...), cloudflare provider v5, R2 backend for state. Fathom does **not** currently have a tunnel resource, so we're authoring `tunnel.tf` from scratch. Mirror fathom's file layout and provider version, but use a **local** backend — this is a one-resource config and wiring up a dedicated R2 bucket is more plumbing than state. Document the upgrade path.

Provider v5 resource names (confirmed against the Cloudflare provider docs for 5.x):
- `cloudflare_zero_trust_tunnel_cloudflared` — the tunnel itself, returns a `token` attribute for the cloudflared daemon.
- `cloudflare_zero_trust_tunnel_cloudflared_config` — ingress rules (map `autopilot.{domain}` → `http://127.0.0.1:7777`).
- `cloudflare_dns_record` — CNAME from hostname to `<tunnel-id>.cfargotunnel.com`, proxied.

**cloudflared.service shape.** Copy `autopilot-server.service`'s user-unit conventions: `WorkingDirectory=%h`, `EnvironmentFile=%h/.config/cloudflared.env`, `ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}`, `Restart=on-failure`, `StandardOutput=journal`. Operator's env file contains only `TUNNEL_TOKEN=<from terraform output>`; not committed.

**401 UX details.**
- Initial load with no token: modal appears immediately; every API call returns 401 until submitted. Avoid flashing error banners before the modal gets a chance. Implementation: `fetchJson` on 401 awaits `promptForToken()`, retries once, only throws `ApiError` if the retry also fails.
- Bad token: modal reopens with a "token rejected" note, keeping the user-entered value selected for edit.
- Logout affordance: small "clear token" button in the header nav. Cheap, answers the "operator fat-fingered the token" case without needing devtools.

## Files to change

**New**
- `packages/web/src/lib/token.ts` — token store (getter/setter, localStorage persistence, `promptForToken()` single-flight pub/sub, `registerPromptHandler()` for the modal). ~40 lines, pure TS with one DOM dependency (`localStorage`) guarded by a `typeof window` check so it's SSR-safe if Astro ever pre-renders an import.
- `packages/web/src/components/TokenPrompt.tsx` — React island. `useEffect` registers the prompt handler; renders a `<dialog>` (native HTML dialog for focus-trap without a library) with a password-style input, submit button, and "token rejected" state when the last attempt was a 401. Opened via `showModal()`. ESC-to-dismiss is suppressed (`onCancel={e => e.preventDefault()}`) because `fetchJson`/`subscribeSse` are awaiting `promptForToken()` — dismissing with no token would leave them hung forever. The only exit is a token submission.
- `packages/web/__tests__/token.test.ts` — `node:test` unit test for the token module with an injected `Storage`-compatible fake. Covers: read/write, single-flight `promptForToken`, rejection reopens prompt, **handler-registered-after-prompt race** (register fires pending handler immediately). `packages/web/__tests__/` already exists (api/sse/format tests); the `test` script is already wired in `package.json`.
- `infra/cloudflare/main.tf` — terraform block (Cloudflare provider v5), local backend.
- `infra/cloudflare/variables.tf` — `cloudflare_api_token`, `cloudflare_account_id`, `zone_id`, `domain`, `tunnel_name`, `tunnel_target` (default `http://127.0.0.1:7777`).
- `infra/cloudflare/tunnel.tf` — `cloudflare_zero_trust_tunnel_cloudflared` + `..._config` (ingress: hostname → tunnel_target, catch-all → `http_status:404`).
- `infra/cloudflare/dns.tf` — `cloudflare_dns_record` CNAME from `{var.tunnel_name}.{var.domain}` (or a dedicated subdomain) to `<tunnel-id>.cfargotunnel.com`, proxied.
- `infra/cloudflare/outputs.tf` — `tunnel_id`, `tunnel_token` (marked `sensitive = true`), `hostname`. Operator copies the token output into `~/.config/cloudflared.env` after first apply; document that tunnel-resource replacement regenerates the token, so reapply-then-update-env-then-restart-cloudflared is the rotation sequence.
- `infra/cloudflare/terraform.tfvars.example` — non-secret placeholders, `*.tfvars` gitignored.
- `infra/cloudflare/.gitignore` — `*.tfstate*`, `.terraform/`, `terraform.tfvars`.
- `infra/systemd/cloudflared.service` — user unit; `ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}`, `EnvironmentFile=%h/.config/cloudflared.env`.

**Modified**
- `packages/web/src/lib/api.ts` — replace the `fetchJson` body with a token-aware version: read `getToken()`, inject `Authorization` header when set, on 401 `await promptForToken()` and retry once, only throw on second failure. `ApiError` shape unchanged (existing callers still destructure `.status`/`.code`).
- `packages/web/src/lib/sse.ts` — wrap the existing single-shot fetch in a retry loop gated on status 401; identical token injection. Keep the existing `headers` param as the escape hatch (tests pass `{ headers: { Authorization: "Bearer x" }}` to avoid the global store).
- `packages/web/__tests__/api.test.ts` — extend to cover: `Authorization` header injection when `getToken()` returns a value; 401 → `promptForToken` → retry → success flow; two consecutive 401s throw `ApiError(401)`. Stub the token module (simplest: reset its internal state between tests and drive it via `setToken()` + manual `registerPromptHandler`).
- `packages/web/__tests__/sse.test.ts` — extend to cover the 401-retry shape symmetrically: first fetch returns 401, prompt resolves, second fetch streams normally.
- `packages/web/src/layouts/Base.astro` — add `<TokenPrompt client:load />` above `<slot />` (renders into a `<dialog>` so it doesn't disturb layout). Add a "clear token" button to the `<nav>` header. Implementation: a plain `<button id="clear-token">` plus an Astro `<script>` block (module script, not `is:inline`) that attaches the click handler — matches Astro 5's preferred pattern for tiny vanilla interactions and keeps the single LocalStorage key name (`"autopilot-token"`) imported from `lib/token.ts` rather than duplicated as a string literal.
- `packages/web/src/components/RunDetail.tsx` — no code change; note that 401 is now handled globally, so the existing `ApiError` branch only fires on non-401 failures after the prompt.
- `docs/server.md` — append "Cloudflare Tunnel setup" section after "Deploy workflow". Cover: terraform apply flow, tunnel token → EnvironmentFile → `systemctl --user enable --now cloudflared`, `CONTROL_PLANE_TOKEN` rotation (edit `~/.config/autopilot-server.env`, `systemctl --user restart autopilot-server`), cellular smoke-test runbook. Update "Bearer-token hook" subsection (currently line 131) to remove the "(TOOL-43 reservation)" framing now that it's live.
- `docs/roadmap-core.md` — `/ship` will strike through TOOL-43; no manual edit needed here.
- `docs/task-index.md` — ditto, `/ship` handles.

**Untouched**
- `packages/server/src/auth.ts`, `packages/server/src/app.ts`, `packages/server/src/config.ts` — already shipped per TOOL-39; re-reading confirms they correctly gate everything except `/healthz`. Adding tests here would be redundant with `packages/server/__tests__/auth.test.ts`.
- `.github/workflows/deploy-server.yml` — deliberately untouched (see Out of scope).

## Test strategy

**Server** — no new tests. `packages/server/__tests__/auth.test.ts` already covers no-op-when-unset, 401 on missing header, 401 on wrong token, timing-safe length check, and successful pass-through. The implementation is unchanged by this ticket.

**Web token module** — `packages/web/__tests__/token.test.ts` via `node:test`:
- `getToken()` returns `null` when storage is empty; returns stored value after `setToken()`.
- `setToken()` persists to the injected storage.
- `promptForToken()` is single-flight: two concurrent calls share one pending promise; `setToken()` resolves both.
- Prompt handler is invoked on open; resolved after `setToken()`.
- Handler registered AFTER `promptForToken()` fires → the late-registered handler is invoked immediately (mount-order-race coverage).

**Web api/sse tests** — extend the existing `api.test.ts` and `sse.test.ts` (already present alongside `format.test.ts`) with cases for header injection and the single-retry-on-401 flow; see "Files to change".

**Rubric verification coverage** — the rubric's Verification block (`.claude/skills/_rubric.md`) currently does not list `packages/web/__tests__/*.test.ts`, even though those tests already exist. Not widened in this ticket. Follow-up is tracked below.

**Web UI 401 flow** — manual. The roadmap's end-to-end smoke test is the primary verification: deploy, set `CONTROL_PLANE_TOKEN`, hit the tunnel hostname from a cellular device with Tailscale off, confirm modal appears, enter token, run a cycle, watch SSE log, confirm pause/resume work. Document this in `docs/server.md` as the operator acceptance checklist.

**Terraform** — `terraform validate` in `infra/cloudflare/` during development; no CI wiring (no terraform runner on the self-hosted runner yet, and standing one up is scope creep).

**Parse-checks** — `npx tsx -e "import('./packages/web/src/lib/token.ts')"` and `import('./packages/web/src/lib/api.ts')` to confirm the modules load. `pnpm check` (biome) already lints these files: the workspace `biome.json` includes `packages/*/src/**/*.{ts,tsx}` and `packages/*/__tests__/**/*.{ts,tsx}`, so new/changed TS+TSX under `packages/web/` is covered without a config change.

**Regression guard** — `packages/server/__tests__/app.test.ts` (if it covers the `guarded` route wrapper) — rerun to confirm routes still attach correctly after no changes.

## Rubric self-check

(Skipping **Idioms** per `/plan`'s review-split convention — `/shakedown` owns that with fresh eyes.)

**Correct.**
- No pipeline invariants touched — this ticket doesn't modify `STEPS`, `BUDGETS`, `TURN_LIMITS`, `EFFORT`, `MODEL_PROFILES`, `expandSkill()`, `parseVerdict()`, worktree-isolation hooks, `parkExit()`, `listWorktrees()`, `detectResumeStep`, `hasDeliverableCommits()`, or `verifyShipLanded()`. Scope is `packages/web/`, `infra/`, `docs/`.
- `parkExit()` not relevant — no new code runs inside the autopilot pipeline.
- Plan-polish guard (PreToolUse hook blocking writes to `docs/plans/` during `implement`) — this plan IS a `docs/plans/` file but is written during `plan`, not `implement`. Compliant.
- `.autopilot.yml` config surface — untouched.
- Phantom-ship guard — this ticket writes code in `packages/web/` and `infra/`, so the branch has deliverable commits outside `docs/plans/`. Ship will run.
- Token comparison is already `timingSafeEqual` with length-mismatch short-circuit (`packages/server/src/auth.ts:20`). The web UI never sees the server's token, so there's no client-side comparison to worry about.
- Token storage is `localStorage`, not `sessionStorage` or a cookie. Roadmap chose this explicitly. No httpOnly cookie path available because the fetch needs to inject `Authorization` from JS anyway. Document the risk ("any XSS = token theft") briefly in `docs/server.md`.
- 401-retry is capped at one retry per request — no infinite loop if the server always rejects.

**Well-typed.**
- `lib/token.ts`: exported functions have explicit return types (`getToken(): string | null`, `setToken(token: string): void`, `promptForToken(): Promise<string>`, `registerPromptHandler(fn: (() => void) | null): void` — null clears, any non-null replaces and fires immediately if a prompt is pending). No `any`. Internal pub/sub uses `((token: string) => void) | null` instead of `Function`.
- `TokenPrompt.tsx`: props-free island; local state is `{ open: boolean; rejected: boolean; value: string }`.
- `api.ts` / `sse.ts` signatures unchanged; the only generic (`fetchJson<T>`) stays.

**Well-factored.**
- Token store isolated in `lib/token.ts`. UI in `components/TokenPrompt.tsx`. Fetchers in `lib/api.ts` + `lib/sse.ts` depend on `lib/token.ts` only, not the component.
- No token logic leaks into `RunDetail.tsx`, `RunList.tsx`, `StartForm.tsx`, `StatsView.tsx`.
- Infra is self-contained under `infra/cloudflare/` (Terraform) and `infra/systemd/` (unit files). Matches the existing `infra/systemd/autopilot-server.service` neighbor.

**Well-tested.**
- Token module: `node:test` unit covers the state machine (~25 lines of test code).
- Server middleware: already covered.
- UI end-to-end: manual, documented. The repo has no web component-test harness; adding one (Vitest + jsdom + Testing Library) is its own ticket-sized decision and out of scope here per the "YAGNI, no premature abstractions" rubric line.

**Concise.**
- Total new + edited TS: ~140 lines (`token.ts` ~40, `TokenPrompt.tsx` ~60, `token.test.ts` ~35, `api.ts`/`sse.ts` retry deltas ~15, added cases in existing `api.test.ts`/`sse.test.ts` ~20).
- No abstraction for "the next N auth schemes" — just bearer. If a second scheme ever shows up, generalize then.
- No Zustand / Jotai / React Query — `fetchJson` is eight lines and the store is a module variable. Adding a state library for one token is the exact trap the rubric warns about.
- Terraform: ~5 small files totaling ~80 lines. No modules, no workspaces — this is one tunnel, one DNS record.
- Bearer clearing: one button in the nav, not a settings page.

## Follow-ups (explicitly deferred)

- Move Terraform state to R2 once a second infra target shows up (right now `infra/cloudflare/` is the only terraform dir, so local state is pragmatic).
- Extend `.claude/skills/_rubric.md`'s Verification block with `npx tsx --test --test-reporter=dot packages/web/__tests__/*.test.ts` so autopilot cycles exercise web tests the way they do server/autopilot tests. (Tests already exist and run via `pnpm -r test`; this is purely rubric-verification plumbing.)
- Web component-test harness — revisit if the UI grows past a handful of components.
