---
title: "ADR-0006: No install/lifecycle scripts in published manifests"
status: accepted
date: 2026-07-07
claims: ["TC-004", "TC-016"]
---

# ADR-0006 — No install/lifecycle scripts in published manifests

## Context
`preinstall` / `install` / `postinstall` lifecycle scripts run arbitrary code on a consumer's machine at install time — a well-known supply-chain attack vector for a published package.

## Decision
No `preinstall`, `install`, or `postinstall` lifecycle scripts in any published package manifest. Installing the package runs no **Pelaggio-authored** lifecycle code; transitive dependency lifecycle scripts remain outside this guarantee (TC-016).

## Alternatives not taken
- Allowing a `postinstall` for setup convenience — opens exactly the supply-chain vector this ADR closes.

## Consequences
- (+) `npm i pelaggio` (or equivalent) executes no package-authored code at install time.
- (−) Any environment setup must be an explicit, user-invoked command rather than an automatic install hook.
