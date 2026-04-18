# TOOL-9 — RoadmapSource abstraction + MarkdownRoadmap adapter

**Branch**: `feat/tool-9-roadmap-source-abstraction`
**Scope**: M — one interface, one adapter, one factory, config key, pipeline refactor, tests.
**Roadmap**: `docs/roadmap-core.md` § TOOL-9
**Deps status**: TOOL-4 (pipeline mocking) ✓ and TOOL-8 (`.autopilot.yml`) ✓ both landed.

## Goal

Factor the markdown-specific logic the pipeline currently imports from `helpers.ts` behind a `RoadmapSource` interface, so TOOL-10 (GitHub Issues) and TOOL-15 (Linear) can drop in peer adapters without further refactor.

The markdown format for `docs/roadmap-*.md` + `docs/task-index.md` is unchanged. This is a code-shape change, not a data-shape change.

## Scope

**In scope**
- New `scripts/autopilot/roadmap/` module: `index.ts` (interface + factory + exports), `markdown.ts` (adapter).
- Move the roadmap-specific helpers (`findPlanFile`, `findPlanPath`, `parseItemId`, `isQuickScope`) from `helpers.ts` onto the `MarkdownRoadmap` adapter. Delete the old exports; update the one test file that imports them (no back-compat re-exports).
- Add `roadmap.source` config key to `.autopilot.yml` schema (default: `"markdown"`). Validator rejects unknown values loudly.
- Refactor `pipeline.ts` to instantiate a `RoadmapSource` via the factory and call `roadmap.getItemPlan({ worktree })`, `roadmap.parseItemId(text)`, `roadmap.isQuickScope(text)` instead of the imported helpers.
- Tests: `roadmap.test.ts` exercises the factory + MarkdownRoadmap methods; `pipeline.test.ts` continues passing (mock `RoadmapSource` via `PipelineDeps` for one new scenario).
- Document the new shape in `CLAUDE.md` under a "Roadmap sources" subsection so future adapter authors have a single entry point.

**Out of scope (per roadmap)**
- GitHub Issues or Linear adapters (TOOL-10, TOOL-15).
- Changing the markdown format or `roadmap-*.md` / `task-index.md` conventions.
- Rewriting the `/pick` or `/ship` skill bodies to call adapter methods. Those skills remain markdown-aware for this cycle; the interface documents what they *would* need to become pluggable. TOOL-10 will decide whether to add per-source skill variants or a callback mechanism — that's the right place to design the cross-skill injection seam, not here.

## Approach

**Why a class, not a set of free functions?** All candidate adapters (`MarkdownRoadmap`, `GitHubIssuesRoadmap`, `LinearRoadmap`) carry per-instance config (repo path, GitHub slug + label, Linear workspace + team). A class with a constructor is the idiomatic shape. Factory function returns the configured instance.

**Why include `parseItemId` / `isQuickScope` on the interface?** These are currently markdown-format-aware (parse roadmap-style IDs like `TOOL-16`; recognize `scope: S` / `fix:` strings from roadmap text). Other sources will carry their own identifier shape (issue number, Linear ID) and their own scope conventions (GitHub labels, Linear estimate points). Pushing them through the interface keeps `pipeline.ts` source-agnostic.

**Why leave `claimItem` and `markDone` on the interface but not on the hot path yet?** They're the non-trivial methods future adapters will need — closing a GH issue, mutating a Linear ticket — but for markdown today `/pick` and `/ship` skills handle the equivalent steps inline within a single SDK session. Implementing them on `MarkdownRoadmap` gives:
1. a TS-level parity point that future non-pipeline callers (CLI `mark-done`, library consumers) can use, and
2. a working reference implementation that TOOL-10 can mirror.
They stay unused by the pipeline until TOOL-10 figures out the skill/adapter coupling.

**Why the factory reads config (not injected)?** Consistent with `ship/index.ts`'s `getShipTarget(name)` pattern. The orchestrator already reads `SHIP_TARGET` from `config.ts` and passes the resolved `ShipTarget` into `runPipeline`. Same pattern: `getRoadmapSource(name, { repo })` → instance → injected into `PipelineDeps`.

## Interface

