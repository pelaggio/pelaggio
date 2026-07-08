# {{TRACK NAME}} Roadmap

{{ONE-PARAGRAPH SUMMARY OF WHAT THIS TRACK COVERS}}

**Related:** [task-index.md](task-index.md) · [other-roadmap.md](other-roadmap.md)

> **Sequencing:** {{NOTES ON WHICH ITEMS BLOCK WHICH}}

## Progress

**Open items** (see `docs/task-index.md` for canonical pick list):

| Item | Depends on |
|------|-----------|
| {{PFX-1}}. {{Title}} | — |
| {{PFX-2}}. {{Title}} | {{PFX-1}} |
| {{PFX-3}}. {{Title}} | — |

**Completed:** {{list of completed IDs}}. See git history for implementation details.

## Dependency Graph

*Optional — draw one for tracks with non-trivial dependencies.*

```
{{PFX-1}} ──┬──► {{PFX-2}}
            └──► {{PFX-4}}

{{PFX-3}} (standalone)
```

---

## Items

*Both format styles below are parsed by `/pick` and `/ship`. Pick one and stick with it per roadmap file.*

---

### Format A — Checkbox list (simpler tracks)

- [ ] **{{PFX-1}}. {{One-line title}}** — {{Short scope sentence.}} *(scope: S)*
- [ ] **{{PFX-2}}. {{Title}}** — {{Scope}} *(scope: M, depends on {{PFX-1}})*
- [x] **{{PFX-0}}. {{Completed title}}** — Completed. *(2026-04-11)*

---

### Format B — Table (richer tracks with more metadata)

### {{PFX-1}}. {{Full title here}}

| What | Scope | Deps |
|------|-------|------|
| {{Short description of what this item delivers}} | M | — |

**Deliverables:**
- {{Concrete deliverable 1}}
- {{Concrete deliverable 2}}
- Tests: {{what coverage is required}}
- i18n: {{keys added, which namespaces}}

**Out of scope:**
- {{Things this item explicitly does NOT do}}

---

### {{PFX-2}}. {{Full title}}

| What | Scope | Deps |
|------|-------|------|
| {{Description}} | L | {{PFX-1}} |

**Deliverables:**
- {{...}}

---

### {{PFX-0}}. {{Completed title}} ✓

Completed. See git history for implementation details.

---

## Scope legend

- **XS** — 1–2 files, <1 hour of work
- **S** — 2–4 files, 1–3 hours
- **M** — 4–10 files, half day to full day
- **L** — 10+ files, multi-day, probably needs a plan
- **XL** — major feature, definitely needs a plan + shakedown-plan pass

Pelaggio detects scope from the `scope: X` hint in the item text. XS/S items skip the planning step and go straight to implementation.
