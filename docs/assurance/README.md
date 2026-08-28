# Shadow assurance corpus

Status: **experimental / non-authoritative**.

This directory is a semantic projection of the current ADR corpus and public trust-claim registry. It tests whether Pelaggio can represent architectural intent as stable graph primitives while leaving ADR prose to carry narrative, history, and trade-off explanation.

The shadow graph deliberately does **not** replace `docs/decisions/*` or `docs/trust/trust-claims.yml` yet.

## Node model

The current semantic kernel is deliberately small:

- **proposition** — something asserted about the system or world, with `role: invariant | constraint | assumption`. Assumption propositions carry exactly one of `wrongIf`, a counterexample that settles the claim, or `revisitIf`, a trigger to look again;
- **decision** — a deliberate choice made at a point in time, which may later be superseded without rewriting history. `status` is a closed five-value vocabulary: `current-construction-choice`, `current-policy-choice`, `target-construction-choice`, `proposed-construction-choice`, `historical-construction-choice`. A current construction choice owes an explicit `realization -derived-from-> decision` edge naming what currently builds it; a current policy choice configures behavior and does not require a realization node. Target, proposed, and historical construction choices are not claimed built;
- **realization** — what currently exists to implement a decision or proposition.

`TC-*` trust records are propositions too. Their stable public IDs, visibility, status, scope, and projection metadata do not create a parallel node hierarchy.

The anchoring rule is:

> Propositions say what we believe or require. Decisions say what we chose. Realizations say what exists. Observations say what happened. Assessments say what that means.

