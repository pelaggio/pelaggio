# TOOL-19 — `orchestrate()` test coverage

## Scope

**In:** unit-test coverage for the outer `orchestrate()` loop in `scripts/autopilot/pipeline.ts`. Scenarios called out in the roadmap:

- resume mode uses `detectResumeStep` and invokes `runPipeline` with the correct `startFrom`
- parallel workers share a single `pickMutex` instance
- park-and-resume respects `--max-wait` (including weekly-limit wording + unknown-reset branch)
- cycle auto-sizing when `--item A,B,C` exceeds `--cycles`
- recoverable vs fatal error continuation in the worker loop
- invalid `--target` exits 2 without invoking `runPipeline`

**Out:** real SDK calls, signal-handler testing (`SIGINT` cleanup), TUI rendering assertions, anything inside `runPipeline` that already has its own tests (`pipeline.test.ts`).

## Approach

`orchestrate()` today is one function that: creates TUI state, installs `process.on` handlers, loops workers, parks, resumes, and calls `process.exit()` in ~5 places. Tests can't invoke it directly — `process.exit` aborts the runner and signal handlers leak across tests.

**Chosen approach:** extract a pure `runOrchestrator(flags, deps)` that returns `{ exitCode, results }`, leaving `orchestrate()` as the thin I/O wrapper that installs signal handlers and calls `process.exit`. Deps mirror `PipelineDeps` — default to the real imports, override in tests.

Boundary between wrapper and core:

- **Wrapper (`orchestrate`)**: installs `process.on("exit", cleanup)` and `process.on("SIGINT", ...)` exactly once around the call, then `process.exit(exitCode)`. `cleanup` tears down the statusBar/cursor.
- **Core (`runOrchestrator`)**: owns `StatusBar` + `LiveStatus` construction, `statusBar.setup/teardown`, the status-render `setInterval`, and the park-countdown `setInterval`. Both the resume branch and the normal branch run inside the core — the two duplicate `process.on` blocks in the current code collapse into the single wrapper install.
- `results: CycleResult[]` is declared at the top of `runOrchestrator` so every early-exit path (including the invalid-`--target` exit-2) can return `{ exitCode, results }` without a fresh array allocation scattered through the function.

Tests must call `runOrchestrator` directly; calling `orchestrate` in a test would leak real `process.on` handlers across `node:test` files.

Rejected: (1) `t.mock.method(process, 'exit', …)` — SIGINT/exit handlers accumulate across `node:test` files; messy teardown. (2) Keeping `orchestrate` monolithic and spawning a child process per test — slow, defeats the point of unit tests. (3) A full `Orchestrator` class — over-abstraction for one function.

This is the same pattern `runPipeline` / `PipelineDeps` already uses — no new convention.

### Dep surface

```ts
export interface OrchestratorDeps {
  runPipeline?: typeof runPipeline;
  detectResumeStep?: typeof detectResumeStep;
  resolveWorktree?: typeof resolveWorktree;
}
```

Timers (`setTimeout`/`setInterval`) are mocked per-test via `node:test`'s `mock.timers` — no deps slot needed. `appendFileSync`/`mkdirSync` for per-worker logs only fires when `parallel > 1 && verbose`; tests stay on `verbose: false` to avoid touching `.dev/`.

### What gets exported

- `runOrchestrator(flags, deps?): Promise<{ exitCode: number; results: CycleResult[] }>` — new, testable core
- `OrchestratorDeps` interface — new
- `orchestrate(flags)` — unchanged signature, now a ~15-line wrapper

No other callers import `orchestrate` today (only `main.ts`), so the refactor is local.

## Files to change

| File | Change |
|------|--------|
| `scripts/autopilot/pipeline.ts` | Extract `runOrchestrator`; make `orchestrate` a thin wrapper. Export `OrchestratorDeps`. Replace every `process.exit(n)` in the extracted body with `return { exitCode: n, results }`. |
| `scripts/autopilot/__tests__/mocks.ts` | Add `createMockRunPipeline(behavior)` — returns a `runPipeline` stub driven by a per-item (or per-cycle) outcome map, capturing calls for assertions. Optionally mutates `parkSignal` via outcomes. |
| `scripts/autopilot/__tests__/orchestrator.test.ts` | New file. Scenarios listed below. |

## Test strategy

Each test injects `runPipeline` + `detectResumeStep` + `resolveWorktree` stubs and a fresh `Flags` object. `mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })` in park-and-resume tests. Assertions target `exitCode`, `results`, and the recorded `runPipeline` call log.

### Scenarios

