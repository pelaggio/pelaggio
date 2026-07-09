---
title: "ADR-0002: Treat repo/issue/PR as untrusted input; scope tools accordingly"
status: accepted
date: 2026-07-08
claims: [TC-015]
---

# ADR-0002 — Untrusted input and tool scope

## Context
Pelaggio is designed to read and act on repository files, issues, and PR text — surfaces an attacker can control. This is the product's defining threat (OWASP LLM01/LLM06, Agentic Top-10). Today the agent runs allow-all tools; blast radius is bounded by the worktree (`ADR-0001`), the fail-closed review gate (`ADR-0004`), and budget/turn caps — but there is no injection-specific defense.

## Decision
Adopt, as a standing principle, that **all repo/issue/PR content is untrusted** and safety must not depend on the agent "deciding correctly." Accept the current bounded posture as v1; commit the hardening path as roadmap: least-privilege tool scoping by trust level, human approval gates on risky file classes (`.env`, CI, publish, infra), and injection red-team fixtures.

## Alternatives not taken
- Claim injection-resistance now — dishonest; there is no designed defense yet.
- Disallow acting on issues/PRs — removes the core feature.

## Consequences
- (+) The threat is named as first-class and drives the permission model; `TC-015` stays honestly `best_effort` with its weakness public.
- (−) Real defense is roadmap, not shipped; this ADR is the promise, not the fix.
