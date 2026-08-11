# ADR reconciliation: reduce the constitution to the product we mean to build

Status: proposal, pre-decision. Based on `path-forward.md`, trio review, and the Stage 2 falsification campaign under `docs/spikes/adr-probes/`.

## Why this exists

The current ADR ledger mixes durable product invariants, hard-won negative constraints, current topology, experimental algorithms, provider-specific limitations, and detailed construction. The correction is not simply fewer ADRs; it is a sharper boundary between invariant, failure-derived constraint, policy, and replaceable construction.

The governing ADR test is:

> **If the mechanism changed tomorrow, would this sentence still be required to avoid reintroducing a known failure?**

The probe campaign adds a second discipline: distinguish **current-state fact**, **target-state invariant**, and **candidate abstraction**. A desirable target may be false today; a useful current seam need not become the final abstraction.

## 1. Product target

> **A charter becomes a change by passing through well-defined, safely executed skills. Every consequential execution occurs under harness-owned authority. Every consequential transition is reconciled and evidenced. The resulting provenance explains how the change came to exist.**

The target has four concerns: delivery, safe execution, source provenance, and semantic reconciliation.

## 2. Candidate architectural constitution

### A. Work executes as typed steps in an ordered pipeline

A pipeline orders typed steps. Pelaggio need not become a general DAG scheduler. The invariant is explicit lifecycle boundaries with typed inputs and outputs, not today's exact step count or orchestrator topology.

### B. Keep execution narrow; compose lifecycle around it

P1 found a real shared execution seam: nine heterogeneous activities use `RunStepFn` without an untyped options bag. It did **not** find a lifecycle contract containing authority, exit criteria, accepted outputs, provenance, reconciliation, or recovery.

Therefore:

- **execution contract** — narrow invocation of work; exists today and should remain small;
- **lifecycle contract** — target-state behavior around execution: identity, authority, accepted outputs, recovery, provenance, reconciliation.

The lifecycle layer should wrap/compose the execution seam rather than turning `RunStepFn` into a universal options bag. The target vocabulary may be `Pipeline → Run → Step → StepRun → Attempt`, but exact type decomposition remains construction.

### C. Agents provide intelligence; Pelaggio retains advancement authority

Agents may propose, implement, inspect, review, and judge. They do not grant themselves authority.

**Advancement authority resolves through deterministic harness semantics.** Model judgments may be required evidence, but cannot themselves exercise authority to advance. Policy is explicit, inspectable, versioned, and evaluated outside model discretion; its representation is construction.

### D. Consequential agent execution has a harness-owned authority boundary — target state

Each consequential agentic execution must run inside a harness-controlled sandbox / authority boundary with explicit grants. The environment cannot broaden its own authority.

P2 falsified any claim that today's ordinary `runStep` path already provides this. The designed containment path is not currently the production step path.

**Containment is not permission.** Technical reachability and contractual permission are separate decisions.

Trust evidence must exercise controls at the real production seam. Testing a helper that constructs a safe environment does not prove that every driver invocation uses it; TC-014 currently demonstrates this failure.

### E. Agent Drivers enter through one declared authority construction

An **Agent Driver** is the runtime integration; provider and model are separate execution facts.

P1/P2 falsified the stronger current-state story of interchangeable drivers. The replacement constraint is:

> **Every Agent Driver enters through the harness's declared authority construction; driver-specific lifecycle concerns do not leak into the shared execution/lifecycle contract.**

Drivers may add native defense-in-depth. A required capability with no proven harness equivalent refuses seating. “Interchangeable” means interchangeable behind the same declared authority contract **where equivalence has been demonstrated**, not assumed equality or lowest-common-denominator behavior.

### F. Durable recovery follows run/attempt lineage, not deterministic replay

Accepted outputs, resumable WIP, failed attempts, and superseded attempts remain distinct. Nondeterministic agent execution is not pretended replayable. P3 supported this behavior; refactoring should preserve it.

### G. Capture provenance at authoritative semantic boundaries

The final lineage must explain charter/outcome/scope; supplied context and skill; Agent Driver/provider/model; sandbox/authority; step/attempt outputs; checks; review findings/resolution; retries/parks/supersession; semantic reconciliation; landing authorization; and final subject without mutable external joins.

P3 showed this is not durable today. The replacement rule is:

> **Capture each provenance fact durably at the authoritative boundary where it becomes known rather than reconstructing it later.**

Claim snapshots charter intent; step boundaries bind attempt/input/output; review binds clearing evidence; ship/landing binds authorization and final subject. The Change Dossier is a projection over these records, not a transcript/event-log requirement.

