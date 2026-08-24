# Semantic question contract experiment

Status: **experimental / shadow-only**.

This experiment records a deliberately small candidate seam between probabilistic human/model interpretation and deterministic semantic retrieval over the shadow graph (`docs/assurance/shadow-graph.json`, ontology in `docs/assurance/README.md`, decision in `docs/decisions/0027-machine-readable-architectural-intent-graph.md`). It does **not** define a public API, runtime protocol, storage format, transport, or authoritative query vocabulary.

The governing hypothesis is:

> Pelaggio's semantic substrate should provide stable, typed, attributable premises for human and model reasoning rather than replace that reasoning. Natural-language interpretation and synthesis may remain probabilistic; once a question is normalized to a semantic contract, the deterministic portion of its answer must depend only on represented semantics, binding/provenance, and explicit policy rather than model rhetoric or graph implementation details.

## Question-driven semantic growth

The semantic model exists to answer consequential competency questions. A new primitive, relation, or qualifier is earned only when an important question cannot be answered correctly, traceably, and economically from existing semantics.

Before expanding the model, classify an answer failure as one of:

- missing semantic knowledge or relationship;
- missing binding/provenance;
- missing runtime/control-state semantics;
- insufficient question grammar/query planning;
- presentation deficiency.

Only failures that reveal irreducible missing semantics justify ontology growth. Renderer needs, natural-language phrasing, storage/query implementation, or awkward presentation do not.

## Candidate minimal grammar

The current experiment keeps five operator-intent families:

```text
Question {
  family:
    explain
    trace
    challenge
    recover
    steer

  subject        # any addressable semantic identity: a node id (DEC-0014), a source (ADR-0022), later a bound record id

  qualifiers?:
    direction
    state
    epistemicPosture
    authority
    depth
    scope
}
```

`subject` is an addressable identity, not the future-facing Subject node kind the README reserves for the evidence slice. This grammar is intentionally **not ontology** and is not yet a stable/public API. Each family or qualifier must survive operator-prompt, paraphrase, composition, cross-agent, and deletion tests before promotion.

Current candidate meanings:

- **explain** — expose why something exists/holds and the typed premises relevant to explaining it;
- **trace** — follow explicit semantic relationships upstream/downstream without inventing implied edges;
- **challenge** — expose attributable challenging/unresolved assessments or missing evidence without manufacturing a defeater ontology (its assessment half presupposes records the shadow graph does not yet hold — Q12; its missing-evidence half is already served by the `debt` diagnostics, so until the stacked assessment slice lands `challenge` degrades to those and the `epistemicPosture` qualifier retrieves nothing);
- **recover** — identify what evidence/state transition would permit progress, while keeping clearing authority in runtime/control semantics rather than model suggestion;
- **steer** — expose which decisions/policy/configuration may change within the constraints of durable intent and authority boundaries.

`retrieve(subject)` and `semantic-diff(before, after)` are separate operations rather than question families unless usage proves otherwise.

Candidate qualifiers are likewise provisional:

- **direction** — upstream/downstream traversal where meaningful;
- **state** — current, historical, target, or a specific binding/version;
- **epistemicPosture** — supporting, challenging, unresolved;
- **authority** — any, advisory, judgment, enforcing;
- **depth** — immediate or recursive, preserving branches rather than declaring a single root cause;
- **scope** — only when material applicability cannot be represented by the owning record's binding/projection.

## Natural language is outside the deterministic contract

Equivalent natural-language prompts should be allowed to normalize to equivalent semantic contracts even when wording differs substantially. Ambiguous language may yield multiple candidate contracts or an explicit ambiguity; scalar interpretation confidence must not become authority.

The deterministic layer should not depend on one LLM reproducing another model's paraphrase or traversal intuition. The model may choose which semantic question to ask next and may synthesize the returned facts; semantic identity and represented relationships remain stable underneath that reasoning.

## Recursive why, not Five Whys

Repeated explanation is branch-preserving expansion, not a root-cause declaration. For example:

