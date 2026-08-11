# P4 — Semantic reconciliation and document ownership

**Targets:** K (semantic reconciliation is a delivery obligation).

**Hypothesis.** Reconciliation can reliably take chartered impact → realized impact → canonical
reconciliation, updating routine construction/behavior documentation autonomously while escalating
architecture/trust/external-contract conflicts.

**Falsification conditions.** Unbounded research task; routine changes spray edits across many
documents; cannot distinguish construction from architectural/trust changes; silently modifies
authoritative decisions to agree with implementation; canonical ownership does not converge.

**Method — and its limit.** Eight merged PRs spanning the archetypes. For each, the realized impact
was reconstructed from the file manifest (`gh pr view --json files`), the canonical owner was
derived from the four-lane routing, and the result compared against what the PR actually reconciled.

> **This measures reconstruction, not autonomy.** The classification was done by inspection with
> hindsight, not by a reconciliation agent. It therefore tests whether the *judgment* is tractable
> and whether canonical ownership converges — **not** whether an agent can perform it unattended.
> The autonomy half of K remains untested, and no result below should be read as evidence for it.

## Results

| PR | Archetype | Realized impact | Canonical owner | Actually reconciled | Verdict |
|---|---|---|---|---|---|
| 459 | routine internal refactor | hermetic orchestrator tests, `pipeline.ts` | none | none | ✅ correct no-op |
| 447 | bug fix, no doc impact | max-turns classification preserved | none | none | ✅ correct no-op |
| 457 | externally observable behavior | park cause recorded; stats surface | `pipeline.md` § Parking | `pipeline.md` | ✅ correct owner |
| 446 | Agent Driver / provider change | per-step model + effort parity, 4 providers | `docs/config.md` | `config.md` + `decision-log/431` | ✅ correct owner |
| 442 | provenance change | PR-keyed review-gate record | `docs/pr-review.md` | `pr-review.md` + `decision-log/328` | ✅ correct owner |
| 463 | docs-only | ADR-0026 + collapse plans | decisions / agent-context | 5 docs | ✅ correct owner |
| **475** | **safety/authority change** | implements **ADR-0026's attempt-freshness constraint** (attempt identity as an authority) | ADR-0026 status + `guarded-actions.md` | **none** | ❌ **missed** |
| **427** | **trust / supply-chain** | third-party actions pinned to immutable commit SHAs | `docs/trust/` + ADR-0007 | **none** | ❌ **missed** |

### Measurements

| Metric | Result |
|---|---|
| Stale documentation missed | **2 / 8** — both #475 and #427 |
| Unnecessary documentation edits proposed | **0 / 8** |
| Duplicate facts introduced | **0 observed** |
| Correct canonical owner selected | **6 / 6** where any doc was touched |
| Architecture/trust conflicts escalated rather than silently rewritten | **0 escalations, 1–2 warranted** — but also **0 silent rewrites** |

### The two misses share a class

Both failures are changes that **realize or alter an architectural or trust claim** — precisely the
class K says must escalate rather than be handled autonomously. Every change that was purely
construction or behavior got its canonical owner right.

- **#475** implements ADR-0026's *attempt freshness must be unforgeable* constraint. That ADR is still `status: proposed`, which this
  repository defines as *decided, not yet implemented*. Part of it is now implemented. Both
  `0026` and `guarded-actions.md` still describe attempt identity as target-state.
- **#427** pinned third-party workflow actions to immutable SHAs — a material supply-chain posture
  change under ADR-0007 / `TC-005`. No trust document records it.

## Verdict — K survives, with its failure mode inverted

None of the five falsification conditions fired:

- **Not unbounded.** Eight PRs classified from file manifests in minutes. The manifest is the input
  that makes it bounded; requiring the implementation agent to discover prose dependencies itself is
  what would make it unbounded, and the plan already forbids that.
- **No spraying.** Zero unnecessary edits across eight changes.
- **Construction vs architecture is distinguishable.** The classification was never ambiguous once
  the manifest was read. The problem is not that the distinction is hard — it is that **nobody was
  making it**.
- **No silent rewriting.** #475 left ADR-0026 alone rather than editing it to match the
  implementation. The system failed in the *safe* direction.
- **Canonical ownership converges.** 6/6 correct where docs were touched, and both misses have an
  obvious owner.

**The predicted failure was too many edits; the observed failure is silence on the highest-stakes
class.** A reconciliation capability tuned to suppress noise would make this worse, not better.

## Independent convergence with the document reviews

ADR-0026's `proposed` status is now wrong in a way the vocabulary cannot express: 1 of its 10
decisions is implemented. The third trio review reached the same conclusion from the document side
(finding C17 — redefining `proposed` without re-triaging the ADRs that carry it). P4 reaches it from
the implementation side. Two independent methods, one defect: **the status vocabulary has no term
for partially implemented**, and a bundled ADR makes that unavoidable rather than rare.

## Canonical ownership / dedupe observations

Recorded as observations, not a redesign — per the guardrail, the documentation tree is not to be
redesigned before P4.

1. **Two decision lanes with an unstated boundary.** `docs/decisions/` (ADRs) and
   `docs/decision-log/<id>.md` both record decisions; #442 and #446 wrote to the latter. Nothing
   states when a change earns an ADR versus a decision-log entry. This is the most likely source of
   future duplicate facts.
2. **The trust lane has no owner for build/supply-chain posture.** #427 changed how artifacts are
   built and no trust document claims that surface. `TC-005` covers publish provenance;
   third-party action pinning falls between it and `reproducible-install.md`.
3. **No dedupe candidates are proposed yet.** Eight changes produced zero duplicate facts, so the
   observations do not yet justify collapsing anything. Proposing a dedupe now would be redesigning
   the tree on the strength of a hypothesis rather than evidence.