```ts
// scripts/autopilot/roadmap/index.ts (excerpt)

export type RoadmapSourceName = "markdown"; // TOOL-10/15 extend this union

export interface RoadmapItem {
  id: string;
  title: string;
  /** Raw deps column (e.g. "TOOL-4, TOOL-8" or "blocked: waiting on X" or "—"). */
  deps: string;
  /** Source-specific payload (roadmap file path, issue number, Linear ID). */
  sourceRef: string;
}

export interface MarkDoneContext {
  /** Human-readable closure note; adapters decide placement (commit body / issue comment / etc.). */
  note?: string;
}

export interface RoadmapSource {
  readonly name: RoadmapSourceName;

  /** Enumerate open/unblocked items. Used by `/pick` flows that rank items. */
  listOpenItems(): Promise<RoadmapItem[]>;

  /**
   * Claim an item: mark it in-flight on the source + create a local feat branch + worktree.
   * For markdown this is today performed by `/pick`'s skill body within the SDK session;
   * this method is the TS-level equivalent for non-pipeline callers.
   */
  claimItem(id: string): Promise<{ branch: string; worktree: string }>;

  /**
   * Mark an item done. For markdown: edits roadmap + task-index + commits.
   * For TOOL-10/15: closes the GH issue / Linear ticket.
   * IMPORTANT: must run in MAIN_REPO context — the worktree-isolation hook will
   * block edits to roadmap files from inside a worktree SDK session.
   */
  markDone(id: string, ctx?: MarkDoneContext): Promise<void>;

  /**
   * Fetch the item's plan content location.
   * For markdown: absolute path to `docs/plans/<slug>.md`, or null if missing.
   * For TOOL-10/15: may resolve from an issue comment / PR description.
   */
  getItemPlan(ref: { worktree?: string; id?: string }): Promise<string | null>;

  /** Extract an item ID from free-form text (pick output, branch names). */
  parseItemId(text: string): string | null;

  /** Heuristic: does the item text suggest XS/S scope or a bug fix (→ quick-mode profile)? */
  isQuickScope(text: string): boolean;
}
```

Notes on the shape:
- `async` everywhere — markdown is sync today but GH/Linear must be async; picking the common denominator now avoids an incompatible v2 later.
- `sourceRef` is opaque on purpose. The pipeline never reads it; adapters use it internally to round-trip metadata.
- `getItemPlan` takes `{ worktree?, id? }` so markdown can use the branch (current `findPlanPath(worktree)`) and GH/Linear can use the issue number (`id`). MarkdownRoadmap prefers `worktree` when supplied, falls back to `id`.
- No `getItem(id)` single-fetch method — YAGNI; `listOpenItems().find(...)` is fine. TOOL-10/15 can add one if a roundtrip cost justifies it.

## Files to change

