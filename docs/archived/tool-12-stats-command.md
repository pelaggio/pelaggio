# TOOL-12. Running totals — tokens + quality signals + `pnpm autopilot stats`

## Scope

**In:**
- Capture `usage` tokens from `SDKResultMessage` per step.
- Capture quality signals per step/cycle: turn-exhaustion retries, shakedown verdict(s), parked, shipwreck-invoked.
- Enrich `.dev/autopilot-log.jsonl` (already append-only) with the new fields.
- Add `scripts/autopilot/stats.ts` — pure reducer + dashboard renderer.
- Route `pnpm autopilot stats` through `main.ts` to the renderer.
- Unit tests for the reducer.
- README update with an example dashboard.

**Out:**
- Separate `.dev/autopilot-stats.json` file (see *Deviation* below).
- Time-series / per-day / per-week aggregations — cumulative + last-10 only.
- Per-model cost breakdown (per-step only).
- Graphs/plots — tabular text only.
- Back-filling stats for pre-existing log entries that lack token fields (reducer tolerates missing fields, renders `—`).

## Deviation from roadmap

The roadmap specifies a separate `.dev/autopilot-stats.json` "append-only" file. That's
semantically off: aggregates are a *snapshot* (not append-only), and we'd be duplicating data
already present in `autopilot-log.jsonl`. I'm collapsing the two:

- `autopilot-log.jsonl` remains the single source of truth (append-only, already exists).
- `stats.ts` derives aggregates by streaming/reducing the log on each invocation.

This removes a file, eliminates a concurrent-writer hazard between parallel workers, and
matches the existing "state is the git working tree + `.dev/autopilot-log.jsonl` append-only
log" invariant in `CLAUDE.md`. If someone later wants a cached snapshot for speed, they can
add one without changing the reducer. Logs are small (one line per cycle) — re-reducing is
trivially fast for any realistic history.

## Approach

### 1. Thread SDK `usage` into `StepResult`

`runStep()` in `step-runner.ts` already receives `SDKResultMessage` in its main loop.
Extend the `result` branch to read `msg.usage` when present and return a new `tokens` object
on `StepResult`:

```ts
interface TokenUsage {
  input: number;          // input_tokens
  output: number;         // output_tokens
  cacheCreation: number;  // cache_creation_input_tokens
  cacheRead: number;      // cache_read_input_tokens
}
```

`StepResult.tokens` is **optional** — absent in dry-run synthesized results and in error
paths where no `result` message arrived. Reducer treats missing as zeros.

### 2. Extend `StepLog` with per-step observability

```ts
interface StepLog {
  name: string;
  model: string;
  cost: number;
  turns: number;
  ok: boolean;
  // new:
  tokens?: TokenUsage;
  attempt?: number;  // 1-indexed; absent => 1
  verdict?: "APPROVE" | "REVISE" | "RETHINK";  // shakedown-plan only
}
```

**Rationale — retries as `attempt` per entry rather than a single `retries` count:** the
pipeline already logs each attempt as its own `StepLog` entry (one push per `step()` call).
Tagging each with its attempt number keeps the existing log shape and lets the reducer compute
`avgRetriesByStep` from `max(attempt)` per (cycle, step). This is strictly additive —
consumers that ignore the field see the same data as today.

**Verdict tracking:** parsed in `pipeline.ts` immediately after `shakedown-plan`. Attach the
verdict to *that step's* `StepLog` entry by mutating the just-pushed record in place
(pattern already used implicitly — `step()` is the only writer). The roadmap mentions
`verdictTrail` as an array; since shakedown-plan runs once per cycle today, a scalar suffices.
If a future change adds a verdict-driven retry loop, promote to array then. YAGNI.

### 3. Extend cycle-level log fields

In `pipeline.ts`'s `finish()`, `appendLog()` receives the cycle summary. Add:

```ts
parked: boolean,         // true iff error === "parked"
parkReason: string | null,  // parkSignal.limitType when parked
shipwrecked: boolean,    // true iff /shipwreck ran
```

Hook `shipwrecked` into the existing shipwreck branch (pipeline.ts:349) — set a flag before
`finish()` returns.

### 4. Capture retries per step

`implement` and `shakedown-code` have attempt loops (`MAX_ATTEMPTS = 2`, `MAX_SHAKEDOWN_ATTEMPTS = 2`).
Each attempt currently calls `step()`, which pushes its own `StepLog`. Thread attempt index
into `step()` as an optional arg:

