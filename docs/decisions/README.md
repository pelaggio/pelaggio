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
| [0001](./0001-worktree-write-confinement.md) | Writes confined to the item's worktree | accepted | `TC-011` |
| [0002](./0002-untrusted-input-and-tool-scope.md) | Treat repo/issue/PR as untrusted; scope tools accordingly | accepted (with known gap) | `TC-015` |
| [0003](./0003-pr-gated-by-default.md) | Default *shipped* ship target = pull-request (amended by 0015) | proposed | `TC-012` |
| [0004](./0004-review-gate-fails-closed-shakedown-fails-safe.md) | Review gate fails closed; shakedown fails safe (two parsers) (amended by 0026) | accepted | `TC-003` |
| [0005](./0005-auto-merge-safety-via-branch-protection.md) | Auto-merge safety delegated to branch protection (amended by 0025) | accepted (to verify) | `TC-013` |
| [0006](./0006-no-lifecycle-scripts-in-published-manifests.md) | No install/lifecycle scripts in published manifests | accepted | `TC-004`, `TC-016` |
| [0007](./0007-signed-tag-provenance-publish.md) | Publish = signed tag + provenance on self-hosted runner | accepted | `TC-005` |
| [0008](./0008-control-plane-fail-closed.md) | Control plane fails closed (auth required / loopback-only) | proposed | `TC-010` |
| [0009](./0009-claims-are-git-branches.md) | Claims are git branches; no registry | accepted | — |
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
| [0020](./0020-multi-driver-provider-seam-and-capability-model.md) | Multi-driver provider seam + data-only capability model; native-prefer routing, fail-closed, no polyfill emulation | accepted | — |
| [0021](./0021-capability-enforcement-and-placement.md) | Enforcement = ocap tool-mediation; placement = effects-as-handlers; agentic-loop vs deterministic only | proposed | — |
| [0022](./0022-pipeline-shape-and-review-orchestrators.md) | Fixed 6 steps; policy-triggered review; distinct cold CI + authoring orchestrators (rejects uniform Node) | accepted | — |
| [0023](./0023-contained-execution-boundary.md) | Contained-execution: `network=none` jail + fail-closed egress broker; keys unattended, subscription local-only; containment ≠ permission | proposed | — |
| [0024](./0024-adversarial-authoring-review-loop.md) | Review moves upstream: multi-driver panel + Judge, deterministic convergence, park-on-safety, provenance record | accepted | — |
| [0025](./0025-landing-serialization-cas-fence-optional-ordering.md) | Landing serialization: CAS fence, optional ordering (amends 0005) | proposed | `TC-013` |
| [0026](./0026-stateful-guards-fence-reconcile-and-gate-disposition.md) | Stateful guards: fence-or-reconcile classification; gate disposition splits judgment from evidence (amends 0004) | proposed | `TC-003`, `TC-013` |

*Status vocabulary:* `proposed` (decided, not yet implemented) · `accepted` (implemented) · `superseded`.

## The four documentation lanes

These ADRs are one lane of four; keep a decision in its lane rather than duplicating it across them:

- **`AGENTS.md` one-liner** — the invariant index (what is true, one line, always loaded).
- **`docs/agent-context/*.md`** — the design / RFC lane (exploration, tagged `(design)` / `(flow, planned)`) **and operator how-tos** (e.g. `supervised-run.md`). **RFC-before-ADR** — design docs explore; an ADR records the settled decision they converged on.
- **`docs/decisions/*.md`** (this lane) — the settled decision and *why*.
- **`docs/trust/*`** — the *what + proof*.

