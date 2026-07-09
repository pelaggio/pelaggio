---
title: "ADR-0003: Default ship target is pull-request"
status: proposed
date: 2026-07-08
claims: [TC-012]
---

# ADR-0003 — PR-gated by default

## Context
`ship.target` defaults to `direct-push` today, so a consumer who runs `init` and changes nothing gets autonomous pushes to remote `main` (audit S2). Combined with the allow-all agent and the injection threat (`ADR-0002`), the default blast radius is high. Trust-first means the safe thing is the default, not an opt-in.

## Decision
Flip the shipped default to **`pull-request`**. `direct-push` becomes an explicit, warned opt-in (loud banner on first autonomous-push config).

## Alternatives not taken
- Keep direct-push for zero-friction dogfooding — optimizes our convenience over the consumer's safety.
- Remove direct-push — it's legitimate for trusted solo repos; keep it, just not by default.

## Consequences
- (+) `TC-012` becomes a shipped `default` guarantee; matches Fathom's propose-then-confirm ethos.
- (−) One extra step (open a PR) for users who genuinely want autonomous push; mitigated by the opt-in.