```ts
async function step(name: Step, prompt: string, cwd: string, attempt = 1): Promise<StepResult>
```

`step()` sets `attempt` on the pushed `StepLog`. Reducer detects retries when `max(attempt) > 1`
for a given (cycle, step).

### 5. `scripts/autopilot/stats.ts` — reducer + renderer

Single file, ~200 lines. Two exported functions:

```ts
export function reduce(entries: CycleLogEntry[]): Stats;
export function renderDashboard(stats: Stats): string;  // ANSI-coloured text
```

Plus a default entry point:

```ts
export function runStatsCommand(): void {
  // read LOG_PATH, parse lines (tolerant of JSON errors like detectResumeStep does),
  // reduce, render, console.log.
}
```

**Shape of `Stats`:**

```ts
interface Stats {
  // Aggregates
  totalCycles: number;
  completedCycles: number;
  failedCycles: number;
  parkedCycles: number;
  shipwreckedCycles: number;
  // Cost / tokens
  totalCostUsd: number;
  totalTokens: { input: number; output: number; cacheCreation: number; cacheRead: number };
  cacheHitRatio: number;  // cacheRead / (input + cacheRead); 0 when denom is 0
  // Quality
  avgRetriesByStep: Record<string, number>;          // mean(max_attempt - 1) per cycle per step
  rethinkRateByStep: Record<string, number>;         // fraction of shakedown steps with verdict RETHINK
  avgShakedownIterations: number;                    // mean attempts on any shakedown-* step
  // Per-step
  costByStep: Record<string, number>;
  tokensByStep: Record<string, { input: number; output: number; cacheCreation: number; cacheRead: number }>;
  cacheHitRatioByStep: Record<string, number>;
  // Per-item history
  itemsDelivered: Array<{
    id: string;
    date: string;       // ISO YYYY-MM-DD
    cost: number;
    tokens: number;     // input + output + cacheCreation (cacheRead is not billed as input)
    rethinks: number;   // count of RETHINK verdicts on shakedown-plan for this cycle
    parked: boolean;
  }>;
}
```

**Dashboard layout** (monospace, 80 cols max, uses existing `A` helpers from `tui.ts`):

```
autopilot stats                                              14 cycles  $12.34

Cost & tokens
  Cycles        14   completed 10    failed 2    parked 1    shipwrecked 1
  Spend         $12.34
  Tokens        in 1.2M   out 180K   cache-write 340K   cache-read 2.1M
  Cache-hit     63.6%

  By step           cost      in    out  cache-read  hit%
    pick          $0.12     22K    800K        45K   65%
    plan          $2.30    180K     25K       320K   64%
    ...

Quality
  Retry rate (turn-exhaustion)
    implement        0.28 per cycle
    shakedown-code   0.14 per cycle
  Rethink rate (plan review)
    shakedown-plan   14.3%   (2 / 14)
  Avg shakedown iterations
    1.18

Recent items (last 10)
  2026-04-17  TOOL-12  $1.10  128K tok  0 rethinks  ✓
  2026-04-15  TOOL-6   $0.82   92K tok  0 rethinks  ✓
  ...
```

Use `padEnd` / `padStart` — no table library. Colour headers with `A.bold`, dim secondary
labels with `A.dim`, `A.yellow` for parked, `A.red` for failed, `A.green` for completed.

### 6. CLI routing

`main.ts` currently parses flags only. Extend to read a leading positional:

```ts
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { /* unchanged */ },
});

if (positionals[0] === "stats") {
  await runStatsCommand();
  process.exit(0);
}

orchestrate(values as Flags);
```

No other subcommands today, so a single `if` is the minimal correct thing. When
`TOOL-13`/CLI arrives, it can generalise this. YAGNI.

### 7. Tests

`scripts/autopilot/__tests__/stats.test.ts` — pure reducer tests. Scenarios:

1. **Empty log** → all counters zero, all rates zero (no NaN).
2. **Single completed cycle, one attempt each** → totals, cache ratio correct, `avgRetriesByStep` all zero.
3. **Cycle with implement attempt=2** → `avgRetriesByStep.implement === 1`, shakedown-plan verdict threaded.
4. **Parked cycle** → `parkedCycles === 1`, item included in `itemsDelivered` with `parked: true` only if it eventually completed, else excluded.
5. **Shipwreck cycle** → `shipwreckedCycles` increments regardless of completion.
6. **Cycle with RETHINK verdict** → `rethinkRateByStep["shakedown-plan"]` reflects it, `itemsDelivered[n].rethinks === 1`.
7. **Legacy entry without `tokens`** → reducer treats as zeros, no crash.
8. **Mixed legacy + new entries** → aggregates only over present fields, counts all cycles.

