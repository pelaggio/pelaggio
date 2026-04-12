# Open Decisions

Unresolved questions that will affect implementation. Resolve before building the relevant feature.

Format: strikethrough the row when resolved, add the resolution inline. Never delete resolved decisions — they're valuable context for future contributors who wonder why things are the way they are.

## Open

| Decision | Options | Urgency | Notes |
|----------|---------|---------|-------|
| **{{DECISION 1}}** | {{Option A}} vs. {{Option B}} vs. {{Option C}} | High / Medium / Low | {{Context, tradeoffs, what to consider}} |

## Resolved

| Decision | Options | Urgency | Notes |
|----------|---------|---------|-------|
| ~~**{{Example resolved decision}}**~~ | ~~{{Option A}} vs. {{Option B}}~~ | ~~High~~ | **Resolved**: {{Chosen option and rationale}}. See [{{linked doc}}]({{link}}). |

---

## What belongs here

- **Stack choices** that aren't trivial — ORM, auth library, build system, deployment target
- **Architecture questions** — sync model, offline support, multi-tenancy, data residency
- **Product scope** — features considered but not yet committed
- **External dependencies** — which aggregator, which payment provider, which LLM provider

## What does NOT belong here

- Implementation details ("should this function take X or Y parameter?") — those go in a code comment or PR
- Bugs — those go in a bug tracker or roadmap
- Typos and cleanup — just fix them
- Anything you can decide in 5 minutes of reading — just decide

## Format rules

- **Urgency**: High = blocks a current feature, Medium = blocks something soon, Low = long-horizon
- **Options**: list 2-4 real alternatives, not a vague "figure this out"
- **Notes**: one line of context per decision, link to deeper doc if needed
- **Resolution**: when closing a decision, write the chosen option + one-sentence rationale + a link if there's a deeper doc explaining it

Keep this file short — if it gets over ~30 rows, something's wrong (decisions aren't being resolved fast enough, or non-decisions are leaking in).