```text
explain(DEC-X)
  -> implements CLM-A
  -> assumes ASM-B

explain(ASM-B, depth=recursive)
  -> supporting assessments
  -> challenging assessments
  -> material residuals
```

Expansion is a further `explain` with the `depth` qualifier, not a sixth family. No fixed number of expansions is meaningful, and competing explanatory branches must not be collapsed into a single causal chain.

## 5W1H as answer coverage, not API taxonomy

Who/What/When/Where/Why/How is retained only as a candidate completeness lens over answers:

```text
Coverage {
  who: covered | missing | unknown | not-material
  what: covered | missing | unknown | not-material
  when: covered | missing | unknown | not-material
  where: covered | missing | unknown | not-material
  why: covered | missing | unknown | not-material
  how: covered | missing | unknown | not-material
}
```

These are not mandatory answer fields or ontology slots. The experiment should retain this lens only if it repeatedly catches material omissions such as missing current/target state, missing enforcement mechanism, missing clearing authority, or ambiguous scope.

## Stable semantics, replaceable representation

Question meaning and answer semantics are the compatibility contract. Storage, graph representation, indexes, query planner, transport, MCP/tool names, renderer, and human-facing prose are replaceable implementation choices.

Semantic conformance should be demonstrated with competency-question fixtures and invariant behavior rather than field-for-field representation identity. Two implementations using different storage can interoperate if they preserve meaning; identical JSON with different interpretation does not constitute semantic interoperability.

Optional extensions may add semantics but may not silently redefine existing semantics. Unknown/unsupported extensions may be ignored only when doing so cannot strengthen a claim, grant authority, erase uncertainty, or create false equivalence; otherwise the result remains explicitly unsupported/unknown or fails closed at an authority boundary.

## Minimal maintenance contract

Humans/models should author the smallest irreducible semantic delta once at the layer that owns it. Reverse indexes, projections, diagnostics, semantic diffs, views, transport forms, and other derived artifacts should be generated where possible.

A worker should never be asked to author a fact the harness can determine more reliably itself. Identity, binding, run/attempt/provider context, completeness, and authoritative execution outcomes are examples of harness-owned facts.

Consumer repositories must be able to implement the same semantic/question contracts against locally owned corpora without depending on Pelaggio's storage or global graph. Federation/composition remains deliberately undecided; composition must not implicitly transfer authority between owners.

## Experiment / falsification

Use authentic operator prompts and compare at least:

1. raw-corpus model reconstruction;
2. today's flat named view catalog;
3. 5W1H as the primary question taxonomy;
4. the candidate operator families;
5. operator families + qualifiers with deterministic semantic premises supplied to the model.

Evaluate intent fidelity, answerability, composability, semantic ownership, non-overclaiming, API economy, represented-fact completeness, token/tool effort, and cross-model consistency. Include paraphrase and conversational follow-up chains.

The candidate grammar should be reduced if families collapse cleanly into retrieval/diff/qualifiers, if models perform equally well from the raw corpus at comparable cost and reliability, or if the semantic layer merely restates prose without improving boundedness, repeatability, temporal/authority distinctions, or cross-agent portability.

## First run: three named-view questions plus one ad-hoc, two conditions, two models (2026-08-24)

Record: `question-contract-run-2026-08-24.json` — every run's answer items, the premise node ids
supplied, the graph revision, the hand-made concept mappings, and the reconciliation below, so the
numbers can be re-derived from the artifact. Four authentic operator questions were each answered
by read-only agents under two conditions — **raw**: the ADR corpus and trust registry only;
**graph**: deterministic premises supplied by the experimenter, with the ADRs readable for
rationale — by two models (claude sonnet, claude opus). For Q-a (the ADR-0022 topology), Q-b (the
cost of provider-diverse review) and Q-c (replacing the landing executor) the premises were what
`selectView` returned for a named view in `views.json`; in the terms of the comparison above that
is **arm 2 (today's flat named-view catalog) against arm 1**. Q-d (which decisions are no longer
current) used an ad-hoc premise set — every decision node with its status and edges, which is not a
view — and is reported separately. No operator family or qualifier was invoked anywhere, so arms
3–5 were not run and this record says nothing about the candidate grammar itself.