Externally consumed provenance binds a builder identity whose trust basis the consumer can independently verify.

### H. Consequential effects require authorization, evidence, and recovery ownership

Consequential mutations require harness-owned authorization and evidence appropriate to consequence/reversibility.

Stateful mutations are fenced at the state-owning authority or idempotently reconciled. Pre-checks, locks, ordering, and expiring hints do not substitute for authority.

**Safe refusal is incomplete without recovery ownership.** Every non-success absorbing state names a clearing transition and authorized actor. P2's confinement abort demonstrated the failure: correct guards stranded worktree, branch, and roadmap state and poisoned subsequent runs. Claim/pick therefore falls under this rule and ADR-0026.

Degradation may reduce rigor but never broaden authority; degraded evidence is visibly weaker and stale verified fallback is bounded.

### I. Review is part of authoring; clearing judgment is separated from authorship

The same decision-maker cannot both author a candidate and supply its clearing judgment. Clearing judgment is independently attributable; Pelaggio resolves it plus required evidence into authoritative disposition.

This does not prescribe reviewer count, Judge topology, convergence algorithm, driver diversity, or a third reviewing actor. P3 did not reach review, so I remains materially untested.

### J. Independent evaluation isolates information, not necessarily execution authority

Where policy requires independent evaluation, the evaluator receives only declared inputs and does not inherit mutable author-session state or hidden author context.

This is an information-isolation property, not evidence of sandboxing. Today's cold path may be better isolated informationally while being less protected on authority. Generic lifecycle/storage/budget/provenance machinery may be shared if information isolation survives.

### K. Semantic reconciliation is a delivery obligation

Chartering identifies potentially affected semantic surfaces; execution records realized impact; delivery reconciles the two.

Implementation reports what changed rather than discovering an unbounded prose graph. Reconciliation owns canonical placement/deduplication.

P4 found reconstruction tractable across eight historical PRs but did not prove autonomous reconciliation. The load-bearing rule is:

> **Conflict with architecture, trust, or an external contract escalates rather than silently rewriting the authoritative statement to fit implementation.**

Routine construction/behavior reconciliation may be autonomous. Noise suppression is optimization, not the safety property.

## 3. Design tradeoffs the architecture must optimize

These are not additional ADRs. They are the tensions architecture discovery and the remaining probes should resolve.

### T1. Narrow execution seam vs rich lifecycle abstraction

**Bias:** preserve the small execution primitive and compose lifecycle around it.

Putting authority, provenance, recovery, reconciliation, budgets, and every output shape directly into `RunStepFn` would make one interface easy to find but difficult to understand and extend. A lifecycle wrapper costs an additional concept/indirection but keeps execution simple and permits deterministic/non-agent work to share lifecycle without pretending it has identical invocation needs.

**Failure signal:** the wrapper merely moves today's special cases into another giant optional record.

### T2. Driver neutrality vs lowest-common-denominator execution

**Bias:** common authority contract, heterogeneous capabilities.

Do not make all runtimes look identical by throwing away useful native capabilities. Driver-native controls can strengthen safety/observability; they cannot silently weaken the declared harness boundary. Unsupported required capabilities refuse seating.

**Failure signal:** adding a driver either requires orchestration edits or forces every other driver down to its weakest feature set.

### T3. Harness-owned authority vs driver-native safety

**Bias:** the harness owns the portable authority floor; driver controls are defense-in-depth.

This is the engineering-heavy choice. Relying primarily on driver-native controls is cheaper but makes Pelaggio's safety semantics driver-dependent and weakens bring-any-agent. The remaining authority probe should determine which axes the harness can actually own and where a runtime genuinely cannot be seated equivalently.

**Failure signal:** a required authority axis cannot be mediated outside a particular driver without unacceptable complexity or bypass.

### T4. Strong containment vs developer friction

**Bias:** make ordinary safe work cheap; make unusual authority explicit.

Routine repo read/write and test execution should not require capability bureaucracy. Network, credentials, external mutation, and irreversible effects justify progressively more explicit grants/evidence. H's consequence/reversibility principle should govern ceremony.

**Failure signal:** common skill authors need to understand sandbox internals or enumerate incidental low-risk capabilities to do ordinary work.

### T5. Boundary-captured provenance vs omniscient logging

**Bias:** small durable records at authoritative transitions.

