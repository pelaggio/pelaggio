# ADR reconciliation: reduce the constitution to the product we mean to build

Status: proposal, pre-decision. Based on `path-forward.md`, trio review, Stage 2 falsification probes, and the architecture discovery in PR #482.

## Why this exists

The current ADR ledger mixes durable product invariants, hard-won negative constraints, current topology, experimental algorithms, provider-specific limitations, and detailed construction. The correction is not simply fewer ADRs; it is a sharper boundary between invariant, failure-derived constraint, policy, and replaceable construction.

The governing ADR test is:

> **If the mechanism changed tomorrow, would this sentence still be required to avoid reintroducing a known failure?**

The probe/discovery work adds two further disciplines:

- distinguish **current-state fact**, **target-state invariant**, and **candidate abstraction**;
- **prefer widening an underspecified existing boundary over introducing a new abstraction** when the existing concept is sound and the leakage exists because its interface is one size too small.

A desirable target may be false today. A useful current seam need not become the final abstraction. A large function does not, by itself, justify a framework.

## 1. Product target

> **A charter becomes a change by passing through well-defined, safely executed skills. Every consequential execution occurs under harness-owned authority. Every consequential transition is reconciled and evidenced. The resulting provenance explains how the change came to exist.**

The target has four concerns: delivery, safe execution, source provenance, and semantic reconciliation.

## 2. Candidate architectural constitution

### A. Work executes as typed steps in an ordered pipeline

A pipeline orders typed steps. Pelaggio does not need to become a general DAG scheduler. The invariant is explicit lifecycle boundaries with typed inputs and outputs, not today's exact step count or orchestrator topology.

Architecture discovery reinforces this: the current pipeline is honestly linear and step-name branching is already low. There is no measured DAG pressure.

### B. Keep execution narrow; make lifecycle state explicit around it

P1 found a real shared execution seam: nine heterogeneous activities use `RunStepFn` without an untyped options bag. PR #482 independently found the provider/type layer comparatively healthy while lifecycle concerns concentrate in `runPipeline` and `runOrchestrator`.

Therefore:

- **execution contract** — narrow invocation of work; exists today and should remain small;
- **lifecycle behavior** — identity, authority, accepted outputs, recovery, provenance, reconciliation, and transition ownership around execution.

The important architectural property is **explicit lifecycle state and ownership**, not necessarily one universal `LifecycleContract` interface.

Two constructions remain intentionally open for the next probe:

1. a small lifecycle wrapper / `StepRun` abstraction around the existing execution seam; or
2. narrow phase functions over a shared typed cycle/run context.

For example, `plan(ctx) → PlanResult`, `implement(ctx) → ImplementResult`, `review(ctx) → ReviewResult`, `ship(ctx,target) → ShipResult` may prove clearer than a deeply generic `Step<Input, Output, Authority, Recovery, …>`.

**Constraint:** do not enlarge `RunStepFn` into a universal optional-field record, and do not hide today's special cases inside a new lifecycle god-object.

### C. Agents provide intelligence; Pelaggio retains advancement authority

Agents may propose, implement, inspect, review, and judge. They do not grant themselves authority.

**Advancement authority resolves through deterministic harness semantics.** Model judgments may be required evidence, but cannot themselves exercise authority to advance. Policy is explicit, inspectable, versioned, and evaluated outside model discretion; its representation is construction.

### D. Consequential agent execution has a harness-owned authority boundary — target state

Each consequential agentic execution must run inside a harness-controlled sandbox / authority boundary with explicit grants. The environment cannot broaden its own authority.

P2 falsified any claim that today's ordinary `runStep` path already provides this. PR #482 confirms the designed containment stack exists but is only connected to `run-contained`, not normal pipeline execution.

**Containment is not permission.** Technical reachability and contractual permission are separate decisions.

**Trust evidence must exercise the real production seam.** A correct helper is not proof that every driver uses it. TC-014 is the measured exemplar: the env builder is correct and tested while the default Claude production path bypasses it.

### E. Preserve the good Agent Driver dispatch seam; construct authority around it

An **Agent Driver** is the runtime integration; provider and model are separate execution facts.

PR #482 found the dispatch itself is already a healthy seam: typed providers behind a registry and narrow dispatcher. P1/P2 found that authority and driver-specific lifecycle concerns leak around it.

The replacement invariant is:

> **Every Agent Driver enters through the harness's declared authority construction; driver-specific lifecycle concerns do not leak into the shared execution/lifecycle boundary.**

Do not redesign a functioning dispatch abstraction merely because its surrounding authority plumbing is wrong. Widen or wrap the existing seam as needed.

