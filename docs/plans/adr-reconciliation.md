# ADR reconciliation: reduce the constitution to the product we mean to build

Status: proposal, pre-decision. Based on the measurements and corrections in `path-forward.md` and intended to be attacked before the constitutional swap.

## Why this exists

The current ADR ledger mixes durable product invariants, hard-won negative constraints, current implementation topology, experimental algorithms, provider-specific limitations, and detailed construction. That makes replaceable machinery feel constitutional and, in the other direction, makes it easy to throw away the reason an old mechanism had teeth.

The correction is not simply "fewer ADRs." It is a sharper boundary:

- an ADR owns the **invariant** and the **constraints a replacement must still satisfy**;
- construction has one canonical home outside the ADR;
- policy and experiments stay policy and experiments until they earn permanence;
- superseded decisions remain as history rather than being rewritten away.

The governing test is:

> **If the mechanism changed tomorrow, would this sentence still be required to avoid reintroducing a known failure?**

## 1. Product target

> **A charter becomes a change by passing through well-defined, safely executed skills. Every execution occurs under harness-owned authority. Every consequential transition is reconciled and evidenced. The resulting provenance explains how the change came to exist.**

The target has three first-class systems plus semantic reconciliation across them: delivery, safe execution, source provenance, and reconciliation of the durable semantic surfaces a change affects.

## 2. Candidate architectural constitution

The labels are review handles, not proposed ADR numbers.

### A. Work executes as typed steps in an ordered pipeline

A pipeline orders typed steps. Pelaggio need not become a general DAG scheduler. The invariant is explicit lifecycle boundaries with typed inputs and outputs, not today's exact step count or orchestrator topology.

### B. Every step uses one lifecycle contract

Conceptually:

```text
Step
  identity
  skill
  inputs
  context
  authority profile
  execution profile
  Agent Driver requirements / preferences
  budgets
  exit criteria
  outputs
  provenance contribution
  reconciliation obligations
  recovery / escalation semantics
```

The contract is a common seam, not mandatory enrollment in one implementation topology.

### C. Agents provide intelligence; Pelaggio retains authority

Agents may propose, implement, inspect, review, and judge. They do not grant themselves filesystem, process, network, credential, git, merge, or external-effect authority.

**Advancement authority resolves through deterministic harness semantics.** Model judgments may produce evidence or dispositions, but cannot themselves exercise the authority to advance. A harness rule may deterministically accept a valid, attributable model judgment as one of its required inputs; the semantic judgment need not itself be deterministic.

**Policy is explicit, inspectable, versioned, and evaluated by the harness rather than hidden in model discretion.** Its representation may be data, typed code, or another reviewable form; that representation is construction.

### D. Agent execution has no ambient authority

Each agentic step executes inside a harness-controlled sandbox / authority boundary. Authorities are explicit grants; the execution environment cannot broaden its own authority.

**Containment is not permission.** Bounding what execution can technically reach does not establish whether that execution is contractually permitted. Permission is decided separately on its own evidence.

### E. Agent Drivers are interchangeable intelligence adapters

An **Agent Driver** is the runtime integration Pelaggio invokes. Provider and model are separate execution facts. The driver reports factual optional/native capabilities and telemetry.

A missing driver-native hook is not automatically a safety failure if the harness supplies an equivalent authority boundary. A required capability with **no proven harness equivalent** refuses seating rather than being silently downgraded.

### F. Durable recovery follows run/attempt lineage, not deterministic replay

A completed step produces an accepted artifact/checkpoint. Nondeterministic agent execution is not replayed as if deterministic. Valid interrupted WIP may be durable and resumable. Retries are new attempts in the same lineage, not mutations of history.

### G. Every change accumulates self-contained source provenance

The final lineage must explain, without mutable external joins: charter/outcome/scope; supplied context and skill; Agent Driver/provider/model; sandbox/authority; step and attempt outputs; deterministic checks; review findings and resolution; retries/parks/supersession; semantic reconciliation; landing authorization; and final commit/tree.

Where provenance is consumed outside the local system, it binds a **builder identity whose trust basis the consumer can independently verify**. Signing format, attestation envelope, and runner topology are construction.

### H. Consequential effects require deterministic authorization and durable evidence

Agent judgment may be an input to policy; it is not itself authority. Consequential mutations require harness-owned authorization and evidence appropriate to the effect.

Stateful mutations — external or shared local harness state — are fenced at the state-owning authority or idempotently reconciled. Observational pre-checks, locks, and expiring hints are not correctness boundaries by themselves.

Required rigor scales with **consequence and reversibility**, not lifecycle position. The cost model is policy, not doctrine.

**Degradation reduces rigor; it never broadens authority.** A degraded path is visibly weaker, cannot use an unverified/uncontained surface, and any stale verified fallback is bounded by a staleness ceiling and active re-verification trigger.

Every non-success terminal state identifies a recovery transition and authorized clearer.

### I. Review is part of authoring; clearing judgment is separated from authorship

A change is challenged, revised, and resolved during authoring rather than presenting a raw first draft as the finished artifact. The review record contributes to source provenance.

**The same decision-maker cannot both author a candidate and supply the clearing judgment for that candidate.** The clearing judgment must be independently attributable. Pelaggio may then deterministically resolve that judgment plus other required evidence into an authoritative disposition; this does not require a third reviewing agent or a particular review topology.

The number of reviewers, Judge role, convergence algorithm, and driver/provider mix remain strategy.

### J. When policy requires independent evaluation, independence is a property of the execution

An evaluation required to be independent receives only explicitly declared inputs and does not inherit mutable author-session state or hidden author context.

