# 02 · Speakers

There is **no single "Joe voice."** Every authored or generated string has one
identified speaker. The governing rule:

> **The closer a string is to a machine-verifiable event, the less it should
> sound like Joe.** One speaker per block.

## The speakers

### Pelaggio System
The authoritative operational speaker. Speaks for pipeline state, configured scope,
permissions, budgets, elapsed time, counts, timestamps, file/branch boundaries,
verification outcomes, shipping policy, system errors, recoverability. Direct,
literal, minimally characterized.

### Active harness
The coding environment Pelaggio is driving (Claude Code, Codex). Speaks for
generated plans, implementation explanations, proposed technical choices, questions
from repo analysis, model uncertainty, summaries of its own work. **Harness
identity stays visible where attribution affects trust.** Do not rewrite harness
output as Joe dialogue.

### Review process
The independent review. Speaks for plan/code verdicts, findings, requested
revisions, blocking concerns, deferred work. Review results stay **distinguishable**
from implementation claims and from Joe's recommendations.

### Joe
Speaks for first-run orientation, empty states, supervision transitions,
consequential handoffs, recovery framing, session-level interpretation, the
occasional grounded recommendation, and brand storytelling. **Joe does not
automatically speak for every status event.**

### User & source content
User- and externally-authored content stays visibly distinct: roadmap items, issue
titles, commit messages, PR descriptions, test/compiler/log output, filenames,
copied agent text, third-party errors. Voice linting must **not** treat quoted or
source-authored content as Pelaggio's own.

## Joe presence levels

- **Level 0 — System only.** No Joe sentence, no required marker. Logs, config,
  evidence views, tables, routine status, raw errors. *This is the default.*
- **Level 1 — Visual marker.** Joe present but silent (supervision mode, attention
  required, offshore in progress, handoff available).
- **Level 2 — Speaking guide.** A short authored intervention: orientation, work
  moving offshore or returning onshore, control points, recovery, a useful
  post-session interpretation. Level 2 should be comparatively rare.

## Composite messages

A payload may carry blocks from multiple speakers, but **each block has exactly one
speaker** and the rendering layer keeps them visually distinct. A generation prompt
for one block must not receive another block's speaker definition — that is what
keeps personality from contaminating verified facts. Store proposed copy under
`corpus/proposed/<speaker>/` so speaker identity is a path property and lint scope
is deterministic.
