---
title: "ADR-0004: Review gate fails closed; shakedown fails safe (two parsers)"
status: accepted
date: 2026-07-07
claims: ["TC-003"]
---

# ADR-0004 — Review gate fails closed; shakedown fails safe

## Context
Both the review gate and the `shakedown` step decide whether to block by interpreting model output. A parse failure, an absent verdict, or ambiguous output must not silently resolve to "pass" — that would land an unreviewed change on a formatting flake.

## Decision
The **review gate fails closed**: a malformed, absent, or ambiguous verdict blocks, never passes. **Shakedown fails safe**: on uncertainty it degrades conservatively rather than proceeding. The two steps use **two separate, role-appropriate parsers** (the review-gate parser fails closed; the shakedown parser fails safe) — not dual-redundant parsing of one gate.

## Alternatives not taken
- A single shared parser / fail-open policy across both roles — loses the role-appropriate default, so a parse problem lands an unvetted change.
- Fail-open on parse error — an unreviewed or unvetted change lands on a transient output-format problem.

## Consequences
- (+) No unreviewed change lands because of a parse flake; the safe direction is the default.
- (−) Output-format flakes can fail-close otherwise-good code; bounded parse-tolerance (see ADR-0024, #280) narrows this without weakening the fail-closed guarantee.
