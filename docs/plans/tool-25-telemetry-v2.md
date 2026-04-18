# TOOL-25 — Telemetry v2: per-step files, tool histogram, output tail, stats JSON

Branch: `feat/tool-25-telemetry-v2` · Scope: S

## What it does

Adds three per-step signals to the log and a JSON dashboard export so post-mortems and external dashboards work without replaying cycles.

1. **`filesChanged`** — paths the step committed, captured by diffing the HEAD SHA before/after the step.
2. **`toolCounts`** — histogram of tool_use events by name (Read/Edit/Write/Bash/…).
3. **`outputTail`** — last ~200 chars of the step's final assistant text, ANSI-stripped.
4. **`stats --json`** — emit the aggregated `Stats` record as JSON on stdout.
5. **"Recent failures" dashboard section** — surface `outputTail` from the last few `completed=false` cycles so `pnpm autopilot stats` is enough for a quick post-mortem.

## What it does NOT touch

- No log schema migration — all new fields are optional and absent on legacy entries.
- No prompt-input token tracking (explicit out-of-scope in roadmap).
- No attempt-count rollups beyond what TOOL-12 already does.
- No changes to the TUI live view (`tui.ts`), the SDK event stream shape, or step-runner error handling.
- No new step; `STEPS` is unchanged, so no exhaustiveness churn.

## Approach

**Capture locations follow existing module boundaries.** SDK-derived signals (`toolCounts`, `outputTail`) collected in `step-runner.ts` because that's where the SDK loop runs. Git-derived signal (`filesChanged`) captured in `pipeline.ts`'s `step()` helper because only pipeline.ts controls the pre/post-checkpoint boundary. Git primitives live in `helpers.ts` per the rubric's module-boundary rule ("shell wrappers (git, fs)"). Aggregation + rendering in `stats.ts`.

**`filesChanged` captured around the checkpoint, not inside `runStep`.** The motivating use case is "implement touched only `docs/plans/`" — but `implement` and `shakedown-code` rely on `pipeline.ts` calling `checkpoint()` *after* `runStep` returns. If we snap the post-SHA inside `runStep`, the checkpoint's commits are missed and `filesChanged` is always `[]` for exactly the steps that matter most. Capture has to straddle the checkpoint.

Cleanest fix: fold the optional checkpoint into `pipeline.ts`'s `step()` helper. `step()` gains a `commitLabel?: string` option; when present it runs `checkpoint()` + `ensureCheckpointed()` before computing the post-SHA. Call sites that currently do `step(...)` + `checkpoint()` manually (implement, shakedown-code — the only two) migrate to the single call. Steps without checkpoint (pick, plan, ship, shipwreck) keep the default; their agents commit internally, so pre→post diff captures those.

- Two new helpers in `helpers.ts`: `getHeadSha(cwd)` (wraps `git rev-parse HEAD`, `null` on error) and `filesChangedSince(cwd, preSha)` (wraps `git diff --name-only <preSha>..HEAD`, `[]` on null preSha / git error / no-op). Both use `execSync` — already the idiom there (`hasDeliverableCommits`, etc.).
- In `step()`, capture preSha before `runStep`, run checkpoint (if any) after, then compute `filesChanged = filesChangedSince(cwd, preSha)`. Attach to the pushed `StepLog` only when non-empty (conditional spread, like existing `tokens`).
- Dry-run path short-circuits both helpers and emits no `filesChanged`.

**`toolCounts` piggybacks on the existing `tool_use` branch.** Add a `const toolCounts = new Map<string, number>()` next to `editCounts`. Increment before the existing `toolName === "Edit"` loop-detection block. Serialize to plain `Record<string, number>` via `Object.fromEntries` on return.

**`outputTail` = `stripAnsi(text).slice(-200)`.** The SDK's `result` field (already assigned to `text`) is the agent's final summary — exactly the signal we want for "what did it say right before it finished". ANSI-strip defensively (`text.replace(/\x1b\[[0-9;]*m/g, "")`) — assistant text rarely has ANSI but tool-result echoes sometimes do. Only populate when `text` is non-empty; `undefined` otherwise.

**`Stats.recentFailures` exposed from reducer, not built in the renderer.** Keeps `renderDashboard` pure and makes the `--json` output include failures automatically (consumer dashboards want them too). Shape: `Array<{ ts, item, error, outputTail? }>`, last 5 `completed=false` cycles, newest-first. `outputTail` pulled from the last step of the cycle (typically the failing one — and when no step ran, absent).

**`stats --json` via new `renderJson()` + a boolean on `runStatsCommand`.** Parse `--json` in `main.ts` and forward. `renderJson(stats) => JSON.stringify(stats, null, 2)`. Pretty-print so humans can `pnpm autopilot stats --json | jq` without jq; machines don't care about whitespace.

## Files to change

