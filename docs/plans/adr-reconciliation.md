# ADR reconciliation: reduce the constitution to the product we mean to build

Status: proposal, pre-decision. Based on the measurements in `path-forward.md`, trio review, and the first Stage 2 falsification campaign under `docs/spikes/adr-probes/`.

## Why this exists

The current ADR ledger mixes durable product invariants, hard-won negative constraints, current implementation topology, experimental algorithms, provider-specific limitations, and detailed construction. That makes replaceable machinery feel constitutional and, in the other direction, makes it easy to throw away the reason an old mechanism had teeth.

The correction is not simply "fewer ADRs." It is a sharper boundary:

- an ADR owns the **invariant** and the **constraints a replacement must still satisfy**;
- construction has one canonical home outside the ADR;
- policy and experiments stay policy and experiments until they earn permanence;
- superseded decisions remain as history rather than being rewritten away.

The governing test is:

> **If the mechanism changed tomorrow, would this sentence still be required to avoid reintroducing a known failure?**

The probe campaign adds a second discipline: distinguish **current-state fact**, **target-state invariant**, and **candidate abstraction**. A target can be worth pursuing even when the current implementation falsifies it; a useful current seam need not be promoted into the final lifecycle abstraction merely because it exists.

## 1. Product target

> **A charter becomes a change by passing through well-defined, safely executed skills. Every consequential execution occurs under harness-owned authority. Every consequential transition is reconciled and evidenced. The resulting provenance explains how the change came to exist.**

The target has four concerns: delivery, safe execution, source provenance, and semantic reconciliation.

## 2. Candidate architectural constitution

The labels are review handles, not proposed ADR numbers. Probe status is stated explicitly where evidence now exists.

### A. Work executes as typed steps in an ordered pipeline

A pipeline orders typed steps. Pelaggio need not become a general DAG scheduler. The invariant is explicit lifecycle boundaries with typed inputs and outputs, not today's exact step count or orchestrator topology.

**Probe status:** not falsified by P1.

### B. Separate the shared execution contract from the lifecycle contract

P1 found a real shared execution seam: nine heterogeneous activities already use `RunStepFn` without an untyped options bag. It did **not** find a lifecycle contract containing authority, exit criteria, accepted outputs, provenance, reconciliation, or recovery.

Therefore two concepts must not be conflated:

- **execution contract** — the narrow common interface for invoking work; this exists today and should remain small;
- **lifecycle contract** — the target-state contract governing identity, authority, accepted outputs, recovery, provenance, and reconciliation around an execution.

The lifecycle contract may wrap or compose the execution seam. It must not absorb driver-specific details merely to become universal, and it should not become a god-object of optional fields.

Conceptually the target lifecycle vocabulary remains:

```text
Pipeline
  Run
    Step
      StepRun
        Attempt
```

The exact type decomposition is construction and remains subject to architecture discovery.

**Probe status:** execution half supported; lifecycle half aspirational and still to be designed/probed.

### C. Agents provide intelligence; Pelaggio retains advancement authority

Agents may propose, implement, inspect, review, and judge. They do not grant themselves filesystem, process, network, credential, git, merge, or external-effect authority.

**Advancement authority resolves through deterministic harness semantics.** Model judgments may produce evidence or dispositions, but cannot themselves exercise the authority to advance. A harness rule may deterministically accept a valid, attributable model judgment as one of its required inputs; the semantic judgment need not itself be deterministic.

**Policy is explicit, inspectable, versioned, and evaluated by the harness rather than hidden in model discretion.** Its representation may be data, typed code, or another reviewable form.

**Probe status:** the advancement-authority principle was not falsified, but P2 falsified any claim that today's `runStep` path already owns the full execution authority boundary.

### D. Agent execution has no ambient authority — target state

Each agentic execution that can produce consequential effects must run inside a harness-controlled sandbox / authority boundary. Authorities are explicit grants; the execution environment cannot broaden its own authority.

**This is target state, not a description of the current production step path.** P2 found that `runStep` currently enforces almost none of the claimed authority axes, and the designed containment path in `contained-execution.ts` is not on the ordinary step path.

**Containment is not permission.** Bounding what execution can technically reach does not establish whether that execution is contractually permitted. Permission is decided separately on its own evidence.

The immediate trust implication is also explicit: a helper that correctly constructs a restricted environment is not evidence that every real driver invocation actually uses it. Trust evidence must exercise the control at the production seam.