No test for the renderer itself — output format is visual, not load-bearing. Smoke-test by running `pnpm autopilot stats` against the real log.

## Files to change

| File | Change |
|------|--------|
| `scripts/autopilot/types.ts` | Add `TokenUsage`; extend `StepResult` (optional `tokens`); extend `StepLog` (optional `tokens`, `attempt`, `verdict`); add `CycleLogEntry` type for reducer input. |
| `scripts/autopilot/step-runner.ts` | Read `msg.usage` from `SDKResultMessage`; populate `tokens` on return. |
| `scripts/autopilot/pipeline.ts` | Thread `attempt` into `step()`; attach `verdict` to the shakedown-plan log entry; add `parked`, `parkReason`, `shipwrecked` fields to `appendLog` payload. |
| `scripts/autopilot/stats.ts` | **New** — reducer + renderer + `runStatsCommand()`. |
| `scripts/autopilot/main.ts` | Route leading positional `stats` to `runStatsCommand()`. |
| `scripts/autopilot/__tests__/stats.test.ts` | **New** — reducer tests. |
| `README.md` | Add a "Stats dashboard" subsection with an example snapshot. |

No changes to `config.ts` (no new paths), `helpers.ts`, `tui.ts`, `.claude-templates/`,
or any skill files.

## Schema changes

None to code-level types that break callers — all extensions to `StepResult.tokens`,
`StepLog.{tokens,attempt,verdict}`, and cycle-log fields are **optional/additive**.
Old log lines remain parseable; new consumers tolerate missing fields.

## Test strategy

- Unit tests: reducer behaviour (see §7 above). Run via `npx tsx --test scripts/autopilot/__tests__/*.test.ts`.
- Manual smoke: run one real cycle, verify `autopilot-log.jsonl` contains the new fields, then run `pnpm autopilot stats` and sanity-check the output.
- Parse-checks (from rubric `Verification` section) — all four imports must succeed after the change.

## i18n

N/A — CLI tool, English only.

## Rubric self-check

| Dimension | Status | Notes |
|-----------|--------|-------|
| Well-typed | ✓ | `TokenUsage` is a named interface; `Stats` is a named interface; no `any`; all exported functions have explicit return types. Discriminated handling isn't needed (no new state machines). |
| Well-tested | ✓ | Reducer is pure → fully unit-tested. Renderer smoke-tested manually (visual output). `step-runner` plumbing is straight field extraction; error cases (missing `usage`) handled by optional type. |
| Well-factored | ✓ | New code lives in `stats.ts` — reducer and renderer only, no business logic elsewhere. No SDK calls. No mutation of pipeline state. `main.ts` change is 3 lines of dispatch — entry-point concern only. |
| Idiomatic | ✓ | Biome-clean (tabs, double quotes, trailing commas). Relative imports use `.js`. Named exports. Tolerant JSON parsing matches `detectResumeStep` pattern. Reuses `A` from `tui.ts` for colour. |
| Correct | ✓ | No step-exhaustiveness impact (no new `Step`). No frontmatter changes. `parkExit()` contract untouched. `shipwrecked` flag set *before* `finish()` returns to preserve single-writer invariant. Cache-hit ratio guards divide-by-zero. `itemsDelivered` excludes non-completed cycles to avoid misleading "delivered" count. |
| Concise | ✓ | Single new file (~200 lines). No premature abstractions — `stats` is one subcommand, dispatched via one `if`. No separate `stats.json`; reducer reads the existing log. All new fields optional/additive. |

## Self-review revisions

On re-read I caught and fixed three issues:

1. **Original draft had a separate `autopilot-stats.json` writer.** Parallel workers would race
   on it, and the data duplicates the existing JSONL. Collapsed to a reduce-on-read design —
   documented as an explicit deviation from the roadmap with rationale.

2. **Original draft proposed `retries: number` on `StepResult`.** But retries are a pipeline
   concern (pipeline decides to retry), not an SDK concern (SDK just runs the step). Moved to
   `StepLog.attempt` so each attempt is its own log entry and the reducer derives retry count.
   Keeps `step-runner.ts` focused on SDK mechanics.

3. **Original draft had `verdictTrail: string[]` on `StepLog`.** Overkill — shakedown-plan runs
   once today. Downgraded to scalar `verdict`; noted the forward path if iteration is ever added.
