# TOOL-16 — Split `/refit` → `/bump-models` + self-hosted Renovate

## Scope

**In scope**

- Replace `.claude/skills/refit/SKILL.md` with a new `.claude/skills/bump-models/SKILL.md` (model-IDs-only, ~25 lines)
- Delete `.claude/skills/refit/` entirely
- Add `.github/workflows/ci.yml` — self-hosted, `push` to main + `pull_request`, runs `pnpm install --frozen-lockfile && pnpm test && pnpm check && pnpm check:skills && pnpm check:roadmap`
- Add `.github/workflows/renovate.yml` — self-hosted, weekly Monday cron + `workflow_dispatch`, runs `renovatebot/github-action` pinned to SHA
- Add `renovate.json` at repo root
- Update `CLAUDE.md`'s skill table (remove `/refit` row, add `/bump-models` row)
- Update the auto-memory `feedback_dependency_bumps.md` to note deps are now Renovate-managed; the `/bump-models` manual flow remains only for Opus/Sonnet IDs
- Mark TOOL-16 done in `docs/roadmap-core.md` + `docs/task-index.md`
- Verify the Renovate workflow runs end-to-end at least once via `workflow_dispatch` before the cycle completes

**Out of scope**

- Migrating `../fathom` to Renovate (separate charter if desired)
- Renovate's Mend app — explicitly rejected
- Changing the self-hosted runner config — reuse as-is
- PAT scope work: if `GITHUB_TOKEN` suffices, do nothing. If not, document the required PAT scope in `renovate.yml` comments; do **not** commit a token

## Approach

Today's `/refit` bundles two concerns:

1. **Anthropic model IDs** — legitimately manual. No `-latest` alias ships; bumping is a low-frequency judgment call with a single web fetch + two constants edited in `config.ts`.
2. **Package dep drift** — redundant. `pnpm outdated` is fragile to parse, and Renovate already solves this at industry scale.

The split reflects that shape difference: (1) stays a Claude skill (small, judgment-heavy); (2) moves to Renovate because dep bumping is a well-solved automation problem, not a Claude ideal surface.

**Why self-hosted runner** — the spec requires zero GitHub-hosted Actions minutes consumed. The existing self-hosted runner (shared with `../fathom`) already runs CI; Renovate is one more workflow on the same box.

