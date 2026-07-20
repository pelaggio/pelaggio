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

The taxonomy has a **named owner** (the operator / CTO). This ADR fixes its *structure and change-management*; the concrete per-class table is authored by the owner (open sub-decision).

**Emission, not just reclassification.** The anti-downgrade rule guards *reclassification*, but the load-bearing risk is the *entry* classifier — which findings are assigned to the safety class at emission. Per [ADR-0014](./0014-mechanism-policy-separation-spine.md), that mapping cannot rest on model discretion: it must be **rule-based where possible** (fingerprint / CWE / rule-id / diff-shape) and **default-to-safety-on-ambiguity** — a finding whose class is uncertain is treated as safety-class, so a misclassification fails *toward* the floor. This does not close the *missing-finding* residual (a real defect no reviewer raises at all); that residual is carried by decorrelated reviewer diversity and post-merge verification — the taxonomy must not be read as closing it. A second residual sits at the *finding-description* step: whether a finding matches a safety rule can still hinge on how the model frames it. Default-to-safety and decorrelated diversity make that residual *safe*, not *absent* — this narrows model discretion to "ambiguous ⇒ safety" rather than eliminating it, and should not be read as fully satisfying [ADR-0014](./0014-mechanism-policy-separation-spine.md).

**Extend freely, contract only through the gate.** The safety enumeration is a *floor*. The owner may **extend** it (add a class to safety) autonomously, but **contracting** it — moving a class out to the judgment band, or seating a *new* class as judgment-band — requires the enforceable path: a **signed config change** (the ADR is the human-readable record; the signed config is the gate an autonomous agent cannot clear). Any new finding class **defaults to safety-class** until the owner explicitly reclassifies it judgment-band through that ritual. This asymmetry is what lets the throughput dial ([ADR-0015](./0015-autonomy-by-default-configurable-tolerance.md)) be turned safely: judgment-band gates loosen without touching the floor, and the floor can only shrink through a signed, non-autonomous act.

## Alternatives not taken
- Emergent thresholds scattered across the code — a loophole, not a control; no single place defines what autonomy may touch.
- Model-adjudicated severity — violates [ADR-0014](./0014-mechanism-policy-separation-spine.md) (the blocking decision must be deterministic).

## Consequences
- (+) The keystone that makes autonomy-by-default safe: a single citable boundary between fail-closed and configurable.
- (+) Turning the throughput dial is safe by construction.
- (−) Requires a human owner and a change-management ritual for the safety set — the one irreducible human duty under full autonomy.
