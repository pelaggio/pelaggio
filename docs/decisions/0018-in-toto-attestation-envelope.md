---
title: "ADR-0018: Review-record attestations (#188) target the in-toto / ITE-6 envelope"
status: proposed
date: 2026-07-19
claims: [TC-005]
---

# ADR-0018 — Attestations target the in-toto / ITE-6 envelope

## Context
Under autonomy-by-default ([ADR-0015](./0015-autonomy-by-default-configurable-tolerance.md)), the provenance record **is** the "documented reasoned decision" that substitutes for a human at the merge. The review-record → attestation binding (#186 predicate / #187 emit / #189 assisted-by) is already the in-toto predicate/statement pattern, and #170's fat-events rule ("don't re-derive by joining mutable git/provider") is exactly why an attestation must be self-contained and signed rather than a joinable derivation.

## Decision
The #188 attestation targets the standard **in-toto / ITE-6 statement envelope**, not a bespoke format. This is an interoperability commitment (external verifiers, SLSA tooling), ratified now, before the format ossifies.

## Alternatives not taken
- A bespoke attestation format — convenient short-term, but not externally verifiable and harder to unwind once shipped.

## Consequences
- (+) Autonomous merges are externally auditable — the accountability substitute for a human at the gate.
- (+) Rides existing SLSA / in-toto tooling.
- (−) Conformance cost to the envelope schema.