| Q-a / Q-b / Q-c | graph premises (arm 2) | raw corpus (arm 1) |
|---|---|---|
| tokens per answer | 27.0k | 42.4k |
| files read | 4.5 | 8.0 |
| wall-clock | 55 s | 80 s |
| must-survive items per answer | 7.3 | 12.8 |
| must-survive items that name a mechanism rather than a property | 7% | 30% |
| cross-model agreement on must-survive (Jaccard) | 0.67 / 0.63 / 0.90 — reconciled 1.00 / 0.63 / 0.89 | 0.33 / 0.27 / 0.40 |

Reconciliation: in both Q-c graph replicas `CON-0004` is cited on a must-survive item (the rule that
ordering never substitutes for a fence) and on a may-change item (the reason an ordering layer is
optional); Q-a opus cites `DEC-0012`/`DEC-0014` on both sides as the decision implementing an
invariant and as the decision that may change. A bracketed id is a citation, not a classification;
the reconciled figures drop ids that appear on both sides. The Q-a 1.00 needs both drops:
removing DEC-0012 alone (the status defect this run exposed) gives 0.80; DEC-0014's double citation
is sourced and legitimate, and removing it too is what reaches 1.00.

The sharpest result is Q-c. Asked what must remain true *regardless of the new landing mechanism*,
both raw replicas listed the CAS fence, `--force-with-lease`, the ancestry check, and the isolated
worktree as must-survive — realizations of DEC-0015 presented as intent, the conflation ADR-0027
exists to prevent. Both graph replicas placed the CAS implementation and the optional ordering layer
under may-change, and named neither the ancestry check nor the worktree at all. The premises do not
contain them, but the graph agents could read ADR-0025 and one of them did (the opus answer cites
the retry ladder, admission lattice and receipt carriage from it), so their omission cannot be
attributed to premise boundedness alone; a source-constrained rerun would be needed to separate
"the premises framed the answer" from "the model chose not to list them". What the record does
support is narrower: with premises supplied, neither replica presented the CAS fence, the lease, the
ancestry check, or the worktree as intent, and without them both did; the one graph item the record
does count as mechanism-shaped (opus's "load-bearing landing action remains fenced or reconciled
[DEC-0016]", a decision cited as if it were a property) is what the 7% is made of. No recall measure was taken, so the smaller must-survive counts cannot be
read as precision.

Q-d cut the other way again. The raw replicas answered at ADR granularity (11 and 31 files read)
because the corpus has no per-decision status, and in doing so exposed that the graph was **wrong**:
neither listed ADR-0022 as historical or under reconsideration (opus listed only its rejected
alternatives), and ADR-0025 says it is unamended, so the graph's "under reconsideration" label on
DEC-0012 had no source; the graph replicas repeated the label. Separately, the graph opus
replica noticed `supersedes` was declared but never authored. Both defects are fixed on this branch;
the run is the reason, and the first is a case the source-grounding check cannot catch because it is
the graph overclaiming rather than the prose drifting.

Against the reduction trigger: on the three named-view questions the models did not perform equally
well from the raw corpus at comparable cost — 1.6× the tokens, 1.8× the files, and roughly half the
cross-model agreement — but the honest reading is boundedness and non-conflation, not correctness,
since every raw answer was also defensible from its sources. Confounds and caveats, all recorded in
the artifact: the matching view was chosen by the experimenter, which is the probabilistic
normalization step this contract leaves outside the deterministic seam, and its cost is not in the
table; the mechanism-naming judge and the raw concept mapping are the session author's; graph
Jaccard is over a closed, supplied id set while raw Jaccard is over open-ended concepts, a unit
difference biased toward the graph condition; no recall was measured; one provider; three questions
in the aggregate. Q-b is `challenge`-shaped (a defeater of ASM-0002), not `recover`-shaped; no
family was exercised, and `challenge`/`epistemicPosture` could not have been because no assessment
records exist.

No question family, qualifier, answer schema, 5W1H field, federation mechanism, transport, or tool name is promoted by this document.