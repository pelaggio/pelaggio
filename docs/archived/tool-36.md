# TOOL-36 — AbortController-based cancellation for in-flight SDK calls

## Scope

**What this does:**
- Construct a single `AbortController` at process top in `orchestrate()` (the CLI entrypoint, `pipeline.ts:814`).
- Thread its `signal: AbortSignal` through `runOrchestrator` → `runPipeline` → step runner → `query()` so the SDK's in-flight fetch stream is torn down when SIGINT fires.
- Replace the current SIGINT handler (`pipeline.ts:821-824`, which only clears the status bar and calls `process.exit(130)`) with a graceful path: abort the controller, wait up to 2s for `runOrchestrator` to return, then exit 130. Second Ctrl-C exits immediately.
- Add one unit test in `pipeline.test.ts` that simulates SIGINT mid-step and asserts the mocked in-flight step observes the signal and the orchestrator returns within the 2s budget.

**What this does NOT touch:**
- Resumable cancellation semantics — one-shot teardown only, per the charter's out-of-scope.
- Exit-code semantics for non-SIGINT failures — only the SIGINT-path exit is changed (the grace window; code stays `130`).
- Any `execSync` call in `helpers.ts` / `config.ts` / `worktree-deps.ts`. They're synchronous and not cancellable; the charter's "or any `execFile`/`spawn` invocations in step-runner" clause is vacuous today (audit: no async child-process usage exists in `scripts/autopilot/*.ts`, the only in-flight awaitable is the SDK `query()` async iterator). Noting this explicitly so a reader doesn't look for phantom exec integration.
- Parking / rate-limit path. Abort is a user-initiated stop; parking preserves work for auto-resume. They're mutually exclusive failure modes — aborted cycles surface as `error: "aborted"` and the worker loop exits naturally; `parkExit()` semantics are unchanged.
- Auto-checkpoint of uncommitted work on abort. Existing `step()` post-run `checkpoint()` only fires after `runStep` returns successfully; any uncommitted work from an aborted step stays on the worktree for the user to inspect. Adding a safety-net `git add -A && commit` is tempting but expands scope beyond "one-shot teardown" — user can `git status` and resume manually or run `/pickup`.

## Approach

**Signal, not controller, in the type chain.** The SDK's `query()` option `abortController?: AbortController` wants the controller object, not a signal. If we thread the controller itself through `PipelineOpts` / `RunStepOpts`, every downstream caller gains `.abort()` authority they shouldn't have. Instead:

