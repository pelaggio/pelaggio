# `.autopilot.yml` — configuration schema

Place an `.autopilot.yml` at the repo root to override pipeline defaults. All
keys are optional — omit anything you don't want to change and the default
applies. If the file is absent or empty, behavior is identical to today.

The file is read once at startup by `loadConfig()` in
`packages/autopilot/scripts/autopilot/config.ts`. Parse errors fail loudly with the file path in
the message — delete the file to fall back to defaults.

## Precedence

For the worktree prefix (the one key with an env-var escape hatch):

```
CLAUDE_AUTOPILOT_WORKTREE_PREFIX  >  worktree.prefix (yml)  >  basename(REPO) + "-"
```

All other values use: `yml value` > default.

`budgets`, `turn-limits`, and `effort` also support a per-profile layer that
overrides the global step value for one profile only (see
[Per-profile step overrides](#per-profile-step-overrides)):

```
models.profiles.<name>.<section>.<step>  >  <section>.<step> (global yml)  >  default
```

## Annotated example

```yaml
# .autopilot.yml — every key is optional

worktree:
  prefix: "myproj-"            # default: `${basename(REPO)}-`

ship:
  target: direct-push           # default: direct-push
                                # values: direct-push | pull-request | auto-merge-pr

roadmap:
  source: markdown              # default: markdown
                                # values: markdown | github-issues | linear
  # github:                     # only consulted when source is github-issues
  #   repo: acme/widgets        # required when source=github-issues (owner/repo)
  #   label: autopilot          # default: autopilot
  #   plan-location: issue-comment  # default: issue-comment | pr-description
  # linear:                     # only consulted when source is linear
  #   team: <team-uuid>         # required when source=linear (Linear team UUID)
  #   label: autopilot          # default: "" (no label filter)
  #   plan-location: issue-comment  # default: issue-comment (pr-description reserved)

budgets:                        # dollars per step (safety-net caps)
  pick: 2
  plan: 8
  shakedown-plan: 5
  implement: 25
  shakedown-code: 25
  ship: 3
  shipwreck: 3

turn-limits:                    # SDK turn cap per step
  pick: 30
  plan: 80
  shakedown-plan: 60
  implement: 200
  shakedown-code: 150
  ship: 60
  shipwreck: 40

effort:                         # "low" | "medium" | "high" | "xhigh" | "max"
  pick: medium                  # xhigh needs Opus 4.7/4.8 or Sonnet 5; falls back to high on models without it.
  plan: xhigh                   # Opus 4.8 defaults to `high` when effort is omitted; max needs Opus 4.6/4.7/4.8 or Sonnet 5.
  shakedown-plan: xhigh
  implement: xhigh
  shakedown-code: xhigh
  ship: medium
  shipwreck: medium

models:
  profiles:
    standard:
      pick: claude-sonnet-5
      plan: claude-opus-4-8
      shakedown-plan: claude-opus-4-8
      implement: claude-opus-4-8
      shakedown-code: claude-opus-4-8
      ship: claude-opus-4-8
      shipwreck: claude-sonnet-5
    quick:
      pick: claude-sonnet-5
      plan: claude-sonnet-5
      shakedown-plan: claude-sonnet-5
      implement: claude-sonnet-5
      shakedown-code: claude-sonnet-5
      ship: claude-sonnet-5
      shipwreck: claude-sonnet-5
    # Additional named profiles (e.g. `thrifty`) can be added here.
    # A profile may also carry its own budgets / effort / turn-limits, which
    # override the global step values above for that profile only (sparse —
    # list only the steps you want to bump):
    # deep:
    #   plan: claude-opus-4-8
    #   budgets:
    #     plan: 16                # this profile's plan cap; other steps stay global
    #   effort:
    #     plan: max
    #   turn-limits:
    #     plan: 120
```

## Merge semantics

- Partial overrides are allowed. `budgets: { implement: 40 }` sets that one
  step and leaves every other step at its default. The same applies inside
  `turn-limits`, `effort`, and each profile under `models.profiles`.
- Adding a new profile (e.g. `thrifty`) leaves `standard` and `quick`
  untouched. Within a new profile, any step you omit inherits the slot from
  whatever was already defined under that profile name in defaults (for a
  brand-new profile, omitted steps stay unset — be explicit).
- Section keys use kebab-case (`turn-limits`), matching YAML convention. Step
  names (`pick`, `plan`, `shakedown-plan`, etc.) are literal keys whose
  internal hyphens are part of the step identifier.

## Per-profile step overrides

The top-level `budgets`, `turn-limits`, and `effort` blocks set values that
apply to *every* profile. A profile that swaps a step onto a differently-priced
or differently-tuned model often needs matching cost/effort headroom — so each
`models.profiles.<name>` may also carry its own `budgets:`, `effort:`, and
`turn-limits:` sub-blocks:

```yaml
models:
  profiles:
    deep:
      plan: claude-opus-4-8       # step → model, as usual
      budgets:
        plan: 16                  # raise just this profile's plan budget
      effort:
        plan: max
      turn-limits:
        plan: 120
```

- **Sparse.** A per-profile block lists only the steps it changes. Any step you
  omit falls through to the global value for that section, then to the default.
  Precedence per step:
  `models.profiles.<name>.<section>.<step>` > `<section>.<step>` (global) > default.
- **Isolated.** An override on `deep` never affects `standard`, `quick`, or any
  other profile — and never affects `deep`'s *other* steps.
- **Same value rules as the global blocks.** `budgets`/`turn-limits` take
  numbers; `effort` takes one of `low | medium | high | xhigh | max`. A wrong
  type or a non-map block fails loudly at startup with the file path and the
  dotted key (e.g. `models.profiles.deep.budgets.plan`).
- **Unknown steps ignored.** A non-step key inside an override block (e.g.
  `budgets.bogus`) is silently dropped, same as the global sections.
- The built-in `standard` and `quick` profiles carry no override blocks, so out
  of the box every profile resolves to the global/default step values.

## Ship target

`ship.target` selects how `/ship` lands the branch. Three modes:

| Value            | Behavior                                                         |
|------------------|------------------------------------------------------------------|
| `direct-push`    | Squash, merge into local `main`, push, update docs, clean up.    |
| `pull-request`   | Squash, push branch, `gh pr create`. Stop. No docs, no merge.    |
| `auto-merge-pr`  | As `pull-request` + `gh pr merge --auto --squash`.               |

Default: `direct-push`. Precedence: `--target` CLI flag > `ship.target` yml > default.
Invalid values fail fast at startup with the list of valid names.

**`direct-push` splits the work at the merge.** In pipeline runs the `ship`
step's job ends once the branch is squashed, merged into local `main`, and
post-merge verification passes — it then stops (`ship-merged: <ID>`). Everything
past the merge — recovering any stray `MAIN_REPO` changes as a commit (never
discarded), mark-done, archive-plan, the single `git push`, and worktree/branch
cleanup — is run by the **pipeline itself** as deterministic, zero-turn,
idempotent code (`ship/bookkeeping.ts`), not by the budget-capped agent. This
guarantees bookkeeping can't be dropped when the ship step runs out of turns
after merging, and can't destroy a sibling cycle's uncommitted work. The tail
runs only on a **verified** merge (the ship step reported success, i.e. it
completed post-merge verification): a merge that lands but is unverified (the
step ran out of turns) or fails post-merge verification routes to `/shipwreck`
instead of a blind push. The tail's destructive steps (worktree/branch removal)
are gated on mark-done + archive + push all succeeding — a real mark-done/archive
error, a push failure, or a `git pull` conflict leaves the branch intact
(recoverable on local `main`) and reports the cycle incomplete rather than
shipped. Inline (human-typed) `/ship` still runs the full flow itself.

In PR modes the worktree, local branch, and post-merge doc updates
(task-index, roadmap "Recently completed", plan archive) are intentionally
**not** touched in-session — those land after the PR merges externally.
Automating the post-merge side is planned for TOOL-10 / TOOL-15.

## Roadmap source

`roadmap.source` selects the backend that drives `/pick`, plan lookup, and
scope heuristics. Invalid values fail loudly at startup.

| Value           | Status | Reads                                              |
|-----------------|--------|----------------------------------------------------|
| `markdown`      | ready  | `docs/roadmap-*.md` + `docs/task-index.md`         |
| `github-issues` | ready  | GitHub Issues via the `gh` CLI                     |
| `linear`        | ready  | Linear via `@linear/sdk`                           |

Skill bodies (`/pick`, `/plan`, `/ship`, `/charter`, `/status`, `/pickup`,
`/shakedown`, `/tidy`) are adapter-agnostic — all roadmap access flows through
`npx claude-autopilot roadmap ...`, which dispatches to the configured source.

### `github-issues`

### `roadmap.github.*`

Consumed only when `roadmap.source` is `github-issues`:

| Key                           | Default          | Meaning                                                                 |
|-------------------------------|------------------|-------------------------------------------------------------------------|
| `roadmap.github.repo`         | *(required)*     | `owner/name` passed to `gh --repo`. Missing value fails at startup.     |
| `roadmap.github.label`        | `autopilot`      | Label used to filter open issues for `listOpenItems`.                   |
| `roadmap.github.plan-location`| `issue-comment`  | Where plan bodies live. `pr-description` is reserved; not implemented.  |

`gh` availability is probed lazily on first adapter call. If `gh` is not
installed or not authenticated, the adapter throws a clear diagnostic
(`gh CLI required — install https://cli.github.com/` or `gh CLI not
authenticated — run 'gh auth login'`). No config-time probe — tests and
dry-runs can construct the adapter with a stub runner without `gh` on
`PATH`.

Item IDs are bare issue numbers (`"42"`). Branches follow
`feat/issue-<n>[-slug]` where `slug` is a kebab-cased, 40-char-capped
derivation of the issue title. Worktrees follow the same
`${WORKTREE_PREFIX}${id}` convention as the markdown adapter so `--resume`
lookups work identically.

Plan bodies are resolved in two stages: first a local-disk lookup mirroring
the markdown adapter (`docs/plans/issue-<n>-*.md`, then `.dev/plans/<n>.md`),
then the most recent issue comment whose body begins with the
`<!-- autopilot-plan -->` marker. Comment-sourced plans are materialized to
`.dev/plans/<n>.md` (scratch, typically `.gitignore`'d), **not**
`docs/plans/` — that directory remains `/plan`'s canonical committed output.

### `linear`

### `roadmap.linear.*`

Consumed only when `roadmap.source` is `linear`:

| Key                            | Default          | Meaning                                                                 |
|--------------------------------|------------------|-------------------------------------------------------------------------|
| `roadmap.linear.team`          | *(required)*     | Linear team UUID. Missing value fails at startup.                       |
| `roadmap.linear.label`         | `""`             | Label filter for `listOpenItems`. Empty string = no filter.             |
| `roadmap.linear.plan-location` | `issue-comment`  | Where plan bodies live. `pr-description` is reserved; not implemented.  |

`LINEAR_API_KEY` is read from the environment on first adapter call. Missing
or unauthorized keys surface a clear diagnostic — never logged, never stored
in config. Linear API keys are scoped to a single workspace, so there is no
`workspace-id` field.

Item IDs are Linear issue identifiers (`ENG-42`). Branches follow
`feat/<team>-<n>[-slug]` lower-cased (e.g. `feat/eng-42-fix-thing`).
Worktrees follow the same `${WORKTREE_PREFIX}${id.toLowerCase()}` convention
as the markdown and github adapters so `--resume ENG-42` lookups work
identically (dashes in directory names are filesystem-safe on every target
OS).

Plan bodies resolve in two stages: a local-disk lookup
(`docs/plans/<team>-<n>-*.md`, then `.dev/plans/<team>-<n>.md`) followed by
the most recent issue comment whose body begins with
`<!-- autopilot-plan -->`. Comment-sourced plans materialize to
`.dev/plans/<team>-<n>.md` in the worktree — **not** `docs/plans/`, which
remains `/plan`'s canonical committed output.

## Unknown keys

Top-level keys not recognized by the current loader (`project`, `docs`,
`roadmap`, …) are silently ignored. This keeps forward-compatibility as
future tools extend the schema. Unknown step keys inside a recognized
section (e.g. `budgets.bogus: 5`) are also ignored.

## Claim ledger (`.dev/` artifact)

Parallel `/pick` cycles serialize through an ephemeral, gitignored claim ledger
at `${MAIN_REPO}/.dev/autopilot-claims.json`, guarded by a sibling
`${MAIN_REPO}/.dev/autopilot-claims.lock` directory-mutex. It is **not** an
`.autopilot.yml` key — it has no tunables (lock TTL / retry are module
constants) and is created on demand. `.dev/` is already gitignored, so both
files inherit that. The durable roadmap source stays the source of record; the
ledger only prevents two cycles from claiming the same item and lets `list`/`get`
overlay `in-progress` onto open items a live cycle already holds.

Two environment variables affect it:

| Variable                     | Purpose                                                                                          |
|------------------------------|-------------------------------------------------------------------------------------------------|
| `AUTOPILOT_OWNER_PID`        | Set by `orchestrate()` so the `npx roadmap claim` subprocess records the long-lived orchestrator pid. Liveness of this pid is how stale (crashed) claims are reaped. Falls back to `process.ppid`. |
| `CLAUDE_AUTOPILOT_MAIN_REPO` | Test / escape-hatch override for the MAIN_REPO root that hosts the ledger (normally resolved via `git rev-parse --git-common-dir`, so worktrees share one ledger). |

## Not configurable (yet)

- `REPO` / `LOG_PATH` — derived from the module location.
- Runtime reload — load-once at startup.
- Schema validation beyond shape checks — add `zod` if/when warranted.
- Secret handling — store secrets in the environment, not here.
