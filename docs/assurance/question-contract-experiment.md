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
- **challenge** — expose attributable challenging/unresolved assessments or missing evidence without manufacturing a defeater ontology (presupposes assessment records, which the shadow graph does not yet hold — Q12; until the stacked assessment slice supplies them, `challenge` and the `epistemicPosture` qualifier retrieve nothing, and experiment arms 4–5 cannot exercise them);
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

explain(ASM-B, depth=recursive, epistemicPosture=unresolved)
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

## First run: four operator questions, two conditions, two models (2026-08-24)

Record: `question-contract-run-2026-08-24.json`. Four authentic operator questions (the ADR-0022
topology, the cost of provider-diverse review, replacing the landing executor, which decisions are
no longer current) were each answered by read-only agents under two conditions — **raw**: the ADR
corpus and trust registry only; **graph**: deterministic premises retrieved by `selectView` for the
matching view, with the ADRs readable for rationale — by two models (claude sonnet, claude opus).
This is arms 1 and 5 of the comparison above; arms 2–4 were not run.

| | graph premises | raw corpus |
|---|---|---|
| tokens per answer | 29.1k | 45.4k |
| files read | 5.0 | 11.3 |
| wall-clock | 56 s | 89 s |
| must-survive items per answer (Q-a–c) | 7.3 | 12.8 |
| must-survive items that name a mechanism rather than a property | 7% | 30% |
| cross-model agreement on must-survive (Jaccard, Q-a / Q-b / Q-c) | 0.67 / 0.63 / 0.90 | 0.33 / 0.27 / 0.40 |

The sharpest result is Q-c. Asked what must remain true *regardless of the new landing mechanism*,
both raw replicas listed the CAS fence, `--force-with-lease`, the ancestry check, and the isolated
worktree as must-survive — realizations of DEC-0015 presented as intent, the conflation ADR-0027
exists to prevent — while both graph replicas placed them under may-change and agreed on nine of ten
must-survive nodes. Q-d cut the other way: the raw replicas answered at ADR granularity (11 and 31
files read) because the corpus has no per-decision status; the graph replicas answered directly,
and one of them found that the graph was **wrong** — DEC-0012 carried "under reconsideration" with
no source, and `supersedes` was declared but never authored. Both are fixed on this branch; the run
is the reason.

Against the reduction trigger: the models did not perform equally well from the raw corpus at
comparable cost — they cost 1.6× more, read 2.3× more files, and agreed with each other roughly half
as often — but the honest reading is about boundedness and non-conflation, not correctness, since
every raw answer was also defensible from its sources. Caveats: one provider (cross-provider
consistency was not measured), four questions, the mechanism-naming judge is the session author,
the raw Jaccard values are hand-mapped concepts, and the `challenge`/`recover` families could not be
exercised because no assessment records exist yet.

No question family, qualifier, answer schema, 5W1H field, federation mechanism, transport, or tool name is promoted by this document.