- Public type-chain carries `signal: AbortSignal` (Node's idiomatic cancellation shape).
- Inside `runStep`, adapt for the SDK by creating a short-lived child controller whose `abort()` fires on the parent signal: `const sdkCtrl = new AbortController(); if (opts.signal?.aborted) sdkCtrl.abort(); else opts.signal?.addEventListener("abort", () => sdkCtrl.abort(), { once: true });` — then pass `sdkCtrl` as `abortController` to `query()`. The `{ once: true }` flag auto-removes the listener to prevent accumulation across many steps sharing one parent signal (important in parallel mode).

This also keeps `runStep`'s signature stable for existing tests — `signal` is optional; omitting it means "no cancellation" (current behavior).

**Why `addEventListener`, not `AbortSignal.any([opts.signal])`.** `AbortSignal.any` produces a composed *signal*, but the SDK requires a *controller*. We'd still need to construct a controller wrapper — might as well do it directly.

**Grace-window shape.** In `orchestrate()`:

```
const controller = new AbortController();
let sigintCount = 0;
process.on("SIGINT", () => {
  sigintCount += 1;
  if (sigintCount >= 2) {
    cleanup();
    process.exit(130); // hard exit on double-Ctrl-C
  }
  controller.abort();
  // 2s grace — if runOrchestrator returns first, the normal exit path runs
  setTimeout(() => { cleanup(); process.exit(130); }, 2_000).unref();
});
const { exitCode } = await runOrchestrator(flags, {}, statusBar, controller.signal);
process.exit(exitCode);
```

`.unref()` on the setTimeout lets the process exit naturally if the promise resolves before the timer fires. Double Ctrl-C bypasses the grace — standard Unix expectation (first interrupt is polite, second is force).

**Where the signal threads through.** Minimal touch:

1. `orchestrate()` creates controller + SIGINT wiring (above).
2. `runOrchestrator(flags, deps, statusBar, signal?)` gets a new optional fourth param. Stored locally; passed to every `_runPipeline(...)` call (three sites: resume path, main worker loop, park-resume loop). No change to `OrchestratorDeps` — signal is execution state, not a mockable collaborator.
3. `PipelineOpts` gains `signal?: AbortSignal`.
4. `runPipeline`'s inner `step()` helper forwards `opts.signal` into the `RunStepOpts` it builds.
5. `RunStepOpts` gains `signal?: AbortSignal`.
6. Inside `runStep`: construct `sdkCtrl` as described, pass `abortController: sdkCtrl` into the `query()` options object alongside the existing `canUseTool`/`hooks`/etc.

No change to the roadmap-CLI, skills, or any other shell-outs.

**Existing `/abort/i` catch already handles the thrown error.** `step-runner.ts:301-302` already maps abort errors to `subtype = "error_abort"`. When `sdkCtrl.abort()` fires, the SDK's async iterator throws; the existing `try/catch` wraps `for await (const msg of gen)`. The step returns `{ ok: false, subtype: "error_abort" }`, the pipeline logs a non-completed cycle, the worker loop's `if (!result.completed && !RECOVERABLE.has(result.error ?? ""))` exits — and `"aborted"` / `error_abort` are deliberately not in `RECOVERABLE`, so aborted workers stop instead of retrying. Good.

One piece of glue: currently `runPipeline` converts step failures to `CycleResult.error` strings (e.g., "parked", "plan needs rethink"). For abort, we want a distinct error string so the orchestrator's summary shows `✗ aborted` rather than a generic subtype label. But each step's failure branch inlines its own `error: "X failed"` — there's no single shared translation point. Two options I considered:

1. **Check `subtype === "error_abort"` at every `!step.ok` branch** (plan / shakedown-plan / implement / shakedown-code / ship). Five touch-points, easy to drift.
2. **Override in `finish()` using `opts.signal?.aborted`** (chosen). Single intercept: at the top of `finish()`, if `opts.signal?.aborted` is true and the result isn't already `parked` (park wins — it's a preserve-work path, abort is a discard-work path, but both can't be true since `step()` short-circuits once aborted), override `result.error = "aborted"`. This works because SIGINT handler fires `controller.abort()` before any step returns, so by the time `finish()` runs, the signal reflects true intent.

Abort-check short-circuit in `step()`: add once at the very top of `step()` (before the dry-run branch, so Ctrl-C during `--dry-run` also aborts cleanly) — if `opts.signal?.aborted`, skip calling `runStep` and return `{ ok: false, subtype: "error_abort", text: "aborted", fullText: "", cost: 0, turns: 0 }` immediately. Then the usual `!step.ok` propagation runs, and `finish()`'s override swaps the error string. This also avoids useless `runStep` invocations if SIGINT fires between steps.

## Files to change

| File | Change |
|------|--------|
| `scripts/autopilot/types.ts` | Add `signal?: AbortSignal` to `PipelineOpts` (~line 103). |
| `scripts/autopilot/step-runner.ts` | Add `signal?: AbortSignal` to `RunStepOpts` interface; create child `AbortController` from signal; pass `abortController: sdkCtrl` into `query()` options. |
| `scripts/autopilot/pipeline.ts` | (a) `runOrchestrator` gains 4th param `signal?: AbortSignal`, forwards into the three `_runPipeline` calls via `opts.signal`. (b) `runPipeline`'s inner `step()` forwards `opts.signal` into `RunStepOpts`. (c) Short-circuit at the top of `step()` (before the dry-run branch): if `opts.signal?.aborted`, emit a `done` event with `subtype: "error_abort"` and return an aborted-shaped `StepResult` without calling `runStep`. (d) Override in `finish()`: if `opts.signal?.aborted && result.error !== "parked"`, set `result = { ...result, error: "aborted" }` before the `appendLog` call, so the logged entry and the returned value agree. (e) `orchestrate()` constructs the controller, wires the 2-stage SIGINT handler, forwards the signal to `runOrchestrator`. |
| `scripts/autopilot/__tests__/mocks.ts` | Update `createMockRunStep` to honor `opts.signal`. Order: (1) if `opts.signal?.aborted` already when invoked, return `{ ok: false, subtype: "error_abort", text: "aborted", ... }` immediately; (2) else if a new `StepOutcome.awaitAbort: true` flag is set, await the signal's `abort` event (`new Promise(r => opts.signal?.addEventListener("abort", r, { once: true }))`) before applying the rest of the outcome. This lets tests simulate both "already aborted between steps" and "in-flight when SIGINT fires." |
| `scripts/autopilot/__tests__/pipeline.test.ts` | New test (see below). |

No skills, no config, no `BUDGETS`/`TURN_LIMITS`/`EFFORT`/`MODEL_PROFILES` — `signal` is runtime state, not a step parameter.

## Test strategy

One new test in `pipeline.test.ts`, in its own `describe` block:

```
describe("runPipeline — SIGINT cancellation", () => {
  it("step receiving an aborted signal returns error_abort and the cycle surfaces error: 'aborted'", async () => {
    const controller = new AbortController();
    const parkSignal = makeParkSignal();
    const worktree = makeTempGitRepo();

    // Mock: plan step awaits the signal, then throws an abort-shaped error
    const { runStep, calls } = createMockRunStep(
      { plan: { awaitAbort: true, ok: false, subtype: "error_abort", text: "aborted" } },
      parkSignal,
    );

    // Fire abort after ~20ms so the mock is "in-flight" when it happens
    const abortAt = setTimeout(() => controller.abort(), 20);

    const t0 = Date.now();
    const result = await runPipeline(
      { ...baseOpts(worktree), signal: controller.signal },
      parkSignal, baseFlags,
      { runStep, mainRepo: worktree, listWorktrees: () => [], appendLog: () => {} },
    );
    const elapsed = Date.now() - t0;
    clearTimeout(abortAt);

    assert.equal(result.completed, false);
    assert.equal(result.error, "aborted");
    assert.ok(elapsed < 2000, `expected abort to return well under the 2s grace window; got ${elapsed}ms`);
    assert.equal(calls[0].step, "plan");
  });
});
```

This covers the charter's "simulates SIGINT mid-step and asserts the in-flight mock is aborted and the process exits within the budget" without needing a real subprocess. The orchestrator-level 2s `setTimeout` hard-exit isn't testable via `runOrchestrator` (it lives in `orchestrate()`, which calls `process.exit`); verifying that path needs a subprocess test, which is higher cost for a single-line `setTimeout().unref()`. I'll skip it — the important contract (signal propagates; SDK abort surfaces as a clean `CycleResult`) is what the test exercises, and the grace-window plumbing is simple enough to inspect by eye.

Existing tests that pass no `signal` should keep working — the field is optional, and `createMockRunStep`'s new branch only fires when `awaitAbort: true` is set.

Run: `npx tsx --test scripts/autopilot/__tests__/pipeline.test.ts scripts/autopilot/__tests__/step-runner.test.ts scripts/autopilot/__tests__/orchestrator.test.ts` — all must pass. Also `pnpm check` for biome.

## Rubric self-check

- **Correct.** Step exhaustiveness: not a new step, so `BUDGETS`/`TURN_LIMITS`/`EFFORT`/`MODEL_PROFILES` are untouched. Frontmatter stripping: N/A (no skill edits). Worktree isolation: unchanged (PreToolUse hooks still fire; signal is orthogonal). Plan-polish block: N/A. Rate-limit parking: unchanged — abort and park are mutually exclusive paths, verified by the `RECOVERABLE` set not containing `"aborted"`. Phantom ship guard: N/A — an aborted cycle has `completed: false` and never reaches ship. Permission mode: unchanged. No hardcoded model strings: N/A.
- **Well-typed.** `signal?: AbortSignal` is the standard Node shape. Optional field keeps every existing caller (tests, inline invocations) source-compatible. No `any` escape hatches; `AbortSignal` / `AbortController` are lib-dom builtins.
- **Well-factored.** One new field at each type boundary (`PipelineOpts`, `RunStepOpts`), one child-controller adapter inside `runStep`, one SIGINT handler in `orchestrate()`. No helper file, no new abstraction — the wiring is straight-line. The "map `error_abort` to `error: 'aborted'`" translation happens at a single site.
- **Well-tested.** One focused test covers the signal propagation + error surfacing contract. The `awaitAbort` flag in `createMockRunStep` is reusable for future cancellation tests.
- **Concise.** ~40 lines across three source files plus the mock extension and the test. No speculative generality (no "cancellation manager" class, no hook system).

## Self-review notes

Second pass caught three things I revised inline:

1. **Signal vs controller choice** — first draft had me threading the `AbortController` directly because the SDK wants one. Revised to thread the signal and adapt locally, so authority to `.abort()` stays with `orchestrate()`.
2. **Listener accumulation in parallel mode** — when multiple `runStep` calls share one parent signal (parallel workers, or sequential steps within one pipeline), without `{ once: true }` each step would register a listener that lives until GC. Added the flag + an `opts.signal?.aborted` fast-path.
3. **Where the error-string translation lives** — first draft sprinkled `subtype === "error_abort"` checks across every step's failure branch. Revised to a single short-circuit at the top of `step()` (if already aborted, return immediately) plus one translation on the way out.

Deferred to `/shakedown`: idiom drift (e.g., whether `setTimeout(...).unref()` is the right pattern here vs a `Promise.race` with the work promise), convention with the rest of the codebase's error strings, and whether the double-Ctrl-C count-based approach matches prior art in this repo.
