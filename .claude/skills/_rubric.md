# Quality Rubric — pelaggio Tooling

Six dimensions — apply when planning, reviewing, or fixing code in this repo. This rubric is for the pelaggio *tooling itself*, not for downstream projects that use it.

**Scope of this repo**: TypeScript CLI pipeline built on `@anthropic-ai/claude-agent-sdk`. Files under `packages/pelaggio/scripts/pelaggio/`, `.claude/skills/`, and `.claude-templates/`. No UI, no user-facing surface.

## Dimensions

**Well-typed** — No `any`. Discriminated unions over boolean flags where state matters (e.g., `StepEvent`, `SDKResultMessage`). Explicit return types on all exported functions. `Step` is a literal union — new step names must land in config.ts's `STEPS` const and every `Record<Step, T>` must be exhaustive. No `as Step` casts outside controlled entry points (`detectResumeStep` log parsing is the one exception, and it validates via `STEPS.indexOf`).

**Well-tested** — Pure helpers (`text.ts`, `git.ts`, `outcome-classify.ts`, `cycle-outcome.ts`, `skills.ts`, `pick-parse.ts`, `ship/freshness.ts`, `cycle-support.ts`) have unit tests in `__tests__/<module>.test.ts` via `node:test` + `npx tsx --test`. Pipeline integration is harder to test (it spawns real SDK sessions) — acceptable to leave untested until a mocking approach emerges. Edge cases matter especially in `parseResetTime`, `parseWaitFlag`, `parseItemId`, `parseVerdict` — all of which are regex-driven and failure-prone.

**Well-factored** — Strict module boundaries:
- `step-names.ts` — `STEPS` / `Step`: the source of truth for step names; adding a step means updating every step-indexed map in `config.ts`.
- `config.ts` — static configuration (BUDGETS, TURN_LIMITS, EFFORT, MODEL_PROFILES, REPO path). No business logic. No hardcoded model strings anywhere else.
- `git.ts` / `text.ts` / `outcome-classify.ts` / `skills.ts` — pure functions and shell wrappers (git, fs, parsing). No SDK calls, no event emission. `cycle-outcome.ts` / `pick-parse.ts` / `ship/freshness.ts` hold verdict and ship policy; `cycle-support.ts` holds what only the orchestration layer uses.
- `types.ts` — type-only. No runtime code.
- `step-runner.ts` — owns the SDK `query()` loop, hook installation, event streaming. No business logic.
- `pipeline.ts` — the orchestration loop. Composes everything above. No direct SDK imports (goes through `step-runner`).
- `main.ts` / `pelaggio.ts` — entry points. Arg parsing and orchestrator invocation only.
- `tui.ts` — display layer. No business logic, no mutation.

Skills live in `.claude/skills/` — each skill is self-contained markdown with frontmatter. Shared rubric + review logic via `!cat` includes. Skill bodies read by `expandSkill()` which strips frontmatter before passing to the SDK.

**Idiomatic** — Biome-clean (tabs for indent, double quotes, trailing commas). Imports order: node builtins → external packages → local paths. `.js` extension in relative imports (ESM convention, required by `tsx`). No default exports — everything named. Async iteration via `for await` over SDK generators. Error handling via `try/catch` with specific subtype categorization (`error_rate_limit`, `error_budget`, `error_max_turns`, etc.). Environment variable overrides read via `process.env.X ?? default`.

**Idioms** — Framework-version-current conventions (name the version when it matters: Node 22 `node:test`, TypeScript 6 `satisfies`, `@anthropic-ai/claude-agent-sdk` streaming `query()` iteration). Well-established design patterns over ad-hoc invention. Simplicity over cleverness — the boring, widely-understood solution wins. Consistency with broad industry convention, not just this repo. Stress-tested primarily by `/shakedown`'s forked (out-of-context) review because catching convention drift needs fresh eyes.

