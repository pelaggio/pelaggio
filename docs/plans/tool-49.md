# TOOL-49 — TUI non-TTY fallback: plain-line events when stderr isn't a terminal

## Problem

When `pnpm autopilot --verbose` is launched by the control-plane server (`packages/server/src/supervisor.ts:56`), its stderr is piped to a file (`.dev/server-logs/${id}.log`) and fanned out over SSE via `GET /runs/:id/log`. The TUI layer in `packages/autopilot/scripts/autopilot/tui.ts` unconditionally emits:

- Scroll-region manipulation (`\x1b[1;Xr`) and cursor save/restore (`\x1b[s`, `\x1b[u`) — `StatusBar.setup/update` (tui.ts:131–161).
- Clear-line resets (`\x1b[2K\r`) and spinner repaints at 80 ms — `Spinner.render` (tui.ts:99–105).
- Cursor hide/show bracketing (`\x1b[?25l`, `\x1b[?25h`) — `createStepRenderer` (tui.ts:269, 395).
- Unicode box drawing (`╭─`, `╰`, `│`) and color wrappers (`A.bold`, `A.cyan`, …) scattered through every event branch of `createStepRenderer` (tui.ts:279–399) plus ~30 `console.log` banner sites in `pipeline.ts`.

Piped into a file or an SSE stream these bytes become literal `^[[2K^M^[[1;24r…` garbage. The renderer already has a latent ANSI-stripped *file* branch (`fv = toFile`, tui.ts:251–262), but it only activates when the caller passes `opts.logPath`, and orchestrator callers pass `logPath` only in the `isParallel && v` arm (`pipeline.ts:694–698`). Server-spawned single-item runs fall through to the TTY branch.

## Scope

**In scope**
- Detect non-TTY stderr and suppress TUI repaints (spinner, status bar, cursor control) automatically.
- Make `createStepRenderer` emit plain, ANSI-stripped single lines to stderr when in plain mode.
- Make `A.*` color wrappers no-op when ANSI isn't usable, so the ~30 `console.log` banners in `pipeline.ts` don't need per-site churn.
- Provide a deliberate env-var override (`CLAUDE_AUTOPILOT_PLAIN=1`) so the server can force plain mode defensively, and so humans piping to `less` / `tee` can opt in.
- Supervisor: set `CLAUDE_AUTOPILOT_PLAIN=1` in the spawned child's env. Belt-and-suspenders — `isTTY` is already false on a pipe, but making the intent explicit in the spawn args is cheap and survives wrapper shims that might allocate a pty.
- New unit test file `packages/autopilot/scripts/autopilot/__tests__/tui.test.ts` covering the plain-mode branches.
- Supervisor test update to assert the env var is set.

**Out of scope**
- Rich no-color spec: `NO_COLOR` / `FORCE_COLOR` env handling. Single-process consumers who want color off in a TTY have `CLAUDE_AUTOPILOT_PLAIN=1`. Not widening scope until someone asks.
- Structured JSON event log for SSE consumers. That's a separate feature (schema design, back-compat story for existing log readers). Plain lines are the ask for TOOL-49.
- Changing the file-log (`fv`) format or the multi-cycle `.dev/autopilot-{N}.log` paths. Untouched.
- Colorizing / reformatting top-level orchestrator banners (`runOrchestrator` opening lines, summary table). Color bytes there will self-strip once `A.*` respects the detection.

## Approach

### Detection (one module-init read, one env escape hatch)

In `tui.ts`, compute once at import, with injectable inputs so the function is directly unit-testable:

```ts
export function computeTuiEnabled(
	env: NodeJS.ProcessEnv = process.env,
	stderr: { isTTY?: boolean } = process.stderr,
): boolean {
	if (env.CLAUDE_AUTOPILOT_PLAIN === "1") return false;
	return !!stderr.isTTY;
}

export const TUI_ENABLED = computeTuiEnabled();
```

Both function and constant exported. Module-init compute (vs. per-call) is the standard tty-library pattern — `isTTY` doesn't flip mid-process. Injection lets tests exercise both the env-override and isTTY-detection paths in a single process without spawning subprocesses.

### Rewire `A` helpers to honour `TUI_ENABLED`

Replace the current const-object form with an initializer that chooses color vs. identity:

```ts
const wrap = TUI_ENABLED
	? (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`
	: () => (s: string) => s;

