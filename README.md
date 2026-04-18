# claude-autopilot

Headless pipeline for running [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) cycles on roadmap items. Solo developer's answer to "I have a list of work to do and I'd like Claude to burn through it while I do something else."

## What it does

Given a roadmap of work items, runs a fixed pipeline per item:

```
pick → plan → shakedown-plan → implement → shakedown-code → ship
```

- **pick** — select next available item, create a feature branch + worktree
- **plan** — generate implementation plan, write to `docs/plans/`, self-review, commit
- **shakedown-plan** — independent review of the plan against the project rubric, return APPROVE / REVISE / RETHINK verdict
- **implement** — execute the plan incrementally, committing as it goes
- **shakedown-code** — review the diff against the rubric, fix issues, run verification (typecheck / lint / tests), add deferred items to roadmap
- **ship** — squash, merge to main, update docs, push, clean up worktree

Each step runs in its own Claude Agent SDK session (fresh context, configurable model, explicit budget + turn limit). Rate-limit rejection triggers a `wip:` checkpoint commit and parks the cycle for resume.

## Who it's for

Solo developers who:

- Run Claude Code / Claude Agent SDK locally (not in CI)
- Want a fixed pipeline, not an open-ended agent
- Care about their own rubric, not a generic quality heuristic
- Need cost visibility and explicit budgets per step
- Want parallel worktree execution across unrelated items

Not for: teams running shared PR bots, cloud-native flows, IDE-integrated pair programming, or people who want a product-ready tool. This is personal infrastructure.

## What's in here

```
.claude/skills/           # the pipeline steps, each a markdown skill file
  charter/                # /charter — add new work item
  pick/                   # /pick — claim next item
  plan/                   # /plan — write implementation plan
  shakedown/              # /shakedown — review + fix (plan or code)
  ship/                   # /ship — merge + update docs + clean up
  shipwreck/              # /shipwreck — recovery when /ship fails
  pickup/                 # /pickup — rebuild context on resume
  status/                 # /status — where am I
  tidy/                   # /tidy — clean up stale worktrees
  _rubric.md              # this repo's own working rubric
  _review-logic.md        # shared review dispatch + stopping rule

scripts/autopilot/        # TypeScript pipeline orchestrator
  main.ts                 # CLI entry — parses flags, calls orchestrate()
  pipeline.ts             # runPipeline() per-item + orchestrate() for parallel workers
  step-runner.ts          # runs one step via claude-agent-sdk query()
  helpers.ts              # pure helpers — git, fs, parsing
  config.ts               # BUDGETS, TURN_LIMITS, EFFORT, MODEL_PROFILES, STEPS
  types.ts                # Step union, CycleResult, Flags, StepEvent
  tui.ts                  # live status bar + event rendering
  __tests__/              # unit tests via node:test

.claude-templates/        # templates for bootstrapping NEW projects
  README.md               # what's here and how to use it
  migration-checklist.md  # per-project playbook
  CLAUDE.md               # orientation primer template
  _rubric.md              # template rubric (six dimensions, guided blank)
  docs/
    philosophy.md         # the "why" template
    architecture.md       # C4 skeleton
    conventions-ui.md     # Expo-opinionated UI conventions
    tone.md               # voice + copy rules template
    build.md              # EAS + local build setup
    task-index.md         # empty task index
    roadmap-example.md    # roadmap format (checkbox + table)
    roadmap-phase1-core.md # opinionated Phase-1 Expo starter roadmap
    decisions.md          # ADR-style decision log template
```

## Using it in a new project

See `.claude-templates/migration-checklist.md` for the step-by-step bootstrap. TL;DR:

1. Clone this repo's `.claude/skills/` + `scripts/autopilot/` + `.claude-templates/` into your new project
2. Sanitize: find-replace project name, worktree prefix, verification commands
3. **Write `.claude/skills/_rubric.md` for your project before writing any code** — this is the highest-leverage task
4. Fill in `CLAUDE.md` + `docs/philosophy.md` + the starter roadmap items
5. Run `pnpm autopilot --cycles 1 --verbose`

## Stats dashboard

`pnpm autopilot stats` streams `.dev/autopilot-log.jsonl` and prints an aggregate dashboard — token totals, cost per step, cache-hit ratio, retry and rethink rates, and a list of recent items. Example:

```
autopilot stats                                             14 cycles  $12.34

Cost & tokens
  Cycles       14    completed 10  failed 2  parked 1  shipwrecked 1
  Spend        $12.34
  Tokens       in 1.2M  out 180K  cache-write 340K  cache-read 2.1M
  Cache-hit    63.6%

  By step         cost      in    out   cache-rd   hit%
    pick        $0.12     22K   800K        45K   65.0%
    plan        $2.30    180K    25K       320K   64.0%
    ...

Quality
  Retry rate (turn-exhaustion)
    implement        0.28 per cycle
    shakedown-code   0.14 per cycle
  Rethink rate (plan review)
    shakedown-plan   14.3%
  Avg shakedown iterations  1.18

Recent items (last 10)
  2026-04-17  TOOL-12     $1.10  128K tok  0 rethinks  ✓
  2026-04-15  TOOL-6      $0.82   92K tok  0 rethinks  ✓
  ...
```

No separate state file — the reducer runs over the append-only log on each invocation. Legacy log lines (no token fields) are tolerated; their step tokens count as zero.

## Using it on itself (meta)

This repo uses its own pipeline to work on its own roadmap. See `docs/roadmap-core.md` for open items. Run `pnpm autopilot --cycles 1` to pick one up.

## Status

Provenance: extracted from [Fathom](https://github.com/cdhorne/fathom) at commit `c243744` on 2026-04-11. History pre-extraction lives in Fathom's git log under `.claude/skills/` and `scripts/autopilot/` paths.

Not published to npm. Not a library. Personal infrastructure you're welcome to fork.
