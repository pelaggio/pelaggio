# Shadow assurance corpus

Status: **experimental / non-authoritative**.

This directory is a semantic projection of the current ADR corpus and public trust-claim registry. It tests whether Pelaggio can represent architectural intent as stable graph primitives while leaving ADR prose to carry narrative, history, and trade-off explanation.

The shadow graph deliberately does **not** replace `docs/decisions/*` or `docs/trust/trust-claims.yml` yet.

## Node model

The experiment uses eight semantic roles:

- **claim** — something Pelaggio intends to remain true;
- **constraint** — a boundary any replacement must preserve, usually because a known failure or external obligation proved it matters;
- **decision** — a deliberate choice made at a point in time, which may later be superseded without rewriting history;
- **assumption** — an empirical premise a decision relies on and which evidence may challenge without invalidating the underlying claim;
- **construction** — how the current implementation realizes intent;
- **external-claim** — an existing `TC-*` public trust claim projected onto the normalized internal graph;
- **evidence** and **assessment** are reserved for the next slice, when actual run/test/PR artifacts begin attaching automatically;
- subjects are currently referenced through source IDs/paths rather than emitted as explicit nodes.

Edges are intentionally small: `supports`, `challenges`, `constrains`, `implements`, `assumes`, `supersedes`, `specializes`, `derived-from`, and `aliases`.

## Why this is useful

The graph should answer architectural questions without treating historical construction as constitutional truth. Examples encoded as executable tests include:

- If the fixed six-step/two-orchestrator topology in ADR-0022 disappeared tomorrow, what intent must survive?
- Why does the N-reviewer + Judge construction exist, and which assumption would evidence need to validate or challenge?
- What semantic constraints make landing safe even if its current CAS implementation changes?
- Which formerly duplicated ADRs are really specializations of one deterministic-authority claim?
- Are public `TC-*` claims projections of internal architecture rather than a second architecture registry?
- Can restart durability survive without requiring deterministic LLM replay?

Run the corpus tests with:

```bash
pnpm test:ci
```

`ci/__tests__/shadow-assurance.test.ts` validates graph integrity and these semantic question contracts. A change to the corpus is therefore expected to explain whether it intentionally changes an architectural answer, not merely update JSON until parsing succeeds.

## Migration rule

Broad extraction, narrow commitment:

1. Keep the graph shadow-only while its ontology and deduplication are challenged.
2. Prefer stable IDs plus mutable human-readable slugs.
3. Do not copy machine evidence into prose nodes; future evidence should link to immutable run/test/PR subjects.
4. Existing `TC-*` identifiers remain stable external identities.
5. ADRs remain valuable narrative/history, but should eventually reference graph primitives rather than independently restate architectural truth.
6. No runtime or trust guarantee may cite this shadow graph until a later decision explicitly promotes it to an authoritative source.

## Current extraction caveats

The first corpus is AI-assisted and intentionally opinionated. In particular it treats ADR-0022's fixed topology and ADR-0024's N+Judge review arrangement as decisions/construction rather than timeless claims, while preserving independent evaluation and blocker persistence as durable claims. Those are testable hypotheses, not silent migrations.

Open ontology questions are recorded in `shadow-graph.json` under `extraction.openQuestions`.
