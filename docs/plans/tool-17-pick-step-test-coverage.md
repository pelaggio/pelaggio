# TOOL-17 — Pipeline pick-step test coverage (needs REPO injectability)

## Scope

Add unit-test coverage for the pick branch of `runPipeline` in `scripts/autopilot/pipeline.ts` (lines 146–179, the `if (!worktree) { ... }` block). Today that branch is untested because:

- `runPipeline` calls `runStep("pick", ..., REPO)` with the module-level `REPO` constant as cwd, and
- `resolveWorktree(itemId)` is imported unqualified from `helpers.ts` and resolves to `resolve(REPO, "..", WORKTREE_PREFIX+id)` — outside any tmpdir the test can control.

To exercise pick safely, tests need to redirect both the repo root used as the pick-step cwd and the worktree-path derivation. This plan widens the existing `PipelineDeps.mainRepo` seam to also cover pick/shipwreck cwd, adds a `resolveWorktree` dep mirroring `OrchestratorDeps`, and adds six scenario tests in `pipeline.test.ts`.

### In scope

- Extend `PipelineDeps` with `resolveWorktree?: typeof resolveWorktree` (matches `OrchestratorDeps` idiom at pipeline.ts:487).
- Route the pick-step cwd (and shipwreck-step cwd, for symmetry) through the existing `deps.mainRepo ?? REPO` — no new prop. `mainRepo` semantically names the main git repo regardless of the call site using it (ghost-ship verification, pick cwd, shipwreck cwd all refer to the same directory).
- Route worktree derivation through `deps.resolveWorktree ?? resolveWorktree`.
- Add a temp-git-parent helper to `__tests__/mocks.ts` so tests can stand up a main repo + adjacent worktree inside a common tmp parent.
- Five new scenarios in `pipeline.test.ts` covering pick success, "nothing to pick", "no item ID parsed", "pick failed", and "worktree missing".
- One scenario covering the existing `WORKTREE_PREFIX` fallback path on line 170 — proves the fallback still fires against the injected repo.

### Out of scope

