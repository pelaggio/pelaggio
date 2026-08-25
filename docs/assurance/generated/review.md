# review assurance view

> Why does the current review strategy exist, what assumptions does it rely on, and what survives if the strategy changes?

Generated from shadow-graph.json schema 0.3.0 via ci/assurance-views.ts. Do not edit this projection by hand.

```mermaid
flowchart TB
  ASM_0002["diverse-review-earns-cost"]
  CLM_0008["verifiable-custody"]
  CLM_0009["blocker-survives-until-refuted"]
  CLM_0016["independent-evaluation"]
  CLM_0019["deterministic-safety-floor"]
  CON_0008["omission-not-refutation"]
  CTR_0002["two-review-orchestrators"]
  CTR_0003["n-reviewers-one-judge"]
  CTR_0012["fail-closed-review-verdict-parsers"]
  DEC_0003["signed-tag-provenance-publish"]
  DEC_0008["in-toto-envelope"]
  DEC_0012["fixed-six-step-two-review-orchestrators"]
  DEC_0014["multi-driver-judge-review-loop"]
  DEC_0020["claim-scoped-delivery-packet"]
  CLM_0009 -->|specializes| CLM_0019
  CON_0008 -->|constrains| CLM_0009
  CTR_0002 -->|derived-from| DEC_0012
  CTR_0002 -->|implements| CLM_0016
  CTR_0003 -->|derived-from| DEC_0014
  CTR_0003 -->|implements| CLM_0016
  CTR_0012 -->|implements| CLM_0009
  CTR_0012 -->|implements| CLM_0019
  DEC_0003 -->|implements| CLM_0008
  DEC_0008 -->|implements| CLM_0008
  DEC_0012 -->|implements| CLM_0016
  DEC_0014 -->|assumes| ASM_0002
  DEC_0014 -->|implements| CLM_0009
  DEC_0014 -->|implements| CLM_0016
  DEC_0020 -->|implements| CLM_0008
```
