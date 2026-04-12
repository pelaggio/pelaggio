# Task Index

Compact reference for task selection. For full specs, see the linked roadmap section.

**Roadmaps**: [{{track-1}}](roadmap-{{track-1}}.md) · [{{track-2}}](roadmap-{{track-2}}.md)

Deps column shows only **unsatisfied** dependencies. `—` means ready to pick. `blocked: X` means waiting on an external factor. Completed deps are tracked in the "Recently completed" section below.

## Open items

| ID | Title | Deps | Plan | Roadmap |
|----|-------|------|------|---------|
| {{ID-1}} | {{Short title}} | — | — | {{track}} |
| {{ID-2}} | {{Short title}} | {{ID-1}} | — | {{track}} |

## Recently completed

- {{ID-0}} ✓

---

*This file is the canonical pick list for `/pick`. Every item in any `roadmap-*.md` file should have a row here while it's open, and migrate to "Recently completed" when shipped.*

*Order rows alphabetically by prefix, then numerically within prefix (e.g., A11Y-1, A11Y-2, COMP-5, COMP-10). This makes `/pick` output deterministic.*
