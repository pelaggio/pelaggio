# TOOL-4 — pipeline.ts integration tests via SDK query mock

## Scope

**In:**
- Integration tests for `scripts/autopilot/pipeline.ts`'s `runPipeline` orchestration logic.
- Mock `runStep` so no real SDK calls happen.
- Temp git directory per test so git-touching helpers (`checkpoint`, `ensureCheckpointed`, `findPlanPath`) behave realistically without polluting the real repo.
- Minimal DI via an optional `deps` parameter on `runPipeline` — inject `runStep`, `listWorktrees`, and `appendLog` only.
- Four scenarios from the roadmap.
- Test harness in a sibling `mocks.ts` file so `pipeline.test.ts` stays declarative.

**Out:**
- E2E tests with the real SDK.
- Testing `orchestrate()` (the outer multi-cycle loop, resume flow, parallel workers, park-and-resume wait). Too much surface for now; worth a follow-up.
- Testing `tui.ts` rendering.
- Testing the pick step. Because `resolveWorktree(itemId)` is rooted at the real `REPO/..`, exercising pick in a unit test would force sibling-of-real-repo directory creation. Deferred to a follow-up track that can decide whether `REPO` should become injectable.
- Refactoring any other module.

## Approach

The rubric explicitly permits leaving pipeline integration untested until a mocking approach emerges — this track is that approach. The pipeline reaches external systems via three functions in this execution path:

1. `runStep` (SDK `query()` — expensive, non-deterministic)
2. `listWorktrees` (reads the real git worktree state)
3. `appendLog` (writes into real `REPO/.dev/autopilot-log.jsonl`)

Everything else — `expandSkill`, `checkpoint`, `ensureCheckpointed`, `findPlanPath`, `parseVerdict`, `parseItemId`, `isQuickScope` — is either pure or scoped to the worktree directory the test controls (`opts.worktree` is a temp dir we own).

**Dependency injection, not module mocking.** Node's `mock.module()` is behind an experimental flag; module mocking via loaders complicates `tsx` invocation. A tiny `PipelineDeps` parameter with three optional fields is idiomatic TypeScript, stays compatible with existing callers (who pass nothing), and matches how the rubric's `Well-factored` section already organizes module boundaries.

**Why not inject everything?** `checkpoint`, `findPlanPath`, `parseVerdict`, etc. operate on data the test provides (the temp worktree, mock `StepResult.text`). Injecting them would bloat the deps interface for no coverage gain. Per rubric Concise: only inject what actually escapes to a real resource.

### Pipeline refactor

**`scripts/autopilot/pipeline.ts`**

Add:

```ts
import { appendLog as appendLogDefault, listWorktrees as listWorktreesDefault, /* others unchanged */ } from "./helpers.js";
import { runStep as runStepDefault } from "./step-runner.js";

export type RunStepFn = typeof runStepDefault;

export interface PipelineDeps {
  runStep?: RunStepFn;
  listWorktrees?: () => string[];
  appendLog?: (entry: Record<string, unknown>) => void;
}
```

Change `runPipeline` from module-private to **exported**, and extend its signature:

```ts
export async function runPipeline(
  opts: PipelineOpts,
  parkSignal: ParkSignal,
  flags: Flags,
  deps: PipelineDeps = {},
): Promise<CycleResult> {
  const runStep = deps.runStep ?? runStepDefault;
  const listWorktrees = deps.listWorktrees ?? listWorktreesDefault;
  const appendLog = deps.appendLog ?? appendLogDefault;
  // … rest unchanged, but call these locals instead of the imports
}
```

Local `step()` helper calls the resolved `runStep`. `finish()` calls the resolved `appendLog`. The `listWorktrees()` call inside the pick flow calls the resolved one. `orchestrate()` is not changed — it calls `runPipeline` without a fourth argument, so production behavior is byte-identical.

### Mock infrastructure

**`scripts/autopilot/__tests__/mocks.ts`** (new)