### E. Agent Drivers must enter through harness-owned authority construction

An **Agent Driver** is the runtime integration Pelaggio invokes. Provider and model are separate execution facts. The driver reports factual optional/native capabilities and telemetry.

P1/P2 falsified the stronger current-state story of interchangeable drivers: `RunStepOpts.onChildSpawn` leaks a Claude-specific concern into the common seam, and the environment control used by Codex/Grok/OpenCode is skipped by Claude.

The replacement invariant is therefore deliberately asymmetric:

> **Every Agent Driver must enter through the harness's authority construction; no driver-specific lifecycle field may be required by the shared execution/lifecycle contract.**

A driver may add native defense-in-depth. A required capability with no proven harness equivalent refuses seating rather than being silently downgraded. “Interchangeable” means interchangeable *behind the same declared authority contract where equivalence has been demonstrated*, not that all runtimes are assumed equal.

**Probe status:** previous formulation falsified; this inverted constraint is directly motivated by the measured failure.

### F. Durable recovery follows run/attempt lineage, not deterministic replay

A completed step produces an accepted artifact/checkpoint. Nondeterministic agent execution is not replayed as if deterministic. Valid interrupted WIP may be durable and resumable. Retries are new attempts in the same lineage, not mutations of history.

**Probe status:** supported by P3. A confinement-aborted attempt and its successor remained distinct; WIP did not masquerade as accepted output. Preserve this strength during refactor.

### G. Source provenance is captured at authoritative semantic boundaries

The desired final lineage must explain, without mutable external joins: charter/outcome/scope; supplied context and skill; Agent Driver/provider/model; sandbox/authority; step and attempt outputs; deterministic checks; review findings and resolution; retries/parks/supersession; semantic reconciliation; landing authorization; and final commit/tree.

P3 falsified the claim that this is durable today: half of the required questions require reconstruction from mutable state. It did **not** find that useful provenance requires transcript retention.

The resulting invariant is stronger and more local:

> **A provenance fact is captured durably at the authoritative boundary where it becomes known, rather than reconstructed later from mutable systems.**

Examples: snapshot charter intent when the work is claimed; bind step inputs/outputs and attempt identity at the step boundary; bind clearing judgment at review; mirror landing authorization and final subject at ship/landing.

The Change Dossier is a projection over these durable records, not an omniscient transcript recorder.

Where provenance is consumed externally, it binds a builder identity whose trust basis the consumer can independently verify.

**Probe status:** current implementation falsified; target shape remains viable and gained the capture-at-boundary constraint.

### H. Consequential effects require deterministic authorization and durable evidence

Agent judgment may be an input to policy; it is not itself authority. Consequential mutations require harness-owned authorization and evidence appropriate to the effect.

Stateful mutations — external or shared local harness state — are fenced at the state-owning authority or idempotently reconciled. Observational pre-checks, locks, and expiring hints are not correctness boundaries by themselves.

Required rigor scales with **consequence and reversibility**, not lifecycle position. Degradation may reduce rigor but never broaden authority; any stale verified fallback is bounded and visibly weaker.

Every non-success terminal state identifies a recovery transition and authorized clearer.

P2 exposed a concrete extension of this rule: a non-recoverable confinement abort currently strands worktree, branch, and roadmap state, poisoning subsequent runs even though every individual guard fires correctly. The claim/pick lifecycle is therefore within the scope of this invariant and ADR-0026's typed-clearing rule.

### I. Review is part of authoring; clearing judgment is separated from authorship

A change is challenged, revised, and resolved during authoring rather than presenting a raw first draft as the finished artifact. The review record contributes to source provenance.

**The same decision-maker cannot both author a candidate and supply the clearing judgment for that candidate.** The clearing judgment must be independently attributable. Pelaggio may deterministically resolve that judgment plus other required evidence into an authoritative disposition; this does not require a third reviewing agent or a particular review topology.

The number of reviewers, Judge role, convergence algorithm, and driver/provider mix remain strategy.

**Probe status:** not exercised by P3 because the run quarantined before review. Do not count this as passing.

### J. Independent evaluation isolates information, not necessarily authority

When policy requires independent evaluation, the evaluator receives only explicitly declared inputs and does not inherit mutable author-session state or hidden author context.

This property is **information/context isolation**. It must not be read as evidence that the evaluator is sandboxed or authority-confined. P2/P3 show today's cold path is, if anything, less protected on the authority axis.

