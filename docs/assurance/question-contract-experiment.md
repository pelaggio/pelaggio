# Semantic question contract experiment

Status: **experimental / shadow-only**.

This experiment records a deliberately small candidate seam between probabilistic human/model interpretation and deterministic semantic retrieval. It does **not** define a public API, runtime protocol, storage format, transport, or authoritative query vocabulary.

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

  subject

  qualifiers?:
    direction
    state
    epistemicPosture
    authority
    depth
    scope
}
```

This grammar is intentionally **not ontology** and is not yet a stable/public API. Each family or qualifier must survive operator-prompt, paraphrase, composition, cross-agent, and deletion tests before promotion.

Current candidate meanings:

- **explain** — expose why something exists/holds and the typed premises relevant to explaining it;
- **trace** — follow explicit semantic relationships upstream/downstream without inventing implied edges;
- **challenge** — expose attributable challenging/unresolved assessments or missing evidence without manufacturing a defeater ontology;
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

expand(ASM-B)
  -> supporting assessments
  -> challenging assessments
  -> material residuals
```

No fixed number of expansions is meaningful, and competing explanatory branches must not be collapsed into a single causal chain.

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

No question family, qualifier, answer schema, 5W1H field, federation mechanism, transport, or tool name is promoted by this document.