These lanes route whole documents. For what belongs where *inside* a single decision, see [the three layers](#what-belongs-in-an-adr--the-three-layers) and the cut test below.

Keep the ADR bar where it is: write one only for a decision that is hard to reverse, spans concerns, carries real trade-offs, or has been re-debated. Do not lower it to log routine choices.

## What belongs in an ADR — the three layers

The four lanes above route whole *documents*. This routes the content *within* one decision, which
is where the ambiguity actually bites: an ADR that mixes layers cannot be cut without dropping
something load-bearing, and a reader skimming only its `## Decision` will miss the part that has
teeth.

| Layer | Answers | Home | Example (ADR-0001) |
|---|---|---|---|
| **Invariant** | What must always be true? | ADR → `## Decision` | Agent writes cannot escape the item's worktree |
| **Constraint** | Why this shape — what breaks if you pick the obvious alternative? | ADR → `## Constraints on any implementation` | Enforcement must not depend on parsing tool inputs — bypassable by shell indirection (PR #112) |
| **Construction** | How is it built right now? | detail doc / code / test | The whole-step Git porcelain snapshot and diff, its bounded retries, and probe timing |

The middle layer is the one that gets lost, and the one that makes the cut safe. Write it as a
**negative constraint on the solution space**, not as a positive naming of the mechanism.
*"Must not depend on parsing tool inputs"* permits a porcelain audit, an OS sandbox, or a FUSE
layer, while still killing the approach that already failed. *"Uses the Git porcelain audit"*
prescribes one implementation and tells a replacer nothing about why.

### The cut test

For each line of an ADR, ask: **if someone replaced this mechanism tomorrow, would they need this
line to avoid reintroducing a known failure?**

- **Yes, and it names no mechanism** → `## Decision`.
- **Yes, but it only makes sense as "not X"** → `## Constraints on any implementation`. Rewrite it
  as a constraint and cite the failure.
- **No — it describes how today's code does it** → `## Construction`. Move the prose to the detail
  doc and leave a link.

A line that fails the test in both directions — needed by nobody, cites nothing — is not content.
Delete it.

### Cut is gated on the construction home existing

An ADR is cut when its detail doc lands, **not before**. Cutting first leaves the mechanism
unhomed, which is how a documented, paid-for failure becomes re-discoverable. In practice this
means the detail doc lands *with the feature polish that produced it*, written by whoever did the
work, and the ADR is cut in the same change. `construction: none` is an honest state for a decision
whose mechanism does not exist yet; it is not an excuse to leave built mechanism inline.

## Citing a decision

**Decision numbers are stable and are never reused.** When a re-cut absorbs a decision into
another, demotes it to construction, or promotes it to a constraint, the slot stays and is marked
*withdrawn* in place with a pointer to what now carries its rule. Surviving decisions keep their
original numbers.

The reason is that a stale numeric citation does not dangle — it **mis-resolves onto a different
rule, silently**, and no tool reports it. The 2026-08 ADR-0026 re-cut renumbered ten decisions to
six with different subjects and broke roughly forty citations across nine documents *and shipped
source*; a hand sweep failed twice before the numbering was restored instead. Renumbering is not
worth what it costs to verify.

Where a citation is load-bearing, also name the rule — *ADR-0026 decision 4 (`blocking state is
typed and recoverable`)* — so a future mis-resolution is visible to a reader rather than silent.

## Required shape

New and re-cut ADRs follow [`_TEMPLATE.md`](./_TEMPLATE.md). The shape below is the convention;
a mechanical gate for it is **deliberately not shipped yet** (a prototype was withdrawn on review —
see `adr-reconciliation.md` §9.6 — because its ratchet did not exist and it would have enforced
shape on 2 of 26 ADRs). Until one lands with a real ratchet, this is reviewer-enforced:

- frontmatter carries `title`, `status`, `date`, `claims`, and `construction`;
- `construction` names an existing path (with a resolvable `#anchor` when given) or the literal
  `none`;
- the six sections appear, in order: `Context`, `Decision`, `Constraints on any implementation`,
  `Alternatives not taken`, `Consequences`, `Construction`;
- no source-file paths (`*.ts`) or code symbols outside `## Construction` — those are construction
  by definition;
- a soft warning past 70 lines. Length is a symptom, not the rule; the cut test is the rule.
