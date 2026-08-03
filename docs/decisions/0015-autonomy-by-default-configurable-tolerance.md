---
title: "ADR-0015: Autonomy by default, gated by deterministic gates + documented reasoning; human involvement is a configurable tolerance"
status: proposed
date: 2026-07-19
claims: [TC-012, TC-013]
---

# ADR-0015 — Autonomy by default; human involvement is a configurable tolerance

## Context
The product's aspiration is to go as far autonomously as possible, up to and including merge to main. Two framings are wrong at the extremes: human-in-the-loop per-step approval collapses throughput to human latency; naive human-out-of-the-loop removes meaningful control at the consequential act. The question is *what actually gates autonomy*.

## Decision
**Autonomy — including merge to main — is the default and the goal.** It is gated by exactly two things:

1. **Deterministic gates that fail closed** — the safety-class taxonomy ([ADR-0016](./0016-severity-taxonomy-and-owner.md)), CI green, the phantom-ship guard, review-survival, and containment/egress; and
2. **A machine-checkable attestation** binding those gate results ([ADR-0018](./0018-in-toto-attestation-envelope.md)) — it must assert the deterministic facts (`safety_survivors == 0`, `ci == green`, `containment == verified`), and merge fails **closed** if the attestation is absent or any asserted fact is false. Condition (2) is deliberately **not** a free-text "reasoned decision" a model can always produce: per [ADR-0014](./0014-mechanism-policy-separation-spine.md) there is no prompt-engineered lower bound, so the second condition carries deterministic teeth or it carries none. The predicate is **stamped by the harness from actual tool outputs** — CI status, the review loop's `safety_survivors` count, the containment verifier — and **the driver cannot populate it**; a driver-asserted fact would be model-forgeable and worthless. The #188 slice shipped the **effects-boundary execution-receipt producer** (harness-issued content-addressed receipts for successfully dispatched effects manifests). **Gate-assertion binding, one-time challenge enforcement at merge, and trusted-runner identity remain target-state**, so **condition (2) is still not a shipped control** and autonomous merge is not a shipped guarantee — treat the merge gate as not-yet-wired. A human-readable rationale rides alongside as forensic provenance — it is not itself the withholding control.

When both hold, the cycle proceeds autonomously, including landing to main. Human involvement — **flag vs. move, park vs. note** — is a **configurable tolerance**, per project and varying over time, layered *on top of* the deterministic floor; it is not a fixed requirement. This generalizes the existing `ship.target` / dissent-conditioning seam into a first-class **tolerance policy** over finding-classes. It **amends/generalizes [ADR-0003](./0003-pr-gated-by-default.md)**: the *shipped* `ship.target` default stays `pull-request` (safe-by-default for consumers); this ADR defines what autonomy is *permitted* to be when an operator dials the tolerance up, not a new shipped default.

The **safety class is never subject to the tolerance dial**: it always fails closed on deterministic grounds. A class becomes tolerance-configurable **only** through the taxonomy's change-management ([ADR-0016](./0016-severity-taxonomy-and-owner.md)), never by default — an unclassified finding defaults to the safety set. Consequently the only human decision that cannot be dialed away is authoring and owning that taxonomy; moving a class *out of* the safety set is itself a gated, signed action, never autonomous.

## Alternatives not taken
- Human-ON-the-loop as a fixed default — a values stance, not a deterministic requirement; caps throughput unnecessarily and is the very thing this decision makes configurable rather than mandatory.
- Full human-OUT-of-the-loop with no deterministic floor — removes the security lower bound and meaningful control.

## Consequences
- (+) Supports fully automated operation including merge; each project/operator sets its own flag-vs-move posture and changes it over time.
- (−) Relocates **all** residual trust onto (a) the completeness of the deterministic gates and (b) the integrity of the safety taxonomy — a gate false-negative has no human backstop except revert + post-merge-verify + the audit trail.
- Mitigations: the safety class fails closed regardless of tolerance; merge stays revertable and monitored (post-merge verify, `/shipwreck`); the attestation ([ADR-0018](./0018-in-toto-attestation-envelope.md)) is the machine-checkable binding of the gate results (condition 2), with the human rationale carried alongside as forensic provenance rather than as the control. Depends on [ADR-0016](./0016-severity-taxonomy-and-owner.md) (the floor, including its emission-time classifier) and [ADR-0013](./0013-reversibility-weighted-gate-sizing.md) (why the reversible majority is safe to automate).
