# Shadow assurance corpus

Status: **experimental / non-authoritative**.

This directory is a semantic projection of the current ADR corpus and public trust-claim registry. It tests whether Pelaggio can represent architectural intent as stable graph primitives while leaving ADR prose to carry narrative, history, and trade-off explanation.

The shadow graph deliberately does **not** replace `docs/decisions/*` or `docs/trust/trust-claims.yml` yet.

## Node model

The current semantic kernel is deliberately small:

- **proposition** — something asserted about the system or world, with `role: invariant | constraint | assumption`;
- **decision** — a deliberate choice made at a point in time, which may later be superseded without rewriting history;
- **realization** — what currently exists to implement a decision or proposition.

`TC-*` trust records are propositions too. Their stable public IDs, visibility, status, scope, and projection metadata do not create a parallel node hierarchy.

The anchoring rule is:

> Propositions say what we believe or require. Decisions say what we chose. Realizations say what exists. Observations say what happened. Assessments say what that means.

The final two concepts are deliberately **future-facing**, not current node kinds. The evidence slice is expected to introduce **subject**, **observation**, **assessment**, and likely **actor** only when real custody queries require them. An observation must never intrinsically `support` or `challenge` intent; that interpretation belongs to an attributable assessment.

Existing `CLM-*`, `CON-*`, `ASM-*`, `CTR-*`, and `TC-*` identifiers remain stable through the ontology collapse. Their prefixes are historical identities, not type declarations.

## Relation model

Relations are typed in `shadow-graph.json`. The current vocabulary remains intentionally conservative: `constrains`, `implements`, `assumes`, `supersedes`, `specializes`, `derived-from`, and `projects`.

The class collapse does not erase role semantics: `constrains` must originate at a constraint proposition; `assumes` must target an assumption proposition; public `projects` edges originate at public propositions. Epistemic `supports` / `challenges` relations are intentionally absent until Assessment exists.

## Source grounding vs code grounding

The graph has two independent maintenance checks:

1. **Source grounding** protects semantic extraction. High-risk cuts carry source paths plus small textual anchors into the ADR/trust corpus. If the source proposition moves or changes, CI forces reconciliation rather than allowing graph and prose to drift silently.
2. **Realization evidence** protects current implementation. Realization nodes carry current code/test paths, and CI verifies those paths still exist.

Propositions deliberately do **not** contain source-code paths or symbols. A refactor should be able to replace a realization without changing proposition identity. Code linkage belongs on realization/observation; tests and runtime artifacts can later become observations interpreted by assessments.

## Semantic questions are the stable seam

The graph is not intended to replace model/human reasoning. It supplies stable, typed, attributable premises underneath that reasoning.

Natural-language interpretation and final explanation may be probabilistic. Once a prompt is normalized to a semantic question contract, the deterministic portion of its answer should depend only on represented semantics, binding/provenance, and explicit policy — not on the model's rhetoric, the graph renderer, or a particular traversal implementation.

`views.json` therefore remains a useful catalog of current named projections, not the frozen semantic API. The shadow candidate question grammar and its falsification tests live in `question-contract-experiment.md`.

The current experimental grammar keeps only five operator-intent families (`explain`, `trace`, `challenge`, `recover`, `steer`) plus retrieval/semantic-diff operations and optional qualifiers. This vocabulary is intentionally **not promoted**: families and qualifiers must survive real prompt, paraphrase, composition, cross-agent, and deletion tests before becoming stable conventions.

Question failure is diagnosed before schema growth. A failure may come from missing semantic knowledge/relation, missing binding/provenance, missing runtime/control-state semantics, insufficient query grammar/planning, or presentation. Only irreducible missing semantics can justify expanding the ontology.

## Question-driven semantic growth

The corpus follows a competency-question ratchet:

1. Start from a consequential operator/stakeholder question.
2. Try to answer it from existing semantic facts and owning runtime/provenance layers.
3. Identify exactly why the answer is unreliable or incomplete.
4. Prefer a new query plan/view over new semantics when the facts already exist.
5. Add a primitive/relation/qualifier only when deletion demonstrably breaks an important question.

Natural-language phrasing, renderer needs, storage representation, and anticipated metamodel completeness do not justify ontology by themselves.

Semantic conformance is behavioral before structural: competency-question fixtures and invariant behavior are more important than field-for-field JSON identity. Different storage/query implementations may interoperate if they preserve semantic identity, relation meaning, and answer behavior; identical JSON interpreted differently is not semantic interoperability.

## Author once, derive broadly

Humans and workers should author the smallest irreducible semantic delta once at the layer that owns it.

Reverse indexes, projections, diagnostics, semantic diffs, views, transport forms, and presentation should be generated or derived wherever possible rather than independently maintained. A feature that requires humans to maintain a second representation of something Pelaggio can already determine is presumptively a design smell.

Likewise, a worker should not be asked to author facts that the harness can determine more reliably itself. Future observation/assessment records should receive identity, state binding, run/attempt/provider context, completeness, and authoritative execution outcomes from the harness rather than model prose.

## Interoperability and extension posture

Standardize meaning before representation. Stable semantic identity, relation meaning, competency-question behavior, and authority distinctions form the compatibility contract; JSON shape, graph database, indexes, query implementation, MCP/tool names, and renderers are replaceable choices.

Consumer repositories must be able to own and evolve their corpora independently under the same semantic contract. They must not require Pelaggio's own graph or a global registry to understand local intent. Cross-graph composition/federation remains deliberately undecided; future composition must not implicitly transfer authority between graph owners.