export const A = {
	bold: wrap("1", "22"),
	dim: wrap("2", "22"),
	cyan: wrap("36", "39"),
	yellow: wrap("33", "39"),
	green: wrap("32", "39"),
	red: wrap("31", "39"),
	magenta: wrap("35", "39"),
	clearLine: TUI_ENABLED ? "\x1b[2K\r" : "",
	hideCursor: TUI_ENABLED ? "\x1b[?25l" : "",
	showCursor: TUI_ENABLED ? "\x1b[?25h" : "",
};
```

This single change removes color bytes from every consumer of `A` (`pipeline.ts`, the `main.ts` banner path, and the `createStepRenderer` TTY branch) without touching ~30 call sites. `stripAnsi()` callers are unaffected (no-op on ANSI-free input). `A.clearLine`/`hideCursor`/`showCursor` also become empty strings in plain mode — belt-and-suspenders for any writer that bypasses the flow control below.

### `StatusBar` / `Spinner`: constructor-opt + default-from-module

```ts
export class StatusBar {
	readonly plain: boolean;
	active = false;
	// …
	constructor(opts: { plain?: boolean } = {}) {
		this.plain = opts.plain ?? !TUI_ENABLED;
	}

	setup(lines = 2): void {
		if (this.plain) return;
		// …existing body…
	}
	update(lines: string[]): void {
		if (this.plain || !this.active) return;
		// …existing body…
	}
	teardown(): void {
		if (this.plain) return;
		// …existing body…
	}
}

export class Spinner {
	private readonly plain: boolean;
	// …
	constructor(liveStatus: LiveStatus | null = null, opts: { plain?: boolean } = {}) {
		this.liveStatus = liveStatus;
		this.plain = opts.plain ?? !TUI_ENABLED;
	}

	start(text: string): void {
		if (this.plain) return;
		// …existing body…
	}
	stop(finalLine?: string): void {
		if (this.plain) return;
		// …existing body…
	}
}
```

`orchestrate()` already calls `new StatusBar()` with no args (`pipeline.ts:872`) — the default (`!TUI_ENABLED`) kicks in for free. Tests pass `new StatusBar({ plain: true })` to exercise plain behaviour regardless of the host's `isTTY`.

`Spinner.stop(finalLine)` plain-mode is a full early-return, not a "preserve final-line" branch: in the refactored renderer the spinner is only constructed in `ttyVerbose` mode (`const spinner = ttyVerbose ? new Spinner(liveStatus) : null`), so `spinner!.stop(line)` is never called in plain mode. Tool-use "▸" lines are emitted directly by the `plainLine` sink in the renderer, not routed through the spinner. The `plain` opt remains on `Spinner` as a symmetric defensive knob with `StatusBar`, but carries no behavioural branch in `stop`.

### `createStepRenderer` — three mutually exclusive output modes

Add one optional field to `StepRendererOpts`:

```ts
export interface StepRendererOpts {
	verbose: boolean;
	trace: boolean;
	toFile: boolean;
	logPath?: string;
	liveStatus: LiveStatus;
	workerStatus?: CycleStatus;
	plain?: boolean;  // default !TUI_ENABLED; override for tests
}
```

Refactor the mode flags from two (`v`, `fv`) to three, reading the override with module-init fallback:

```ts
const plain = opts.plain ?? !TUI_ENABLED;
const ttyVerbose = verbose && !toFile && !plain;
const plainVerbose = verbose && !toFile && plain;
const fileVerbose = toFile;
```

Symmetric with `StatusBar`/`Spinner`'s `plain?: boolean` opt — all three display primitives accept the same override and default from the same module-init constant.

Unify the two ANSI-stripped writers behind one sink:

```ts
const plainLine: (s: string) => void =
	plainVerbose
		? (s) => { process.stderr.write(stripAnsi(s)); }
		: fileVerbose && logPath
			? (s) => { appendFileSync(logPath, stripAnsi(s)); }
			: (_s) => {};
