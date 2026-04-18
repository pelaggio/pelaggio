# TOOL-15 — `LinearRoadmap` adapter

Implement `RoadmapSource` for Linear, symmetrical to `GitHubIssuesRoadmap` (TOOL-10). Adapter-only: skill bodies stay markdown-aware, same caveat that already applies to `github-issues` carries over. This work makes the factory type-exhaustive for a third source name, wires config plumbing, and ships a fully stubbed unit-test surface so we never hit Linear in CI.

## Scope

**In scope**
- New adapter `scripts/autopilot/roadmap/linear.ts` implementing `RoadmapSource` (every method: `listOpenItems`, `claimItem`, `markDone`, `getItemPlan`, `parseItemId`, `isQuickScope`).
- Widen `RoadmapSourceName` union to add `"linear"`; add `LinearRoadmapConfig` interface; extend factory `getRoadmapSource` switch.
- Extend `.autopilot.yml` loader in `config.ts` to parse `roadmap.linear.{team,label,plan-location}`, with `ROADMAP_LINEAR` exported like `ROADMAP_GITHUB`.
- Pass `ROADMAP_LINEAR` through `pipeline.ts` to `getRoadmapSource`.
- Inject `@linear/sdk` as a runtime dependency.
- Testing: mirror `roadmap-github.test.ts` with a stub `LinearApi` — zero network.
- Config-parsing tests in `config.test.ts`.
- Document schema + adapter-only caveat in `docs/config.md`.

**Out of scope** (explicit)
- Rewiring `/pick`, `/plan`, `/ship`, `/charter`, `/status`, `/pickup`, `/shakedown`, `/tidy` skill bodies through the adapter — same deferral as `github-issues`. A single consolidated "rewire all skills through `RoadmapSource`" follow-up tracks this across both remote adapters.
- Multi-team / multi-workspace support. One Linear workspace per autopilot instance (workspace is implicit in the API key); one team per config.
- `plan-location: pr-description` equivalent. Linear has no native PR surface, so `getItemPlan` has only one non-local path: issue comments. Parameter symmetry with `github-issues` via `planLocation: "issue-comment"` default; reserved values `throw "not yet implemented"` exactly like GitHub's `pr-description`.
- Storing `LINEAR_API_KEY` in config file — env var only, read lazily, never logged.

## Approach

### Why `@linear/sdk` over raw GraphQL

The roadmap deliverable specifies `@linear/sdk`. Justification:
- First-party, typed, maintained by Linear.
- Handles GraphQL schema, pagination cursors, and retries. Writing those by hand for an adapter used by perhaps one downstream project is the wrong trade.
- Size concern (the SDK pulls in `graphql`) is tolerable; adapter is opt-in — users on `markdown` or `github-issues` pay nothing at runtime unless `LinearClient` is constructed. A lazy `import()` inside the default runner keeps the cost off the hot path for non-Linear consumers.

### Why lazy construction, `LinearApi` injected

Matches the `GhRunner` seam in `github-issues.ts`. Tests never touch the network; the default path inside `linear.ts` dynamic-imports `@linear/sdk` only when `LinearApi` was not injected. This means:
- Unit tests pass in environments without `@linear/sdk` installed (the injected stub shortcuts the dynamic import).
- `loadConfig()` with `roadmap.source: markdown` never triggers the SDK load, keeping startup cost flat.
- `LINEAR_API_KEY` missing at construction time does **not** throw; errors surface on the first real API call with a clear diagnostic, mirroring `gh`'s lazy-probe behavior.

### Factory + config plumbing — type-exhaustiveness

Adding `"linear"` to `RoadmapSourceName` is a deliberate exhaustiveness trigger: the factory's `default: never` branch forces a compile error until the new case is wired. `ROADMAP_SOURCE_NAMES` gets the new entry; `isRoadmapSourceName` picks it up transitively. No `as RoadmapSourceName` casts — the literal union stays the single source of truth, consistent with `STEPS` in `config.ts`.

