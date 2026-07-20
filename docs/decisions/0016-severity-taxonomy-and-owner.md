---
title: "ADR-0016: Safety-class / judgment-band severity taxonomy, anti-downgrade, and owner"
status: proposed
date: 2026-07-19
claims: [TC-003, TC-013]
---

# ADR-0016 — Severity taxonomy + owner (the keystone)

## Context
Tiered rigor already exists (a safety floor vs. a judgment band; the blocking-bar knob) but only as scattered thresholds. Under autonomy-by-default ([ADR-0015](./0015-autonomy-by-default-configurable-tolerance.md)), the taxonomy that defines "safety class" **is** the boundary between the always-fail-closed set and the tolerance-configurable set — the single most load-bearing piece of configuration in the system.

## Decision
Author an explicit, auditable **severity taxonomy** stating, per finding class, whether it **parks** (safety class: security / data-loss / correctness-regression), **ships-with-notes/dissent** (judgment band), or is **tolerance-configurable**. Bind it with the **anti-downgrade** rule (from #272): a class may be elevated, never silently lowered; a lone Judge cannot clear or reclassify a safety-class finding.

The taxonomy has a **named owner** (the operator / CTO). Edits that **move a class out of the safety set** are themselves a fail-closed, documented decision — an ADR or a signed config change — **never an autonomous move**. This is what lets the throughput dial ([ADR-0015](./0015-autonomy-by-default-configurable-tolerance.md)) be turned safely: judgment-band gates loosen without touching the safety floor.

**Open sub-decision:** the concrete per-class table is to be authored by the owner; this ADR fixes the *structure and change-management*, not yet the full contents.

## Alternatives not taken
- Emergent thresholds scattered across the code — a loophole, not a control; no single place defines what autonomy may touch.
- Model-adjudicated severity — violates [ADR-0014](./0014-mechanism-policy-separation-spine.md) (the blocking decision must be deterministic).

## Consequences
- (+) The keystone that makes autonomy-by-default safe: a single citable boundary between fail-closed and configurable.
- (+) Turning the throughput dial is safe by construction.
- (−) Requires a human owner and a change-management ritual for the safety set — the one irreducible human duty under full autonomy.
