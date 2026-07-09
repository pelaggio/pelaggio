---
title: Architecture Decision Records
description: Why Pelaggio's trust posture is the way it is.
status: draft
diataxis: explanation
---

# Decisions (ADRs)

Format: **[MADR 4.0.0](https://adr.github.io/madr/)** (`adr-template-minimal`). ADRs record the *why*; the [trust docs](../trust/overview.md) record the *what + proof*. They cross-link: a trust claim points to the ADR behind it, an ADR points to the claim(s) it governs.

Numbered from the security audit's implicit-decision candidates.

| ADR | Decision | Status | Claim(s) |
|---|---|---|---|
| [0001](./0001-worktree-write-confinement.md) | Writes confined to the item's worktree | proposed (hardening) | `TC-011` |
| [0002](./0002-untrusted-input-and-tool-scope.md) | Treat repo/issue/PR as untrusted; scope tools accordingly | accepted (with known gap) | `TC-015` |
| [0003](./0003-pr-gated-by-default.md) | Default ship target = pull-request | proposed | `TC-012` |
| 0004 | Review gate fails closed; shakedown fails safe (two parsers) | accepted | `TC-003` |
| 0005 | Auto-merge safety delegated to branch protection | accepted (to verify) | `TC-013` |
| 0006 | No install/lifecycle scripts in published manifests | accepted | `TC-004`, `TC-016` |
| 0007 | Publish = signed tag + provenance on self-hosted runner | accepted | `TC-005` |
| [0008](./0008-control-plane-fail-closed.md) | Control plane fails closed (auth required / loopback-only) | proposed | `TC-010` |
| 0009 | Claims are git branches; no registry | accepted | — |
| 0010 | Secrets protected by convention + gitignore; minimal child env | proposed (hardening) | `TC-001`, `TC-014` |

*Status vocabulary:* `proposed` (decided, not yet implemented) · `accepted` (implemented) · `superseded`.
