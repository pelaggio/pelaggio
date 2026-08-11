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
| **P2** | Agent Driver authority | C, D, E | pending |
| **P3** | Lineage, cold isolation, provenance | F, G, I, J | pending — subject is item #481 |
| **P4** | Semantic reconciliation & doc ownership | K | pending |

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
   **by construction, not by design** — a green P3 result on cold isolation is weak evidence.
5. **No reconciliation capability exists.** P4 builds a throwaway one, so a negative result may
   measure the prototype rather than the concept.