```ts
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RunStepFn } from "../pipeline.js";
import { LiveStatus, StatusBar } from "../tui.js";
import type { ParkSignal, Step, StepResult } from "../types.js";

export interface StepOutcome extends Partial<StepResult> {
  /** If set, merged into parkSignal before the mock returns. */
  park?: Partial<ParkSignal>;
  /**
   * Files to write into `opts.cwd` before returning. Keys are paths relative to the worktree.
   * Needed so subsequent `checkpoint()` calls have something to commit — `git add -A && git commit`
   * fails with "nothing to commit" on a clean tree and no commit lands.
   */
  writes?: Record<string, string>;
}

/** Per-step behavior. Array = sequential attempts; single = every call. */
export type MockBehavior = Partial<Record<Step, StepOutcome | StepOutcome[]>>;

export interface MockRunStep {
  runStep: RunStepFn;
  calls: Array<{ step: Step; attempt: number }>;
}

export function createMockRunStep(behavior: MockBehavior, parkSignal: ParkSignal): MockRunStep {
  const calls: MockRunStep["calls"] = [];
  const attempts: Partial<Record<Step, number>> = {};
  const runStep: RunStepFn = async (name, _prompt, opts, emit) => {
    const attempt = (attempts[name] ?? 0) + 1;
    attempts[name] = attempt;
    calls.push({ step: name, attempt });
    const spec = behavior[name];
    const outcome: StepOutcome = Array.isArray(spec)
      ? (spec[Math.min(attempt - 1, spec.length - 1)] ?? {})
      : (spec ?? {});
    if (outcome.writes) {
      for (const [rel, content] of Object.entries(outcome.writes)) {
        const full = resolve(opts.cwd, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    if (outcome.park) Object.assign(parkSignal, outcome.park);
    const result: StepResult = {
      ok: outcome.ok ?? true,
      subtype: outcome.subtype ?? "success",
      text: outcome.text ?? "",
      fullText: outcome.fullText ?? outcome.text ?? "",
      cost: outcome.cost ?? 0.01,
      turns: outcome.turns ?? 1,
      ...(outcome.tokens ? { tokens: outcome.tokens } : {}),
    };
    emit({ type: "done", ok: result.ok, subtype: result.subtype, cost: result.cost, turns: result.turns, elapsed: 0 });
    return result;
  };
  return { runStep, calls };
}

export function makeLiveStatus(): LiveStatus {
  return new LiveStatus(new StatusBar());
}

export function makeParkSignal(): ParkSignal {
  return { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
}

export function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-pipeline-test-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync('git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit --allow-empty -q -m init', { cwd: dir });
  return dir;
}

export function lastCommitMessage(dir: string): string {
  return execSync("git log -1 --format=%s", { cwd: dir, encoding: "utf-8" }).trim();
}

export function allCommitMessages(dir: string): string[] {
  return execSync("git log --format=%s", { cwd: dir, encoding: "utf-8" }).trim().split("\n").filter(Boolean);
}
```

Notes:
- `makeTempGitRepo` uses `-b main` so anything relying on `main` ref works.
- Commit helper disables gpg signing so CI without keys doesn't trip.
- The mock `runStep` signature matches the real one exactly via `typeof runStepDefault`; no `any`.
- `StepEmit` is called once per step with a `done` event so `createStepRenderer` stays happy. Terminal rendering is suppressed by `verbose: false`.

### Test file

**`scripts/autopilot/__tests__/pipeline.test.ts`** (new)

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPipeline } from "../pipeline.js";
import type { Flags, PipelineOpts } from "../types.js";
import {
  allCommitMessages,
  createMockRunStep,
  makeLiveStatus,
  makeParkSignal,
  makeTempGitRepo,
} from "./mocks.js";

const baseFlags: Flags = {
  cycles: "1", parallel: "1", verbose: false, trace: false,
  budget: "10", "max-wait": "6h", pr: false, "dry-run": false,
};