**Why `renovatebot/github-action` over `npx renovate`** — the action handles env plumbing, is the documented path, and pins cleanly via SHA (matches fathom's supply-chain convention of `uses: org/name@<sha> # vX.Y.Z`).

**Why keep the dependency-bump memory feedback rather than delete it** — the staged-commit preference (patch group / majors one-at-a-time) still applies to `/bump-models` (two constants can still reasonably be bumped in one commit), and Renovate's defaults already enforce the same split for deps (auto-merge minor/patch, manual-approval majors). The memory body needs a line update, not a removal.

### Alternatives considered

- **Keep `/refit` and just remove the dep-check section**: rejected — the name connotes "full refresh" and would confuse future readers. Renaming to `/bump-models` makes the narrower scope obvious.
- **Use GitHub-hosted Renovate (Mend app)**: explicitly rejected in the charter — takes deps out of the repo and adds a third-party install.
- **Dependabot instead of Renovate**: Dependabot has no dashboard-approval gate for majors (the `dependencyDashboardApproval` feature is Renovate-only), which the charter requires.

## Files to change

### New

- `.claude/skills/bump-models/SKILL.md` — frontmatter (`name: bump-models`, `description: …`, `allowed-tools: Read Edit Bash(pnpm:*) Bash(git:*) Bash(rg:*) WebFetch`), body ~20 lines:
    1. Fetch current model IDs — prefer `https://api.anthropic.com/v1/models` when `ANTHROPIC_API_KEY` is set, else fall back to `https://platform.claude.com/docs/en/about-claude/models/overview.md`
    2. Read `scripts/autopilot/config.ts`, locate the `OPUS` and `SONNET` constants
    3. If either is behind, edit in place. Never invent a `-latest` suffix (Anthropic doesn't ship one)
    4. Rubric guard: `rg 'claude-(opus|sonnet|haiku)-' scripts/ --glob '!**/__tests__/**'` — must match **only** `scripts/autopilot/config.ts`. Abort loudly if any other path matches (defends the "No hardcoded model strings" invariant). Tests legitimately pin literal IDs in config-parsing fixtures (`scripts/autopilot/__tests__/config.test.ts`), so they're excluded — the invariant is about *production* code.
    5. Run `pnpm test && pnpm check`; abort on failure before committing
    6. Stage only `scripts/autopilot/config.ts`, commit with a **Why:** line explaining model drift (no `-latest` alias)

- `.github/workflows/ci.yml` —
  ```yaml
  name: CI
  on:
    push:
      branches: [main]
    pull_request:
      branches: [main]
  concurrency:
    group: ci-${{ github.ref }}
    cancel-in-progress: true
  jobs:
    ci:
      runs-on: self-hosted
      steps:
        - uses: actions/checkout@<sha>  # vX.Y.Z  (reuse fathom's pinned SHA)
        - uses: pnpm/action-setup@<sha>
        - uses: actions/setup-node@<sha>
          with: { node-version: '24', cache: 'pnpm' }
        - run: pnpm install --frozen-lockfile
        - run: pnpm test
        - run: pnpm check
        - run: pnpm check:skills
        - run: pnpm check:roadmap
  ```
  SHAs for the three actions are copied from `../fathom/.github/workflows/ci.yml`. No new pins to research.

- `.github/workflows/renovate.yml` —
  ```yaml
  name: Renovate
  on:
    schedule:
      - cron: '0 6 * * 1'       # Monday 06:00 UTC
    workflow_dispatch:
  permissions:
    contents: write
    pull-requests: write
    issues: write
  jobs:
    renovate:
      runs-on: self-hosted
      steps:
        - uses: actions/checkout@<sha>
        - uses: renovatebot/github-action@<sha>  # pin latest release SHA at implement time
          with:
            configurationFile: renovate.json
            token: ${{ secrets.GITHUB_TOKEN }}
  ```
  If the default `GITHUB_TOKEN` can't open PRs on self-hosted (needs confirmation during implement), swap to `token: ${{ secrets.RENOVATE_TOKEN }}` and add a comment documenting the required PAT scope (`repo`, `workflow`). Do not commit a token.

- `renovate.json` —
  ```json
  {
    "$schema": "https://docs.renovatebot.com/renovate-schema.json",
    "extends": [
      "config:recommended",
      ":automergeMinor",
      ":automergePatch",
      ":dependencyDashboard"
    ],
    "packageRules": [
      { "matchUpdateTypes": ["major"], "dependencyDashboardApproval": true }
    ]
  }
  ```
  **No internal `schedule` key** — the workflow cron (Monday 06:00 UTC) is the only run trigger, and Renovate's `schedule` in config is "don't act outside this window" not "run at this time". Keeping both would be a race: a `"before 6am on monday"` filter combined with a 06:00 cron means Renovate would often wake up one minute too late and no-op silently. Let the workflow cron own the cadence.

### Modified

- `CLAUDE.md` (skill table around line 72): drop `/refit` row; insert `/bump-models` row — `Refresh Claude model IDs when Anthropic ships new Opus/Sonnet versions. Package deps are Renovate-managed.`
- `docs/roadmap-core.md`: strike through TOOL-16 line (~line 30) and append completed-summary with date `2026-04-18`
- `docs/task-index.md`: remove TOOL-16 row from open items; append `TOOL-16 ✓` to recently-completed
- `~/.claude/projects/-home-chris-workspace-claude-autopilot/memory/feedback_dependency_bumps.md`: update final sentence — replace `This is codified in .claude/skills/refit/SKILL.md.` with a note that deps are Renovate-managed (enforced via `renovate.json`'s `dependencyDashboardApproval` for majors + auto-merge for minor/patch); `/bump-models` is the manual flow *only* for Opus/Sonnet model IDs. Keep the preference description intact — it still applies to the model-ID bumps themselves.

### Deleted

- `.claude/skills/refit/SKILL.md` (and the empty `refit/` directory via `git rm -r`)

## Test strategy

- **Static checks before commit**:
    - `pnpm check:skills` — confirms `bump-models/SKILL.md` frontmatter is valid, directory matches `name:`, no dangling includes
    - `pnpm check` — biome-clean (only SKILL.md + yaml touched, so this is a no-op but confirms nothing leaked into `scripts/`)
    - `pnpm test` — regression check that nothing in the skill deletion path affected other skills' tests
    - `pnpm check:roadmap` — confirms task-index ↔ roadmap consistency after marking TOOL-16 done
- **YAML workflow validation**: run `actionlint` locally on both new workflows. If `actionlint` isn't installed, fall back to `npx @action-validator/cli` or minimal `yq` parse-check.
- **Rubric-guard end-to-end**: after writing the skill, manually run the `rg 'claude-(opus|sonnet|haiku)-' scripts/ --glob '!**/__tests__/**'` check to verify it produces exactly one match (`config.ts`). If it matches anything else outside `__tests__/`, either (a) that match is legit and the rubric-guard is wrong, or (b) the invariant is already broken — either way, address before committing.
- **Renovate workflow end-to-end** (the charter's explicit gate): after the ship commit lands on main, trigger `gh workflow run renovate.yml`, tail the run with `gh run watch`, and confirm one of:
    - A "Dependency Dashboard" issue opens, or
    - At least one Renovate PR opens for an existing outdated dep
    Either outcome = pass. A token-scope failure (HTTP 403 on issue create or PR open) = fail — swap to PAT with comment-documented scope and retry. Do not claim TOOL-16 done until this observation succeeds.
- **Dry-run CI**: push the branch (or run `act` if available) to exercise `ci.yml` on self-hosted before merging.

## Rubric self-check (in-context pass — skip Idioms)

- **Correct** — no pipeline invariants touched. `STEPS` / `MODEL_PROFILES` / `BUDGETS` / `TURN_LIMITS` / `EFFORT` untouched; phantom-ship-guard, worktree-isolation, plan-polish block, rate-limit parking all untouched. The "No hardcoded model strings" invariant is actively strengthened by the skill's `rg` guard. The skill has no `$ARGUMENTS`, so no `argument-hint` needed — `check-skills.ts` won't flag it. The skill doesn't participate in the SDK pipeline (inline-only maintenance), so frontmatter-stripping and worktree hooks don't apply.
- **Well-typed** — no TS changes. Model literals stay in `config.ts`; only the update *mechanism* (skill body) moves. The two `const OPUS`/`const SONNET` declarations at `scripts/autopilot/config.ts:43-44` are the exact edit targets.
- **Well-factored** — the split is itself the factoring improvement: the old refit mixed two concerns with different frequencies, risk profiles, and automation affinities. Skill body shrinks 86 → ~25 lines.
- **Well-tested** — covered above. No new TS means no new unit tests; the manual `workflow_dispatch` run is the load-bearing verification.
- **Concise** — new files are small (skill ~25 lines, ci.yml ~20 lines, renovate.yml ~20 lines, renovate.json ~15 lines). No abstractions introduced.

### Revisions made during self-review

1. **Added the rubric guard step** — initially omitted from approach; spec explicitly requires it, and it defends the "No hardcoded model strings" invariant proactively.
2. **Added explicit `permissions:` block on renovate.yml** — default `GITHUB_TOKEN` permissions vary by repo setting; being explicit about `contents/pull-requests/issues: write` avoids a mystery 403 during the verification run.
3. **Added `pnpm check:skills` and `pnpm check:roadmap` to CI** — both already exist as npm scripts in `package.json:22-23`; gating merges on them costs ~1s and catches SKILL.md frontmatter drift before it reaches main.
4. **Clarified action SHA-pinning convention** — fathom already pins `actions/checkout`, `pnpm/action-setup`, `actions/setup-node` to SHAs with version comments; reuse those exact pins instead of researching fresh ones (supply-chain consistency across the two repos matters more than using the absolute newest versions).
5. **Kept the `feedback_dependency_bumps.md` body intact** — first draft proposed rewriting it wholesale. On reflection, the staged-commit preference still applies to `/bump-models` itself (OPUS + SONNET can still be bumped in one commit or two), and Renovate's defaults enforce the same split for deps. A one-line addendum preserves both signals.
6. **Clarified the `workflow_dispatch` pass criteria** — either a dashboard issue *or* a PR counts as pass; a 403 on token scope is a fail that blocks ship, not a deferred follow-up.

### Revisions made during shakedown plan-review

1. **Rubric-guard pattern narrowed with `--glob '!**/__tests__/**'`** — first draft expected a single match in `config.ts`, but `scripts/autopilot/__tests__/config.test.ts` legitimately pins `claude-haiku-4-5-20251001` literals in config-parser fixtures. Without the exclusion the skill would abort on every run. The invariant is "no hardcoded model strings in production code," not "none anywhere."
2. **Dropped `schedule` from `renovate.json`** — the internal `schedule` is an allow-window, not a trigger; combining `"before 6am on monday"` with a 06:00 UTC cron is a race (Renovate wakes up moments after the window closes and no-ops silently). The workflow cron is the sole run trigger; let it own the cadence.
