# Project Scaffold Templates

Opinionated starting point for new Expo/TypeScript projects, extracted from Fathom. Pairs with the `.claude/skills/` + `scripts/autopilot/` stack to give a new project the same propose-then-confirm + rubric-driven workflow on day one.

## What's in here

| File | Goes in new project at | Purpose |
|---|---|---|
| `migration-checklist.md` | *(reference only)* | The per-project playbook — follow it in order |
| `CLAUDE.md` | `CLAUDE.md` (repo root) | Claude's orientation primer for this repo |
| `_rubric.md` | `.claude/skills/_rubric.md` | Six-dimension quality bar that `/shakedown` reads |
| `docs/philosophy.md` | `docs/philosophy.md` | Why this project exists and what it optimizes for |
| `docs/architecture.md` | `docs/architecture.md` | C4 structure, data flows, invariants |
| `docs/conventions-ui.md` | `docs/conventions-ui.md` | Expo/RN component + styling conventions |
| `docs/tone.md` | `docs/tone.md` | Voice for agent/app copy/error messages |
| `docs/build.md` | `docs/build.md` | EAS + local build commands |
| `docs/task-index.md` | `docs/task-index.md` | Cross-roadmap item index for autopilot `/pick` |
| `docs/roadmap-example.md` | `docs/roadmap-{track}.md` | Roadmap format autopilot's parser expects (checkbox + table) |
| `docs/decisions.md` | `docs/decisions.md` | Open + resolved architectural decisions |

## How to use

1. Clone the source project (the one with `.claude/skills/` + `scripts/autopilot/` + these templates)
2. Follow `migration-checklist.md` end to end — it tells you what to copy, what to rewrite, and in what order
3. **Write `_rubric.md` before writing any code.** This is the single highest-leverage task in bootstrapping a new project
4. First commit should land the scaffold docs + rubric + CLAUDE.md together so Claude has context from turn one

## Philosophy

These templates are **opinionated, not abstract.** They reflect a specific take on:

- Local-first where possible; cloud is a choice, never a requirement
- Propose-then-confirm for any automation touching meaningful state
- Confidence-gated automation: high = auto-act, mid = propose, low = flag
- Raw data preservation alongside normalized/enriched versions
- Expo + TypeScript + pnpm + Biome + Jest as the baseline stack
- Bilingual i18n from day one (or document explicitly why not)
- Six-dimension review rubric (well-typed, well-tested, well-factored, idiomatic, correct, concise)

If you disagree with any of these for your project, **say so in `docs/decisions.md` on day one** and rewrite the affected section of the rubric. Don't silently deviate — opinionated scaffolding only works when deviations are documented.

## What's NOT in here

Things that are too project-specific to template and must be hand-authored:

- **Domain model** — your schema, your aggregates, your invariants
- **Rubric bullets under "Correct"** — the project-specific correctness invariants
- **Roadmap content** — your actual tracks and items
- **Any domain deep-dive docs** — e.g., `docs/reconciliation.md` in Fathom

These are what the first week of a new project is *for*. Templates can't predict them.
