# Architecture probes — results

Stage 2 of [`docs/plans/adr-reconciliation.md`](../../plans/adr-reconciliation.md). Posture and
standing caveats: [`README.md`](./README.md).

| Hypothesis | Probe | Falsification condition | Observation | Verdict | Architectural consequence |
|---|---|---|---|---|---|
| **B** — heterogeneous work shares one typed Step lifecycle contract without a god-object | [P1](./p1-step-contract.md) | untyped options bag, proliferating optionals, or branching that hides today's orchestrators inside `Step` | No options bag. 9 activities already share one `RunStepFn`. But 7/11 `RunStepOpts` fields optional, and authority / exit criteria / outputs / provenance / recovery are **not** in the contract | **Survives, overstated** | Split B: an *execution* contract ships; a *lifecycle* contract does not exist. Supports "pressure is in the envelope" |
| **E** — drivers are interchangeable intelligence adapters | [P1](./p1-step-contract.md) | driver-specific concern on the shared contract | `RunStepOpts.onChildSpawn` = *"register the Claude SDK child PID"* | **Falsified (narrow)** | E needs a constraint: no driver-specific field on the shared step contract |
| **A** — work executes as typed steps in an ordered pipeline | — | — | **Not probed.** No probe targeted A; #482 measured no DAG pressure and a linear `STEPS`, which is supporting evidence but not a test | **Not probed** | Do not record A as supported. Nothing argues for or against the step *count* |
| **C** — the harness retains advancement authority | [P2](./p2-authority.md), [P5](./p5-ship-through.md) | a model judgment or artifact exercises authority to advance | **Split by P5.** C1 (harness-owned resolution) holds by inspection but no probe exercised it. C2 (the state resolved over is not agent-writable) is **falsified**: a ship-agent-authored `Closes #N` closed issue #483 on merge, and P2 measured git mutation succeeding on all three drivers | **C1 untested; C2 falsified** | Split C in the constitution. C2 is target state bound to D's probe |
| **D** — consequential execution has no ambient authority | [P2](./p2-authority.md) | a driver bypasses an authority the harness claims to own, or safety depends on a driver's native hook | 6 axes × 3 drivers on the real `runStep` seam. Only harness-enforced control: env allowlist, and **only on codex + grok**. Claude child returned a non-allowlisted parent env var, disk-confirmed | **Falsified** | D is aspirational, not implemented. Label it target-state or wire ADR-0023 into `runStep` first |
| **E** — harness safety must not depend on Claude-shaped hooks | [P2](./p2-authority.md) | as above | The mirror image: the harness's own control is *absent* on Claude, present on codex/grok/opencode | **Falsified (inverted)** | Constrain: every driver adapter must route through the harness's authority construction |
| **F** — run/attempt lineage preserves WIP without conflating it with accepted output | [P3](./p3-lineage-provenance.md), [P5](./p5-ship-through.md) | resume requires replay; failed WIP indistinguishable from accepted output | Attempt 1 (confinement-aborted) and attempt 2 both recorded in `.dev/attempts/481/`; implement checkpoint stayed distinct from accepted output; quarantine is its own terminal state. **Scope:** P3's run never shipped, so destruction never fired; those records carry identity only (`{schemaVersion, itemId, attempt}`), not attempt state. P5 shipped and merged — and nothing cleaned up, so the destruction case remains untested on the production target. **Instrument caveat:** the dossier figures cited by P3/P5 came from an assembler with three defects (main-relative receipt resolution, last-record-only lineage, unfiltered reviewer count); corrected totals are 6/3/4 for #483 and 6/2/5 for #481 | **Supported for the failed/superseded case; untested across successful ship** | Do not read as "F holds as written". Attempt *identity* is durable; attempt *state* is not, and resume is still four heuristics |
| **G** — self-contained source provenance without transcript storage | [P3](./p3-lineage-provenance.md) | provenance answers require mutable joins, or degenerate into transcripts | **6 of 12 questions not durable** — 2 mutable-join, 4 unanswerable. The charter itself (G's own first question) lives in an editable issue body. Transcript signal did **not** fire | **Falsified** | G needs a *capture-at-the-boundary* obligation, not just a schema. Do not weaken the definition to match |
| **I** — review in authoring; author cannot supply own clearing judgment | [P5](./p5-ship-through.md) | clearing judgment fails to bind, or authorship can clear itself | Three cold-gate passes on PR #484: blocked twice on isolated-verified `must-fix` findings, overriding passing seats both times — including a credential-exfiltration regression the author had introduced minutes earlier — then passed on `consensus-pass` with 0 survivors | **Supported** | None. I is the campaign's second actively-supported invariant, and the only one supported by catching a defect its author missed |
| **J** — independence isolates information, not execution authority | [P5](./p5-ship-through.md) | cold evaluation receives undeclared author state | Cold seats re-derived the blocking finding from the diff with no authoring context. But standing caveat 4 is unchanged: `sessionResume` is false on every provider, so there is no inheritance mechanism to defeat | **Exercised; still satisfied by construction, not by design** | Keep J as an information-isolation property. A green result here remains weak evidence |
| **H** — consequential transitions have an owner/reconciler | [P5](./p5-ship-through.md) | a completed external transition has no owner | **Falsified in a worse form than predicted.** #483's issue closed one second after #484 merged — because the ship agent wrote `Closes #483.` into the PR body; no harness code templates one. Every deterministic transition failed: `in-progress`, both claim branches and the worktree all persisted | **Falsified — and C with it** | H is not "unowned", it is *torn*: partially owned by model-authored prose. Record it as a measured violation of C, not only as a missing reconciler |
| **K** — semantic reconciliation is a tractable delivery obligation | [P4](./p4-reconciliation.md) | unbounded research task; sprays edits; cannot separate construction from architecture | No signal fired. 0/8 spraying, 0 silent rewrites, 6/6 correct canonical owner. But **2/8 missed entirely**, both architecture/trust changes | **Supported (tractability only)** | Autonomy untested — P4 measured reconstruction, not an agent. Predicted failure was noise; observed failure is silence |

## Trust-lane consequence

`TC-014` ("child processes get only the secrets they need", status **`guarantee`**) does not hold on
the default driver. Its `evidence_command` runs `secret-hygiene.test.ts`, which tests `buildAgentEnv`
in isolation — no test asserts that a driver path calls it. **A verified mechanism with unverified
application.** The claim needs re-evidencing at the call sites or downgrading from `guarantee`.

This is the campaign's first result that changes something outside the ADR set, and it was found by
a probe designed to falsify rather than to demonstrate.


## Recommended amendments to A–K

Only where evidence requires them. Everything else in A–K is left alone.

| Invariant | Amendment | Evidence |
|---|---|---|
| **B** | Split into an *execution* contract (ships, carries 9 activities) and a *lifecycle* contract (does not exist). Recording both as one invariant hides that half is aspirational | P1 |
| **D** | Mark target-state, or wire ADR-0023 containment into `runStep` before constitutionalizing. "No ambient authority" describes nothing on today's step path | P2 |
| **E** | Add the inverted constraint: *every driver adapter must route through the harness's authority construction; a path that bypasses it is not a conforming adapter.* Also: *no driver-specific field on the shared step contract* | P1 (`onChildSpawn`), P2 (`buildAgentEnv` absent on claude) |
| **G** | Add a capture-at-the-boundary obligation: the charter is snapshotted at claim and the landing authorization mirrored at ship. Without it, G's own first question needs the mutable join it forbids | P3 |
| **J** | Do not read as implying containment. The cold path is the *least* protected, not the most — it is isolation from author context, carrying no authority boundary | P2 |
| **K** | Tune for the observed failure, not the predicted one. Escalation on architecture/trust changes is the load-bearing half; noise suppression is not the problem | P4 |
| **C** | Split. C1 (harness-owned resolution) holds **by inspection only — no probe exercised it**; C2 (the state resolved over is not agent-writable) is target state and was **measured violated** — a ship-agent-authored `Closes #N` performed a roadmap transition | P5 |
| **F** | Scope to the case measured: supported for failed/superseded attempts, untested across successful ship. Attempt records carry identity only | P3, P5 |
| **H** | Record as falsified-and-torn, not merely unowned; the closer must also normalize model-authored closing keywords or they race it | P5 |

**I** needs no amendment on this evidence; **A was never probed** and its row above records that rather than granting it support. **H was never probed before P5** — its earlier
support was observational evidence that H is *violated*, which is not evidence the invariant is
right. F and I are the only invariants a probe actively supported rather than merely failing to
falsify, and I is the stronger of the two: it caught a defect its own author had just introduced.

## Campaign cost

P1 $0 (static) · P2 $2.37 across two runs (one discarded for a probe defect) · P3 $7.11 across four
cycles (three lost to stranded claim state, see [G5](./gaps.md#g5)) · P4 $0 (read-only) ·
**P5 ≈ $113** (one cycle $33.29 + three gate passes at $23.84 / $35.20 / $21.50, one of which was
stopped mid-flight and is not billed here).
**Total ≈ $122.**

The ratio is itself a finding: P1–P4 cost $9.48 because they were static or single-cycle, while P5
cost an order of magnitude more — and almost none of that was *measurement*. It was remediation,
because riding the production pipeline means fixing whatever it surfaces. Probes that touch the real
delivery path belong in a different budget class than probes that read code.