This is conditional: I does not mandate a second independent review system. Generic lifecycle, storage, checkpoint, effects, budget, and provenance machinery may be reused if the isolation property survives.

### K. Semantic reconciliation is a delivery obligation

Chartering identifies the semantic surfaces the intended change may affect; execution records realized impact; delivery reconciles the two before the change is complete.

Implementation reports facts about what changed rather than discovering and rewriting an unbounded prose graph. Reconciliation owns canonical placement/deduplication. Routine construction/behavior reconciliation may proceed autonomously; conflict with architecture, trust, or an external contract becomes typed escalation rather than silent rewrite.

The impact taxonomy, dedicated-step topology, driver choice, routing map, and document layout remain construction/policy to be proven.

## 3. What should not be constitutional

Examples: exact pipeline step/orchestrator count; N+Judge/fingerprint algorithm; provider diversity as permanent primitive; ocap/algebraic-effects vocabulary; containment substrate/broker topology; readiness rubric; retry counts; exact severity/tolerance tables; landing retry arithmetic; current Agent Driver limitations; a dedicated `reconcile-docs` step or `DocumentationImpact` enum; current doc filenames; or a prohibition on cold evaluation sharing generic lifecycle machinery.

## 4. Disposition of the current ADRs

The trio reviews established the rule: shrinking or superseding an ADR must not orphan the reason a replacement would otherwise repeat a known failure. `cut` preserves an ADR under its number; `split` separates independently replaceable decisions; `supersede` moves each surviving constraint into a named replacement clause before marking the old ADR; `demote` moves policy/config out of architecture.

The **Carried by** column makes constraint transfer reviewable. `self` means the ADR survives and carries its own constraints.

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
| 0020 provider seam/capabilities | **split** | Agent Driver seam + factual capabilities; no-equivalent requirement refuses seating | E + self | `pipeline.md` § Step Providers ✅ |
| 0021 effects placement | **supersede** | explicit authority and authorized/evidenced boundary effects | C + D + H | `pipeline.md` § Effects Manifests ✅ |
| 0022 pipeline shape/orchestrators | **split** | ordered lifecycle + conditional isolation property; topology replaceable | A + B + J | cold-evaluation home needed |
| 0023 contained execution | **supersede** | no ambient authority; containment ≠ permission | D | `contained-execution.md` ✅ |
| 0024 authoring review | **split** | review during authoring; author cannot supply own clearing judgment; algorithm replaceable | I | `adversarial-review-loop.md` ✅ |
| 0025 landing serialization | **cut** | actual ref fence remains load-bearing; ordering never substitutes | self | `flow.md` ✅ |
| 0026 stateful guards | **cut** *(re-cut)* | fence-or-reconcile; typed recovery; judgment/evidence/disposition separation; bounded actionable retry; omission never refutation | self | `guarded-actions.md` ✅ |

ADR-0026 has now been re-cut: quota/token design, attempt-register shape, cause tables, aggregation algorithm, retry mechanics, and sequencing live in its construction home; the ADR retains the semantic invariants and failure-derived negative constraints.

## 5. Questions for architecture probes

The remaining uncertainty is empirical, not primarily editorial:

1. Can heterogeneous work fit B without `Step` becoming a god-object?
2. Can one harness authority profile actually bound materially different Agent Drivers?
3. Which required capabilities have no safe harness equivalent?
4. Can cold/independent evaluation reuse common machinery without state leakage?
5. Is source provenance compact, self-contained, and useful without becoming telemetry/transcript storage?
6. Does run/attempt durability preserve WIP without laundering failed attempts into accepted outputs?
7. Can semantic reconciliation stay bounded and high-signal under unattended development?
8. Does canonical doc ownership emerge cleanly enough to support dedupe without another master-document layer?

## 6. Validation plan

### Stage 1 — adversarial document review

The trio attacks A–K and the disposition/carrier table. Acceptance means no unresolved counterexample showing required behavior cannot be represented without freezing replaceable construction.

### Stage 2 — architecture probes

Run the probe suite described below before writing replacement ADRs:

- Step-contract conformance;
- cross-driver authority denial;
- capability-equivalence matrix;
- cold-isolation reuse;
- run/attempt recovery lineage;
- source-provenance / Change Dossier prototype;
- semantic reconciliation replay;
- canonical-doc ownership/dedupe inventory.

### Stage 3 — constitutional swap

Only after Stage 2:

1. add replacement ADRs;
2. refuse supersession until every surviving constraint is present in its named carrier;
3. cut surviving ADR construction only when its canonical home exists;
4. rebind affected trust claims;
5. replace `proposed = decided-unimplemented` and re-triage existing statuses;
6. keep mechanical ADR checks narrow (shape, links, home existence, status/supersession integrity); semantic layering remains review/skill territory unless a heuristic proves high-signal;
7. establish canonical vocabulary once (`Pipeline → Step → Run → Attempt`, `Agent Driver → Provider → Model`, sandbox/authority boundary, provenance/dossier/attestation);
8. dedupe living docs based on the Stage 2 ownership inventory rather than adding another master document.

Superseded ADRs remain archaeology.

## 7. What success looks like

Adding a runtime means implementing an Agent Driver and proving its authority boundary, not editing orchestration around its peculiarities. Adding a delivery activity means implementing a typed step/skill and receiving lifecycle, authority, recovery, provenance, and reconciliation behavior through the common contract.

Implementation can report **what changed** without discovering every prose surface. Reconciliation updates canonical construction/behavior docs where safe and escalates architecture/trust/external-contract conflicts.

A reviewer can traverse one coherent Change Dossier from charter to final commit and understand how the artifact was authored, challenged, revised, reconciled, and authorized.