### Adapter surface — symmetry with `GitHubIssuesRoadmap`

| Method | Behavior |
|---|---|
| `parseItemId(text)` | Matches `feat/<team>-<n>` or `feat/<team>-<n>-<slug>` (e.g. `feat/eng-42-fix`) and returns upper-cased `TEAM-N`. Also bare `TEAM-42` mention. Returns `null` otherwise. |
| `isQuickScope(text)` | Identical regex to github-issues adapter (`scope: S/XS`, `bug`, `fix:`). No reason to diverge. |
| `listOpenItems()` | GraphQL `issues` query filtered by `team.id == teamId`, `state.type in ["unstarted","backlog","triage"]`, optional `labels.some.name == label`. Pagination via SDK's async iteration; cap at 200 like github-issues. `deps` derived from Linear `relations` of type `blocks`/`blocked_by` — formatted as `TEAM-1, TEAM-2` for display. `sourceRef` is the issue `identifier` (e.g. `ENG-42`). |
| `claimItem(id)` | Lookup issue by identifier → title → slug (kebab, 40-char cap). Branch `feat/${id.toLowerCase()}[-slug]` (matches github-issues style; `ENG-42` → `feat/eng-42-fix-the-thing`). Worktree path = `${WORKTREE_PREFIX}${id.toLowerCase()}` — identical formula to `helpers.ts:resolveWorktree()` so `--resume ENG-42` finds its worktree (`-eng-42`). Dashes in directory names are filesystem-safe; do **not** strip them (would desync from `resolveWorktree`). Best-effort state-transition to workflow state of type "started"; best-effort label add `in-progress`. Creates worktree via `git worktree add` exactly as markdown/github adapters do. |
| `markDone(id, ctx?)` | Create comment (`Shipped` or `Shipped — <note>`); transition issue to workflow state of type "completed". Best-effort label strip. Zero local file writes — plan/roadmap stay untouched, matching github-issues. |
| `getItemPlan(ref)` | Local-first: `docs/plans/${id.toLowerCase()}-*.md` then `docs/plans/${id.toLowerCase()}.md` then `.dev/plans/${id}.md` (mirrors github-issues' two-tier lookup). Remote fallback: most-recent issue comment whose body starts with `<!-- autopilot-plan -->`. Comment-sourced plans materialize to `.dev/plans/${id}.md` under the worktree (not `docs/plans/` — that's `/plan`'s territory). |

### Config schema additions

`config.ts`:
- New constant `DEFAULT_LINEAR_ROADMAP: LinearRoadmapConfig = { teamId: "", label: "", planLocation: "issue-comment" }`.
- Parser block under the existing `roadmapBlock` handling, symmetrical to the `gh` block. Keys (YAML kebab-case → camelCase internal):
  - `roadmap.linear.team` → `teamId` (string; required when source=linear)
  - `roadmap.linear.label` → `label` (string; default `""` meaning "no label filter")
  - `roadmap.linear.plan-location` → `planLocation` (reuses `GH_PLAN_LOCATIONS` values; `issue-comment` default)
- Guard: if `roadmapSource === "linear"` and `!roadmapLinear.teamId`, throw the same style of early error.
- Export `ROADMAP_LINEAR: LinearRoadmapConfig = CONFIG.roadmapLinear`.

The union `"issue-comment" | "pr-description"` semantically means "where does the plan body live" and applies identically to both adapters. Clean rename: `GhPlanLocation` → `PlanLocation`, `GH_PLAN_LOCATIONS` → `PLAN_LOCATIONS`, `isGhPlanLocation` → `isPlanLocation`. No deprecated re-export — per CLAUDE.md "no backwards-compat shims", every site updates in the same commit (`types.ts`, `index.ts`, `config.ts`, `github-issues.ts`, and the new `linear.ts`).

### Dependency

Add `@linear/sdk` to `dependencies` in `package.json`. Pin to whatever the most recent stable major is (currently `^50.x`). No `--optional` dep — the intent is to ship it; lazy import is an ergonomics guard, not a pluggability one.

`.autopilot.yml` example updated in `docs/config.md` alongside the existing `roadmap.github.*` block.

## Files to change

- **new** `scripts/autopilot/roadmap/linear.ts` — adapter (~200 lines, shape parallels `github-issues.ts`).
- **edit** `scripts/autopilot/roadmap/types.ts` — add `"linear"` to `RoadmapSourceName` + `ROADMAP_SOURCE_NAMES`; add `LinearRoadmapConfig` interface; rename `GhPlanLocation` → `PlanLocation` (no re-export); export `LinearApi` type.
- **edit** `scripts/autopilot/roadmap/index.ts` — factory `case "linear"`; export `LinearRoadmap` + `LinearRoadmapConfig`; update `PlanLocation` export names.
- **edit** `scripts/autopilot/roadmap/github-issues.ts` — swap `GhPlanLocation` import/use for `PlanLocation`.
- **edit** `scripts/autopilot/config.ts` — `DEFAULT_LINEAR_ROADMAP`, parse `roadmap.linear.*`, export `ROADMAP_LINEAR`, widen `ResolvedConfig`.
- **edit** `scripts/autopilot/pipeline.ts` — pass `linear: ROADMAP_LINEAR` in the `getRoadmapSource` call (single line change).
- **new** `scripts/autopilot/__tests__/roadmap-linear.test.ts` — mirror `roadmap-github.test.ts` structure.
- **edit** `scripts/autopilot/__tests__/config.test.ts` — append a `describe("loadConfig — roadmap.linear", …)` block with three cases (defaults/parse/missing-team).
- **edit** `package.json` — add `@linear/sdk` dep.
- **edit** `docs/config.md` — document `roadmap.linear.*`, note "adapter-only" same as github-issues, show example YAML.
- **edit** `CLAUDE.md` — one-line mention in the "Roadmap sources" paragraph: `LinearRoadmap` joins `MarkdownRoadmap` and `GitHubIssuesRoadmap`.

No touches to `step-runner.ts`, `pipeline.ts` (beyond the one-line config threading), `helpers.ts`, or any skill file. No new pipeline step.

## Test strategy

Pattern: follow `roadmap-github.test.ts` verbatim in structure. Build a `makeStub({ routes, fallback })` helper over the injected `LinearApi`. Tests never construct a real `LinearClient`.

Cases:
1. `parseItemId` — extract from `feat/eng-42`, `feat/eng-42-slug`, bare `ENG-42`, `Closes ENG-42`, unknown-returns-null.
2. `isQuickScope` — `scope: S`, `scope: XS`, `bug`, `fix:`, false on `scope: M`. Mirrors github.
3. `listOpenItems` — 3-issue stub response → 3 `RoadmapItem`s with correct id/title/deps/sourceRef; empty array → `[]`; label parameter threaded to the API.
4. `claimItem` — stub issue lookup + state transition + label add; assert worktree created (using `seedRepo()` helper), branch name matches `feat/eng-<id>-<slug>`, label-add tolerates error (non-critical).
5. `markDone` — with and without note; assert comment body, state transition call, label strip.
6. `getItemPlan` — local file wins with zero API calls; remote fallback writes `.dev/plans/<id>.md`; most-recent marker comment wins when multiple; returns `null` when nothing matches.
7. Error surface — missing `LINEAR_API_KEY` (no injected runner), auth failure, network error — assert clear user-facing messages.
8. Factory — `getRoadmapSource("linear", { repo, linear })` returns `LinearRoadmap`; missing `teamId` throws with a message mentioning `roadmap.linear.team`.
9. Config parsing (in `config.test.ts`) — defaults, parse `team`/`label`/`plan-location` overrides, missing-team-when-source=linear throws.

Run: `npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/*.test.ts`. Exit 0 required.

## Verification

```bash
npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/*.test.ts
npx tsx -e "import('./scripts/autopilot/config.ts')"
npx tsx -e "import('./scripts/autopilot/roadmap/linear.ts')"
npx tsx -e "import('./scripts/autopilot/pipeline.ts')"
pnpm check
pnpm check:skills
```

All must succeed. `pnpm check:publish` also runs in the publish workflow — no new install hooks introduced.

## Rubric self-check

- **Well-typed** — `"linear"` added to the `RoadmapSourceName` literal union; factory `default: never` stays exhaustive. `LinearApi` interface explicit; no `any`; SDK types re-exported only where used. No `as RoadmapSourceName` casts. `LinearRoadmapConfig` shape mirrors `GithubRoadmapConfig`.
- **Well-tested** — parity with `roadmap-github.test.ts`. Nine-plus test cases, all in-memory, zero network. Added config-parsing cases cover the three yml error paths (missing team, invalid plan-location, parse-success).
- **Well-factored** — adapter confined to `roadmap/linear.ts`. Pipeline touches one line; config touches one new parser block. Shared plan-location union extracted to avoid a second `github-issues`-shaped copy (prevents the naming-drift rubric point on github naming leaking into Linear code). No SDK imports leak outside `linear.ts`.
- **Correct** — Load-bearing invariants preserved: `STEPS` and step records untouched (no pipeline step change). Frontmatter stripping unchanged. Worktree isolation unchanged (new adapter uses the same `git worktree add` pattern; no writes to `MAIN_REPO`). Rate-limit parking untouched (adapter lives outside pipeline exit paths). No hardcoded model strings. Factory remains exhaustive. `roadmap.source: linear` without `roadmap.linear.team` fails fast at startup (symmetric with github-issues' `repo` guard). Adapter-only caveat surfaced in `docs/config.md` so the user can't silently land a broken end-to-end cycle.
- **Concise** — No new abstraction beyond the `LinearApi` injection seam that already exists in spirit via `GhRunner`. No "multi-workspace" support, no field plumbing nobody asked for. Under ~200 lines for the adapter; under ~40 lines config delta.

## Risks / open questions

- **Linear GraphQL shape drift**: Linear's API is stable but `@linear/sdk` majors have broken shape before. Pin to `^50.x` (current stable) and keep the `LinearApi` seam narrow so an SDK major bump is a local edit, not a sprawling diff.
- **`LinearApi` surface design**: define it as exactly the methods the adapter uses (no SDK re-export) — 5-6 methods tops (`issues`, `issue`, `issueCreateComment`, `issueUpdate`, `workflowStates`). Keeps the stub small and the SDK loosely coupled.
- **First real Linear cycle**: not verified by this ticket because skills are still markdown-aware. The adapter lands tested-in-isolation; end-to-end Linear cycles require the follow-up "skill-body rewire" ticket shared with github-issues. Plan doc explicitly flags this in `docs/config.md`.

---

Self-review revision notes:
- Initial draft had separate `LinearPlanLocation` type — collapsed into a shared `PlanLocation` rename to avoid two type-aliases for the same literal union. Cleaner and mirrors the "consistency" dimension.
- Initial draft stripped dashes from the Linear id for the worktree path (`ENG-42` → `-eng42`) citing filesystem safety; that desynced from `helpers.ts:resolveWorktree()`, which does not strip — so `--resume` would miss. Reverted to plain `id.toLowerCase()` (`-eng-42`), matching `resolveWorktree` so resume works. Dashes in directory names are filesystem-safe on every target OS.
- Initial draft left `LINEAR_API_KEY` missing as a construction-time throw; changed to lazy (matches `gh`'s ENOENT lazy probe) so `loadConfig()` never trips on a non-Linear consumer.
- Initial draft put `workspace-id` in the config; dropped it — Linear API keys are scoped to a single workspace, so the field was dead weight. Noted the drop in Out-of-scope.
- Initial draft did not cover the worktree-filesystem-id collision (`ENG-42` has a dash); added the `toLowerCase().replace("-","")` normalization note with the rationale (filesystem safety + keeps `WORKTREE_PREFIX` lookup working).