I does not mandate a second independent review system. Generic lifecycle, storage, checkpoint, budget, and provenance machinery may be reused if the independence property survives.

**Probe status:** effectively untested as an architectural guarantee; current providers have `sessionResume=false`, so accidental statelessness would be weak evidence.

### K. Semantic reconciliation is a delivery obligation

Chartering identifies the semantic surfaces the intended change may affect; execution records realized impact; delivery reconciles the two before the change is complete.

Implementation reports facts about what changed rather than discovering and rewriting an unbounded prose graph. Reconciliation owns canonical placement/deduplication.

P4 found the model tractable across eight historical PRs but did not test autonomous execution. The important load-bearing property exposed by the sample is **escalation correctness**, not minimizing harmless prose noise:

> **A realized change that conflicts with architecture, trust, or an external contract must escalate rather than silently rewrite the authoritative statement to match the implementation.**

Routine construction/behavior reconciliation may proceed autonomously. The impact taxonomy, dedicated-step topology, driver choice, routing map, and document layout remain construction/policy.

**Probe status:** tractability supported; autonomous reconciliation still untested.

## 3. What should not be constitutional

Examples: exact pipeline step/orchestrator count; N+Judge/fingerprint algorithm; provider diversity as permanent primitive; ocap/algebraic-effects vocabulary; containment substrate/broker topology; readiness rubric; retry counts; exact severity/tolerance tables; landing retry arithmetic; current Agent Driver limitations; a dedicated `reconcile-docs` step or `DocumentationImpact` enum; current doc filenames; or a prohibition on cold evaluation sharing generic lifecycle machinery.

## 4. Current ADR disposition

The trio reviews established the rule: shrinking or superseding an ADR must not orphan the reason a replacement would otherwise repeat a known failure. `cut` preserves an ADR under its number; `split` separates independently replaceable decisions; `supersede` moves each surviving constraint into a named replacement clause before marking the old ADR; `demote` moves policy/config out of architecture.

| ADR | Disposition | Invariant / constraint that survives | Carried by | Construction home |
|---|---|---|---|---|
| 0001 worktree write confinement | **cut** | observed-effect gate; no correctness dependence on parsing tool intent; ambiguity violates | self | `pipeline.md` § Worktree Isolation ✅ |
| 0002 untrusted input/tool scope | **cut** | untrusted content cannot grant authority | self | *home needed* |
| 0003 PR-gated default | **demote** | safe default may remain PR | policy | config |
| 0004 review gate / shakedown parsing | **cut**, amended by 0026 | irreversible advancement fails closed; parse-invalid remains signal; role-appropriate parsing may differ | self | gate half in `guarded-actions.md`; shakedown home needed |
| 0005 branch-protection auto-merge | **cut** | external landing authority positively verified | self | `flow.md` ✅ |
| 0006 no lifecycle scripts | **cut** | published manifests carry no lifecycle scripts | self | `architecture.md` ✅ |
| 0007 provenance publish | **cut** | externally verifiable provenance from a verifiable builder trust basis | self + G | trust docs ✅ |
| 0008 control plane fail closed | **cut** | unauthenticated control authority never exposed | self | `docs/server.md` ✅ |
| 0009 claims are git branches | **cut** | atomic authority owns claim; no pre-check/secondary registry | self | `roadmap-and-ship.md` ✅ |
| 0010 env/log safety | **cut** | no ambient secret/environment authority; evidence does not leak credentials | self | `architecture.md` section needed |
| 0011 Andon not DoR | **cut** | charter inadequacy produces typed escalation, not guessing | self | `flow.md` ✅ |
| 0012 readiness computed | **demote** | readiness signals may inform scheduling | policy | `flow.md` ✅ |
| 0013 reversibility-weighted gates | **supersede** | rigor scales with consequence/reversibility | H | home needed |
| 0014 mechanism/policy spine | **supersede** | agents judge; harness resolves advancement authority; policy explicit/versioned/outside model discretion | C + H | cross-cutting |
| 0015 autonomy/tolerance | **demote** above constitutional floor | dial is policy; cannot broaden authority | D + H | home needed |
| 0016 severity taxonomy | **cut** | safety/judgment floor not agent-contractible; ambiguity fails toward floor | self | `adversarial-review-loop.md` ✅ |
| 0017 graceful degradation | **supersede** | weaker path never broadens authority; visibly weaker record; bounded stale fallback | H | `adversarial-review-loop.md` ✅ |
| 0018 in-toto attestation | **split** | narrow envelope/signing decision vs rich source provenance | self + G | trust docs ✅ |
| 0019 checkpoint restart | **supersede** | no deterministic replay; accepted + valid WIP durability | F | `pipeline.md` § Parking ✅ |
| 0020 provider seam/capabilities | **split** | Agent Driver seam + factual capabilities; every driver enters through harness authority; no-equivalent requirement refuses seating | E + self | `pipeline.md` § Step Providers ✅ |
| 0021 effects placement | **supersede** | explicit authority and authorized/evidenced boundary effects | C + D + H | `pipeline.md` § Effects Manifests ✅ |
| 0022 pipeline shape/orchestrators | **split** | ordered lifecycle; execution/lifecycle distinction; conditional context isolation; topology replaceable | A + B + J | cold-evaluation home needed |
| 0023 contained execution | **supersede** | target-state no ambient authority; containment ≠ permission | D | `contained-execution.md` ✅ |
| 0024 authoring review | **split** | review during authoring; author cannot supply own clearing judgment; algorithm replaceable | I | `adversarial-review-loop.md` ✅ |
| 0025 landing serialization | **cut** | actual ref fence remains load-bearing; ordering never substitutes | self | `flow.md` ✅ |
| 0026 stateful guards | **cut** | fence-or-reconcile; typed recovery across guard lifecycles including claim/pick; judgment/evidence/disposition separation; bounded retry; omission never refutation | self | `guarded-actions.md` ✅ |

