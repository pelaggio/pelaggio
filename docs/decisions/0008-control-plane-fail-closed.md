---
title: "ADR-0008: Control plane fails closed"
status: proposed
date: 2026-07-08
claims: [TC-010]
---

# ADR-0008 — Control plane fails closed

## Context
The control-plane server can spawn coding agents on registered repositories and inherits the daemon's credentials. A loopback bind does not make that authority safe from hostile webpages: browsers can send simple cross-origin POST requests to loopback services. Silent or conditional authentication is therefore not sufficient.

## Decision
**Fail closed.** With no token configured, the server refuses to start on every host, including loopback. The app and auth middleware also require the token by type. No unauthenticated run-spawning endpoint, ever.

## Alternatives not taken
- Warn but continue — a warning in a log is not a control.
- Generate a token automatically — hidden credentials are their own problem.

## Consequences
- (+) `TC-010` becomes a shipped guarantee; removes the one fatal finding.
- (−) Operators must set a token for local development too — the correct friction for an authority-bearing daemon.