Drivers may add native defense-in-depth. A required capability with no proven harness equivalent refuses seating. “Interchangeable” means interchangeable behind the same declared authority contract **where equivalence has been demonstrated**, not assumed equality or lowest-common-denominator execution.

### F. Durable recovery follows run/attempt lineage, not deterministic replay

Accepted outputs, resumable WIP, failed attempts, and superseded attempts remain distinct. Nondeterministic agent execution is not pretended replayable. P3 supported this behavior; refactoring should preserve it.

Architecture discovery also found identity fragmentation around otherwise useful attempt identity. Unification should strengthen joins without destroying the working attempt-lineage semantics.

### G. Capture provenance at authoritative semantic boundaries, in a durable attempt-keyed home

The final lineage must explain charter/outcome/scope; supplied context and skill; Agent Driver/provider/model; sandbox/authority; step/attempt outputs; checks; review findings/resolution; retries/parks/supersession; semantic reconciliation; landing authorization; and final subject without mutable external joins.

P3 showed this is not durable today. PR #482 identified the concrete inversion: strong execution receipts and review records live under `WORKTREE/.dev` and are destroyed by successful ship, while durable identities do not cleanly join.

The replacement rules are:

> **Capture each provenance fact durably at the authoritative boundary where it becomes known rather than reconstructing it later.**

> **Evidence that must survive delivery lives in a durable home keyed by coherent run/attempt identity, not only inside the disposable worktree.**

Claim snapshots charter intent; step boundaries bind attempt/input/output; review binds clearing evidence; ship/landing binds authorization and final subject. The Change Dossier is a projection over these records, not a transcript/event-log requirement.

Externally consumed provenance binds a builder identity whose trust basis the consumer can independently verify.

### H. Consequential transitions require authorization, evidence, and an owner/reconciler

Consequential mutations require harness-owned authorization and evidence appropriate to consequence/reversibility.

Stateful mutations are fenced at the state-owning authority or idempotently reconciled. Pre-checks, locks, ordering, and expiring hints do not substitute for authority.

**Safe refusal is incomplete without recovery ownership.** Every non-success absorbing state names a clearing transition and authorized actor.

The same principle applies to successful external transitions: **a lifecycle transition that completes outside the current process must have an explicit owner/reconciler for the next state.** PR #482's clearest example is production `auto-merge-pr`: GitHub can merge the PR, but no code currently owns `merged → done`; stale quarantine is the accidental reconciler.

P2's confinement abort is the failure-side mirror: correct guards strand worktree, branch, and roadmap state and poison subsequent runs.

Degradation may reduce rigor but never broaden authority; degraded evidence is visibly weaker and stale verified fallback is bounded.

### I. Review is part of authoring; clearing judgment is separated from authorship

The same decision-maker cannot both author a candidate and supply its clearing judgment. Clearing judgment is independently attributable; Pelaggio resolves it plus required evidence into authoritative disposition.

This does not prescribe reviewer count, Judge topology, convergence algorithm, driver diversity, or a third reviewing actor.

PR #482 suggests the **review concept is healthy but orchestration is duplicated**: the pure authoring-review core exists while authoring and cold-gate orchestration have diverged enough to create safety asymmetry. Prefer reusing/widening the good shared review core over preserving multiple independent review engines.

I remains materially untested end-to-end because P3 did not reach review.

### J. Independent evaluation isolates information, not necessarily execution authority

Where policy requires independent evaluation, the evaluator receives only declared inputs and does not inherit mutable author-session state or hidden author context.

This is an information-isolation property, not evidence of sandboxing. Today's cold path may be better isolated informationally while being less protected on authority. Generic lifecycle/storage/budget/provenance machinery may be shared if information isolation survives.

### K. Semantic reconciliation is a delivery obligation

Chartering identifies potentially affected semantic surfaces; execution records realized impact; delivery reconciles the two.

Implementation reports what changed rather than discovering an unbounded prose graph. Reconciliation owns canonical placement/deduplication.

P4 found reconstruction tractable across eight historical PRs but did not prove autonomous reconciliation. The load-bearing rule is:

> **Conflict with architecture, trust, or an external contract escalates rather than silently rewriting the authoritative statement to fit implementation.**

PR #482 supplies further evidence for why this matters: agent-facing docs currently blur planned vs shipped behavior, including a landing fence and skill expansion behavior that code does not implement.

Routine construction/behavior reconciliation may be autonomous. Noise suppression is optimization, not the safety property.

## 3. Construction bias from architecture discovery

PR #482 changes the default refactoring posture:

