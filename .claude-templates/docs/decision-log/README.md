# Decision log (operational authority)

Pelaggio records operational decisions and review-escalation rows as **per-item
authority files** in this directory:

```text
docs/decision-log/<owner>.md
docs/decision-log/archive/<owner>.md   # after archive-resolved
```

- **Owner** is the item ID for claimed work, or `run-<runId>` for unclaimed
  emissions (sweeps, pick-without-item).
- Each file is the single writer for that owner on the feature branch — concurrent
  items do not conflict on a shared append-only table.
- Lifecycle: `npx pelaggio decisions resolve …`, `archive-resolved`, and (cold
  path) `migrate` / `rebuild-index`.
- The generated index at `docs/decisions.md` is a projection only; do not treat it
  as authority and do not hand-edit it for pelaggio operational rows.

This directory is **not** the product “open architectural decisions” scratchpad.
That consumer-facing template remains `docs/decisions.md` in greenfield bootstraps
(open questions, stack choices). Settled architecture ADRs live under
`docs/decisions/` when the project uses them.