The final two concepts are deliberately **future-facing**, not current node kinds; a candidate *artifact* grammar for an assessment (proposition, basis, conclusion, residual) is prototyped as a stacked slice (#626), not as a graph node. The evidence slice is expected to introduce **subject**, **observation**, **assessment**, and likely **actor** only when real custody queries require them. An observation must never intrinsically `support` or `challenge` intent; that interpretation belongs to an attributable assessment.

Existing `CLM-*`, `CON-*`, `ASM-*`, `CTR-*`, and `TC-*` identifiers remain stable through the ontology collapse. Their prefixes are historical identities, not type declarations.

## Relation model

Relations are typed in `shadow-graph.json`. The current vocabulary remains intentionally conservative: `constrains`, `implements`, `assumes`, `supersedes`, `specializes`, `derived-from`, and `projects`.

The class collapse does not erase role semantics: `constrains` must originate at a constraint proposition; `assumes` must target an assumption proposition; public `projects` edges originate at public propositions. Epistemic `supports` / `challenges` relations are intentionally absent until Assessment exists.

## Source grounding vs code grounding

The graph has two independent maintenance checks:

1. **Source grounding** protects semantic extraction. High-risk cuts carry source paths plus small textual anchors into the ADR/trust corpus. CI verifies only that each anchor substring still occurs somewhere in its source file: deleting or rewording an anchored sentence forces reconciliation; moving text within the file, or changing the proposition outside the anchored snippets, is **not** detected. The `stale-source-grounding` debt check reports the same condition as a diagnostic.
2. **Realization evidence** protects current implementation. Realization nodes carry current code/test paths, and CI verifies those paths still exist — existence only, not revision-bound evidence that the mechanism still does what the realization says (ADR-0027 keeps realization claims non-authoritative until they are bound or observation-backed).

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

## Author once; standardize meaning before representation

The maintenance and interoperability rules — author the irreducible semantic fact once and derive indexes, projections, diagnostics, diffs and transport; standardize meaning before representation; consumer-owned corpora and undecided federation; extensions that may not silently strengthen a claim — are ADR-0027 decisions 5, 8 and 9 and its constraints, not restated here. In this corpus they show up concretely: `adrMap` is generated from each node's `sources` by `node --import tsx ci/assurance-views.ts --write` (the same command that regenerates the Mermaid views) and a test fails when the stored copy is stale, so the ADR→primitive relation is authored once; a worker is never asked to author a fact the harness can observe.

## Versioned questions and projections

`views.json` is a renderer-neutral catalog of questions Pelaggio should answer from the graph:

- **architecture** — what internal invariant propositions does Pelaggio currently preserve? (Public `TC-*` invariants are routed to **trust**.)
- **why** — why does this node exist, what constrains it, and what realizes it today?
- **affected** — what intent could this node/source/change affect?
- **debt** — what realization or intent is orphaned, unsupported, or stale? (No check detects contradiction; that needs assessments.)
- **trust** — which public propositions exist, at what projection status and scope? It is public-audience, so it lists public nodes only; the internal intent a `TC-*` projects onto (the `projects` edge originates at the public proposition) is reached per node through **why**, not through this view.
- **review** — why does the current review strategy exist and what survives if it changes?
- **landing** — what must remain true if the current landing realization changes?

The query layer is separate from presentation. GitHub gets generated Mermaid projections for selected static views; local or hosted explorers can consume the same selected subgraphs later without changing semantic state.

## Stress-test findings

The first stress pass found that several high-value questions existed only in the view catalog. The query engine now executes parameterized `why` / `affected` traversal, and all nine checks the `debt` view declares are implemented in `ci/assurance-views.ts`, bound to `views.json` by test (a declared check nothing implements fails), and fire through the view itself — `stale-source-grounding` reads the graph's own groundings from the repository by default, while callers evaluating another owner can supply that owner's diagnostics environment. Tests mutate the graph in memory to prove each check fires. On the current corpus the diagnostics report five internal invariants that name no realization — CLM-0001 (untrusted input: confinement bounds blast radius but is not an injection defense, and TC-015 says best_effort), CLM-0006 (no self-authorization: the required `review` status is planned branch protection per TC-013, `land --admin` bypasses the pin, and two CLIs post the status — no mechanism yet holds the property), CLM-0008 (verifiable custody: execution receipts are a bespoke effects manifest and the ADR-0018 in-toto envelope is not applied), CLM-0020 (single-source intent: the graph is a shadow and cannot realize its own promotion), CLM-0021 (no undeclared egress: the registry's denylist grep is evidence, not enforcement) — and one public guarantee, TC-002, that projects onto that last unrealized intent (`projection-overreach`). `selectView(debt)` now also reports `constraint-without-enforcement` for each unbound constraint proposition: the corpus has 29 constraints, 23 bound, so 6 live hits; the Q17 ceiling is frozen at exactly those 6. #650 reduced the ceiling from 29 to 9 by binding 20 constraints — seven to the conformance suite and thirteen to realizations that already existed. #680 reduced it from 9 to 8 by correcting ADR-0027's forward-looking kernel-sufficiency claim and its shadow node, `CON-0024`, to an assumption. #681 reduced it from 8 to 7 by binding CON-0018 to CTR-0022 on a paired no-false-fire/true-fire fixture over enumerated intent-preserving source and realization-path edits; that fixture is not a proof that every intent-preserving edit is accepted (see `extraction.decided`), and anchored-sentence edits may still require `sourceGrounding` reconciliation, which is verification-artifact maintenance outside CON-0018's semantic-state promise. #682 reduced it from 7 to 6 by binding CON-0025 to CTR-0022 via `docs/assurance/owner-independence-fixture.json`, a second-owner graph the live schema, query engine, views, and diagnostics operate on. Its source grounding resolves and validates relative to the synthetic consumer root, and the shared source reader rejects lexical and symlink escapes from that root; the paired default-root run diagnoses the same foreign path. That fixture is owner-independence of the current checks, not a competency-question or interoperability contract (ADR-0027 decision 7). Each of the 6 constraints that remain carries a written reason in the corpus at `extraction.unenforcedConstraints`, pinned against the ceiling by the same test: four are genuine gaps behind `proposed` ADRs (`CON-0004` the ADR-0025 landing fence, `CON-0028`/`-0029`/`-0030` the ADR-0028 delivery packet), and two are false binds removed after review exposed missing enforcement (`CON-0007`, whose attempt identity lacks the anti-rollback register and consumer fence needed for authority, and `CON-0016`, whose public projection is not semantically compared with its internal claim). `selectView(debt)` now also reports `decision-without-realization` for three current-construction choices that name no realizing machinery — DEC-0003 (signed-tag-provenance-publish), DEC-0008 (in-toto-envelope), and DEC-0011 (ocap-effects-placement). Target (`DEC-0015`), proposed (`DEC-0020` / `DEC-0019`), historical (`DEC-0002`), and current-policy decisions are excluded by status class; a choice-to-choice `derived-from` does not count. Explicit-link and path-existence evidence only — the diagnostic does not prove a named realization implements the decision. The graph carries 20 realizations: 5 from the original extraction, 7 named in the #616 reconciliation, 6 named in that pass, and 2 added by #650's binding pass. Review removed five nodes rather than softening claims they did not implement — `CLM-0014`, `CTR-0014`, `CTR-0019`, `CTR-0020`, and `CTR-0024` are therefore permanent ID gaps, recorded in `extraction.decided` so "removed after review" stays distinguishable from "never existed". Realization evidence here is path existence only — which ADR-0027 decision 4 says is *not* evidence that the mechanism does what the node claims; that is why realization claims stay non-authoritative, and why `constraint-without-enforcement` does not prove a named realization actually enforces its proposition. These counts are not ratcheted; rerun `selectView(debt)` rather than trusting prose. Two earlier entries (a decision with no semantic relationship, an assumption nothing assumed) were encoding gaps in ADR-0012 and ADR-0017's decisions and were closed by authoring the missing, source-anchored nodes.

A second question/qualifier stress pass found that the ontology did not need to grow for most richer operator questions. Assumption lifecycle questions can be expressed through Assessment rather than `revisitOn`; generic Context/Actor/Policy/Defeater nodes remain unearned; recovery authority belongs to runtime/control state; and `what changed?` is primarily a semantic-diff/query problem.

The same pass found 5W1H more useful as an answer-completeness lens than as the question API, and recursive branch-preserving explanation more useful than a linear Five-Whys/root-cause chain. These findings remain shadow hypotheses in `question-contract-experiment.md` rather than promoted vocabulary.

The top-level architecture view remains intentionally sparse. Most invariant propositions are not naturally a causal chain. Marketing/product story views may sequence them for explanation, but that sequence must not become a fake semantic relation.

Public-audience views are constrained to proposition nodes with role `invariant` — that is the whole of "projection-safe" today, enforced in `assurance-views.test.ts`. The public-audience `architecture` view therefore publishes the slugs of internal-visibility invariants into the checked-in Mermaid projection (the renderer labels nodes by slug, not statement); a finer sensitivity/export policy belongs with observation/subject data once those exist.

## Why this is useful

Executable questions now include:

- If ADR-0022's fixed topology disappeared tomorrow, what intent must survive?
- Why does N-reviewer + Judge exist, and which empirical assumption should later evidence test?
- What constraints make landing safe even if its current CAS realization changes?
- Can principal judgment remain distinct from deterministic safety enforcement?
- Are `TC-*` records scoped public propositions rather than a second architecture registry?
- Can restart durability survive without deterministic LLM replay?
- Is any realization orphan machinery with no articulated purpose?
- Do the current schema, query, view, and diagnostic checks operate on a graph that does not belong to Pelaggio? (Q13 — `docs/assurance/owner-independence-fixture.json` is a second-owner graph with foreign IDs; the suite validates it through the live ontology and every `views.json` entry. Its own source grounding validates under the synthetic consumer root, whose reader rejects paths that escape that root, while the paired Pelaggio-root control emits all nine `DEBT_CHECKS`, including `stale-source-grounding` for the foreign path. Catalog seeds still fail on that graph without an override. This is owner-independence of the current checks, not a competency-question or interoperability contract under ADR-0027 decision 7.)
- Does every public claim published as an unconditional guarantee name the mechanism that implements it? (Q14 — the registry is enumerated from `trust-claims.yml`, every record must be in the graph with its registry status (Q5), and one guarantee currently names no mechanism — TC-002, whose registry evidence command is a denylist grep, which is evidence rather than an enforcing mechanism; the live set is computed, pinned exactly by `deepEqual` in the test, and bounded by a frozen ceiling — naming a mechanism and admitting a gap are both visible test edits, and the pin is the stricter of the two.)
- Can a constraint proposition bind a mechanism, not only intent? (Q15 — `CON-0027` constrains `CTR-0004`; a rule about how guards are built is intent, not a construction convention. Grounding for that relationship is the two-channel Git-porcelain snapshot in `docs/agent-context/guarded-actions.md` §8.2: a `.git/config` origin rewrite the snapshot does not report, and an ignored `.dev/` write `git status --porcelain` is structurally unable to observe.)
- Does every constraint proposition name an enforcing realization? (Q17 — accepted encodings are constraint `constrains` realization, or realization `implements` constraint; intent-only `constrains` to a proposition or decision, and a decision `implements` a constraint, are not enforcement. Live unenforced IDs come from `diagnostics()`, membership-checked against a frozen ceiling of the 6 currently-unenforced IDs: `CON-0004`, `CON-0007`, `CON-0016`, `CON-0028`, `CON-0029`, and `CON-0030`. #681 bound CON-0018 to CTR-0022 via a paired no-false-fire/true-fire fixture over enumerated intent-preserving edits; that fixture is not a proof that every intent-preserving edit is accepted (see `extraction.decided`). #682 bound CON-0025 to CTR-0022 via the owner-independence fixture; CON-0025 still constrains CLM-0020 as intent. A newly authored unbound constraint fails because it is absent from the ceiling; binding a constraint and later dropping its ID is a visible, reviewable edit. Path-existence only — the diagnostic does not prove the realization enforces the proposition.)
- Does every assumption proposition name exactly one counterexample or revisit trigger? (Q18 — `assumption-without-falsifier` fires unless exactly one of `wrongIf` and `revisitIf` is present and at least 40 characters after trim. The live corpus is empty of this diagnostic; invariants and constraints are not required to carry either field. Existence, exclusivity, and non-triviality only — the diagnostic does not validate that the condition is empirically the right one.)
- Does every current construction choice name realizing machinery? (Q19 — `decision-without-realization` fires only for `current-construction-choice` decisions with no incoming `derived-from` from a realization. The live set is pinned to `DEC-0003`, `DEC-0008`, and `DEC-0011`. Target (`DEC-0015`) and proposed (`DEC-0020`) construction choices, plus current-policy and historical decisions, do not fire; a choice-to-choice `derived-from` does not count. Explicit-link and path-existence evidence only — the diagnostic does not prove the realization implements the decision.)
- Is every always-loaded AGENTS.md invariant either represented in the graph or explicitly a construction rule? (Q16 — `invariantIndex`, matched by anchor substring, with the same limitation as source grounding: a bullet strengthened or weakened around its anchor is not detected.)

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

`ci/__tests__/shadow-assurance.test.ts` validates graph integrity, proposition roles, source grounding, realization evidence, ADR and AGENTS.md coverage, and the semantic questions Q1–Q19. Q13 is behavioral over `docs/assurance/owner-independence-fixture.json` rather than CON-0025's statement text. `ci/__tests__/assurance-views.test.ts` stress-tests query execution, the nine debt diagnostics, public projection boundaries, and generated views. `ci/__tests__/question-contract-experiment.test.ts` ratchets the boundaries of the candidate question grammar and checks its run record is complete. `ci/__tests__/assessment-experiment.test.ts` ratchets `assessment-experiment.md`, and `ci/__tests__/assessment-shadow.test.ts` demonstrates the shadow disposition properties against `assessment-fixtures.json` (the reading of those runs is in #624). The remaining stacked slice (#623: charter normalization and activity provenance) adds its own document, ratchet test, and run record when it lands; nothing here depends on it.

## Migration rule

Broad extraction, narrow commitment. The ontology and interoperability constraints themselves live in ADR-0027 and are not restated here; what follows is the shadow-phase operating rule:

1. Keep the graph shadow-only while ontology and deduplication are challenged.
2. Prefer stable IDs plus mutable human-readable slugs; never renumber merely because classification changes. Existing `TC-*` identifiers remain stable public proposition identities with their own status/scope.
3. Do not copy machine observations into prose nodes; future observations should reference immutable run/test/PR subjects and be interpreted through assessments.
4. ADRs remain valuable narrative/history, but should eventually reference graph primitives rather than independently restate architectural truth.
5. No runtime or trust guarantee may cite this shadow graph until a later decision explicitly promotes it to an authoritative source.

## Current extraction caveats

The corpus is AI-assisted and intentionally opinionated. Pre-review attacks have already split overbroad authority concepts, demoted policy from invariant status, converted public aliases to scoped projections, and collapsed claim/constraint/assumption/external-claim into one proposition base type while preserving semantic roles.

Open ontology questions are recorded in `shadow-graph.json` under `extraction.openQuestions`. The loudest live finding was a coverage fact rather than an ontology question — six, then three, then one public `guarantee`-status claim had no implementing realization (Q14). One still does: TC-002, "no telemetry", whose registry `evidence_command` is a denylist grep for known SDK names — evidence about a few names, not a mechanism that enforces the absence — so it projects onto intent that nothing realizes (`projection-overreach`). The registry is fully enumerated and the live unlinked set is computed from the graph against a frozen ceiling in the test: a newly published guarantee fails Q5 until it is represented and Q14 until it names a mechanism, and admitting it instead requires editing the frozen set — a visible, reviewable diff, not a silent pass. Whether an unlinked guarantee is a documentation gap or an overstated guarantee is a question for the reconciliation campaign (#624), not something the graph decides.
