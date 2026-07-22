---
title: Architecture Decision Records
description: Why Pelaggio's trust posture is the way it is.
status: draft
diataxis: explanation
---

# Decisions (ADRs)

Format: **[MADR 4.0.0](https://adr.github.io/madr/)** (`adr-template-minimal`). ADRs record the *why*; the [trust docs](../trust/overview.md) record the *what + proof*. They cross-link: a trust claim points to its primary ADR, and an ADR lists the claim(s) it governs. A claim may be governed by more than one ADR, and a newer ADR may reference a claim before the trust doc back-links it — the reference here is the source of truth for the ADR→claim direction.

Numbered from the security audit's implicit-decision candidates.

| ADR | Decision | Status | Claim(s) |
|---|---|---|---|
| [0001](./0001-worktree-write-confinement.md) | Writes confined to the item's worktree | proposed (hardening) | `TC-011` |
| [0002](./0002-untrusted-input-and-tool-scope.md) | Treat repo/issue/PR as untrusted; scope tools accordingly | accepted (with known gap) | `TC-015` |
| [0003](./0003-pr-gated-by-default.md) | Default *shipped* ship target = pull-request (amended by 0015) | proposed | `TC-012` |
| 0004 | Review gate fails closed; shakedown fails safe (two parsers) | accepted | `TC-003` |
| 0005 | Auto-merge safety delegated to branch protection | accepted (to verify) | `TC-013` |
| 0006 | No install/lifecycle scripts in published manifests | accepted | `TC-004`, `TC-016` |
| 0007 | Publish = signed tag + provenance on self-hosted runner | accepted | `TC-005` |
| [0008](./0008-control-plane-fail-closed.md) | Control plane fails closed (auth required / loopback-only) | proposed | `TC-010` |
| 0009 | Claims are git branches; no registry | accepted | — |
| [0010](./0010-agent-env-allowlist-and-log-scrub.md) | Deny-by-default child env allowlist + secret-scrubbed logs | accepted | `TC-001`, `TC-014` |
| [0011](./0011-andon-not-dor.md) | Spec quality is runtime Andon, not upstream Definition-of-Ready | proposed | — |
| [0012](./0012-readiness-computed-not-groomed.md) | Readiness is a computed FlowPolicy verdict, not human grooming | proposed | — |
| [0013](./0013-reversibility-weighted-gate-sizing.md) | Gate rigor sized by reversibility, not lifecycle stage | accepted | — |
| [0014](./0014-mechanism-policy-separation-spine.md) | Mechanism/policy separation is the harness spine | accepted | — |
| [0015](./0015-autonomy-by-default-configurable-tolerance.md) | Autonomy by default; human involvement is a configurable tolerance (amends 0003) | proposed | `TC-012`, `TC-013` |
| [0016](./0016-severity-taxonomy-and-owner.md) | Safety/judgment severity taxonomy + anti-downgrade + owner | proposed | `TC-003`, `TC-013` |
| [0017](./0017-graceful-degradation-rigor-only.md) | Degrade on rigor only; last-verified-pin ok, uncontained never | proposed | `TC-001`, `TC-010` |
| [0018](./0018-in-toto-attestation-envelope.md) | Attestations (#186–189) carry machine-checkable gate assertions in the in-toto / ITE-6 envelope | proposed | `TC-005` |
| [0019](./0019-checkpoint-restart-not-replay.md) | Checkpoint-restart durability, not deterministic replay | accepted | — |
| [0020](./0020-multi-driver-provider-seam-and-capability-model.md) | Multi-driver provider seam + data-only capability model; native-prefer routing, fail-closed, no polyfill emulation | proposed | — |
| [0021](./0021-capability-enforcement-and-placement.md) | Enforcement = ocap tool-mediation; placement = effects-as-handlers; agentic-loop vs deterministic only | proposed | — |
| [0022](./0022-pipeline-shape-and-review-orchestrators.md) | Fixed 6 steps; policy-triggered review; distinct cold CI + authoring orchestrators (rejects uniform Node) | proposed | — |

*Status vocabulary:* `proposed` (decided, not yet implemented) · `accepted` (implemented) · `superseded`.

## The four documentation lanes

These ADRs are one lane of four; keep a decision in its lane rather than duplicating it across them:

- **`AGENTS.md` one-liner** — the invariant index (what is true, one line, always loaded).
- **`docs/agent-context/*.md`** — the design / RFC lane (exploration, tagged `(design)` / `(flow, planned)`) **and operator how-tos** (e.g. `supervised-run.md`). **RFC-before-ADR** — design docs explore; an ADR records the settled decision they converged on.
- **`docs/decisions/*.md`** (this lane) — the settled decision and *why*.
- **`docs/trust/*`** — the *what + proof*.

Keep the ADR bar where it is: write one only for a decision that is hard to reverse, spans concerns, carries real trade-offs, or has been re-debated. Do not lower it to log routine choices.