Boundary capture imposes a recording obligation on claim/step/review/ship, but avoids a centralized recorder, transcript retention, or mutable post-hoc joins. Provenance should be sufficient to explain custody without becoming observability storage.

**Failure signal:** answering basic custody questions still requires provider/GitHub/log joins, or provenance volume approaches transcript volume.

### T6. Durable WIP vs immutable accepted history

**Bias:** preserve both and type the distinction.

Attempt-local WIP may be mutable/resumable; accepted outputs and historical attempts must not be rewritten. P3 suggests this distinction already works and should not be sacrificed for a purist event model.

**Failure signal:** resumption launders failed work into accepted state, or preserving history makes useful resume prohibitively expensive.

### T7. Fail-closed vs recoverable

**Bias:** safe refusal plus explicit recovery ownership.

A guard that blocks unsafe progress but strands the system is incomplete. Recovery does not mean automatically clearing safety conditions; it means every blocked state has a known transition/actor capable of resolving it.

**Failure signal:** normal faults create debris that causes unrelated future runs to fail or require archaeological manual cleanup.

### T8. Review separation vs review bureaucracy

**Bias:** author ≠ clearing judgment; everything beyond that earns itself empirically.

Do not infer three agents, N+Judge, always-cold review, or provider diversity from the role-separation invariant. Review strategy should be replaceable and benchmarked for quality/cost.

**Failure signal:** satisfying the invariant requires a fixed multi-agent topology rather than independently attributable clearing judgment.

### T9. Context isolation vs authority isolation

**Bias:** model these as orthogonal properties.

A cold evaluator can be context-independent yet have broad host authority; a warm author can be tightly sandboxed. APIs, tests, and provenance should not use one property as evidence for the other.

**Failure signal:** “cold,” “independent,” or “sandboxed” becomes shorthand for multiple unverified guarantees.

### T10. Semantic reconciliation rigor vs autonomous-development friction

**Bias:** optimize first for consequential escalation correctness, then for prose quietness.

False-positive doc suggestions are annoying; silently normalizing an architecture/trust violation into prose is materially worse. Routine construction docs should be low-friction and autonomous while authoritative semantic conflicts stop/escalate.

**Failure signal:** reconciliation either sprays routine edits everywhere or rewrites authoritative decisions to make implementation appear coherent.

## 4. What should not be constitutional

Exact pipeline step/orchestrator count; N+Judge/fingerprint algorithm; provider diversity as permanent primitive; ocap/algebraic-effects vocabulary; containment substrate/broker topology; readiness rubric; retry counts; exact severity/tolerance tables; landing retry arithmetic; current Agent Driver limitations; a dedicated `reconcile-docs` step or `DocumentationImpact` enum; current doc filenames; or a prohibition on cold evaluation sharing generic lifecycle machinery.

## 5. Current ADR disposition

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
| 0020 provider seam/capabilities | **split** | Agent Driver seam + factual capabilities; every driver enters through harness authority; no-equivalent requirement refuses seating | E + self | `pipeline.md` § Step Providers ✅ |
| 0021 effects placement | **supersede** | explicit authority and authorized/evidenced boundary effects | C + D + H | `pipeline.md` § Effects Manifests ✅ |
| 0022 pipeline shape/orchestrators | **split** | ordered lifecycle; execution/lifecycle distinction; conditional context isolation; topology replaceable | A + B + J | cold-evaluation home needed |
| 0023 contained execution | **supersede** | target-state no ambient authority; containment ≠ permission | D | `contained-execution.md` ✅ |
| 0024 authoring review | **split** | review during authoring; author cannot supply own clearing judgment; algorithm replaceable | I | `adversarial-review-loop.md` ✅ |
| 0025 landing serialization | **cut** | actual ref fence remains load-bearing; ordering never substitutes | self | `flow.md` ✅ |
| 0026 stateful guards | **cut** | fence-or-reconcile; typed recovery across guard lifecycles including claim/pick; judgment/evidence/disposition separation; bounded retry; omission never refutation | self | `guarded-actions.md` ✅ |

## 6. Immediate correctness findings

Independent of the architecture choice:

1. **TC-014 is overstated on the default Claude path.** The env helper works but the real driver bypasses it. Fix the path or weaken the claim until end-to-end evidence exists.
2. **Confinement abort strands claim state across worktree, branch, and roadmap.** This is a missing clearing transition under H/ADR-0026, not a guard failure.

## 7. Remaining probes / architecture discovery

Do not re-test questions P1–P4 already answered. Focus on:

- falsifying a minimal lifecycle wrapper around the narrow execution seam;
- seating at least