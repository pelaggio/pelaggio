---
title: "ADR-0027: Architectural intent converges on one machine-readable graph"
status: proposed
date: 2026-08-22
claims: []
construction: docs/assurance/README.md
---

# ADR-0027 — Architectural intent converges on one machine-readable graph

## Context

Pelaggio's ADR, trust, agent-context, code, and test corpus contains valuable architectural history, but repeated principles have accumulated across prose documents with different scopes and implementation eras. That made current realization easy to mistake for invariant intent, made semantic duplication hard to detect, and required humans or reviewers to reconstruct which statements were still controlling.

The shadow assurance-corpus experiment compresses the existing ADR corpus into propositions, decisions, realizations, and typed relationships, with executable questions over those relationships. Invariant, constraint, and assumption are roles of a common proposition rather than separate base node classes. It is intentionally non-authoritative while its ontology, deduplication, and maintenance workflow are validated.

## Decision

1. **Pelaggio architectural intent must have one machine-readable semantic source of truth.** Propositions, decisions, realizations, and their relationships must not require reconciliation across independent prose registries.
2. **Narrative documentation remains valuable but explanatory.** ADRs may preserve context, rationale, rejected alternatives, and historical decisions; narrative prose must not become a second independently maintained definition of current architectural intent.
3. **Machine-produced observations must be linked rather than manually restated.** Tests, runs, PRs, attestations, and other execution artifacts should eventually attach through machine plumbing; maintaining an existing proposition must not require repetitive human bookkeeping. Observation and interpretation remain distinct so later assessments can be attributed.
4. **The current shadow graph is not authoritative yet.** Promotion requires demonstrated corpus coverage, source grounding, low-friction authoring, and query/check behavior that detects drift instead of merely agreeing with its own extraction.
5. **The semantic contract is not Pelaggio-repository-specific.** Consumer repositories must be able to own intent independently under the same model. Cross-graph composition / federation is deliberately undecided until an actual use case forces that decision.

## Constraints on any implementation

- **Architectural identity must survive implementation replacement.** Durable intent must not depend on source-file paths, symbols, renderer coordinates, or other realization details; those belong on realization/observation links.
- **Narrative edits must not force meaningless graph churn.** Spelling, explanation, rationale, and realization-only changes must be able to leave semantic graph state unchanged when intent did not change.
- **New architectural intent must not bypass the semantic corpus.** Once the graph is promoted, adding or changing a load-bearing invariant, replacement constraint, assumption, or architectural decision must update the graph in the same change.
- **Propositional roles must not require separate base types.** Invariant, constraint, and assumption remain semantically distinguishable roles of one proposition type so common reasoning can operate across them without duplicating ontology.
- **Observation and interpretation must remain separate.** An observation cannot intrinsically support or challenge architectural intent. Any support or challenge is an assessment/assertion whose actor, method, confidence, time, and other qualifications can be represented when needed.
- **Choice, proposition, and realization must remain distinct.** A Decision records what an authority chose; a Proposition states something asserted or required; a Realization records what currently exists. Choosing or implementing something must not itself make that mechanism architectural truth.
- **Public scope must not create a parallel ontology.** Public `TC-*` trust statements use the same proposition model with explicit visibility, status, scope, and projection semantics. A public projection may narrow or weaken internal intent but cannot silently strengthen it.
- **Agency and context must remain extensible.** Future decisions, observations, assessments, executions, and authorizations must be able to identify responsible actors/principals, and propositions must be scopeable to repository/platform/environment, without redesigning the core intent graph. Actor or Context becomes a base node only if real usage earns that identity.
- **Consumer repositories must be able to own intent independently.** The semantic model must not assume Pelaggio itself is the only graph owner or require a consumer repository to depend on Pelaggio's own corpus. Graph composition / federation remains a future decision, not an implicit global graph.
- **The ontology must expand only when usage earns it.** SACM, GSN, PROV, ArchiMate, and related models inform the semantic seams but do not justify importing their full class hierarchies. Prefer roles, attributes, or qualified relationships until Pelaggio needs irreducible semantics they cannot carry.
- **Generated views are projections, not authority.** CLI answers, diagrams, web explorers, GitHub renderings, and marketing views must be reproducible from semantic graph/query definitions rather than becoming independent maintained copies.
- **Migration must be ratcheted, not declared complete by convention.** The graph cannot become authoritative while existing ADR/trust artifacts can introduce load-bearing intent without a mechanical coverage or reconciliation signal.

## Alternatives not taken

- **Keep ADR prose authoritative and add a graph only for visualization** — preserves the duplication and semantic-reconstruction burden the experiment is intended to remove.
- **Replace ADRs entirely with graph nodes** — discards useful narrative, historical context, trade-off explanation, and decision archaeology that are not well represented as semantic primitives.
- **Use separate Claim, Constraint, Assumption, and ExternalClaim base classes** — encodes differences in propositional role or publication scope as ontology when those semantics can remain explicit attributes of one proposition model.
- **Adopt a full assurance/provenance metamodel now** — imports complexity before Pelaggio has demonstrated a need for those classes and relationships.
- **Adopt a graph database or hosted service as the source of truth** — adds synchronization and availability boundaries before the small git-native representation has earned them.
- **Make the shadow graph authoritative immediately** — mistakes a promising extraction for a validated maintenance system and repeats the premature-constitutionalization failure this work is intended to correct.

## Consequences

- (+) Architectural questions such as "why does this exist?", "what would this change affect?", and "what machinery is orphaned?" can become executable and renderer-independent.
- (+) A smaller semantic kernel is easier for consumer repositories and tooling to adopt without inheriting Pelaggio's documentation history.
- (+) ADRs can become shorter, more useful historical narratives instead of carrying duplicated constitutional prose.
- (+) Existing dogfood activity can accumulate assurance automatically once observations and assessments are linked.
- (−) During migration, prose and graph coexist and require explicit drift checks until authority is promoted.
- (−) Semantic extraction remains judgmental; CI can enforce coverage and reviewed relationships but cannot prove that a human/model classified every proposition correctly.
- (−) Promotion creates a new authoring obligation: architectural changes must update semantic intent, so the workflow must make that obligation cheaper than maintaining today's prose constellation.

## Construction

`docs/assurance/README.md` — shadow ontology, query/projection model, maintenance rules, and promotion constraints.