> **Before creating a new abstraction, ask whether a sound existing boundary is merely underspecified. Prefer widening that boundary when doing so restores singular ownership and removes leaked orchestration without making the interface incoherent.**

`ShipTarget` is the canonical current example: it exposes too little, so direct-push/PR-specific lifecycle behavior leaks back into the orchestrator. Widening the target contract is presumptively better than creating a generic shipping framework.

The same test applies elsewhere:

- provider dispatch: preserve it; fix authority around it;
- review core: preserve/reuse it; extract duplicated orchestration;
- flow policy: preserve its pure deterministic core rather than delegating policy back through an agent turn;
- attempt lineage: preserve the semantics; fix durability/join ownership around it.

A new abstraction must answer: **which concrete duplication, ownership ambiguity, or invalid state disappears because this abstraction exists?**

## 4. Design tradeoffs the architecture must optimize

These are not additional ADRs.

### T1. Narrow execution seam vs lifecycle explicitness

**Bias:** preserve the small execution primitive; make lifecycle explicit around it. Do not assume that means one generic lifecycle interface.

**Competing shapes to probe:** generic lifecycle wrapper vs narrow phase functions over shared run/cycle context.

**Failure signal:** either shape becomes a giant optional record or reproduces the orchestration closure under a different name.

### T2. Driver neutrality vs lowest-common-denominator execution

**Bias:** common authority contract, heterogeneous capabilities.

**Failure signal:** adding a driver requires orchestration edits or forces every driver down to the weakest feature set.

### T3. Harness-owned authority vs driver-native safety

**Bias:** harness owns the portable authority floor; driver controls are defense-in-depth.

**Failure signal:** a required authority axis cannot be mediated outside a particular driver without unacceptable complexity/bypass.

### T4. Strong containment vs developer friction

**Bias:** ordinary repo work is cheap; unusual authority is explicit. Ceremony scales with consequence/reversibility.

**Failure signal:** routine skill authors need sandbox-internal knowledge or incidental capability declarations.

### T5. Boundary-captured provenance vs omniscient logging

**Bias:** small durable attempt-keyed records at authoritative transitions.

**Failure signal:** custody still requires mutable joins or evidence volume approaches transcript volume.

### T6. Durable WIP vs immutable accepted history

**Bias:** preserve and type both.

**Failure signal:** resumption launders failed work into accepted state, or history makes useful resume impractical.

### T7. Fail-closed vs recoverable

**Bias:** safe refusal plus explicit recovery ownership.

**Failure signal:** ordinary faults create debris that poisons future runs or requires archaeological cleanup.

### T8. Review separation vs bureaucracy

**Bias:** author ≠ clearing judgment; everything beyond that earns itself empirically.

**Failure signal:** the invariant requires a fixed multi-agent topology.

### T9. Context isolation vs authority isolation

**Bias:** model and test them independently.

**Failure signal:** “cold,” “independent,” or “sandboxed” becomes shorthand for unverified bundles of guarantees.

### T10. Semantic reconciliation rigor vs autonomous-development friction

**Bias:** optimize first for consequential escalation correctness, then prose quietness.

**Failure signal:** reconciliation sprays routine edits or silently rewrites authoritative decisions to fit implementation.

### T11. Widen an existing boundary vs introduce a new abstraction

**Bias:** widen when the concept is sound, ownership belongs there, and leaked behavior is homogeneous with that responsibility. Introduce a new abstraction only when responsibilities are genuinely independent and need separate evolution.

**Failure signal for widening:** the interface accumulates unrelated concerns and becomes another god-object.

**Failure signal for a new abstraction:** it adds indirection without removing duplication, invalid states, or ownership ambiguity.

## 5. What should not be constitutional

Exact pipeline step/orchestrator count; generic DAG semantics; N+Judge/fingerprint algorithm; provider diversity as permanent primitive; ocap/algebraic-effects vocabulary; containment substrate/broker topology; readiness rubric; retry counts; exact severity/tolerance tables; landing retry arithmetic; current Agent Driver limitations; a dedicated `reconcile-docs` step or `DocumentationImpact` enum; current doc filenames; a universal lifecycle interface; or a prohibition on cold evaluation sharing generic lifecycle machinery.

## 6. Current ADR disposition