1. **Resume mode — success.** `flags.resume = "tool-99"`. `detectResumeStep` → `"implement"`. `runPipeline` returns `{ completed: true, cost: 1, itemId: "TOOL-99" }`. Assert: `exitCode === 0`; one `runPipeline` call whose `opts.startFrom === "implement"` and `opts.itemId === "TOOL-99"`.
2. **Resume mode — failure.** Same setup, `runPipeline` returns `completed: false`. Assert `exitCode === 1`.
3. **Invalid `--target`.** `flags.target = "bogus"`. Assert `exitCode === 2`, `runPipeline` never called.
4. **Cycle auto-sizing.** `flags.item = "A-1,A-2,A-3"`, `flags.cycles = "1"`, `parallel = "1"`. Assert 3 `runPipeline` calls with `itemId` matching each.
5. **Parallel workers share mutex.** `parallel = "2"`, 3 items. Assert every `runPipeline` call received the same `opts.pickMutex` reference and it is defined.
6. **Recoverable error continues queue.** First call returns `error: "nothing to pick"`; assert worker keeps pulling subsequent cycles.
7. **Fatal error stops worker.** First call returns `error: "plan failed"` (not in `RECOVERABLE`); assert worker returns and remaining items are skipped (exit 1).
8. **Park-and-resume — success.** First call returns `error: "parked"` and mutates `parkSignal` (`parked: true`, `resetsAt: Date.now() + 60_000`, `limitType: "5h"`). Second call (post-wait) returns `completed: true`. Use `mock.timers.tick(60_000 + 30_000)` to fast-forward the `setTimeout`. Assert `exitCode === 0`; resume call used `detectResumeStep`-provided `startFrom`.
9. **Park-and-resume — exceeds `--max-wait`.** `flags["max-wait"] = "1h"`, `parkSignal.resetsAt = now + 3h`. Assert `exitCode === 1`, `runPipeline` not re-invoked.
10. **Park-and-resume — weekly limit wording.** `limitType = "weekly"` with wait exceeding max. Assert the printed message contains `Weekly rate limit` (capture via `t.mock.method(console, 'log')`).
11. **Park-and-resume — unknown reset time.** `resetsAt = 0`. Assert `exitCode === 1`, `runPipeline` not re-invoked.
12. **Budget warning fires but doesn't abort.** `flags.budget = "0.01"`, two cycles each costing 1. Assert warning logged, both cycles still run.

### Mock API shape

```ts
createMockRunPipeline({
  byItem: { "TOOL-99": [{ completed: true, cost: 1 }, /* subsequent calls */] },
  default: { completed: false, error: "nothing to pick", cost: 0 },
  onCall: (opts) => { /* inspect/mutate parkSignal */ },
}) → { runPipeline, calls }
```

Array values handle multi-call items (park → resume). `calls` records `{ itemId, opts, flags }` for assertions.

### Timer mocking note

`node:test` `mock.timers` reaches into globals. Enable per-test with `t.mock.timers.enable(...)` (scoped to the test, auto-restored). `Date` must be mocked alongside `setTimeout` because the countdown `setInterval` and the `waitMs` calculation both read `Date.now()`.

## Rubric self-check

- **Correct:** tests assert the invariants the roadmap calls out (resume step detection, mutex sharing, park-and-resume wait math). The `RECOVERABLE` set guard is covered by scenarios 6+7. `process.exit` contract preserved by the thin wrapper.
- **Well-typed:** `OrchestratorDeps` uses `typeof` of the existing exports — no `any`, no casts. `runPipeline` stub types match the real signature by construction.
- **Well-factored:** the extraction follows the `runPipeline` / `PipelineDeps` pattern already in the file. No new module, no new abstraction layer.
- **Well-tested:** eleven+ scenarios; happy path, every early-return exit code, both timer-driven branches. Existing `pipeline.test.ts` stays untouched.
- **Concise:** new code is one refactored function + one test file + one mock helper. No helpers introduced speculatively.
- **Idioms:** deferred to `/shakedown`.

## Verification

```bash
npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/*.test.ts
npx tsx -e "import('./scripts/autopilot/pipeline.ts')"
pnpm autopilot --dry-run --cycles 1
pnpm check
```

All four must pass.

- `pipeline.test.ts` staying green only proves `runPipeline` is unchanged — not `orchestrate`. The new `orchestrator.test.ts` covers the extracted `runOrchestrator` core.
- `pnpm autopilot --dry-run --cycles 1` exercises the thin `orchestrate` wrapper end-to-end (signal-handler install, `process.exit` path) which `runOrchestrator` tests skip by design.
