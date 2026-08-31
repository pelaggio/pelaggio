# Corpus accountability audit

Status: **experimental / non-authoritative migration work**.

This pass extends the [Review and Landing audit](./review-landing-corpus-audit.md) across the
developer front door: every internal invariant, assumption, and decision. It asks whether each
record is accountable to source language, whether construction status matches what exists, and
whether representative changes recover the intent an agent or developer must preserve.

It deliberately does not add a relation kind, node kind, generic rationale field, owner hierarchy,
or issue node. ADRs retain narrative, alternatives, and historical authority; the corpus anchors
and relates those facts rather than copying their prose.

The follow-on [intent lineage audit](./intent-lineage-audit.md) tests whether that ADR/trust boundary
captured the intent that preceded it. Source grounding and source completeness are separate claims.

## Results

- All 46 front-door records now carry exact source grounding: 21 decisions, 21 internal
  invariants, and 4 assumptions. The grounding check fails when an anchor disappears, while its
  paired mutation fixture confirms that unrelated source edits do not fire it.
- `DEC-0008` is corrected from `current-construction-choice` to
  `target-construction-choice`. ADR-0018 explicitly says the in-toto envelope, gate-assertion
  binding, challenge enforcement, and trusted identities remain target-state.
- `CTR-0025` names the current signed-tag/npm-provenance workflow and derives from `DEC-0003`.
  It explicitly does not claim downstream verification or the whole custody invariant.
- `CTR-0026` names current typed effect dispatch and derives from `DEC-0011`. It explicitly does
  not claim cross-provider per-call tool mediation.
- Every current-construction choice now names at least one bounded realizing construction. This is
  linkage and freshness evidence, not semantic proof that the whole decision or invariant holds.
- The existing `supersedes` relation is now included in the `why`, `affected`, and `landing`
  projections so decision archaeology is visible without a new relation or explanatory copy.
- Seven executable competency fixtures cover topology replacement, review diversity, landing
  replacement, constraint deletion, landing overclaim refusal, effect-placement replacement, and
  corpus promotion. They exercise existing views and meanings rather than defining a new query API.

## Decision dispositions

| Records | Disposition | Why |
|---|---|---|
| `DEC-0001`, `DEC-0005`–`DEC-0007`, `DEC-0017`, `DEC-0018`, `DEC-0021` | retain policy choices | Each materially selects behavior or risk posture; none is merely a copied configuration default. `DEC-0001` is consequential because it chooses whether an untouched installation proposes or directly lands work. |
| `DEC-0002` | retain history | Branch protection is superseded construction whose rationale and surviving landing obligation remain relevant. |
| `DEC-0003`, `DEC-0004`, `DEC-0009`–`DEC-0014`, `DEC-0016` | retain current construction | Each selects replaceable machinery and now names a bounded current realization. Partial realizations remain bounded in their statements. |
| `DEC-0008` | reclassify as target construction | The selected envelope is not built; labeling it current made the corpus stronger than its ADR and repository. |
| `DEC-0015` | retain target construction | Candidate-bound CAS landing is selected but unbuilt. |
| `DEC-0019`, `DEC-0020` | retain proposed construction | Corpus promotion and delivery packets remain explicit prospective choices, not current behavior. |

The pass did not add scalar rationale or alternatives to decision records. Those are narrative facts
already owned by ADR sections; source anchors let a projection retrieve them without establishing a
second independently maintained summary.

## Unrealized invariant dispositions

The same six internal invariants remain intentionally visible as unrealized. None earned a weaker
statement or a speculative implementation edge merely to clear a diagnostic.

| Record | Disposition |
|---|---|
| `CLM-0001` | Real confinement bounds blast radius, but the source explicitly says injection-specific defense is not built. |
| `CLM-0006` | Existing review and authorization mechanisms do not establish the universal no-self-authorization boundary. |
| `CLM-0007` | The red-check reader is current machinery; candidate-bound concurrency-safe landing remains target construction. |
| `CLM-0008` | Signed-tag publication and execution receipts are partial custody machinery; no current realization establishes the full delivered-and-published invariant. |
| `CLM-0020` | A shadow, non-authoritative corpus cannot realize its own single-source-authority proposition. |
| `CLM-0021` | Registry evidence and denylist inspection do not enforce the universal absence of undeclared egress. |

## Competency boundary

The fixtures in [`competency-fixtures.json`](./competency-fixtures.json) pin represented answers,
including required and forbidden edges and live debt where absence is meaningful. Mutable issue,
PR, CI, and branch state remains a read-time join owned by those systems.

The next ontology question remains Assessment. It should be admitted only when attributable
interpretation of observations is exercised by a real challenge query. This pass supplies no basis
for adding `supports`, `challenges`, generic dependency types, Actor, Context, or Change nodes.