Optional extensions may add semantics but may not redefine existing semantics. An unknown extension may be ignored only when ignoring it cannot strengthen a claim, grant authority, erase uncertainty, or create false equivalence. Otherwise the result must remain explicitly unsupported/unknown, or fail closed if an authority-bearing decision depends on it.

## Versioned questions and projections

`views.json` is a renderer-neutral catalog of questions Pelaggio should answer from the graph:

- **architecture** — what invariant propositions does Pelaggio currently preserve?
- **why** — why does this node exist, what constrains it, and what realizes it today?
- **affected** — what intent could this node/source/change affect?
- **debt** — what realization or intent is orphaned, unsupported, stale, or contradictory?
- **trust** — what public propositions project from internal intent and at what status/scope?
- **review** — why does the current review strategy exist and what survives if it changes?
- **landing** — what must remain true if the current landing realization changes?

The query layer is separate from presentation. GitHub gets generated Mermaid projections for selected static views; local or hosted explorers can consume the same selected subgraphs later without changing semantic state.

## Stress-test findings

The first stress pass found that several high-value questions existed only in the view catalog. The query engine now executes parameterized `why` / `affected` traversal and structural debt diagnostics, and tests mutate the graph in memory to prove diagnostics detect orphan realizations and unused assumptions.

A second question/qualifier stress pass found that the ontology did not need to grow for most richer operator questions. Assumption lifecycle questions can be expressed through Assessment rather than `revisitOn`; generic Context/Actor/Policy/Defeater nodes remain unearned; recovery authority belongs to runtime/control state; and `what changed?` is primarily a semantic-diff/query problem.

The same pass found 5W1H more useful as an answer-completeness lens than as the question API, and recursive branch-preserving explanation more useful than a linear Five-Whys/root-cause chain. These findings remain shadow hypotheses in `question-contract-experiment.md` rather than promoted vocabulary.

The top-level architecture view remains intentionally sparse. Most invariant propositions are not naturally a causal chain. Marketing/product story views may sequence them for explanation, but that sequence must not become a fake semantic relation.

Public views are constrained to projection-safe proposition data. More granular sensitivity/export policy belongs with observation/subject data once those exist.

## Why this is useful

Executable questions now include:

- If ADR-0022's fixed topology disappeared tomorrow, what intent must survive?
- Why does N-reviewer + Judge exist, and which empirical assumption should later evidence test?
- What constraints make landing safe even if its current CAS realization changes?
- Can principal judgment remain distinct from deterministic safety enforcement?
- Are `TC-*` records scoped public propositions rather than a second architecture registry?
- Can restart durability survive without deterministic LLM replay?
- Is any realization orphan machinery with no articulated purpose?
- Can the same semantic contract describe consumer-owned repository intent without depending on Pelaggio's own graph?

The shadow question-contract experiment adds higher-order prompts such as:

- What could make this architectural conclusion wrong?
- What evidence or state transition would clear this block?
- What may an operator steer without weakening a durable invariant?
- What changed semantically rather than textually?
- Can different agents receive the same bounded semantic premises while synthesizing different explanations?

Run the corpus tests with:

```bash
pnpm test:ci
```

`ci/__tests__/shadow-assurance.test.ts` validates graph integrity, proposition roles, source grounding, realization evidence, and semantic question contracts. `ci/__tests__/assurance-views.test.ts` stress-tests query execution, diagnostics, public projection boundaries, and generated views.

## Migration rule

Broad extraction, narrow commitment:

1. Keep the graph shadow-only while ontology and deduplication are challenged.
2. Prefer stable IDs plus mutable human-readable slugs; never renumber merely because classification changes.
3. Treat invariant, constraint, and assumption as proposition roles, not separate base types.
4. Keep proposition, decision, and realization semantically distinct.
5. Do not copy machine observations into prose nodes; future observations should reference immutable run/test/PR subjects and be interpreted through assessments.
6. Existing `TC-*` identifiers remain stable public proposition identities with their own status/scope.
7. ADRs remain valuable narrative/history, but should eventually reference graph primitives rather than independently restate architectural truth.
8. Code paths belong on realizations/observations, never on propositions.
9. View/query definitions remain semantic and renderer-neutral; visual layout/style is not canonical graph state.
10. Treat question meaning/behavior as the stable interoperability seam; keep question vocabulary experimental until usage earns promotion.
11. Diagnose question failure before adding semantic primitives; prefer query/view changes when the facts already exist.
12. Author irreducible semantic facts once and derive reversible indexes/projections/transport/presentation.
13. Consumer repositories must be able to own their own intent graph under the same semantic contract; composition/federation remains deliberately undecided and must not imply authority transfer.
14. Unknown extensions may be ignored only when doing so cannot strengthen authority/assurance or erase uncertainty.
15. Do not import full SACM/GSN/PROV/ArchiMate class hierarchies unless Pelaggio usage demonstrates irreducible semantics that roles, attributes, or qualified relationships cannot represent.
16. No runtime or trust guarantee may cite this shadow graph until a later decision explicitly promotes it to an authoritative source.

## Current extraction caveats

The corpus is AI-assisted and intentionally opinionated. Pre-review attacks have already split overbroad authority concepts, demoted policy from invariant status, converted public aliases to scoped projections, and collapsed claim/constraint/assumption/external-claim into one proposition base type while preserving semantic roles.

Open ontology questions are recorded in `shadow-graph.json` under `extraction.openQuestions`.
