---
title: "ADR-0008: Control plane fails closed"
status: proposed
date: 2026-07-08
claims: [TC-010]
---

# ADR-0008 — Control plane fails closed

## Context
The control-plane server's bearer auth is opt-in: if `CONTROL_PLANE_TOKEN` is unset, the auth middleware becomes a no-op and `POST /runs` — which spawns the coding agent on registered repos — is unauthenticated. Only the non-`0.0.0.0` bind stands between a LAN/tailnet peer and arbitrary autonomous code execution (audit F1, fatal). Silent insecurity is the worst kind.

## Decision
**Fail closed.** With no token configured, the server refuses to start, or binds to loopback only — and says so, loudly. No unauthenticated run-spawning endpoint, ever.

## Alternatives not taken
- Warn but continue — a warning in a log is not a control.
- Generate a token automatically — hidden credentials are their own problem.

## Consequences
- (+) `TC-010` becomes a shipped guarantee; removes the one fatal finding.
- (−) Operators must set a token (or accept loopback-only) — the correct friction.
