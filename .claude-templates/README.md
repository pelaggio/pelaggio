# Pelaggio Consumer Templates

The files `pelaggio init` copies into a consumer repo, plus an optional scaffold-doc set
for bootstrapping a project onto the same propose-then-confirm, rubric-driven workflow.

## What `init` installs

| File | Lands in your repo at | Purpose |
|---|---|---|
| `_rubric.md` | `.claude/skills/_rubric.md` | The quality bar `/shakedown` and every review pass read. **Author this before your first cycle** — it is the single highest-leverage setup task |
| `docs/task-index.md` | `docs/task-index.md` | Cross-roadmap item index for `/pick` |
| `docs/roadmap-example.md` | `docs/roadmap-{track}.md` | The roadmap format Pelaggio's parser expects (checkbox + table) |
| `.pelaggio.example.yml` | `.pelaggio.yml` | Configuration stub — uncomment only the overrides you need |

## Optional scaffold docs

The remaining files (`CLAUDE.md`, `docs/philosophy.md`, `docs/architecture.md`,
`docs/conventions-ui.md`, `docs/tone.md`, `docs/build.md`, `docs/decisions.md`,
`docs/decision-log/README.md`, `migration-checklist.md`) are **shape references**: they
show what a well-scaffolded repo gives its agents, with `{{PLACEHOLDER}}` markers for the
parts you must supply. Their concrete examples come from a mobile-app project and will not
match your stack — copy the structure, rewrite the content wholesale.

## Workflow opinions these templates encode

- **Propose-then-confirm** for any automation touching meaningful state.
- **Confidence-gated automation**: high = auto-act, mid = propose, low = flag.
- **Rubric-driven review** across six dimensions (well-typed, well-tested, well-factored,
  idiomatic, correct, concise).
- **Documented deviations**: if you disagree with an opinion, say so in
  `docs/decisions.md` on day one and rewrite the affected rubric section. Opinionated
  scaffolding only works when deviations are written down.

## What's NOT here

Things too project-specific to template, hand-authored in your first week:

- **Domain model** — your schema, your aggregates, your invariants.
- **Rubric bullets under "Correct"** — the project-specific correctness invariants.
- **Roadmap content** — your actual tracks and items.
- **Domain deep-dive docs** — whatever your project's equivalent of a reconciliation or
  pricing engine writeup is.
