# TOOL-53 — orchestrator.test.ts parent-runner IPC deserialize error

## Problem

`npx tsx --test packages/autopilot/scripts/autopilot/__tests__/orchestrator.test.ts` reports
`not ok 1` for the **file** with `failureType: 'uncaughtException'` and
`error: 'Unable to deserialize cloned data due to invalid or unsupported version.'`
The exception originates inside `node:internal/test_runner/runner` (`#processRawBuffer` /
`FileTest.parseMessage`). All seven nested `it()` subtests pass; only the parent reporter
chokes on a stream message coming back from the child. The result: CI sees the file as
"1 fail" even though every assertion succeeded, masking real failures and noising the suite.

The bug has been present since TOOL-38 (the monorepo conversion, `aebad39`) — the only
file mutation since then was the `nothing to pick` → `pick:queue-empty` rename in TOOL-33.
The test was added clean in TOOL-19; somewhere between TOOL-19 and TOOL-38 the failure mode
was introduced (most likely a Node 22 minor bump that changed test-runner IPC framing,
not anything in our code).

## Root-cause hypothesis (to confirm in step 1)

Node 22's test runner reads child stdout in `FileTest.parseMessage` looking for a framed
**V8-serialized** payload (see `node:internal/test_runner/runner` — `#processRawBuffer`
scans for the magic prefix and calls `v8.deserialize()` on the body). The deserializer
throws `Unable to deserialize cloned data due to invalid or unsupported version` when
the first byte of the "payload" isn't a recognized V8 wire-format version.

The system under test is `runOrchestrator` (pipeline.ts:563), which itself emits 25+
`console.log` calls — banner, cycle summary lines, park / resume messages — all wrapped
in ANSI escapes from `tui.ts`'s `A.bold` / `A.dim` / `A.green` / `A.red` / `A.yellow`
helpers. (Note: `runPipeline`'s own `log()` helper at pipeline.ts:60 is **not** the
source — `orchestrator.test.ts` injects `createMockRunPipeline`, so the production
helper never runs in these tests.) Several subtests do **not** mock `console.log`,
so those bytes flow through the child's pipe to the parent. The framing parser treats
any byte sequence that starts with the magic prefix as a serialized message — random
ANSI / time / status bytes can collide with that prefix and trigger the deserialize
attempt, which then explodes on the wrong "version" byte.

One alternate trigger to disambiguate via bisect:
- **mock.timers + Date**: only `orchestrator.test.ts` enables
  `t.mock.timers.enable({ apis: ["...", "Date"] })`. Mocked Date instances may not
  round-trip cleanly through V8's structured clone if any value reaches the parent.

The bisect resolves which one (or which combination) is the trigger before we touch code.

## Scope

**In:** `packages/autopilot/scripts/autopilot/__tests__/orchestrator.test.ts` only — adding `t.mock.method(console, "log", () => {})` at the top of each currently-unmocked `it()` so ANSI/log bytes from `runOrchestrator` don't leak into the child→parent IPC pipe.

**Out:**
- New helpers (`silenceConsole`, etc.) — one-liner per test is its own documentation.
- Changes to `mocks.ts`.
- Touching `pipeline.ts` / `tui.ts` runtime behavior — production code stays as-is.
- Filing an upstream Node bug (optional follow-up — noted but not deliverable).
- Silencing the suite via `--test-reporter=...` or any other CI knob; per the roadmap, fix at the source.
- Changing `pnpm -r test` invocation, CI workflow, or the rubric's verification commands.

## Approach

1. **Reproduce in isolation.** Run the file directly with `npx tsx --test packages/autopilot/scripts/autopilot/__tests__/orchestrator.test.ts`. Confirm the file-level `not ok 1` with `error: 'Unable to deserialize cloned data due to invalid or unsupported version.'` and that all seven inner `it()` subtests pass. Run twice to confirm determinism (the roadmap describes it as consistent, not flaky).

2. **Bisect by subtest.** Use `--test-name-pattern=...` (Node 22 supports anchored regex) to run one `describe` block at a time. Order to test, fastest disambiguation first:
   - `runOrchestrator — invalid target` (mocks `console.error` only, no timers)
   - `runOrchestrator — resume mode` (no console mocking, no timers)
   - `runOrchestrator — cycle auto-sizing` (no console mocking, no timers)
   - `runOrchestrator — parallel workers share mutex` (no console mocking, no timers)
   - `runOrchestrator — worker continuation` (no console mocking, no timers)
   - `runOrchestrator — park-and-resume` (mocks timers including `Date`; one block also mocks `console.log`)
   - `runOrchestrator — budget warning` (mocks `console.log`)
   Record which subset still triggers the parent error. The first subset that does is the trigger surface.

