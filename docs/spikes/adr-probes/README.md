# ADR reconciliation — architecture probes

Stage 2 of [`docs/plans/adr-reconciliation.md`](../../plans/adr-reconciliation.md), executed as a
falsification campaign against candidate invariants **A–K**.

## Posture

These are **falsification probes, not acceptance tests**. Each probe states the hypothesis, the
observation that would falsify it, and the architectural consequence of failure *before* it runs.

- A failed probe is a successful experiment.
- Probe scaffolding is throwaway. Nothing here is promoted into an ADR.
- Where an invariant cannot be tested honestly, that is recorded as *untestable* — not as a pass.
  Absence of evidence is not evidence of safety (the standing register of `docs/spikes/`).
- Where a probe exercises real production behavior it does so through the real seam. Toy
  re-implementations are used only where noted, and their results are labelled as measuring the
  prototype rather than the concept.

## Probes

| | Probe | Targets | Status |
|---|---|---|---|
| **P1** | Step-contract conformance | A, B | [`p1-step-contract.md`](./p1-step-contract.md) |
| **P2** | Agent Driver authority | C, D, E | [`p2-authority.md`](./p2-authority.md) |
| **P3** | Lineage, cold isolation, provenance | F, G, I, J | [`p3-lineage-provenance.md`](./p3-lineage-provenance.md) — subject #481, quarantined before review |
| **P4** | Semantic reconciliation & doc ownership | K | [`p4-reconciliation.md`](./p4-reconciliation.md) |
| **P5** | Ship-through lineage on the production target | F, G, H, I, J | [`p5-ship-through.md`](./p5-ship-through.md) — subject #483, merged as #484 |

Results roll up into [`architecture-probes.md`](./architecture-probes.md).

## Standing caveats

Recorded at campaign start so no probe silently inherits an unstated assumption:

1. **Containment is not in the step path.** `contained-execution.ts` and `egress-broker.ts` are
   reachable only from `run-contained-cli.ts`; neither `step-runner.ts` nor `pipeline.ts` imports
   them. P2 therefore measures the *production* boundary and the *designed* boundary as two
   separate columns, and cannot report a single "harness-enforced" verdict for D.
2. **OpenCode is not installed here.** Driver diversity is three CLI-over-stdio agents (claude,
   codex, grok). "Materially different Agent Driver" is narrower than A–K assumes.
3. **`providers.grok.allow-unsandboxed-fallback: true`** in this repo's config means a grok seat may
   already run unsandboxed. Its P2 row is contaminated unless the probe pins that off.
4. **`sessionResume` is `false` for every provider**, and the type comment records it as
   *unevidenced*. There is no session-inheritance mechanism to defeat, so J is currently satisfied
   **by construction, not by design** — a green result on cold isolation is weak evidence. P5
   exercised the cold path for real and this caveat is unchanged by it.
5. **No reconciliation capability exists.** P4 builds a throwaway one, so a negative result may
   measure the prototype rather than the concept.
6. **P5 rides the production pipeline, so it is not free of side effects.** It chartered a real item,
   opened and merged a real PR, and required two rounds of remediation before the gate passed. Its
   findings are correspondingly strong — they are observations of production, not of a harness — but
   its cost is an order of magnitude above the read-only probes, and almost all of that is
   remediation rather than measurement.
