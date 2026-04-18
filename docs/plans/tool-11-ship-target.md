# TOOL-11 — ShipTarget abstraction + DirectPush / PullRequest / AutoMergePR adapters

**Scope**: M · **Deps**: TOOL-4 ✓, TOOL-8 ✓ · **Branch**: `feat/tool-11-ship-target`

## Goal

Factor the three "how do we land the branch" modes out of the monolithic `/ship`
skill into typed adapters behind a single `ShipTarget` interface. Pipeline picks
the adapter from config (`ship.target`) and passes it to the ship step. One repo
picks one mode; no mix-and-match.

The three targets:

| Target             | Behavior                                                           |
|--------------------|--------------------------------------------------------------------|
| `direct-push`      | Squash → merge into local `main` → push (today's default).         |
| `pull-request`     | Squash → push branch → `gh pr create` → stop.                      |
| `auto-merge-pr`    | Squash → push branch → `gh pr create` → `gh pr merge --auto`.      |

## Scope — what this touches

**In:**
- New `scripts/autopilot/ship/` module: `index.ts` (interface + factory) + three adapter files.
- `config.ts`: extend `ResolvedConfig` with `shipTarget`; parse `ship.target` from yml; default `direct-push`. Export `SHIP_TARGET`.
- `types.ts`: define `ShipTargetName` literal union, `ShipContext`, `ShipResult`, and `ShipTarget` interface here (not in `ship/index.ts`) to avoid a `types.ts ↔ ship/index.ts` import cycle (ship adapters need `StepResult` from types.ts, and `PipelineOpts` needs `ShipTarget`). Swap `Flags.pr` for `Flags.target?: string`. Swap `PipelineOpts.pr` for `PipelineOpts.shipTarget: ShipTarget`. Add `awaitingMerge?` / `prUrl?` to `CycleResult`.
- `pipeline.ts`: resolve adapter, build prompt via adapter, interpret result via adapter. Replaces every `opts.pr` / `flags.pr` reference (currently 6 sites — see "Files to change → pipeline.ts" below for the enumeration). Skip `/shipwreck` recovery when the shipTarget is not `direct-push` (PR modes can't post-merge fail in a way shipwreck knows how to recover).
- `main.ts`: parse `--target` CLI flag (replacing `--pr`).
- `.claude/skills/ship/SKILL.md`: branch on the target arg (three modes). Update the `Parse $ARGUMENTS` line in the Context section as well as Step 4.
- `docs/config.md`: document `ship.target`.
- `CLAUDE.md`: add one-line note under the key-constraints section AND update the Configuration paragraph that lists `ship` in the silently-ignored set.
- `scripts/autopilot/__tests__/pipeline.test.ts`: update `baseOpts` to include `shipTarget` (default to direct-push adapter); update `baseFlags` to drop `pr` and add optional `target`.
- New `scripts/autopilot/__tests__/ship.test.ts` — factory + adapter + integration tests.

**Out (explicit):**
- Changing what `/shipwreck` recovers (it still handles post-merge rollbacks for `direct-push` only — the PR modes don't merge in-session so there's nothing to wreck).
- Post-merge doc updates for PR modes. When a PR is merged externally, the task-index / roadmap / plan archive stays untouched for now — that's TOOL-10/TOOL-15 territory once remote roadmaps exist. We surface this limitation in the user-facing report, not by silently degrading.
- Multi-target / per-item selection. `ship.target` is repo-wide.
- Custom conflict resolution. Each adapter reuses the known-safe additive patterns already in the skill.
- Mapping the legacy `--pr` flag. Solo tool, no external consumers — we do a hard rename.

## Approach — why this factoring

**Where does the shipping logic actually live today?** Inside the `/ship` skill
markdown. The TS pipeline just calls `expandSkill("ship", opts.pr ? "--pr" :
undefined)` and lets Claude execute the git/gh/doc work. That's the right
division: the skill has adaptive conflict resolution, context-aware doc edits,
and formulaic-but-branchy post-merge flows that aren't worth rewriting in TS.

So the abstraction isn't "TS adapter executes `git merge` directly." It's:

1. **TS-side `ShipTarget`** — picks which skill mode runs, builds the mode's
   prompt preamble, and interprets the step result (extract PR URL, classify
   completed vs awaiting-merge). Lives in `scripts/autopilot/ship/`.
2. **Skill-side modes** — `/ship` has a single verify/identify/squash prelude,
   then branches on `--target=<name>` into one of three shipping tails.

Alternative considered: push all three flows into TS via `execSync`. Rejected —
moves ~150 lines of adaptive merge/doc logic into brittle shell scripting, and
loses the phantom-guard defense-in-depth that the skill already enforces. The
skill is the right home for the "do the ship" verbs.

Alternative considered: leave `/ship` as one monolith and have it read
`.autopilot.yml` directly. Rejected — skills aren't the right place to re-parse
config, and TS-side dispatch lets us unit-test the factory and give type-safe
plumbing through `Flags`, `PipelineOpts`, `CycleResult`.

## Files to change

### New

- **`scripts/autopilot/ship/index.ts`** — re-exports the interface types from
  `types.ts` (so adapter consumers have a single import surface) and declares
  the factory:
  ```ts
  import type { ShipTarget, ShipTargetName } from "../types.js";
  export type { ShipTarget, ShipTargetName, ShipContext, ShipResult } from "../types.js";
  export function getShipTarget(name: ShipTargetName): ShipTarget;  // factory; throws on unknown
  ```
  Interface shapes (defined in `types.ts` to break the cycle described above):
  ```ts
  export type ShipTargetName = "direct-push" | "pull-request" | "auto-merge-pr";
  export interface ShipContext { itemId: string; worktree: string; }   // branch is computed by the skill, omitted here (YAGNI)
  export interface ShipResult {
      completed: boolean;
      awaitingMerge?: boolean;      // true for pull-request + auto-merge-pr on success
      prUrl?: string;                // extracted from step text when present
      error?: string;
  }
  export interface ShipTarget {
      readonly name: ShipTargetName;
      buildPrompt(ctx: ShipContext): string;   // appended to expandSkill("ship")
      interpretResult(step: StepResult): ShipResult;
  }
  ```
  Factory maps name → adapter instance. Exhaustive switch (type narrows on
  `ShipTargetName`), so adding a future target fails compile here first.

- **`scripts/autopilot/ship/direct-push.ts`** — `name: "direct-push"`.
  `buildPrompt` emits: "Mode: direct-push. Squash, merge into main locally,
  run post-merge verification, mark the item done, commit docs, push main,
  clean up the worktree and branch." (The skill knows how.) `interpretResult`:
  `{ completed: step.ok, error: step.ok ? undefined : "ship failed" }`.

- **`scripts/autopilot/ship/pull-request.ts`** — `name: "pull-request"`.
  `buildPrompt` emits: "Mode: pull-request. Squash. Push the branch. Create a
  PR via `gh pr create` with title/body derived from the squashed commit
  message. Do NOT merge. Do NOT update docs or task-index — the PR merge is
  external. Report the PR URL." `interpretResult` parses the PR URL from
  `step.text` (match `https://github.com/.+/pull/\d+`) and returns
  `{ completed: step.ok, awaitingMerge: step.ok, prUrl, error }`.

- **`scripts/autopilot/ship/auto-merge-pr.ts`** — `name: "auto-merge-pr"`.
  Identical to `pull-request` plus one line of preamble: "After creating the
  PR, enable auto-merge: `gh pr merge --auto --squash <pr-number>`." Same URL
  extraction, same `awaitingMerge: true` semantics (the auto-merge fires later
  when CI passes — the pipeline is still done).

- **`scripts/autopilot/__tests__/ship.test.ts`** — three tiers:
  1. Factory: each name → correct adapter; unknown name throws with a clear
     message that lists valid names.
  2. Adapter unit: `buildPrompt` contains the mode-specific verbs
     (`gh pr create`, `gh pr merge --auto`, `merge "$BRANCH"`);
     `interpretResult` extracts PR URLs and classifies `awaitingMerge`.
  3. Pipeline integration: `runPipeline` with each target, via the existing
     `createMockRunStep` mock. Assert the ship step receives a prompt that
     contains the adapter's mode signature, and that `CycleResult.completed`
     + `error` agree with the adapter's interpretation. Uses the same
     `makeTempGitRepo` fixture as `pipeline.test.ts`.

### Modified

- **`scripts/autopilot/config.ts`**:
  - Add `ShipTargetName` import from `./ship/index.js` (no circular — ship/index
    doesn't import config).
  - `ResolvedConfig.shipTarget: ShipTargetName`.
  - In `loadConfig()`: read `yml.ship?.target`; validate against known names;
    default `"direct-push"`. Invalid value throws the same shape of error as
    other section validators (`{configPath}: expected \`ship.target\` to be one
    of direct-push|pull-request|auto-merge-pr, got ...`).
  - Export `SHIP_TARGET: ShipTargetName = CONFIG.shipTarget`.

- **`scripts/autopilot/types.ts`**:
  - `Flags`: remove `pr: boolean`; add `target?: string` (CLI override).
  - `PipelineOpts`: remove `pr: boolean`; add `shipTarget: ShipTarget` (resolved
    before calling `runPipeline`).
  - `CycleResult`: add optional `awaitingMerge?: boolean`, `prUrl?: string`.

- **`scripts/autopilot/pipeline.ts`** — touch every `flags.pr` / `opts.pr` site:
  - `orchestrate()` resolves the target once per run: CLI `--target` > config
    `SHIP_TARGET`. Passes the adapter into every `runPipeline` call via
    `PipelineOpts.shipTarget`. Three call sites today: resume mode (~L473),
    normal worker (~L569), and park-and-resume (~L680). All three drop
    `pr: flags.pr` and pass `shipTarget` instead.
  - Banner line (~L507): replace `${flags.pr ? `  ${A.dim("PR mode")}` : ""}`
    with a target indicator that reads from the resolved adapter name (skip
    the suffix when target is `direct-push` to keep the default banner clean).
  - Ship step (~L396–397): drop the `(PR mode)` log decoration. Prompt becomes
    `expandSkill("ship") + "\n\n" + shipTarget.buildPrompt(ctx)`.
  - Post-step (~L398–420): `const shipResult = opts.shipTarget.interpretResult(ship);`
    then propagate `shipResult.completed / awaitingMerge / prUrl / error` into
    `finish(...)`. **`/shipwreck` recovery (~L400–412) only runs when
    `opts.shipTarget.name === "direct-push"`** — for PR modes a `ship` failure
    is reported as-is (nothing was merged, so there's nothing to wreck).
  - Worktree-cleanup handling: unchanged — the skill handles cleanup only in
    `direct-push` mode. In PR modes the worktree + local branch stay around
    (user cleans up after the PR merges; this is fine for solo use).
  - Summary printout at the bottom of `orchestrate()` (~L713): when
    `awaitingMerge`, print `"↗ PR opened"` plus the URL instead of `"shipped"`.

- **`scripts/autopilot/main.ts`**:
  - `parseArgs`: remove `pr`; add `target: { type: "string" }`.
  - Validate passed-in value against `ShipTargetName` at startup (fail fast
    with the list of valid names).

- **`.claude/skills/ship/SKILL.md`**:
  - Update frontmatter `argument-hint` to `"[--no-squash] [--target=<name>]"`.
  - Update the Context section's "Parse `$ARGUMENTS` for `--no-squash` and
    `--pr` flags" line to "Parse `$ARGUMENTS` for `--no-squash` and
    `--target=<direct-push|pull-request|auto-merge-pr>`. Default target if
    unset: `direct-push` (so inline use without args matches today's
    behavior)."
  - Replace the step-4 `--pr` branch with a target-mode dispatch:
    - Steps 1–3 (Verify, Identify, Squash, phantom guard) run unconditionally.
    - Step 4 becomes a three-branch "Ship" section keyed on the mode arg
      passed by the adapter. Each branch is self-contained; the existing
      direct-push body moves under `Mode: direct-push`. PR modes define their
      push-and-PR flow and **skip** steps 6–9 (doc updates, main push,
      cleanup) with a one-line report including the PR URL.
  - Keep the phantom-guard defense-in-depth check (the pipeline already has
    one, but removing the skill's copy here would widen blast radius for
    inline use — see `CLAUDE.md`'s existing guidance).

- **`docs/config.md`**:
  - New `ship` section in the annotated example:
    ```yaml
    ship:
      target: direct-push     # direct-push | pull-request | auto-merge-pr
    ```
  - Add a "Ship target" subsection explaining the three modes and the
    limitation that PR modes don't currently update docs post-merge (link
    out to TOOL-10/TOOL-15 once those land — for now just state it).
  - Update the "Unknown keys" paragraph — `ship` is no longer in the
    "silently ignored" list.

- **`CLAUDE.md`**:
  - Extend the "Key constraints" section with one bullet:
    > **Ship target is config-driven**: `/ship`'s merge vs PR behavior is
    > selected by `ship.target` and dispatched via adapters in
    > `scripts/autopilot/ship/`. The skill body branches on the target arg;
    > don't hardcode merge logic in TS.
  - Update the skills table — `/ship`'s row grows a "(direct-push | PR modes)"
    annotation.

## Schema changes

None — no persistent data model.

## Config schema delta

```yaml
# .autopilot.yml (new optional section)
ship:
  target: direct-push     # default: direct-push
                          # values: direct-push | pull-request | auto-merge-pr
```

Precedence: `--target` CLI flag > `ship.target` yml > default `direct-push`.
Unknown values fail fast at load time with the list of valid names (matches
existing validator style in `mergeStepRecord`).

## Test strategy

Runs via `npx tsx --test scripts/autopilot/__tests__/ship.test.ts`.

**Unit** (fast, no git):
- `getShipTarget("direct-push" | "pull-request" | "auto-merge-pr")` returns
  an adapter whose `name` matches.
- `getShipTarget("bogus" as ShipTargetName)` throws with a message listing
  the three valid names.
- Each adapter's `buildPrompt` contains mode-specific verb signatures:
  - `direct-push`: `/merge.*\$BRANCH/` and `/git push origin main/`.
  - `pull-request`: `/gh pr create/` and explicit "do NOT merge".
  - `auto-merge-pr`: both of the above plus `/gh pr merge --auto/`.
- `interpretResult` on a step whose `text` contains a GitHub PR URL returns
  `prUrl` populated; missing URL leaves it `undefined` but `completed` still
  reflects `step.ok`.

**Integration** (via `createMockRunStep` + `makeTempGitRepo`, like
`pipeline.test.ts`):
- For each of the three targets, run `runPipeline` with a mocked ship step
  whose `text` contains a PR URL (for PR modes) or a "merged" marker (for
  direct-push). Assert:
  - The prompt captured by the mock at the `ship` step contains the
    adapter's mode signature (proves dispatch wiring is intact).
  - `CycleResult.completed` is `true` in the success path.
  - `CycleResult.awaitingMerge` is `true` for the two PR modes, absent for
    direct-push.
  - `CycleResult.prUrl` is extracted for PR modes.
- **Shipwreck-skip in PR modes**: ship step returns `{ ok: false }` with
  target `pull-request`. Assert `calls` does NOT include `"shipwreck"` and
  `CycleResult.error` is `"ship failed"`. Symmetric test with
  `direct-push`: shipwreck IS invoked (matches existing
  `pipeline.test.ts` behavior — keep that test passing too).
- `mocks.ts` may need a small extension: `createMockRunStep` currently
  ignores `_prompt`. Tests that assert prompt contents need to capture it
  — extend `MockRunStep.calls` with `prompt: string` or add a separate
  `prompts` array. Either is fine; pick the smaller diff.
- Config parse failure: `loadConfig({ configPath })` with a yml containing
  `ship: { target: "rocket" }` throws an error whose message includes
  `ship.target` and the list of valid names.

**Not tested** (explicitly, with justification):
- Actual `gh pr create` / `gh pr merge` invocation — that's the skill's
  responsibility, executed by Claude inside the SDK session. Testing it
  would require a live `gh` + GitHub, which belongs in manual smoke.
- The `/ship` skill body — still no skill linter (that's TOOL-5). We
  manually verify the three-mode branches render by dry-run invocation
  before shipping this.

Manual smoke before shipping:
1. `pnpm autopilot --item TOOL-11 --dry-run --cycles 1` — dispatch executes,
   no SDK calls.
2. `pnpm autopilot --item <cheap throwaway item> --target=pull-request` —
   one real cycle, verify PR is created and pipeline reports the URL.
3. `pnpm autopilot --item <same kind> --target=auto-merge-pr` — verify
   `gh pr merge --auto` is enabled on the resulting PR (inspect in GitHub).

## i18n needs

None — tooling repo, no user-facing UI copy.

## Rubric self-check

| Dimension      | Score | Notes |
|----------------|-------|-------|
| Well-typed     | ✓     | `ShipTargetName` literal union; `ShipResult` is a flat record with optional `awaitingMerge` / `prUrl` / `error` (not a discriminated union — failure path is `completed: false` + `error`, success-with-PR is `completed: true` + `awaitingMerge: true` + `prUrl`); factory `switch` exhaustive (compile error if target added without arm). No `any`. Interface types live in `types.ts` to avoid an import cycle with `ship/index.ts`. |
| Well-tested    | ✓     | Unit + integration tiers via `node:test`. Factory, prompt content, result interpretation, pipeline wiring, config validator. SDK-level gh/git execution stays manual (documented). |
| Well-factored  | ✓     | New `ship/` module keeps adapters siloed; `config.ts` stays declarative; `pipeline.ts` only gains ~6 lines for dispatch; `step-runner.ts` untouched; skill retains verb-level knowledge. |
| Idiomatic      | ✓     | Biome-clean, `.js` ESM imports, named exports, no default exports, `process.env.X ?? default` only for the existing worktree-prefix (no new env vars). |
| Correct        | ✓     | Phantom-guard stays intact (pipeline + skill). Step exhaustiveness unchanged (no new Step). Worktree isolation unchanged. `parkExit` paths unchanged — ship-failure path still routes through `/shipwreck`. |
| Concise        | ✓     | Adapters are ~30 lines each; factory is a one-switch file; pipeline delta is small. No helpers that don't earn their keep. |

### Invariant checklist (from CLAUDE.md)
- ✓ Step exhaustiveness — no new `Step`; `BUDGETS`/`TURN_LIMITS`/`EFFORT`/`MODEL_PROFILES` untouched.
- ✓ Frontmatter stripping — `/ship` frontmatter is still stripped by `expandSkill`.
- ✓ Worktree isolation — no changes to step-runner hooks.
- ✓ Rate-limit parking — ship-step parking path unchanged; adapter dispatch happens after `parkExit()`.
- ✓ No hardcoded model strings — adapters use skill names and arg strings only.
- ✓ Phantom ship guard — pipeline-side guard (`hasDeliverableCommits`) runs before dispatch; skill-side guard stays as defense in depth.

## Self-review notes

Four things I considered and revised during self-review:

1. **Initial draft had separate `ShipTarget.run()` methods on adapters** that
   would execute git/gh via `execSync`. Rejected and removed — that would
   duplicate ~150 lines of logic that the skill already does well, and lose
   adaptive conflict resolution. The revised split keeps adapters as
   prompt-builders + result-interpreters; the skill remains the shipping
   executor. Matches what the roadmap means by "wraps current /ship flow."

2. **Initial draft kept `--pr` as a backward-compat alias for
   `--target=pull-request`**. Rejected — CLAUDE.md explicitly calls out "no
   backwards-compat shims — this repo has no external consumers beyond the
   user's own projects." Hard rename is cheaper than carrying an alias that
   will outlive its utility. If someone has muscle memory for `--pr`, the
   invalid-flag error from `parseArgs` tells them immediately.

3. **Initial draft put `ShipTarget` types in `ship/index.ts` and imported
   them into `types.ts`**. Rejected — `ship/index.ts` needs `StepResult`
   from `types.ts` for `interpretResult`, so importing `ShipTarget` back
   into `types.ts` (because `PipelineOpts` holds it) creates a value-level
   circular import that tsx ESM handles unpredictably. Moved the four
   interface declarations into `types.ts` and re-exported them from
   `ship/index.ts` so adapter authors still have one tidy import surface.

4. **Initial draft left `/shipwreck` recovery wired up for all targets**.
   Rejected — `/shipwreck` is built around the post-merge "main is broken,
   roll back" scenario. PR modes never merge in-session, so a failed `ship`
   step in PR mode means the push or `gh pr create` failed; running
   `/shipwreck` against that state is at best a no-op and at worst confuses
   the recovery agent. Pipeline now skips shipwreck unless the target is
   `direct-push`. Added a dedicated test for this branch.

## Cost / risk

- ~250 LOC added (adapters + tests + skill branching), ~20 LOC removed (the
  `--pr` branch in pipeline + main).
- No schema, no migration, no breaking data change.
- Behavioral risk: direct-push path must stay byte-identical to today's
  `/ship` default. Guarded by the pipeline integration test in
  `pipeline.test.ts` (already passing) plus one new integration test
  targeting `direct-push` specifically.
- Skill body is the highest-risk surface (no typechecker). Mitigation: dry-run
  + manual smoke before shipping, and the three-branch structure is shallow.