```

Rename `flog` → `plainLine`. Every existing `flog("…\n")` call site becomes `plainLine("…\n")` and now fires in plain-to-stderr mode too, with byte-identical formatting to the file log. No event-branch body changes — just the sink changes. The existing `v` → `ttyVerbose` rename is mechanical.

The one subtlety: `ttyVerbose` now folds in the `TUI_ENABLED` check, so the TTY path is guaranteed a real terminal. `A.hideCursor` write at line 269 gates on `ttyVerbose` (already does via `if (v)`), so no new guard needed — but the write is now also a no-op string under plain mode even if a caller forces it.

### Pipeline wiring

`runOrchestrator` (pipeline.ts:554) — one guarded call site:

```ts
const statusInterval = isParallel && v && TUI_ENABLED ? setInterval(() => liveStatus.render(), 200) : null;
```

Skipping the interval is strictly an optimization — `liveStatus.render()` → `statusBar.update()` now no-ops when plain — but it avoids a 200 ms timer spinning uselessly in server-spawned processes for the full cycle duration.

Everything else (`statusBar.setup()`, `statusBar.teardown()`, `liveStatus.render()` calls, `v`-guarded branches) flows through the no-ops added to `StatusBar` / `Spinner`. No other call-site edits needed in `pipeline.ts`.

No change needed to `types.ts` / `PipelineOpts` — `TUI_ENABLED` is read once at import, and the renderer reads it via the mode-flag computation. Keeps the pipeline surface unchanged.

### Supervisor (server-side defensive flag)

`packages/server/src/supervisor.ts:56`:

```ts
const child = this.spawn("pnpm", args, {
	cwd: this.repoCwd,
	env: { ...process.env, CLAUDE_AUTOPILOT_REPO: this.repoCwd, CLAUDE_AUTOPILOT_PLAIN: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});
```

One key added. Supervisor is the only autopilot-spawning surface in this repo, so this covers today's server and future `/runs` siblings.

## Files to change

| File | Change |
|---|---|
| `packages/autopilot/scripts/autopilot/tui.ts` | Add `TUI_ENABLED` + `computeTuiEnabled()` exports (injectable env/stderr); rewire `A` helpers; add `plain` constructor opt to `StatusBar` / `Spinner` with early-returns; add `plain?: boolean` to `StepRendererOpts`; refactor `createStepRenderer` to three-mode flags (`ttyVerbose` / `plainVerbose` / `fileVerbose`) and unify the ANSI-stripped sink as `plainLine` |
| `packages/autopilot/scripts/autopilot/pipeline.ts` | One-line guard on `statusInterval` to avoid the 200 ms timer in plain mode |
| `packages/server/src/supervisor.ts` | Add `CLAUDE_AUTOPILOT_PLAIN: "1"` to the spawn env |
| `packages/autopilot/scripts/autopilot/__tests__/tui.test.ts` *(new)* | Unit tests for plain-mode branches (see test strategy) |
| `packages/server/__tests__/supervisor.test.ts` | One assertion that `CLAUDE_AUTOPILOT_PLAIN=1` appears in the spawned env |
| `docs/server.md` | One-paragraph note appended to the `GET /runs/:id/log` section noting that spawned children receive `CLAUDE_AUTOPILOT_PLAIN=1` so tee'd logs / SSE streams are ANSI-free; mention the env var as the opt-in for users who pipe `pnpm autopilot` output outside the server |

## Test strategy

New file `packages/autopilot/scripts/autopilot/__tests__/tui.test.ts`, `node:test` + `tsx`, terse reporter (per rubric):

**Helper** — a `captureStderr` utility that monkey-patches `process.stderr.write`, collects chunks, returns `restore()`. Standard Node pattern; no new deps.

**Cases**:

1. `StatusBar({ plain: true })` — `setup()` / `update(["x"])` / `teardown()` write zero bytes to stderr, and `active` stays false.
2. `Spinner(null, { plain: true })` — `start("working…")` writes nothing; after 200 ms no frames appear; `stop()` and `stop("▸ done")` both write nothing. (Plain-mode Spinner is a pure no-op; final-line emission is the renderer's responsibility via `plainLine`, not the Spinner's.)
3. `createStepRenderer({ verbose: true, trace: false, toFile: false, plain: true, liveStatus })` — feed the scripted sequence `step_header` → `tool_use` (mutating) → `tool_use` (non-mutating) → `done(ok)`. Assert stderr output contains no `\x1b`, no `\r`, and matches the expected `── step ──` / `   ▸ Running …` / `   · Searching …` / `   ✓ done $x.yz` shape (same format as the existing file log branch).
4. `computeTuiEnabled()` unit tests — call with synthetic `env` / `stderr` shapes to cover the precedence matrix: `{ CLAUDE_AUTOPILOT_PLAIN: "1" }` + `isTTY: true` → `false` (env override wins); `{}` + `isTTY: true` → `true`; `{}` + `isTTY: false` → `false`; `{ CLAUDE_AUTOPILOT_PLAIN: "0" }` + `isTTY: true` → `true` (only exact `"1"` disables). Pure-function test, no subprocess, no env mutation.
5. `A` rewire check — assert `A.bold("x") === "x"` and `A.clearLine === ""` when the test process has a non-TTY stderr (the default in `node:test` runners). This also transitively validates the module-init `TUI_ENABLED = false` branch used by every other test in this file.

**Supervisor test** (`packages/server/__tests__/supervisor.test.ts`, existing file): extend the existing "spawns pnpm with the expected argv" test to also assert the spawned options include `CLAUDE_AUTOPILOT_PLAIN=1`. The fake `spawn` already records `(cmd, args)` — widen it to record `opts` too (one-line change) so the assertion has something to check.

**Smoke verification (manual, one-shot)** — run `pnpm autopilot --dry-run --cycles 1 2>/tmp/autopilot.log` and confirm `/tmp/autopilot.log` contains no `\x1b` bytes (`grep -P '\x1b' /tmp/autopilot.log` exits non-zero). Note in the plan; not a gate.

## Rubric self-check

- **Well-typed** — New `plain?: boolean` constructor opts are typed. `TUI_ENABLED` typed `boolean`. Three-flag refactor in `createStepRenderer` keeps existing `StepRendererOpts` interface; no `any`.
- **Well-tested** — New `tui.test.ts` covers the plain path. Supervisor env-var assertion covers the defensive flag. Existing coverage (helpers, pipeline) untouched.
- **Well-factored** — Change lands entirely in `tui.ts` (display layer) + one guard in `pipeline.ts` + one env key in `supervisor.ts`. No cross-module coupling added. `A` rewire is one initializer, not 30 call-site edits.
- **Idiomatic** — `process.stderr.isTTY` is the Node-standard detection. Const-object → initialized-with-function is common tty-library shape (`chalk`, `kleur`, `picocolors` all use it). `.js` relative imports preserved. No default exports added. Double-quoted, tab-indented per Biome config.
- **Idioms** — Deliberately not pulling in `NO_COLOR` / `FORCE_COLOR` despite the no-color-spec precedent — YAGNI, one env override is enough for this repo's consumers. Defer if someone asks.
- **Concise** — No new helpers exported from `tui.ts` beyond `TUI_ENABLED`. No config-schema change in `config.ts` / `.autopilot.yml` (env-only override, matching the existing `CLAUDE_AUTOPILOT_*` idiom). Renderer event-branch bodies untouched — only sink function changes.
- **Correct** — Load-bearing invariants: step exhaustiveness (unaffected — no new step), frontmatter stripping (unaffected), worktree isolation (unaffected — not a renderer concern), rate-limit parking (unaffected — park-exit path writes through `A.*` and `console.log`, still works with color-stripping). Spinner's "final line" contract is preserved in plain mode (branch in `stop(finalLine)`) so tool-use event logging doesn't regress.

## Revision notes

- Initial draft wired `plain` through `PipelineOpts` as a new field. Dropped — `TUI_ENABLED` as module-init constant covers both `createStepRenderer` and top-level `A.*` uses without an extra thread, and the supervisor can still force it via env. Pipeline surface stays unchanged. (`StepRendererOpts` still gets a local `plain?` override for tests — symmetric with `StatusBar`/`Spinner`.)
- Self-review fix: original draft left `Spinner.stop(finalLine)` with a "preserve final-line" branch in plain mode. Traced every caller — the refactored renderer constructs Spinner only in `ttyVerbose` mode, so `spinner.stop(finalLine)` is never invoked when plain. Dropped the branch; plain-mode `stop` is a full no-op. Test #2 updated to assert no writes on any `stop()` overload.
- Self-review fix: original `computeTuiEnabled()` read `process.env` / `process.stderr` directly, forcing test #5 to spawn a subprocess to cover the env-override path. Switched to injectable signature (`env`, `stderr` parameters with `process` defaults). Test #5 collapses to a direct call with synthetic inputs; no subprocess, no env mutation.
- Initial draft added `NO_COLOR` / `FORCE_COLOR` handling. Dropped per YAGNI — one env override is sufficient, adding two more widens the matrix (FORCE_COLOR=0 vs NO_COLOR vs CLAUDE_AUTOPILOT_PLAIN — which wins?) without a concrete consumer asking. Easy to add later if needed.
- Initial draft stripped color from top-level `console.log` banners via a per-site `colorize()` helper. Dropped in favour of the `A.*` rewire — one initializer replaces ~30 touch sites, which is also cheaper to verify.
- Initial draft added a `--plain` CLI flag. Dropped — redundant with `CLAUDE_AUTOPILOT_PLAIN=1` and `isTTY` auto-detection, and CLI flag surface should stay minimal per the rubric's "no configurability that nobody has asked for" guidance.
