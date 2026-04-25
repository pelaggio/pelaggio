# TOOL-51 — `_resolveWorktree` fallback: actionable diagnostics on miss

## Scope

**In:**
- Enrich the existing `_resolveWorktree`-miss block in `pipeline.ts` so the three branches (single nested match, multiple matches, no match) all produce actionable output:
  - **Single match:** add a clear `log()` line `expected <path>, using <found> for in-flight <extendedId>`.
  - **Multiple matches:** keep current behaviour (`worktree ambiguous: <a>, <b>` already names the children) — unchanged.
  - **No match:** replace the bare `"worktree missing"` error string with one that names `itemId`, the expected path, and a one-line summary of `git worktree list`.
- Tests covering all three branches in `__tests__/pipeline.test.ts`.

**Out:**
- The second `worktree missing` site at `pipeline.ts:232` (the `opts.worktree` resume branch). Different cause, different signal — out of scope per the charter, which targets `_resolveWorktree`-miss specifically.
- Re-litigating TOOL-35 (`parseItemId`, `CLAIMED:` marker).
- Auto-recovery / re-creation of missing worktrees.
- Extracting a shared matching helper. The block runs once per cycle and has no other call site; inline matches the surrounding pipeline.ts style.

## Approach

The block at `pipeline.ts:211-227` already does the *matching* work the charter calls for — single-match adoption resolves; multi-match aborts with `worktree ambiguous: <list>` (which names the children); no-match aborts with bare `"worktree missing"`. Two of three branches are already correct. The remaining gaps are diagnostic, not behavioural:

1. **Adoption is silent.** When we adopt a sibling worktree, the operator has no breadcrumb. Add `log(...)` before the assignment.
2. **No-match error swallows context.** Add itemId, expected path, and a one-line `git worktree list` summary.

I considered extracting a `tryAdoptNestedWorktree(itemId, list, expected)` helper returning `{ kind: "found" | "ambiguous" | "missing", ... }`. Rejected: single-site, ten lines, tight coupling to local `log()` and `finish()`. Indirection without reuse. The surrounding pipeline.ts is full of similar inline decision trees (e.g. the `newWt` prefix-fallback two lines above).

For the no-match summary, basenames keep the line short and stable across machines (absolute paths leak `/tmp/...` noise into cycle logs). Format: `git worktree list (N entries): a, b, c`. No length cap — any sane setup has <20 worktrees, and truncating risks hiding the one entry that would diagnose the bug.

For the adoption log, `extendedId` is recovered by stripping `WORKTREE_PREFIX` from the basename and uppercasing the remainder. E.g. `autopilot-comp-11c-ii-fixes` → slug `comp-11c-ii-fixes` → `COMP-11C-II-FIXES`.

## Files

| File | Change |
|---|---|
| `packages/autopilot/scripts/autopilot/pipeline.ts` | In the `_resolveWorktree`-miss block (currently lines 211-227): add a `log(...)` call when `nested.length === 1`; replace the bare `"worktree missing"` string with one that includes `itemId`, expected path, and a one-line summary of the `listWorktrees()` result. |
| `packages/autopilot/scripts/autopilot/__tests__/pipeline.test.ts` | Update the existing single-match test (`worktree cross-reference adopts a nested sub-item worktree…`, line 572) to capture `console.log` via `t.mock.method` and assert the new log line. Update the existing no-match test (`worktree missing — pick succeeds, id parses, but worktree dir not created…`, line 494) to use `assert.match` against the enriched error string covering itemId, expected basename, and the `git worktree list (N entries):` summary. The multi-match test (line 624) is unchanged — its existing `/worktree ambiguous/` assertion plus the comma-joined paths already satisfy the "naming the children" requirement. |

## Test strategy

Three node:test cases — two updated, one untouched — under the existing `runPipeline — pick + worktree resolution` describe block.

- **(a) Single-match resolves and logs.** `t.mock.method(console, "log", ...)` records calls during `runPipeline`. After the cycle completes, assert `result.completed === true` (already passes) and that one captured log line matches a regex like `/expected .* using .* for in-flight COMP-11C-II-FIXES/`. Mock is auto-restored at end of test by node:test.
- **(b) Multiple matches abort naming the children.** Existing assertion `assert.match(result.error ?? "", /worktree ambiguous/)` plus the impl's `nested.join(", ")` already covers this — no test change.
- **(c) No match yields enriched error.** Replace `assert.equal(result.error, "worktree missing")` with three `assert.match` checks: includes `TOOL-99`, includes the expected basename (e.g. `${WORKTREE_PREFIX}tool-99`), and includes `git worktree list (` (the count-prefixed summary; the test's `listWorktrees: () => []` yields `0 entries`, which proves the summary fired even when the list is empty).

Run via `pnpm -r test` (workspace) or `npx tsx --test packages/autopilot/scripts/autopilot/__tests__/pipeline.test.ts` for the targeted file.

## Rubric self-check

- **Correct.** No interaction with step exhaustiveness, frontmatter stripping, plan-polish hook, phantom ship guard, or model-string rules. Worktree isolation preserved — adoption still requires a real entry from `git worktree list`. Rate-limit parking unaffected — this site fires after `pick` committed; there's no in-flight uncommitted work to park, and the existing `finish()` path already handles abort/parked relabeling. Cross-platform basename extraction keeps the existing `p.split(/[/\\]/).pop()` style for consistency with the multi-match filter five lines away.
- **Well-typed.** No new types or signatures. `log()` accepts a string, error fields are `string`, summary is built via `Array.join`.
- **Well-factored.** Localized inside the existing block. No new exports. No utility extraction (no second call site).
- **Well-tested.** All three charter-required branches covered with clear failure messages. The `console.log` mock is the minimum needed to verify the operator-facing log without restructuring the pipeline's logging plumbing.
- **Concise.** ~10 lines added in `pipeline.ts`; ~10 lines updated across two existing test cases. No new files.
