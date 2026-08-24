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

1. **Source grounding** protects semantic extraction. High-risk cuts carry source paths plus small textual anchors into the ADR/trust corpus. CI verifies only that each anchor substring still occurs somewhere in its source file: deleting or rewording an anchored sentence forces reconciliation; moving text within the file, or changing the proposition outside the anchored snippets, is **not** detected. The `stale-source-grounding` debt check reports the same condition as a diagnostic.
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

- **architecture** — what internal invariant propositions does Pelaggio currently preserve? (Public `TC-*` invariants are routed to **trust**.)
- **why** — why does this node exist, what constrains it, and what realizes it today?
- **affected** — what intent could this node/source/change affect?
- **debt** — what realization or intent is orphaned, unsupported, stale, or contradictory?
- **trust** — which public propositions project onto internal intent — the `projects` edge originates at the public proposition — and at what status/scope?
- **review** — why does the current review strategy exist and what survives if it changes?
- **landing** — what must remain true if the current landing realization changes?

The query layer is separate from presentation. GitHub gets generated Mermaid projections for selected static views; local or hosted explorers can consume the same selected subgraphs later without changing semantic state.

## Stress-test findings

The first stress pass found that several high-value questions existed only in the view catalog. The query engine now executes parameterized `why` / `affected` traversal, and all six checks the `debt` view declares are implemented in `ci/assurance-views.ts` and bound to `views.json` by test (a declared check nothing implements fails). Tests mutate the graph in memory to prove each check fires. On the current corpus the diagnostics report 17 internal invariants that name no realization, 4 public guarantees whose projected intent nothing realizes (`projection-overreach`), one decision with no semantic relationship, and one unused assumption — the graph's own open debt, not a claim that the repository is wrong.

A second question/qualifier stress pass found that the ontology did not need to grow for most richer operator questions. Assumption lifecycle questions can be expressed through Assessment rather than `revisitOn`; generic Context/Actor/Policy/Defeater nodes remain unearned; recovery authority belongs to runtime/control state; and `what changed?` is primarily a semantic-diff/query problem.

The same pass found 5W1H more useful as an answer-completeness lens than as the question API, and recursive branch-preserving explanation more useful than a linear Five-Whys/root-cause chain. These findings remain shadow hypotheses in `question-contract-experiment.md` rather than promoted vocabulary.

The top-level architecture view remains intentionally sparse. Most invariant propositions are not naturally a causal chain. Marketing/product story views may sequence them for explanation, but that sequence must not become a fake semantic relation.

Public-audience views are constrained to proposition nodes with role `invariant` — that is the whole of "projection-safe" today, enforced in `assurance-views.test.ts`. The public-audience `architecture` view therefore publishes internal-visibility invariant *statements* into the checked-in Mermaid projection; a finer sensitivity/export policy belongs with observation/subject data once those exist.

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
- Does every public claim published as an unconditional guarantee name the mechanism that implements it? (Q14 — six do not; the set is ratcheted so it may only shrink.)
- Can a construction rule bind a mechanism, not only intent? (Q15 — `CON-0027` binds `CTR-0004`.)
- Is every always-loaded AGENTS.md invariant either represented in the graph or explicitly a construction rule? (Q16 — `invariantIndex`.)

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

`ci/__tests__/shadow-assurance.test.ts` validates graph integrity, proposition roles, source grounding, realization evidence, ADR and AGENTS.md coverage, and the semantic questions Q1–Q16. `ci/__tests__/assurance-views.test.ts` stress-tests query execution, the six debt diagnostics, public projection boundaries, and generated views. `ci/__tests__/question-contract-experiment.test.ts` ratchets the boundaries of the candidate question grammar.

## Migration rule

Broad extraction, narrow commitment. The ontology and interoperability constraints themselves live in ADR-0027 and are not restated here; what follows is the shadow-phase operating rule:

1. Keep the graph shadow-only while ontology and deduplication are challenged.
2. Prefer stable IDs plus mutable human-readable slugs; never renumber merely because classification changes. Existing `TC-*` identifiers remain stable public proposition identities with their own status/scope.
3. Do not copy machine observations into prose nodes; future observations should reference immutable run/test/PR subjects and be interpreted through assessments.
4. ADRs remain valuable narrative/history, but should eventually reference graph primitives rather than independently restate architectural truth.
5. No runtime or trust guarantee may cite this shadow graph until a later decision explicitly promotes it to an authoritative source.

## Current extraction caveats

The corpus is AI-assisted and intentionally opinionated. Pre-review attacks have already split overbroad authority concepts, demoted policy from invariant status, converted public aliases to scoped projections, and collapsed claim/constraint/assumption/external-claim into one proposition base type while preserving semantic roles.

Open ontology questions are recorded in `shadow-graph.json` under `extraction.openQuestions`. The loudest live finding is a coverage fact rather than an ontology question: six public `guarantee`-status claims (TC-003/004/010/011/012/014) name no implementing realization (Q14), and four of them project onto intent that nothing realizes (`projection-overreach`). Whether that is a documentation gap or an overstated guarantee is a question for the reconciliation campaign (#624), not something the graph decides.