**Correct** — Load-bearing invariants specific to this pipeline:
- **Step exhaustiveness**: `STEPS` const is the source of truth. `BUDGETS`, `TURN_LIMITS`, `EFFORT`, and every `MODEL_PROFILES[profile]` must have an entry for every Step. Missing keys cause runtime lookups of `undefined` which crash late.
- **Frontmatter stripping**: `expandSkill()` MUST strip frontmatter before returning. Downstream consumers pass the result directly as a SDK prompt; leaked frontmatter pollutes the prompt and confuses the model.
- **Verdict parsing default**: `parseVerdict()` **fails closed** — when no verdict keyword is present it returns `RETHINK` (which halts the cycle) *unless* the output shows the review actually engaged with the rubric, in which case it keeps the historical `APPROVE` fail-safe. A refused/empty/truncated shakedown must not read as an implicit approval and ship on a phantom sign-off. Changing this contract requires a comment explaining why.
- **Worktree isolation**: `step-runner` installs `PreToolUse` hooks when running in a worktree to block Write/Edit/Bash calls targeting `MAIN_REPO` paths. This prevents agents from corrupting sibling worktrees. The hook must run before every mutating tool — don't add exceptions without a test.
- **Claude seat isolation**: every Claude SDK `query()` must preflight Bubblewrap and spawn through `spawnClaudeSeat`. Fail closed on non-Linux, missing `bwrap`, or a bad harness socket locator. Keep `--new-session` so the seat cannot inherit the harness controlling terminal. Do not gate the custom spawn on `onChildSpawn`, fall back to the SDK default spawn, or conflate this PID/mount wrapper with Landlock or the full contained-execution jail.
- **Rate-limit parking preserves work**: on rate limit rejection, `parkSignal.parked` is set, and `parkExit()` runs `checkpoint()` before returning. Any new exit path from the pipeline must call `parkExit()` first or risk losing committed-but-not-pushed work.
- **`listWorktrees()` filters by prefix**: new worktree detection matches `WORKTREE_PREFIX` to ignore unrelated worktrees. `WORKTREE_PREFIX` is derived from `basename(REPO)` by default — tests that mock REPO need to set `PELAGGIO_WORKTREE_PREFIX` env var.
- **`detectResumeStep` trusts only valid Step names**: when reading log entries from disk, it validates parsed step names against `STEPS.indexOf()`. Unknown names (from legacy logs or corruption) fall through to `"ship"` as a safe default — *not* to a random step.
- **Phantom ship guard**: `pipeline.ts` calls `hasDeliverableCommits()` (three-dot diff against main; branches that only touch `docs/plans/` are phantoms) before invoking `/ship`, and `verifyShipLanded()` afterward to confirm `main` actually advanced. The identical checks in `/ship`'s SKILL.md are defense-in-depth for inline (non-pipeline) use. Don't bypass either layer.

**Concise** — YAGNI. No dead code. Early returns. No premature abstractions — the pipeline is ~600 lines across 7 files and should stay that way. Avoid "configurability" that nobody has asked for. When adding a feature, prefer extending an existing function over adding a new helper. No backwards-compat shims — this repo has no external consumers beyond the user's own projects, and those can update.

## Verification

```bash
npx tsx --test --test-reporter=dot packages/pelaggio/scripts/pelaggio/__tests__/*.test.ts   # unit + pipeline tests (terse dot reporter)
npx tsx --test --test-reporter=dot packages/server/__tests__/*.test.ts                         # server unit tests (supervisor, state-store, auth, app)
npx tsx -e "import('./packages/pelaggio/scripts/pelaggio/config.ts')"                        # parse-check config
npx tsx -e "import('./packages/pelaggio/scripts/pelaggio/git.ts')"                           # parse-check git helpers
npx tsx -e "import('./packages/pelaggio/scripts/pelaggio/pipeline.ts')"                      # parse-check pipeline
npx tsx -e "import('./packages/server/src/app.ts')"                                            # parse-check server entry
pnpm typecheck                                                               # ordinary gate: pelaggio+server tsc --noEmit (relaxed noUncheckedIndexedAccess) + web astro check
pnpm typecheck:ratchet                                                       # strict non-web debt: diagnostic count may only fall (except governed root-TS bump)
pnpm check                                                                   # biome (exit 0 on success — output is already compact)
pnpm check:skills                                                            # lint .claude/skills/*/SKILL.md frontmatter + includes
```

All must succeed. `pnpm typecheck` is the ordinary compiler gate (package configs temporarily set `noUncheckedIndexedAccess: false`; base stays true; web stays full-strict under `astro check`). `pnpm typecheck:ratchet` measures shadow strict configs and fails if either non-web package exceeds `ci/typecheck-baseline.json` (counts may only decrease, except a root lockfile TypeScript bump authorized by an exact PR-body delta marker). ADR-0025 will later consolidate this interim policy.

**Reporter choice matters for token cost.** Inside pelaggio cycles, verification stdout lands in the agent's event stream and counts as tool-result tokens. Default `node:test` spec reporter emits ~20-30 tokens per test — at 100+ tests a verification pass costs ~2k tokens; at 3500+ tests (fathom scale) it costs ~100k tokens per pass × 3 passes per cycle. **Always use a terse reporter in the rubric's verification commands.** Equivalents by framework: `node:test --test-reporter=dot`, `vitest --reporter=dot`, `jest --silent --reporters=summary`, `biome check --reporter=summary`. Verbose output is for humans debugging a failure, not for pelaggio to re-confirm success.

**Biome** lints `scripts/**/*.ts` via `biome.json`; run `pnpm check` (or `pnpm format` to auto-fix). Skill and template markdown is not linted. A lefthook `pre-commit` hook auto-formats staged TS files.
