# Shadow assurance corpus

Status: **experimental / non-authoritative**.

This directory is a semantic projection of the current ADR corpus and public trust-claim registry. It tests whether Pelaggio can represent architectural intent as stable graph primitives while leaving ADR prose to carry narrative, history, and trade-off explanation.

The shadow graph deliberately does **not** replace `docs/decisions/*` or `docs/trust/trust-claims.yml` yet.

## Node model

The experiment uses these semantic roles:

- **claim** — something Pelaggio intends to remain true;
- **constraint** — a boundary any replacement must preserve, usually because a known failure or external obligation proved it matters;
- **decision** — a deliberate choice made at a point in time, which may later be superseded without rewriting history;
- **assumption** — an empirical proposition relied upon by a decision and capable, in principle, of being challenged by observation;
- **construction** — how the current implementation realizes intent;
- **external-claim** — an existing `TC-*` public trust claim projected, with its own scope/status, onto the normalized internal graph;
- **evidence**, **subject**, and **assessment** remain the next slice, when actual run/test/PR artifacts attach automatically.

The anchoring rule is:

> Claims say what Pelaggio promises to preserve. Decisions say what we chose. Assumptions say what we believe about the world. Constraints say what replacements must not forget. Construction says what happens to implement it today.

## Relation model

Relations are typed in `shadow-graph.json`. The current vocabulary is intentionally small: `constrains`, `implements`, `assumes`, `supersedes`, `specializes`, `derived-from`, `projects`, `supports`, and `challenges`.

`TC-*` links are **projections**, not aliases. A public projection may narrow scope or expose a weaker current status than the internal architectural intent; it must never silently strengthen that intent.

## Source grounding vs code grounding

The graph has two independent maintenance checks:

1. **Source grounding** protects the semantic extraction. High-risk cuts carry source paths plus small textual anchors into the ADR/trust corpus. If the source proposition moves or changes, CI forces reconciliation rather than allowing the graph and prose to drift silently.
2. **Construction evidence** protects the current implementation. Construction nodes carry current code/test paths, and CI verifies those paths still exist.

Durable claims deliberately do **not** contain source-code paths or symbols. A refactor should be able to replace construction without changing claim identity. Code linkage belongs on construction/evidence; tests and runtime artifacts are what eventually support or challenge claims.

This means ordinary construction tests do much of the implementation-validation duty, but only if Pelaggio knows which construction they evidence. The graph provides that association without duplicating test results into documentation.

## Questions are first-class projections

`views.json` versions the questions we expect the graph to answer. The initial catalog includes:

- **architecture** — what durable architectural intent does Pelaggio preserve?
- **why** — why does a node exist, what constrains it, and what realizes it today?
- **affected** — what intent could a decision, construction, ADR, or change affect?
- **debt** — what machinery or intent is unsupported, orphaned, stale, or contradictory?
- **trust** — how do public trust claims project from internal intent and current evidence?
- **review** — why does the current review strategy exist and what survives if it changes?
- **landing** — what must remain true if the current landing mechanism changes?

These are semantic queries, not UI definitions. A CLI, GitHub rendering, local web UI, hosted dashboard, or marketing site should consume the same query definitions.

### Trial visualization

`ci/assurance-views.ts` projects statically renderable views into Mermaid. GitHub can render the checked-in generated Markdown directly:

- [`generated/architecture.md`](./generated/architecture.md) — the durable claim graph;
- [`generated/review.md`](./generated/review.md) — review intent, strategy, assumption, and surrounding constraints.

Regenerate them with:

```bash
node --import tsx ci/assurance-views.ts --write
```

CI verifies the checked-in views are exactly derivable from the canonical graph and query catalog. Visualization-specific positions, colors, and grouping deliberately do not live in `shadow-graph.json`.

## Audience / surface split

The same graph should support different projections without creating different sources of truth:

- **GitHub / OSS repo:** generated Mermaid/SVG-style views for review, architecture navigation, and public inspectability.
- **Pelaggio local product:** the primary operator surface for `why`, `affected`, `debt`, and per-change assurance exploration. It should work without a hosted service.
- **Hosted Pelaggio:** organization/repository aggregation, historical evidence, cross-repo posture, and richer interactive exploration. It consumes portable graph/evidence rather than owning local semantics.
- **Marketing website:** curated public-safe projections such as the architecture/custody spine and an illustrative Change Dossier journey. These should be generated from the same public graph but are presentation, not authority.

A future interactive explorer can use Cytoscape.js or a similar renderer over the same selected nodes/edges. The query layer should stabilize before the renderer does.

## Why this is useful

The graph should answer architectural questions without treating historical construction as constitutional truth. Examples encoded as executable tests include:

- If the fixed six-step/two-orchestrator topology in ADR-0022 disappeared tomorrow, what intent must survive?
- Why does the N-reviewer + Judge construction exist, and which empirical assumption would evidence need to validate or challenge?
- What semantic constraints make landing safe even if its current CAS implementation changes?
- Can a human principal exercise judgmental authority without weakening the deterministic safety floor?
- Are public `TC-*` claims scoped projections rather than a second architecture registry?
- Can restart durability survive without requiring deterministic LLM replay?
- Is any construction now orphan machinery with no articulated purpose?

Run the corpus tests with:

```bash
pnpm test:ci
```

`ci/__tests__/shadow-assurance.test.ts` validates graph integrity, relation typing, source grounding, construction evidence, and semantic question contracts. `ci/__tests__/assurance-views.test.ts` validates the versioned question catalog and generated visual projections. Semantic question tests protect a reviewed interpretation from accidental drift; source-grounding tests are a separate guard against the graph merely agreeing with itself.

## Migration rule

Broad extraction, narrow commitment:

1. Keep the graph shadow-only while its ontology and deduplication are challenged.
2. Prefer stable IDs plus mutable human-readable slugs.
3. Do not copy machine evidence into prose nodes; future evidence should link to immutable run/test/PR subjects.
4. Existing `TC-*` identifiers remain stable external identities and retain their own status/scope.
5. ADRs remain valuable narrative/history, but should eventually reference graph primitives rather than independently restate architectural truth.
6. Code paths belong on construction/evidence, never on durable claims.
7. Queries/views are projections of the graph and may be freely regenerated or replaced.
8. No runtime or trust guarantee may cite this shadow graph until a later decision explicitly promotes it to an authoritative source.

## Current extraction caveats

The first corpus is AI-assisted and intentionally opinionated. The pre-review attack produced four material corrections: `deterministic-authority` split into `no-self-authorization` and `deterministic-safety-floor`; public aliases became scoped projections; `rigor-by-consequence` became a policy decision; and human value judgment moved from assumption to responsibility decision.

Open ontology questions are recorded in `shadow-graph.json` under `extraction.openQuestions`.
