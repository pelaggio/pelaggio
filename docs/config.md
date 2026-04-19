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
  ship: 40
  shipwreck: 40

effort:                         # "low" | "medium" | "high"
  pick: medium
  plan: high
  shakedown-plan: high
  implement: high
  shakedown-code: high
  ship: medium
  shipwreck: medium

models:
  profiles:
    standard:
      pick: claude-sonnet-4-6
      plan: claude-opus-4-7
      shakedown-plan: claude-opus-4-7
      implement: claude-opus-4-7
      shakedown-code: claude-opus-4-7
      ship: claude-sonnet-4-6
      shipwreck: claude-sonnet-4-6
    quick:
      pick: claude-sonnet-4-6
      plan: claude-sonnet-4-6
      shakedown-plan: claude-sonnet-4-6
      implement: claude-sonnet-4-6
      shakedown-code: claude-sonnet-4-6
      ship: claude-sonnet-4-6
      shipwreck: claude-sonnet-4-6
    # Additional named profiles (e.g. `thrifty`) can be added here.
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

## Ship target

`ship.target` selects how `/ship` lands the branch. Three modes:

| Value            | Behavior                                                         |
|------------------|------------------------------------------------------------------|
| `direct-push`    | Squash, merge into local `main`, push, update docs, clean up.    |
| `pull-request`   | Squash, push branch, `gh pr create`. Stop. No docs, no merge.    |
| `auto-merge-pr`  | As `pull-request` + `gh pr merge --auto --squash`.               |

Default: `direct-push`. Precedence: `--target` CLI flag > `ship.target` yml > default.
Invalid values fail fast at startup with the list of valid names.

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

## Not configurable (yet)

- `REPO` / `LOG_PATH` — derived from the module location.
- Runtime reload — load-once at startup.
- Schema validation beyond shape checks — add `zod` if/when warranted.
- Secret handling — store secrets in the environment, not here.
