# `.autopilot.yml` — configuration schema

Place an `.autopilot.yml` at the repo root to override pipeline defaults. All
keys are optional — omit anything you don't want to change and the default
applies. If the file is absent or empty, behavior is identical to today.

The file is read once at startup by `loadConfig()` in
`scripts/autopilot/config.ts`. Parse errors fail loudly with the file path in
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

## Unknown keys

Top-level keys not recognized by the current loader (`project`, `docs`,
`roadmap`, `ship`, …) are silently ignored. This keeps forward-compatibility
as future tools extend the schema. Unknown step keys inside a recognized
section (e.g. `budgets.bogus: 5`) are also ignored.

## Not configurable (yet)

- `REPO` / `LOG_PATH` — derived from the module location.
- Runtime reload — load-once at startup.
- Schema validation beyond shape checks — add `zod` if/when warranted.
- Secret handling — store secrets in the environment, not here.
