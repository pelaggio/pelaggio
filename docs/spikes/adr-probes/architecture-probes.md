# Architecture probes — results

Stage 2 of [`docs/plans/adr-reconciliation.md`](../../plans/adr-reconciliation.md). Posture and
standing caveats: [`README.md`](./README.md).

| Hypothesis | Probe | Falsification condition | Observation | Verdict | Architectural consequence |
|---|---|---|---|---|---|
| **B** — heterogeneous work shares one typed Step lifecycle contract without a god-object | [P1](./p1-step-contract.md) | untyped options bag, proliferating optionals, or branching that hides today's orchestrators inside `Step` | No options bag. 9 activities already share one `RunStepFn`. But 7/11 `RunStepOpts` fields optional, and authority / exit criteria / outputs / provenance / recovery are **not** in the contract | **Survives, overstated** | Split B: an *execution* contract ships; a *lifecycle* contract does not exist. Supports "pressure is in the envelope" |
| **E** — drivers are interchangeable intelligence adapters | [P1](./p1-step-contract.md) | driver-specific concern on the shared contract | `RunStepOpts.onChildSpawn` = *"register the Claude SDK child PID"* | **Falsified (narrow)** | E needs a constraint: no driver-specific field on the shared step contract |
| **C/D** — harness retains authority; execution has no ambient authority | [P2](./p2-authority.md) | a driver bypasses an authority the harness claims to own, or safety depends on a driver's native hook | 6 axes × 3 drivers on the real `runStep` seam. Only harness-enforced control: env allowlist, and **only on codex + grok**. Claude child returned a non-allowlisted parent env var, disk-confirmed | **Falsified** | D is aspirational, not implemented. Label it target-state or wire ADR-0023 into `runStep` first |
| **E** — harness safety must not depend on Claude-shaped hooks | [P2](./p2-authority.md) | as above | The mirror image: the harness's own control is *absent* on Claude, present on codex/grok/opencode | **Falsified (inverted)** | Constrain: every driver adapter must route through the harness's authority construction |
| **F** — run/attempt lineage preserves WIP without conflating it with accepted output | P3 | resume requires replay; failed WIP indistinguishable from accepted output | pending — subject is item **#481** | pending | — |
| **G** — self-contained source provenance without transcript storage | P3 | provenance answers require mutable joins, or degenerate into transcripts | pending | pending | — |
| **I/J** — review in authoring; independence is a property of execution | P3 | cold evaluation receives undeclared author state | pending — see caveat 4 (`sessionResume` false everywhere → satisfied by construction) | pending | — |
| **K** — semantic reconciliation is a tractable delivery obligation | P4 | unbounded research task; sprays edits; cannot separate construction from architecture | pending | pending | — |

## Trust-lane consequence

`TC-014` ("child processes get only the secrets they need", status **`guarantee`**) does not hold on
the default driver. Its `evidence_command` runs `secret-hygiene.test.ts`, which tests `buildAgentEnv`
in isolation — no test asserts that a driver path calls it. **A verified mechanism with unverified
application.** The claim needs re-evidencing at the call sites or downgrading from `guarantee`.

This is the campaign's first result that changes something outside the ADR set, and it was found by
a probe designed to falsify rather than to demonstrate.