3. **Narrow within the trigger subset.** Inside the offending block, comment out individual `it()` cases (or replace their bodies with `t.skip()`) and re-run until the minimum failing case is identified. Capture the exact stdout bytes emitted by the failing case via `script(1)` or `node --inspect-brk` if needed — but in practice, redirect `2>&1 | xxd | head -50` will show whether ANSI codes are landing in the pipe.

4. **Fix at the source.** Two patterns depending on what the bisect turns up:
   - **If the trigger is leaked stdout from `runOrchestrator`'s `console.log` calls** (most likely): inline `t.mock.method(console, "log", () => {})` at the top of each currently-unmocked `it()`. `node:test`'s `t.mock` is per-test-context, so a `beforeEach` doesn't apply cleanly — and a `silenceConsole(t)` wrapper for one line of code is the kind of premature abstraction the rubric forbids. Don't over-mock tests outside the trigger surface.
   - **If the trigger is `t.mock.timers` with `"Date"`**: dropping `"Date"` from the `apis` list will break `park-and-resume` — `runOrchestrator` reads `Date.now()` at pipeline.ts:763 and pipeline.ts:790 to compute wait deltas against the mocked `resetsAt`. So the only viable variant is to thread an injected `now?: () => number` through `OrchestratorDeps` and use it for those reads. **Prefer the console-silencing fix** unless the bisect proves `"Date"` is the sole trigger; this fallback is larger-blast-radius and touches production code.
   - **Do not** silence with `--test-reporter`, suppress at the runner level, or wrap the whole describe in a try/catch.

5. **Stabilize and verify.** With the fix in place:
   - Run the file in isolation **10 consecutive times**: `for i in {1..10}; do npx tsx --test --test-reporter=dot packages/autopilot/scripts/autopilot/__tests__/orchestrator.test.ts || break; done`. All 10 must report `# pass 8 # fail 0` (7 subtests + 1 file = 8 pass).
   - Run the full workspace test suite: `pnpm -r test`. Must exit 0.
   - Run every command in the rubric's "Verification" block — the four parse-checks, both `--test-reporter=dot` test runs, `pnpm check`, and `pnpm check:skills`. All exit 0.

## Files to change

- `packages/autopilot/scripts/autopilot/__tests__/orchestrator.test.ts` — the only expected mutating change. Per-test `t.mock.method(console, "log", () => {})` calls in the currently unmocked tests. Net diff expected to be under ~30 lines.

No production code changes, no new files, no changes to `mocks.ts`. The one scenario that would breach this — `"Date"` proven sole trigger, requiring an injected `now()` in `OrchestratorDeps` — is called out in step 4 and explicitly disfavored.

## Test strategy

The change *is* test-only. There is no new public API to unit-test. The proof is the 10x
isolation run + the full `pnpm -r test` exit 0. Single-run isolation can hide flakes —
hence 10x. We do not add a regression guard in another file because the failure
manifests at the test-runner-process level, which can't be asserted from inside a test.

The mock-and-restore is one line per `it()`; no helper, no separate unit test.

## Rubric self-check

- **Correct:** Fix is at the source per the roadmap. No `--test-reporter` silencing. No production code touched, so the load-bearing pipeline invariants (step exhaustiveness, frontmatter stripping, worktree isolation, rate-limit parking, phantom ship guard) are unaffected. The 10x verification matches the roadmap deliverable verbatim.
- **Well-typed:** No `any`. No `as Step` casts. Test-only code; no exported function signatures change.
- **Well-factored:** The fix lives in the test file that owns the problem. No leakage into `mocks.ts` unless the bisect demands it. No changes to `pipeline.ts`, `step-runner.ts`, or `tui.ts` — strict module boundaries preserved.
- **Well-tested:** The change is itself test code; verification is a 10x isolation run plus full suite. We don't add tests-for-tests.
- **Concise:** Expected diff <30 lines, single file. No new abstractions. No dead code. No "configurability" knobs.

(Idioms dimension deferred to `/shakedown`.)

## Self-review notes

Re-read pass surfaced two concerns:

1. **The bisect could fail to reproduce in isolation** — i.e. one subtest in isolation might *not* trigger the parent error, only the combined run does. If so, the trigger is cumulative buffer state, not a single subtest. In that case the fix is the same ("silence stdout in unmocked tests"); the bisect just produces less precise blame. The plan above already handles this by ordering subsets and only narrowing further once a triggering subset is found.

2. **Fix-by-dropping-`"Date"` would break the timer-tick assertions.** Confirmed: `runOrchestrator` reads `Date.now()` at pipeline.ts:763 (`waitMs = parkSignal.resetsAt - Date.now()`) and pipeline.ts:790 (remaining-wait countdown). Dropping `"Date"` from the `apis` list returns real wall-clock time, blowing past `baseNow + 60_000` immediately. So the only viable Date-route fix is to inject `now?: () => number` through `OrchestratorDeps` — strictly larger than the console-silencing alternative. The plan defers that path unless the bisect forces it.

No revisions needed beyond the notes above — they're called out inline in the Approach section.
