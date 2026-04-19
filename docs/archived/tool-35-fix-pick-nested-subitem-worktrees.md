# TOOL-35 — Fix `/pick` claiming parent ID when nested sub-items own worktrees

## Scope

**What it does**: repair three independent layers that together caused the pipeline to claim `COMP-11` when a sibling worktree was already in-flight for `COMP-11c-ii`, then error `worktree missing`.

- Make `MarkdownRoadmap.parseItemId` hierarchical-aware: match the longest open-items ID whose normalized form is a prefix of the slug, instead of stopping at the first numeric group (`^([a-z][\da-z]*(?:-\d+)?)`).
- Add a structured `pick-item: <ID>` marker to `/pick`'s success output so the pipeline reads the actually-claimed ID from a reliable channel rather than free-text parsing.
- On `worktree missing`, scan `listWorktrees()` for branches whose slug extends the parsed `itemId`; if exactly one matches, adopt it (a nested sub-item was really in-flight); otherwise abort with an error naming the in-flight children so the cause is obvious.

**What it does not touch**:
- Hierarchy format / roadmap conventions. Consumers with IDs like `COMP-11c-ii` are supported as-is.
- `/pick`'s narrative prose — only the structural marker changes.
- `GitHubIssuesRoadmap` / `LinearRoadmap` parseItemId semantics (their IDs aren't hierarchical in the same shape). They pick up the `async` interface change and nothing else.

## Approach

Three layered fixes, each of which independently shrinks the failure surface; together they close the race:

1. **Async `parseItemId` with longest-prefix disambiguation.** The root cause of the misparse is that the branch-slug regex can't represent IDs with post-digit letters or nested segments. Rather than inventing a more permissive regex and hoping it still terminates cleanly (slug descriptions like `feat/tool-9-roadmap-source` are ambiguous without external knowledge), consult the open-items list and pick the longest ID whose lowercase-with-dashes form is a prefix of the slug. This requires `listOpenItems()`, which is already async, so `parseItemId` widens from sync → `Promise<string | null>`. Alternative considered: cache a sync snapshot — rejected because `MarkdownRoadmap.listOpenItems` is already cheap (two fs reads) and adding a cache layer means reasoning about invalidation on `/charter` commits.
2. **`pick-item:` marker in `/pick`.** Even with parseItemId fixed, parsing the ID out of free-form pick narration is fragile: the skill may mention other IDs in passing ("blocked on COMP-11"). The skill body knows exactly which ID it claimed; have it emit `pick-item: <ID>` on its own line next to the existing `pick-result: claimed` tag. Pipeline prefers this marker; falls back to `roadmap.parseItemId` if absent (keeps older skill copies working).
3. **Worktree cross-reference on miss.** Even with (1) and (2) solid, there's still a class of failures where itemId was correctly parsed but `_resolveWorktree(itemId)` doesn't land on the right path (e.g. a sub-item claim whose slug differs from the canonical derivation). Scanning existing worktrees for branches that start with `feat/<id-lower>` and are followed by a descriptive tail turns "worktree missing" into either a recovery or a clearly-actionable error.

## Files to change

| File | Change |
|------|--------|
| `scripts/autopilot/roadmap/types.ts` | Widen `RoadmapSource.parseItemId` to `(text: string) => Promise<string \| null>`. |
| `scripts/autopilot/roadmap/markdown.ts` | Rewrite `parseItemId`: broaden branch-slug regex to allow hierarchical segments; `await listOpenItems()`; among known IDs whose lower-with-dashes form is a **string prefix** of the slug, pick the longest (so `[COMP-11, COMP-11C, COMP-11C-II]` against slug `comp-11c-ii-…` yields `COMP-11C-II`; `[COMP-11]` only yields `COMP-11`). Fall through to explicit uppercase-ID regex, preferring the longest known ID when multiple candidates appear in text. Final fallback = current regex for robustness when `listOpenItems` is empty (baseline behavior preserved). |
| `scripts/autopilot/roadmap/linear.ts` | `async parseItemId(text)`; `resolveIdentifier` must also become `async` so it can `await this.parseItemId(…)` at lines 153, 159 (its sole caller `getItemPlan` is already async). Behavior identical. |
| `scripts/autopilot/roadmap/github-issues.ts` | `async parseItemId(text)`; `resolveIssueNumber` must also become `async` so it can `await this.parseItemId(…)` at lines 131, 137 (its sole caller `getItemPlan` is already async). Behavior identical. |
| `scripts/autopilot/helpers.ts` | Add `parsePickItem(text: string): string \| null` — reads the last `pick-item:\s*<ID>` line, validates the shape `[A-Z]+-?\d[\dA-Z-]*`. Colocated with `parsePickResult`. |
| `scripts/autopilot/pipeline.ts` | Import `parsePickItem`; at line 179 prefer `parsePickItem(pickText) ?? (await roadmap.parseItemId(pick.text)) ?? (await roadmap.parseItemId(pick.fullText))`. At lines 183-187, before returning `worktree missing`, scan `listWorktrees()` for paths whose basename starts with `${WORKTREE_PREFIX}${itemId.toLowerCase()}` followed by `-` or end-of-string; if exactly one matches use it, if >1 abort with `worktree ambiguous: {list}`, if 0 keep the existing `worktree missing` error. |
| `.claude/skills/pick/SKILL.md` | In "Claim" step (5), add `pick-item: <ID>` structured line on its own immediately before the existing `pick-result: claimed`. Update "Result tag" section to mention the companion marker. |
| `scripts/autopilot/__tests__/mocks.ts` | Update `makeMockRoadmap`: `parseItemId` becomes async (`async (text) => …`). |
| `scripts/autopilot/__tests__/roadmap.test.ts` | Add tests for hierarchical IDs (see Test strategy). Adjust existing assertions to `await r.parseItemId(…)`. |
| `scripts/autopilot/__tests__/roadmap-github.test.ts` | Adjust assertions to `await`. |
| `scripts/autopilot/__tests__/roadmap-linear.test.ts` | Adjust assertions to `await`. |
| `scripts/autopilot/__tests__/helpers.test.ts` | Add `parsePickItem` unit tests — present / absent / last-wins / invalid shape rejected. |
| `scripts/autopilot/__tests__/pipeline.test.ts` | Add two tests: (a) `pick-item:` marker is honored over free-text parse; (b) worktree-cross-reference adopts a nested sub-item worktree when `_resolveWorktree(itemId)` missed. Existing tests that stub `parseItemId` update to `async () => …`. |

Line-count estimate: ~120 LOC production + ~90 LOC tests. No new files.

## Test strategy

**Unit — `MarkdownRoadmap.parseItemId` (in `roadmap.test.ts`)**:
- Hierarchical branch slug resolves to longest known ID:
  - Given items `[TOOL-9]`, `await r.parseItemId("feat/tool-9-roadmap-source")` → `"TOOL-9"` (baseline preserved).
  - Given items `[COMP-11, COMP-11C, COMP-11C-II]`, `await r.parseItemId("feat/comp-11c-ii-fixes")` → `"COMP-11C-II"`.
  - Given items `[COMP-11]` only, `await r.parseItemId("feat/comp-11c-ii-fixes")` → `"COMP-11"` (longest *known* wins; unknown deeper form not invented).
- Explicit-ID path also disambiguates: items `[COMP-11, COMP-11C]`, input `"claimed COMP-11C successfully"` → `"COMP-11C"` (not `"COMP-11"`).
- Fallback preserved when `listOpenItems` returns empty: current regex behavior for `"item COMP13"` → `"COMP13"`.

**Unit — `parsePickItem` (in `helpers.test.ts`)**:
- Present → parsed: `"pick-item: COMP-11C-II"` → `"COMP-11C-II"`.
- Absent → `null`.
- Last-wins when repeated (mirrors `parsePickResult`).
- Malformed (`"pick-item: foo bar"`) → `null`.

**Pipeline integration (in `pipeline.test.ts`)**:
- **Marker honored**: pick output `"found COMP-11 blocker, claimed COMP-11c-ii successfully\npick-item: COMP-11C-II\npick-result: claimed"` — even with a mock `parseItemId` that would return `"COMP-11"` (free-text path), pipeline uses `"COMP-11C-II"` from the marker and resolves the correct worktree.
- **Worktree cross-reference**: `_resolveWorktree("COMP-11C-II")` returns a nonexistent path; `listWorktrees()` returns a pre-existing `${WORKTREE_PREFIX}comp-11c-ii-nested`; pipeline adopts that path and continues. Add a sibling case asserting the *ambiguous* branch aborts with a clear error naming both candidates.

**Verification (rubric commands)**:
- `npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/*.test.ts`
- `npx tsx -e "import('./scripts/autopilot/pipeline.ts')"` — validates the new async `await` wiring parses.
- `pnpm check` — Biome on `scripts/**/*.ts`.
- `pnpm check:skills` — validates the updated `/pick` frontmatter/include.

## Rubric self-check

- **Correct** — The three load-bearing invariants this touches:
  - *Worktree isolation*: unchanged. The pipeline still passes `worktree` (never `mainRepo`) to downstream steps; the cross-reference only widens the set of candidate paths that count as "this cycle's worktree" without affecting `step-runner`'s hook installation.
  - *Rate-limit parking preserves work*: new exit paths (`worktree ambiguous`) happen before any checkpoint is at risk — `parkExit()` is untouched and the new error returns via the existing `finish()` codepath.
  - *Phantom ship guard*: orthogonal, unaffected.
  - *Step exhaustiveness*: no new step, no `MODEL_PROFILES` / `BUDGETS` / `TURN_LIMITS` / `EFFORT` changes needed.
  - *Frontmatter stripping*: the new `pick-item:` line lives in the skill body (below frontmatter) — `expandSkill()` untouched.
- **Well-typed** — `parseItemId` signature change is load-bearing on the interface; adapters and the mock all move together so no `any` casts. `parsePickItem` returns `string | null` to match `parsePickResult`'s shape. No new literal-union widening.
- **Well-tested** — `parseItemId`, `parsePickItem`, and pipeline cross-reference all have explicit tests. Hierarchical-ID cases exercise the actual fathom failure shape (`COMP-11c-ii`). Edge cases (empty items list, ambiguous worktrees, malformed marker) covered.
- **Well-factored** — all three fixes stay in their module boundaries: `roadmap/markdown.ts` owns ID parsing, `/pick` skill owns its marker contract, `pipeline.ts` owns orchestration. No new helper file.
- **Concise** — no new abstractions introduced. `parsePickItem` is a direct peer of `parsePickResult` (~8 lines). Worktree cross-reference is ~10 lines inline in the existing `if (!existsSync(...))` branch, not a new function. Total scope is genuinely S.
- **Idioms** — deferred to `/shakedown` per standing guidance.

## Execution order

1. Update `roadmap/types.ts` signature.
2. Update `roadmap/markdown.ts` `parseItemId` + add tests (roadmap.test.ts).
3. Update `roadmap/linear.ts` and `roadmap/github-issues.ts` for async signature; run tests to confirm.
4. Update `helpers.ts` with `parsePickItem` + tests.
5. Update `pipeline.ts` call sites (marker preference, cross-reference on miss).
6. Update `.claude/skills/pick/SKILL.md` to emit the marker.
7. Update `mocks.ts` + pipeline tests (marker honored, cross-reference adoption).
8. Run full verification: tests, `pnpm check`, `pnpm check:skills`.