The rule is: shrinking/superseding an ADR must not orphan the reason a replacement would otherwise repeat a known failure. `cut` preserves the ADR under its number; `split` separates independently replaceable decisions; `supersede` moves surviving constraints into named replacement clauses first; `demote` moves policy/config out of architecture.

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
| 0020 provider seam/capabilities | **split** | preserve Agent Driver dispatch; every driver enters through harness authority; no-equivalent requirement refuses seating | E + self | `pipeline.md` § Step Providers ✅ |
| 0021 effects placement | **supersede** | explicit authority and authorized/evidenced boundary effects | C + D + H | `pipeline.md` § Effects Manifests ✅ |
| 0022 pipeline shape/orchestrators | **split** | ordered lifecycle; execution/lifecycle distinction; conditional context isolation; topology and exact lifecycle abstraction replaceable | A + B + J | cold-evaluation home needed |
| 0023 contained execution | **supersede** | target-state no ambient authority; containment ≠ permission | D | `contained-execution.md` ✅ |
| 0024 authoring review | **split** | review during authoring; author cannot supply own clearing judgment; algorithm replaceable | I | `adversarial-review-loop.md` ✅ |
| 0025 landing serialization | **cut / re-check against current code** | landing must be positively fenced at the authority; do not state the planned direct-push CAS as shipped behavior | self + H | `flow.md` / landing construction |
| 0026 stateful guards | **cut** | fence-or-reconcile; typed recovery across guard lifecycles including claim/pick; judgment/evidence/disposition separation; bounded retry; omission never refutation | self | `guarded-actions.md` ✅ |

## 7. Immediate correctness findings

Independent of the architecture choice:

1. **TC-014 is overstated on the default Claude path.** The env helper works but the real driver bypasses it. Fix the path or weaken the claim until end-to-end evidence exists.
2. **Confinement abort strands claim state across worktree, branch, and roadmap.** This is a missing clearing transition under H/ADR-0026, not a guard failure.
3. **Production `auto-merge-pr` has no explicit `merged → done` owner.** This is a lifecycle/reconciliation gap, not merely a shipping implementation detail.
4. **Durable evidence is currently inverted.** Execution receipts/review records may be destroyed with the successful worktree; evidence required for custody needs a durable home.
5. **Agent-facing docs contain planned-as-shipped claims.** In particular, the ADR-0025 direct-push CAS fence and skill include expansion must not be treated as current-state guarantees without production evidence.

## 8. Remaining probes / architecture discovery

Do not re-test questions P1–P4 already answered. Focus on:

- compare a **minimal lifecycle wrapper** with **narrow phase functions over shared typed cycle/run context**; falsify both rather than assuming one;
- seat at least two materially different Agent Drivers behind one **real harness authority construction** and repeat authority-denial probes;
- exercise the designed containment path through ordinary step execution rather than only `run-contained`;
- complete authoring review + clearing to test I and deliberately test context leakage for J;
- prototype capture-at-boundary provenance into a **durable attempt-keyed evidence home**, including successful worktree destruction;
- verify `merged → done` reconciliation for the production PR target under success, delayed merge, restart, and duplicate observation;
- run an autonomous semantic reconciler on representative changes, prioritizing escalation correctness;
- use reconciliation output to derive canonical document ownership/dedupe rather than designing the doc tree first.

Architecture discovery should use PR #482 as the current-state evidence anchor and this document as the target/tradeoff anchor. Candidate refactors should state which assumptions remain probe-dependent.

## 9. Stage 3 gate

Do not perform the constitutional swap merely because an item is desirable target state.

Before a replacement ADR lands:

1. every surviving old constraint is present in its named carrier;
2. current-state vs target-state language is explicit;
3. target-state claims with material implementation risk have probe evidence or are clearly recorded as unimplemented decisions;
4. affected trust claims are rebound or weakened in the same change;
5. `proposed = decided-unimplemented` is replaced and existing ADRs are re-triaged;
6. mechanical ADR checks remain narrow; semantic layering stays review/skill territory unless a heuristic proves high-signal;
7. planned-vs-shipped facts in always-loaded/agent-facing docs have production-seam evidence.

Superseded ADRs remain archaeology.

## 10. What success looks like

Adding a runtime means implementing/preserving an Agent Driver and proving it seats behind the same declared authority construction, not editing orchestration around its peculiarities.

Adding a delivery activity means using the narrow execution seam plus explicit lifecycle state/ownership without extending a monolithic controller or inventing a framework.

Shipping through any target leaves the item in a reconciled terminal lifecycle state, even when completion occurs asynchronously outside the process.

Provenance facts are captured once where they become authoritative, survive successful worktree destruction, and project into one coherent Change Dossier.

Implementation can report **what changed** without discovering every prose surface; reconciliation updates routine canonical material and escalates architecture/trust/external-contract conflict.

And a future maintainer can replace today's driver, review, containment, landing, or documentation machinery without fighting ADRs that accidentally made those mechanisms Pelaggio's identity.