function baseOpts(worktree: string): PipelineOpts {
  return { itemId: "TOOL-99", worktree, cycle: 1, verbose: false, pr: false, dryRun: false, liveStatus: makeLiveStatus() };
}
```

Scenarios below. Each test captures an `appendLog` stub into `logs[]` and passes `listWorktrees: () => []` as a safety net.

#### 1. Happy path (plan → ship)

- `behavior`: plan, shakedown-plan (text="VERDICT: APPROVE"), implement, shakedown-code, ship — all `ok: true`.
- Assert: `result.completed === true`, `result.error === undefined`, `result.verdict === "APPROVE"`.
- Assert: `calls.map(c => c.step)` equals `["plan","shakedown-plan","implement","shakedown-code","ship"]`.
- Assert: one log entry, with 5 step entries and `completed: true`.
- Assert: total `result.cost` ≈ 0.05 (5 × 0.01).

#### 2. RETHINK on plan review aborts cleanly

- `behavior`: plan `ok: true`; shakedown-plan `ok: true, text: "VERDICT: RETHINK"`.
- Assert: `result.completed === false`, `result.error === "plan needs rethink"`, `result.verdict === "RETHINK"`.
- Assert: `calls.map(c => c.step)` equals `["plan","shakedown-plan"]`.
- Assert: the log entry's `verdict` is `"RETHINK"`.
- Assert: `parkSignal.parked === false`.

#### 3. Implement turn exhaustion retries once, then succeeds

- `behavior`:
  - plan: ok. shakedown-plan: ok with APPROVE.
  - implement: `[{ ok: false, subtype: "error_max_turns", writes: { "impl-a.txt": "attempt 1" } }, { ok: true, writes: { "impl-b.txt": "attempt 2" } }]`.
  - shakedown-code: ok. ship: ok.
- Assert: `calls.filter(c => c.step === "implement").length === 2` with attempt values `1` and `2`.
- Assert: `result.completed === true`.
- Assert: `allCommitMessages(worktree)` contains at least one `wip: autopilot implementation checkpoint` AND one `wip: autopilot implementation continued` — proves both `checkpoint()` calls landed. The `writes` on each attempt ensure the tree is dirty before `checkpoint()` runs.
- Assert: the log entry's `steps` includes an `implement` entry with `attempt: 2`.

#### 4. Rate-limit parking preserves state

Park on `shakedown-plan`, not `implement`: the implement retry loop pre-checkpoints its own wip before reaching `parkExit()` (`pipeline.ts:285-287` runs `checkpoint("implementation checkpoint")` before the `error_rate_limit` branch), which would absorb the dirty state and leave `parkExit()`'s own `checkpoint("rate-limit park")` with nothing to commit. The `shakedown-plan` failure path in `pipeline.ts:211-213` goes straight to `parkExit()` with the tree still dirty.

- `behavior`:
  - plan: ok.
  - shakedown-plan: `{ ok: false, subtype: "error_rate_limit", writes: { "wip.txt": "partial work" }, park: { parked: true, limitType: "5h", resetsAt: Date.now() + 3_600_000 } }`.
- Assert: `result.completed === false`, `result.error === "parked"`.
- Assert: `calls` never reaches `"implement"`, `"shakedown-code"`, or `"ship"`.
- Assert: `allCommitMessages(worktree)` contains `wip: autopilot rate-limit park` — proves `parkExit()` checkpointed dirty work before returning.
- Assert: the log entry has `parked: true`, `parkReason: "5h"`.

## Files to change

| File | Change |
|------|--------|
| `scripts/autopilot/pipeline.ts` | Export `runPipeline`, `PipelineDeps`, `RunStepFn`; add optional `deps` param. No behavioral change when `deps` is empty. |
| `scripts/autopilot/__tests__/pipeline.test.ts` | **New.** Four scenarios above. |
| `scripts/autopilot/__tests__/mocks.ts` | **New.** `createMockRunStep`, temp git repo helpers, `LiveStatus`/`ParkSignal` factories. |

No change to `config.ts`, `helpers.ts`, `step-runner.ts`, `types.ts`, or any skill. `appendLog` / `listWorktrees` retain their current signatures.

## Schema / i18n

N/A — tooling repo.

## Test strategy

- Run: `npx tsx --test scripts/autopilot/__tests__/pipeline.test.ts`.
- Regression: `npx tsx --test scripts/autopilot/__tests__/helpers.test.ts scripts/autopilot/__tests__/stats.test.ts`.
- Parse checks from `_rubric.md`:
  ```
  npx tsx -e "import('./scripts/autopilot/config.ts')"
  npx tsx -e "import('./scripts/autopilot/helpers.ts')"
  npx tsx -e "import('./scripts/autopilot/pipeline.ts')"
  ```
- `pnpm check` (biome).

## Rubric self-check

- **Well-typed** ✓ — `RunStepFn = typeof runStepDefault` keeps the signature in lockstep with the real function. `StepOutcome extends Partial<StepResult>` reuses the public type. No `any`. `PipelineDeps` fields all optional; defaults fall back to real implementations.
- **Well-tested** ✓ — this *is* the test addition. Each scenario asserts both the end-state result and the step-call order, which is the load-bearing behavior.
- **Well-factored** ✓ — deps object is three fields, not a kitchen-sink. Mock helpers live in a sibling test file. Pipeline module boundaries unchanged.
- **Idiomatic** ✓ — matches `helpers.test.ts` style (`describe`/`it`/`assert/strict`). Imports end in `.js`. Named exports only. Production code path unchanged.
- **Correct** ✓ — preserves every invariant the rubric lists: step exhaustiveness untouched, frontmatter stripping untouched, verdict parsing default honored (scenario 1 mock text is empty yet still APPROVES — covers the fail-safe), worktree isolation hooks unchanged (step-runner untouched), rate-limit parking still checkpoints (scenario 4 asserts the commit), `parkExit()` still called from every exit path (no new exit paths added). `listWorktrees` filtering by `WORKTREE_PREFIX` unchanged. `detectResumeStep` untouched.
- **Concise** ✓ — no speculative helpers. No abstraction beyond the three-field `PipelineDeps`. No backward-compat shims. `runPipeline` gains ~4 lines (deps resolution at the top) and otherwise uses locals instead of imports.

## Self-review revisions

Three tightenings made during self-review:

1. **Scoped out pick** — `resolveWorktree()` uses the `REPO` const, which would force sibling-of-real-repo writes during a unit test. That's filesystem pollution unit tests should avoid. Scenarios 2–4 still exercise `parseVerdict`, `isQuickScope`-free path, and checkpoint logic. A dedicated pick test belongs in a follow-up that decides whether `REPO` should become injectable.
2. **Injected `appendLog` instead of overriding `LOG_PATH` via env var** — respects the module-boundary rule (`config.ts` is static, no runtime-configurable I/O paths). `appendLog` is the only function in the pipeline that writes outside the worktree, so it's the right seam.
3. **Kept deps interface to exactly three fields** — resisted the urge to add `checkpoint`/`findPlanPath`/etc. injection "for flexibility". YAGNI: nothing in the test plan needs them.

---

Run `/shakedown` for an independent review, or say **go** to start building. When done, run `/shakedown` again to review the code.