## 5. Probe findings that are immediate correctness work, not architecture preference

Two findings should be treated independently of whether A–K ultimately survive:

1. **TC-014 is presently overstated on the default Claude path.** The env allowlist helper is tested, but the production driver path bypasses it. Either the driver path must be fixed or the trust claim weakened until end-to-end evidence exists. The trust lesson is broader: test application of the control at the real seam, not merely the helper implementing it.
2. **A confinement-aborted run strands claim state across worktree, git branch, and roadmap label.** Subsequent cycles fail on debris and may contaminate another item's roadmap state. This is a missing clearing transition, not a failed guard. It should be addressed as an ADR-0026/H correctness gap.

## 6. Remaining architecture probes

The first campaign materially narrowed the open questions. The next probes should focus on what remains unknown rather than re-validating P1–P4:

- design and falsify a minimal **lifecycle wrapper** around the existing narrow execution contract;
- put at least two materially different Agent Drivers through one **real harness authority construction**, then repeat authority-denial probes;
- exercise the **designed containment path** through ordinary step execution rather than only `run-contained-cli`;
- complete an authoring-review + clearing run to test **I**, and deliberately test context leakage to test **J**;
- prototype **capture-at-boundary provenance** across claim → step → review → ship and verify the Change Dossier can answer the required questions without mutable joins;
- run an **autonomous semantic reconciler** on representative historical changes and measure escalation correctness, missed stale surfaces, and duplicate edits;
- use reconciliation results to derive canonical document ownership/dedupe rather than designing the document tree first.

## 7. Stage 3 gate

Do not perform the constitutional swap merely because an item is desirable target state.

Before a replacement ADR lands:

1. every surviving old constraint is present in its named carrier;
2. current-state vs target-state language is explicit;
3. target-state claims with material implementation risk have probe evidence or are clearly recorded as unimplemented decisions;
4. affected trust claims are rebound or weakened in the same change;
5. the ambiguous `proposed = decided-unimplemented` status vocabulary is replaced and existing ADRs are re-triaged;
6. mechanical ADR checks remain narrow; semantic layering stays review/skill territory unless a heuristic proves high-signal.

Superseded ADRs remain archaeology.

## 8. What success looks like

Adding a runtime means implementing an Agent Driver and proving it seats behind the same authority construction, not editing orchestration around its peculiarities.

Adding a delivery activity means composing the narrow execution seam with the common lifecycle behavior it actually needs, rather than growing a universal options bag.

Provenance facts are captured once where they become authoritative and projected into one coherent Change Dossier.

Implementation can report **what changed** without discovering every prose surface; reconciliation updates routine canonical material and escalates architecture/trust/external-contract conflict.

And a future maintainer can replace today's driver, review, containment, landing, or documentation machinery without fighting ADRs that accidentally made those mechanisms Pelaggio's identity.
