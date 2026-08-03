---
title: "ADR-0018: Review-record attestations (#186–189) target the in-toto / ITE-6 envelope"
status: proposed
date: 2026-07-19
claims: [TC-005]
---

# ADR-0018 — Attestations target the in-toto / ITE-6 envelope

## Context
Under autonomy-by-default ([ADR-0015](./0015-autonomy-by-default-configurable-tolerance.md)), the provenance record **is** the "documented reasoned decision" that substitutes for a human at the merge. The review-record → attestation binding (#186 predicate / #187 emit / #189 assisted-by) is already the in-toto predicate/statement pattern, and #170's fat-events rule ("don't re-derive by joining mutable git/provider") is exactly why an attestation must be self-contained and signed rather than a joinable derivation.

## Decision
The attestation cluster (#186 predicate / #187 emit / #188 evidence-binding / #189 assisted-by) targets the standard **in-toto / ITE-6 statement envelope**, not a bespoke format. Beyond interoperability, the predicate **carries the machine-checkable gate assertions** that condition (2) of [ADR-0015](./0015-autonomy-by-default-configurable-tolerance.md) requires — `safety_survivors == 0`, `ci == green`, `containment == verified` — so the attestation is a **deterministic merge precondition** (absent or false ⇒ fail closed), not merely a forensic record. The predicate is computed by the **harness from the actual gate outputs**, never populated by the driver.

**Status of #188.** The **effects-boundary execution-receipt producer** shipped under #188: after successful effects dispatch the harness writes a content-addressed receipt binding the exact pre-delete manifest bytes, realized provider/model, worktree Git revision bindings, and a per-cycle challenge digest. That slice proves harness-observed dispatch at one typed seam. **Gate-assertion binding** (wiring `safety_survivors` / `ci` / `containment` into the predicate from real tool outputs), **one-time challenge enforcement at merge**, and **trusted-runner / provider-issued identities** remain target-state follow-ups — do not cite autonomous-merge condition (2) as a shipped control until those land. This ADR is also an interoperability commitment (external verifiers, SLSA tooling), ratified before the format ossifies.

## Alternatives not taken
- A bespoke attestation format — convenient short-term, but not externally verifiable and harder to unwind once shipped.

## Consequences
- (+) The predicate is a **pre-merge deterministic precondition**, not post-hoc adjudication — which is why it can be a control at all (post-hoc human review after an autonomous merge is not a control; see `adversarial-review-loop.md`).
- (+) Autonomous merges are externally auditable — the forensic accountability record layered on the deterministic gate.
- (+) Rides existing SLSA / in-toto tooling.
- (−) Conformance cost to the envelope schema.
