---
title: "ADR-0027: Architectural intent converges on one machine-readable graph"
status: proposed
date: 2026-08-22
claims: []
construction: docs/assurance/README.md
---

# ADR-0027 — Architectural intent converges on one machine-readable graph

## Context

Pelaggio's ADR, trust, agent-context, code, and test corpus contains valuable architectural history, but repeated principles have accumulated across prose documents with different scopes and implementation eras. That made current construction easy to mistake for invariant intent, made semantic duplication hard to detect, and required humans or reviewers to reconstruct which statements were still controlling.

The shadow assurance-corpus experiment compresses the existing ADR corpus into stable claims, constraints, decisions, assumptions, and construction links, with executable questions over those relationships. It is intentionally non-authoritative while its ontology, deduplication, and maintenance workflow are validated.

## Decision

1. **Pelaggio architectural intent must have one machine-readable semantic source of truth.** Durable claims, replacement constraints, decisions, assumptions, and their relationships must not require reconciliation across independent prose registries.
2. **Narrative documentation remains valuable but explanatory.** ADRs may preserve context, rationale, rejected alternatives, and historical decisions; narrative prose must not become a second independently maintained definition of current architectural intent.
3. **Machine-produced evidence must be linked rather than manually restated.** Tests, runs, PRs, attestations, and other execution artifacts should eventually attach to the intent graph through machine plumbing; maintaining an existing claim must not require repetitive human bookkeeping.
4. **The current shadow graph is not authoritative yet.** Promotion requires demonstrated corpus coverage, source grounding, low-friction authoring, and query/check behavior that detects drift instead of merely agreeing with its own extraction.

## Constraints on any implementation

- **Architectural identity must survive implementation replacement.** Durable intent must not depend on source-file paths, symbols, renderer coordinates, or other construction details; those belong on construction/evidence links.
- **Narrative edits must not force meaningless graph churn.** Spelling, explanation, rationale, and construction-only changes must be able to leave semantic graph state unchanged when intent did not change.
- **New architectural intent must not bypass the semantic corpus.** Once the graph is promoted, adding or changing a load-bearing invariant, replacement constraint, assumption, or architectural decision must update the graph in the same change.
- **Public trust statements must remain scoped projections, not aliases that silently strengthen internal intent.** External guarantee/status/scope can be narrower than the internal claim but cannot claim more than current evidence supports.
- **Generated views are projections, not authority.** CLI answers, diagrams, web explorers, GitHub renderings, and marketing views must be reproducible from semantic graph/query definitions rather than becoming independent maintained copies.
- **Migration must be ratcheted, not declared complete by convention.** The graph cannot become authoritative while existing ADR/trust artifacts can introduce load-bearing intent without a mechanical coverage or reconciliation signal.

## Alternatives not taken

- **Keep ADR prose authoritative and add a graph only for visualization** — preserves the duplication and semantic-reconstruction burden the experiment is intended to remove.
- **Replace ADRs entirely with graph nodes** — discards useful narrative, historical context, trade-off explanation, and decision archaeology that are not well represented as semantic primitives.
- **Adopt a graph database or hosted service as the source of truth** — adds synchronization and availability boundaries before the small git-native representation has earned them.
- **Make the shadow graph authoritative immediately** — mistakes a promising extraction for a validated maintenance system and repeats the premature-constitutionalization failure this work is intended to correct.

## Consequences

- (+) Architectural questions such as "why does this exist?", "what would this change affect?", and "what machinery is orphaned?" can become executable and renderer-independent.
- (+) ADRs can become shorter, more useful historical narratives instead of carrying duplicated constitutional prose.
- (+) Existing dogfood activity can accumulate assurance automatically once execution evidence is linked.
- (−) During migration, prose and graph coexist and require explicit drift checks until authority is promoted.
- (−) Semantic extraction remains judgmental; CI can enforce coverage and reviewed relationships but cannot prove that a human/model classified every proposition correctly.
- (−) Promotion creates a new authoring obligation: architectural changes must update semantic intent, so the workflow must make that obligation cheaper than maintaining today's prose constellation.

## Construction

`docs/assurance/README.md` — shadow ontology, query/projection model, maintenance rules, and promotion constraints.
