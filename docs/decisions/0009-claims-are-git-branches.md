---
title: "ADR-0009: Claims are git branches; no registry"
status: accepted
date: 2026-07-07
claims: []
---

# ADR-0009 — Claims are git branches; no registry

## Context
Concurrent cycles must claim a work item without racing. A shared mutable claims registry (or call-site locking) is a coordination hotspot and a new failure mode, when the version-control system already provides atomic reference creation.

## Decision
A claim **is** the existence of the item's `feat/<id>` git branch — git is the claim substrate, and the branch is the authoritative claim token. There is **no separate claims registry and no call-site locking**; roadmap mutations self-serialize on a single lock file (`.dev/roadmap-mutation.lock`).

## Alternatives not taken
- A claims registry or call-site locking — adds a mutable coordination store and its failure modes (staleness, partial writes, lock leaks) to do what an atomic git ref already does.

## Consequences
- (+) Claims are git-native with no extra store to run, back up, or reconcile; provider status is write-back, never the claims registry.
- (−) Claim semantics are limited to what git refs can express; anything richer serializes through the single roadmap-mutation lock rather than a general store.