- Refactoring other call sites of `REPO` in the codebase. The two prompt-string fallbacks on lines 261 and 359 (the `resolve(REPO, ".dev/plans")` / `resolve(REPO, "docs/plans")` hints embedded in implement/shakedown-code prompts) are *text content* sent to the SDK, not functional paths — leaving them on the module-level `REPO` keeps the surface minimal. (They're also not exercised in the new tests because the mock roadmap always returns a plan path.)
- Refactoring `WORKTREE_PREFIX` itself. It's module-level (derived from `basename(REPO)` at import time) and stays that way. Tests that need the prefix-fallback branch construct `listWorktrees()` output whose paths include `WORKTREE_PREFIX` by importing the constant from `config.js` — environment-agnostic, so whether tests run from the main repo (`claude-autopilot-`) or a worktree (`claude-autopilot-tool-17-`), the substring matches. This also sidesteps the rubric's note about needing `CLAUDE_AUTOPILOT_WORKTREE_PREFIX` env-var mocking: because we inject `mainRepo` via `PipelineDeps` instead of swapping the module-level `REPO`, no env juggling is required.
- Changing the orchestrator-level `REPO` uses (the `.dev/autopilot-{N}.log` paths on lines 607–608 and 733). That's `runOrchestrator`'s concern, not `runPipeline`'s.

## Approach — why this over alternatives

**Chosen: widen existing `mainRepo` prop + add `resolveWorktree` via `PipelineDeps`.** Mirrors the pattern `OrchestratorDeps` already uses (`resolveWorktree?: typeof resolveWorktree` at pipeline.ts:487). `mainRepo` already exists on `PipelineDeps` for ghost-ship verification; its semantic meaning ("the path to the main git repo") applies equally to the pick-step cwd and shipwreck-step cwd, so reuse it rather than introducing a parallel `repo` prop that would always hold the same value. Keeps the production code path unchanged — defaults fall through to the module-level constants — and makes the test seam explicit. The worktree-derivation path still needs its own dep because it's a function, not a path.

**Alternative considered: a module-level `setRepoForTesting()` override.** Rejected — global state makes parallel test runs order-dependent, and we already have a clean dep-injection pattern in the file. The `PipelineDeps` interface exists precisely for this kind of seam.

**Alternative considered: do nothing and rely on orchestrator-level coverage.** Rejected — that's what TOOL-4 did, and TOOL-17 is the follow-up to close the gap. Pick is nontrivial (claim detection, item-ID parsing, worktree existence verification, prefix fallback) and deserves its own tests.

## Files to change

| Path | Change |
|------|--------|
| `scripts/autopilot/pipeline.ts` | Add `resolveWorktree?: typeof resolveWorktree` to `PipelineDeps` (do **not** add a new `repo` prop — reuse existing `mainRepo`). Resolve at the top of `runPipeline` (`const _resolveWorktree = deps.resolveWorktree ?? resolveWorktree;`). Replace `REPO` with `mainRepo` at the pick-step `runStep(... REPO)` call (line 156) and the shipwreck-step call (line 446). Replace `resolveWorktree(itemId)` with `_resolveWorktree(itemId)` at line 168. Leave the two prompt-string uses of `REPO` (lines 261, 359) as-is — documented in Scope. |
| `scripts/autopilot/__tests__/mocks.ts` | Add `makeTempRepoWithParent()` helper returning `{ parent, repo }` — creates a tmp parent dir, then creates a git repo inside it (same init steps as `makeTempGitRepo`), and returns both paths so tests can derive a sibling worktree path. Keep `makeTempGitRepo` unchanged for existing callers. |
| `scripts/autopilot/__tests__/pipeline.test.ts` | Add a new `describe("runPipeline — pick step", ...)` block with six `it` cases (listed below). |

## Test strategy

Each new test follows the existing pattern: mock `runStep` via `createMockRunStep`, inject `roadmap` via `makeMockRoadmap` with a custom `parseItemId`/`getItemPlan`, pass `mainRepo` and `resolveWorktree` through `PipelineDeps`, and assert on `result` + `calls` + `logs`. All share a `makeTempRepoWithParent()` setup to keep the sibling worktree inside tmpdir.

For the pick step to succeed, the mock's `pick` outcome must:
1. Return text matching `/claimed|worktree add|successfully/i` (to pass the line-163 regex check).
2. Use a `sideEffect` that creates the target worktree directory on disk (so the line-169 `existsSync(worktree)` check passes). For the prefix-fallback test, skip the sideEffect and instead have the injected `listWorktrees` return a path containing `WORKTREE_PREFIX`.

The mock roadmap's `parseItemId` returns `"TOOL-99"` for the success cases and `null` for the "no item ID parsed" case.

### New test cases

1. **pick success** — opts omits `worktree`. Pick mock's `sideEffect` is `(cwd) => mkdirSync(<expected worktree path>)` — since `createMockRunStep` passes `opts.cwd` to `sideEffect` (mocks.ts:47), using that cwd *inside* the sideEffect implicitly proves the injected `mainRepo` reached pick. Returns text with "claimed". Verify: all six steps run (`pick`→`ship`), `result.completed === true`, `result.itemId === "TOOL-99"`, `calls[0].step === "pick"`, and the worktree directory landed under the injected tmp parent (not `..` of the real repo).

2. **pick failed** — pick returns `{ ok: false }`. Verify: only pick runs, `result.error === "pick failed"`, `result.itemId === null`, `logs[0].completed === false`.

3. **nothing to pick** — pick returns `ok: true` but text has no "claimed|worktree add|successfully" match. Verify: `result.error === "nothing to pick"`, `result.itemId === null`, no subsequent steps run.

4. **no item ID parsed** — pick returns `ok: true` with text "claimed" but the roadmap's `parseItemId` returns `null` for both `text` and `fullText`. Verify: `result.error === "no item ID parsed"`, `result.itemId === null`.

5. **worktree missing** — pick succeeds and roadmap parses `TOOL-99`, but the sideEffect does NOT create the worktree dir, and `listWorktrees` mock returns `[]`. Verify: `result.error === "worktree missing"`, `result.itemId === "TOOL-99"` (id is known, worktree is not).

6. **worktree-prefix fallback** — pick succeeds, sideEffect does NOT create the exact path `_resolveWorktree` returns, but `listWorktrees` returns a new path (not in `worktreesBefore`) whose string contains `WORKTREE_PREFIX` (`"claude-autopilot-"` at test time — import from `config.js`). Verify: pipeline recovers, `worktree` is redirected to the found path, subsequent steps run, `result.completed === true`. This test proves the existing prefix-fallback logic at line 170 still works under the injected repo.

### Expected assertions per test

- `result.completed`, `result.error`, `result.itemId`
- `calls.map((c) => c.step)` (ordered list of steps actually invoked)
- `logs.length === 1` and key log fields (`completed`, `error`)
- For the success case: one checkpoint commit was created (via `allCommitMessages`)

### Tests to run

```bash
npx tsx --test scripts/autopilot/__tests__/pipeline.test.ts
npx tsx --test scripts/autopilot/__tests__/helpers.test.ts  # smoke — we didn't touch helpers but pipeline imports it
pnpm check  # biome
```

## Rubric self-check

- **Correct.** The pipeline's `STEPS`, `BUDGETS`, `TURN_LIMITS`, `EFFORT`, and `MODEL_PROFILES` are untouched — this is test-scaffolding + two dep-injection props, no new step. Frontmatter stripping (expandSkill) is not affected. Worktree-isolation PreToolUse hook is not touched (it's in step-runner, not pipeline). Rate-limit parking: we don't change `parkExit`; the pick-failure paths correctly return via `finish()` without a park path, which is already the pre-existing behavior. Phantom-ship guard is not touched (fires later in `runPipeline`, after pick). No hardcoded model strings.
- **Well-typed.** New `PipelineDeps.resolveWorktree` uses `typeof resolveWorktree` — mirrors `OrchestratorDeps` (pipeline.ts:487). Defaults via `??` keep the existing signatures. No `as` casts. The tests import `WORKTREE_PREFIX` from `config.js` through the existing re-export chain.
- **Well-factored.** Reuses existing `mainRepo` dep rather than adding a duplicate `repo` prop — both semantically name the same thing (path to the main git repo). One new dep (`resolveWorktree`), not two. The new `makeTempRepoWithParent()` helper sits beside the existing `makeTempGitRepo` in `mocks.ts` — same style, ~10 lines.
- **Well-tested.** Six scenarios cover all four early-exit branches in the pick block (pick failed / nothing to pick / no item ID / worktree missing), one happy path, and one prefix-fallback edge. No overlap with existing tests — those all pass `worktree` in opts and skip the pick block entirely.
- **Concise.** Production code change: ~3 lines (one new dep field + one variable reassignment + two `REPO`→`mainRepo` swaps at existing call sites). Test code grows by ~120 lines across six cases. Mock helper grows by ~8 lines. No dead code; no speculative future-proofing.
- **Idioms.** Deferring to `/shakedown`.

## Commit plan

One commit: `test(pipeline): cover pick step via repo + resolveWorktree injection (TOOL-17)`. Includes the pipeline.ts injection seam, the mocks.ts helper, and the six new test cases. Task-index + roadmap updates handled by `/ship`.
