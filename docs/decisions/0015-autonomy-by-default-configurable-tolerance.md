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
2. **A documented, reasoned decision** — the provenance/attestation record ([ADR-0018](./0018-in-toto-attestation-envelope.md)).

When both hold, the cycle proceeds autonomously, including landing to main. Human involvement — **flag vs. move, park vs. note** — is a **configurable tolerance**, per project and varying over time, layered *on top of* the deterministic floor; it is not a fixed requirement. This generalizes the existing `ship.target` / dissent-conditioning seam (park on `direct-push`, ship on `pull-request`) into a first-class **tolerance policy** over finding-classes.

The **safety class is never subject to the tolerance dial**: it always fails closed on deterministic grounds. Consequently the only human decision that cannot be dialed away is authoring and owning the safety taxonomy ([ADR-0016](./0016-severity-taxonomy-and-owner.md)); moving a class *out of* the safety set is itself a gated, documented action, never autonomous.

## Alternatives not taken
- Human-ON-the-loop as a fixed default — a values stance, not a deterministic requirement; caps throughput unnecessarily and is the very thing this decision makes configurable rather than mandatory.
- Full human-OUT-of-the-loop with no deterministic floor — removes the security lower bound and meaningful control.

## Consequences
- (+) Supports fully automated operation including merge; each project/operator sets its own flag-vs-move posture and changes it over time.
- (−) Relocates **all** residual trust onto (a) the completeness of the deterministic gates and (b) the integrity of the safety taxonomy — a gate false-negative has no human backstop except revert + post-merge-verify + the audit trail.
- Mitigations: the safety class fails closed regardless of tolerance; merge stays revertable and monitored (post-merge verify, `/shipwreck`); the attestation ([ADR-0018](./0018-in-toto-attestation-envelope.md)) is the durable record of the reasoned decision. Depends on [ADR-0016](./0016-severity-taxonomy-and-owner.md) (the floor) and [ADR-0013](./0013-reversibility-weighted-gate-sizing.md) (why the reversible majority is safe to automate).