| File | Change |
|---|---|
| `scripts/autopilot/types.ts` | Add optional `toolCounts?: Record<string, number>` and `outputTail?: string` to **both** `StepResult` and `StepLog`. Add optional `filesChanged?: string[]` to `StepLog` only (pipeline computes it; runStep does not). |
| `scripts/autopilot/helpers.ts` | Add `getHeadSha(cwd: string): string \| null` and `filesChangedSince(cwd: string, preSha: string \| null): string[]`. Both wrap `execSync` with try/catch → null / `[]` on failure. |
| `scripts/autopilot/step-runner.ts` | Track a `toolCounts` Map alongside existing `editCounts` (increment on `tool_use` before the Edit-loop check). Compute `outputTail = stripAnsi(text).slice(-200)` from the final `SDKResultMessage.result`. Include both in `StepResult` via conditional spread (same pattern as `tokens`). No git calls in this file. |
| `scripts/autopilot/pipeline.ts` | Extend `step()` signature with `{ attempt?: number; commitLabel?: string } = {}` (trailing options object). Capture `preSha` before `runStep`; if `commitLabel` provided, call `checkpoint()` + `ensureCheckpointed()` after `runStep` returns; then compute `filesChanged` via `filesChangedSince(cwd, preSha)`. Thread `toolCounts` + `outputTail` from `result` into the pushed `StepLog` alongside `tokens`. Migrate the two call sites that manually invoke `checkpoint()` (implement, shakedown-code) to pass `commitLabel` into `step()`. |
| `scripts/autopilot/stats.ts` | Add `recentFailures` to `Stats`; compute in `reduce()`; render new "Recent failures" block in `renderDashboard()`; add `renderJson(stats)`; extend `runStatsCommand(opts: { json: boolean })`. |
| `scripts/autopilot/main.ts` | Add `--json` (boolean, default false) to `parseArgs` options; pass `{ json: !!values.json }` into `runStatsCommand`. Field is stats-only — not added to the `Flags` interface since orchestrate() doesn't consume it. |
| `scripts/autopilot/__tests__/stats.test.ts` | Tests for `recentFailures` populate + ordering + cap at 5, `outputTail` sourcing, legacy entries, and `renderJson` parse round-trip. |

## Test strategy

Pure-reducer + pure-helper coverage matches the rubric's "well-tested" bar (SDK-side collection in step-runner stays untested — existing convention).

**`stats.test.ts`:**
- **`recentFailures` basics** — given 7 failed entries with distinct timestamps, returns 5 newest-first.
- **`recentFailures.outputTail`** — given an entry whose last step has `outputTail`, the record surfaces it; missing `outputTail` → field absent, not `undefined`-stringified.
- **`recentFailures` excludes completed** — mix of completed and failed entries; only the failed ones appear.
- **Legacy entries** — steps without the new fields reduce without throwing and do not produce noise in `recentFailures.outputTail`.
- **`renderJson` round-trip** — `JSON.parse(renderJson(reduce(entries)))` equals the reducer output; contains `totalCycles` and `recentFailures`.

**`helpers.test.ts`:** add a minimal test for `filesChangedSince` — on a `null` preSha it returns `[]`; on a preSha matching HEAD it returns `[]`. A real-git round-trip (init repo, commit, diff) is over-engineering for this scope — the helper is thin shell-wrap and the behavior it protects (null-guard, empty-on-noop) is regex-free and low-risk. `getHeadSha`'s try/catch behavior is similarly covered implicitly by callers.

No test changes for `step-runner.ts` (SDK-dependent) or `main.ts` (arg-parsing glue). No test for the `step()` + `commitLabel` refactor in `pipeline.ts` — the pipeline is already untested per the rubric's "well-tested" dimension, and the refactor is a mechanical move of two checkpoint calls.

## Rubric self-check

- **Correct** — All new fields optional; no `Record<Step, T>` introduced, so step exhaustiveness in `config.ts` (STEPS/BUDGETS/TURN_LIMITS/EFFORT/MODEL_PROFILES) is untouched. Frontmatter stripping: untouched. Worktree isolation: `execSync` in `helpers.ts` takes `cwd` from pipeline (worktree for worktree-scoped steps, `REPO` for pick) — the PreToolUse hook isn't involved because helper-layer code isn't an agent tool call. Rate-limit parking: `step()`'s new `commitLabel` path runs `checkpoint()` inside the helper, and the existing `parkExit()`-then-checkpoint ordering is preserved (parkExit runs before the next `step()` call, same as today). Phantom ship guard: `hasDeliverableCommits` unchanged.
- **Well-typed** — No `any`. New fields declared as `string[]`, `Record<string, number>`, `string`, all optional. `StepResult`/`StepLog`/`Stats` stay as plain interfaces. `getHeadSha` return type `string | null` is explicit; `filesChangedSince` handles the null case at the boundary.
- **Well-factored** — Git primitives in `helpers.ts` (shell wrappers) per the rubric. SDK collection in `step-runner.ts`. Orchestration + git-call timing in `pipeline.ts`. Aggregation + render in `stats.ts`. `stats.ts` still doesn't import SDK.
- **Well-tested** — Reducer's new behavior covered; one null-guard test for `filesChangedSince`; SDK-side collection + pipeline integration left untested per existing convention.
- **Concise** — Net change ~80-110 lines across 6 source files + ~50 lines of tests. No new files, no new abstraction beyond two thin helpers, no backwards-compat shim. The `step()` signature grows by one optional options arg; two call sites migrate.

## Open questions / risks

- **ANSI strip regex correctness**: the minimal `\x1b\[[0-9;]*m` only catches SGR escapes, which is what `text` realistically contains. Broader CSI/OSC stripping would be over-engineering for a 200-char tail.
- **`git diff` at step boundaries in a brand-new worktree**: `rev-parse HEAD` succeeds because worktrees are created from `main` (or the existing feat branch) with a valid HEAD. If a future step runs before any commit exists, `preSha` captures and post-SHA matches → `[]`. No crash.
- **`ship` step's `filesChanged`** in direct-push mode: the ship merges into main and pushes; inside the *worktree* HEAD may have advanced (via a squash commit) or stayed put (if the agent merged without committing locally). Either way the diff computation is safe — worst case it's `[]`, which is still informative.
- **`step()` signature change churn**: `step()` is a local closure inside `runPipeline`, not exported — call sites are only within `pipeline.ts`. The options-object param is the same style as `RunStepOpts` in step-runner, so idiom is preserved.