| File | Change |
|------|--------|
| `scripts/autopilot/roadmap/index.ts` | **New.** Interface types, `ROADMAP_SOURCE_NAMES`, `getRoadmapSource(name, { repo })` factory, `isRoadmapSourceName(v)` guard. Re-exports types for consumers. |
| `scripts/autopilot/roadmap/markdown.ts` | **New.** `MarkdownRoadmap` class implementing `RoadmapSource`. Constructor takes `{ repo }`. Internally uses the existing helpers' logic (moved in, not duplicated). |
| `scripts/autopilot/helpers.ts` | Remove `findPlanFile`, `findPlanPath`, `parseItemId`, `isQuickScope`. Bodies move into `markdown.ts` unchanged. Everything else (`resolveWorktree`, `checkpoint`, `hasDeliverableCommits`, `detectResumeStep`, etc.) stays — not markdown-specific. |
| `scripts/autopilot/config.ts` | Add `roadmapSource: RoadmapSourceName` to `ResolvedConfig`. Parse `roadmap.source` from `.autopilot.yml`, default `"markdown"`, validate against `ROADMAP_SOURCE_NAMES` via the same pattern as `SHIP_TARGET_NAMES`. Export `ROADMAP_SOURCE`. |
| `scripts/autopilot/pipeline.ts` | Import `getRoadmapSource` + `RoadmapSource`. Add `roadmap?: RoadmapSource` to `PipelineDeps` (default: constructed from `ROADMAP_SOURCE` + `REPO`). Replace imported helper calls with `roadmap.parseItemId`, `roadmap.isQuickScope`, `roadmap.getItemPlan({ worktree })`. `detectResumeStep` still lives in helpers.ts but internally uses a MarkdownRoadmap instance for plan lookup — constructed locally, not plumbed through (it only runs on markdown today). |
| `scripts/autopilot/__tests__/roadmap.test.ts` | **New.** Covers: factory returns `MarkdownRoadmap` for `"markdown"`; throws on unknown name; `parseItemId` roundtrip on branch names + explicit IDs; `isQuickScope` true/false cases; `getItemPlan({ worktree })` finds plan file and returns null when absent; `markDone` edits a tmp roadmap/task-index and commits (end-to-end via the existing `makeTempGitRepo` pattern). |
| `scripts/autopilot/__tests__/helpers.test.ts` | No changes required — `parseItemId` and `isQuickScope` currently have no tests here, so the new coverage lands fresh in `roadmap.test.ts`. (The rubric flags `parseItemId` as regex-driven / failure-prone, so we're adding coverage the repo was missing.) |
| `scripts/autopilot/__tests__/pipeline.test.ts` | Add one scenario using a mock `RoadmapSource` injected via `PipelineDeps.roadmap` to verify the pipeline calls into it (e.g., `getItemPlan` is called with `{ worktree }` and the returned path flows into the implement prompt). Existing scenarios continue unchanged against the default markdown adapter. |
| `scripts/autopilot/__tests__/mocks.ts` | Add a `makeMockRoadmap(overrides?)` factory so tests don't each hand-roll the interface. |
| `scripts/autopilot/__tests__/config.test.ts` | Add coverage: defaults yield `roadmapSource: "markdown"`; `roadmap.source: "markdown"` parses; unknown value throws with a clear message. |
| `docs/config.md` | Document the new `roadmap.source` key with the `"markdown"` default. Note the forward-compat reservation for TOOL-10/15. |
| `CLAUDE.md` | Add a short "Roadmap sources" subsection. Name the interface + factory, list the current adapter (markdown), note that adding an adapter means adding a file under `roadmap/` + widening `RoadmapSourceName`. |

## Test strategy

- **Unit (`roadmap.test.ts`)** — the tests listed above. Use the same `makeTempGitRepo` / tmpdir pattern as `helpers.test.ts`. Seed a minimal `docs/roadmap-core.md` + `docs/task-index.md` + `docs/plans/tool-9-*.md` inside the temp repo for the filesystem-touching methods.
- **Integration (`pipeline.test.ts`)** — one new scenario with a mock `RoadmapSource` confirms the pipeline wires into the adapter correctly. Existing scenarios keep using the default markdown adapter (already correct for `makeTempGitRepo` fixtures) so we don't grow the mock footprint unnecessarily.
- **Config (`config.test.ts`)** — three cases: default, explicit markdown, invalid value throws.
- **Smoke** — `pnpm autopilot --dry-run --cycles 1` still succeeds against this repo's real roadmap.

All runs with `--test-reporter=dot` per the rubric's token-cost note.

## Rubric self-check (Correct / Well-typed / Well-factored / Well-tested / Concise — skip Idioms per plan guidance)

- **Correct**
  - **Step exhaustiveness** — no new pipeline Step; `STEPS`, `BUDGETS`, `TURN_LIMITS`, `EFFORT`, `MODEL_PROFILES` untouched. ✓
  - **Frontmatter stripping** — no new skills introduced; `expandSkill()` unchanged. ✓
  - **Worktree isolation** — `MarkdownRoadmap.markDone` writes to `docs/roadmap-*.md` and `docs/task-index.md` in MAIN_REPO. The pipeline never calls `markDone` today (skills handle it inline), so the worktree-isolation hook doesn't trip. Documented on the interface so future work doesn't accidentally call it inside a worktree SDK session. ✓
  - **Rate-limit parking** — refactor doesn't add new pipeline exit paths; `parkExit()` call sites unchanged. ✓
  - **Phantom ship guard** — unchanged; `hasDeliverableCommits()` stays in `helpers.ts` (git-based, not roadmap-format-specific). ✓
  - **`.autopilot.yml` forward-compat** — `roadmap.source` is the documented key; validator only rejects unknown *values* for `source`, not unknown subkeys. TOOL-10 adding `roadmap.github.*` won't choke on older configs. ✓
- **Well-typed**
  - `RoadmapSourceName` is a literal union; factory does exhaustive `switch` with `never` fallback (mirrors `getShipTarget`). ✓
  - No `any`. `sourceRef: string` is opaque but typed. ✓
- **Well-factored**
  - Module boundary is clean: `roadmap/` is the only place that parses roadmap markdown. `pipeline.ts` stops importing format-specific helpers. `helpers.ts` shrinks to "pure utilities + git + logging" only. ✓
  - `config.ts` still has no business logic — just parses `roadmap.source` and exports the resolved name. ✓
- **Well-tested**
  - New adapter covered unit-level; pipeline integration mock confirms the injection seam; config parser coverage. ✓
  - Edge cases: `parseItemId` on branch names with mixed alpha-digit IDs (new coverage — the function is regex-driven and the rubric flags it as failure-prone); `getItemPlan` when plan file is missing (returns `null`); `markDone` when item row is absent → **throws** with a clear message (so callers don't silently miss items). ✓
- **Concise**
  - One new module (2 files), one new test file, small edits to 4-5 existing files. No premature extension points beyond what the roadmap deliverable names. No backwards-compat shims on `helpers.ts` — callers are updated in the same commit. ✓

## Self-review — revisions made

First draft actively wired `claimItem` / `markDone` into the pipeline, which expanded scope into rewriting `/pick` and `/ship` skills — the roadmap explicitly lists that as out-of-scope. Revised: implement the methods on the adapter (so the interface has a real reference impl for TOOL-10) but leave the pipeline's skill invocations untouched this cycle.

Second pass: kept `parseItemId` / `isQuickScope` as re-exports from `helpers.ts` for back-compat. That violates the "no backwards-compat shims" rubric line — this repo has no external consumers of `helpers.ts` beyond its own tests and pipeline. Revised to delete them and update the one test file that imports them.

Third pass: considered adding a `RoadmapSource.verifyConfig()` hook for TOOL-10's "gh CLI installed + authed" graceful-failure requirement. Left out — YAGNI; TOOL-10 adds it when it needs it. Adding a method now that only one future adapter will fill is the premature-abstraction anti-pattern.

Fourth pass: validated the method signatures against the roadmap deliverable text ("`listOpenItems`, `claimItem`, `markDone`, `getItemPlan`"). All four are present and named as listed. `parseItemId` / `isQuickScope` are additions beyond the deliverable list but are load-bearing for the pipeline refactor — reasoning lives in the Approach section.

---

Run `/shakedown` for an independent review, or say **go** to start building. When done, run `/shakedown` again to review the code.
