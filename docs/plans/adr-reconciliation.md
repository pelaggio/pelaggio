# ADR reconciliation: reduce the constitution to the product we mean to build

Status: proposal, pre-decision. Based on the measurements and corrections in `path-forward.md` and intended to be reviewed **before** replacing any ADRs.

## Why this exists

The current ADR ledger contains 26 decisions, including 12 whose status is `proposed`, where this repository defines `proposed` as **decided, not yet implemented**. That is too strong a status for several large mechanisms that have not yet earned their permanence through implementation and operation.

The problem is not that the ADRs contain no good engineering. They contain a great deal of it. The problem is that durable product invariants, current implementation topology, experimental algorithms, provider-specific limitations, and detailed mechanism designs have all been promoted into the same constitutional lane.

The measurements in `path-forward.md` make the cost visible. Routed documentation exists but is not reliably found. The authoring-review loop accounts for all 22 August parks. Provider root-context loading works better than assumed. The structural pressure in `pipeline.ts` is concentrated in its lifecycle envelope rather than evidence that the six phases themselves need replacement.

This document proposes a smaller architectural constitution and a disposition for the existing ADRs. It deliberately changes **no ADR yet**.

---

## 1. Product target

Pelaggio should make one promise:

> **A charter becomes a change by passing through a sequence of well-defined, safely executed skills. Every execution occurs under harness-owned authority. Every transition produces evidence. The resulting evidence chain explains how the change came to exist.**

That implies three first-class systems.

### 1.1 Delivery harness

Work moves through an ordered recipe of engineered steps. A step has an explicit purpose, inputs, skill, context, authority, execution requirements, exit criteria, outputs, recovery behavior, and provenance contribution.

The default software-delivery recipe may remain recognizably similar to today's pipeline. The architectural commitment is the **step contract**, not the exact count or names of today's steps.

### 1.2 Safe execution harness

Claude, Codex, Grok, Gemini, OpenCode, and future agents are intelligence providers behind a common execution contract. Pelaggio owns the enclosing authority boundary: filesystem, process, environment, network, credentials, git mutation, and external effects.

Provider-native controls are useful defense-in-depth and observability. They must not become the architectural source of Pelaggio's authority model. A provider supplies intelligence; the harness grants or withholds authority.

### 1.3 Custody / provenance system

Every accepted step contributes an immutable record to one coherent change dossier. The dossier records the charter, context, actors, provider/model realization, sandbox and authority profile, outputs, verification, findings, resolutions, retries, delivery decision, and lineage.

A compact machine-verifiable attestation may bind this dossier to a commit and gate results. The attestation and the rich authoring dossier are related but distinct artifacts:

- **attestation:** small, signed, machine-checkable control/evidence;
- **dossier:** rich, durable explanation of how the change came to exist, useful for provenance now and archaeology later.

The dossier is accumulated during execution, not reconstructed afterward by joining mutable provider, git, issue, PR, and log state.

---

## 2. Proposed architectural constitution

The replacement ADR set should be small. The following are candidate durable decisions; numbering is intentionally deferred until review.

### A. Work executes as typed steps in an ordered recipe

A recipe orders typed steps. The harness need not become a general DAG scheduler. Conditionality, fan-out, iterative review, and deterministic sub-work may live inside a step or a deliberately small recipe construct.

The invariant is not `STEPS.length === 6`; it is that work crosses explicit lifecycle boundaries with typed inputs and outputs.

### B. Every step uses one lifecycle contract

Conceptually, every step declares:

```text
Step
  identity
  skill
  inputs
  context
  authority profile
  execution profile
  provider requirements / preferences
  budgets
  exit criteria
  outputs
  provenance contribution
  recovery / escalation semantics
```

This is the seam the current `step()` envelope is trying to provide. Refactoring should make it explicit without forcing every internal algorithm into one generic node abstraction.

### C. Agents provide intelligence; Pelaggio retains authority

Agents may propose, implement, inspect, review, and judge. They do not grant themselves filesystem, process, network, credential, git, merge, or external-effect authority.

The harness deterministically decides whether an agent judgment is sufficient to advance and which requested effects are permitted.

### D. Agent execution has no ambient authority

Each agentic step executes inside a harness-controlled boundary. Authorities are explicit grants. The execution environment cannot broaden its own authority.

The ADR should specify the trust invariant, not freeze bubblewrap vs Podman vs Landlock, broker topology, package-store layout, or provider credential mechanics. Those belong in design and trust/conformance documentation unless a mechanism becomes externally load-bearing and hard to reverse.

### E. Providers are interchangeable intelligence adapters

The provider seam describes how Pelaggio invokes an intelligence provider and what optional/native capabilities and telemetry it offers. Provider-native restrictions may narrow authority or strengthen evidence but do not define the base Pelaggio safety model.

Provider selection may consider quality, cost, context, native features, and policy. Missing optional provider-native safety hooks should not by itself make a provider impossible to execute safely if the harness boundary supplies the required authority controls.

### F. Accepted step outputs are immutable checkpoints

A completed step produces an accepted artifact/checkpoint. Crash recovery resumes from accepted boundaries rather than pretending nondeterministic LLM execution can be deterministically replayed.

**Accepted boundaries are not the only durable state.** A step interrupted for a reason that does not impugn the tree — a rate-limit park, a budget pause, an operator stop — must checkpoint its partial work and resume onto it. Only an outcome that proves the tree untrustworthy (a confinement failure) may discard it. A constitution that recovers *only* from accepted step outputs would silently delete recoverable work in progress.

Retries are new attempts in the same lineage, not mutations of historical evidence.

### G. Every change accumulates a self-contained custody dossier

Each step appends/binds its contribution to the change's provenance lineage. The final dossier must be sufficient to answer, without re-deriving from mutable external state:

- Why did this work exist?
- What was the intended outcome and scope?
- What context and skill were supplied?
- Which agent/provider/model acted?
- Under what authority and containment profile?
- What did each step produce?
- What deterministic checks ran?
- What reviewers found, and how were findings fixed or refuted?
- What retries, parks, resumptions, or superseded attempts occurred?
- Why was the final candidate authorized to land?
- What exact commit/tree resulted?

### H. Irreversible effects require deterministic authorization and durable evidence

Agent judgment may be an input to policy; it is not itself authority. Irreversible or externally consequential effects require harness-owned authorization and evidence appropriate to the effect.

Stateful mutations must have real ownership semantics: fence stale actors at the authority, or make the operation idempotently reconcilable. Observational pre-checks and expiring hints are not correctness boundaries.

**This is not scoped to external effects.** Shared *local* harness state — worktree ownership, the attempt register, revision entitlements, review queues — is governed by the same rule, and is where the class was first found. A fence-or-reconcile invariant written only against external mutations reopens the local half of the guard class.

Every non-success terminal state must identify a recovery transition and the actor authorized to perform it.

### I. Review happens during authoring, and its record ships with the change

Evaluation is not a post-hoc gate on a raw draft. A change is challenged, revised, and converged **inside** the authoring lifecycle, and the resulting record travels with the candidate as evidence. What arrives for human or platform judgment is an already-reviewed artifact plus the account of how it was reviewed.

This is the product commitment, and it is separable from any particular review algorithm. The number of reviewers, the presence of a judge, the convergence rule, and the provider mix are all replaceable strategy; *that review is part of authoring rather than after it* is not.

### J. Evaluation that must be independent executes cold

Some evaluation is only worth what its independence is worth. A step whose job is to judge work it did not do must not inherit the author's context, session state, or mutable in-cycle lifecycle — that isolation is a **product guarantee, not debt**, and it survives regardless of how many orchestrators implement it.

A uniform lifecycle contract (B) may describe such a step's inputs, authority, and provenance contribution. It must not thereby enroll it in the authoring cycle's checkpoint and effects machinery, which is precisely the state it exists not to share.

---

## 3. What should *not* be constitutional

The following may be excellent implementations or policies, but should not be ADR-level commitments unless evidence later shows they are durable and externally load-bearing:

- exactly six pipeline steps;
- review being implemented by a separate orchestrator, or the number of orchestrators (the *isolation* guarantee is `J`; only the topology that delivers it is replaceable);
- N reviewers + one Judge as the required authoring algorithm;
- fingerprint-survival as the universal review-convergence mechanism;
- provider diversity as a permanent safety primitive rather than a measured review strategy;
- object-capability terminology or algebraic-effects terminology;
- exactly two handler kinds (`agentic-loop` / `deterministic`);
- a particular containment substrate or egress-broker implementation;
- a particular readiness rubric such as INVEST;
- cross-provider retry as the required response to an underspecified charter;
- the current six-class safety taxonomy and its exact signed-contraction ceremony;
- the detailed landing admission lattice and retry arithmetic;
- current provider capability limitations.

These belong in recipe policy, skill design, agent-context/design docs, trust/conformance docs, or implementation tests.

---

## 4. Disposition of the current ADRs

**Revised after the trio document review** (3/3 reviewers `block`, 11 must-fix; record bound to
`fefa0848`). The first draft of this table treated the problem as *too much ADR* and reached for
demotion. The review's convergent objection was that the demotions dropped properties that are
load-bearing precisely *because* they name a failure — ADR-0001's independence from tool-input path
parsing (failed PR #112) being the clearest case, preserved in the first draft as only "writes are
bounded to the item workspace".

The resolution is a layering rule, not a smaller set of conclusions. See
[`docs/decisions/README.md` § the three layers](../decisions/README.md#what-belongs-in-an-adr--the-three-layers):
an ADR carries the **invariant** and the **constraints a replacement must also satisfy**;
**construction** — how it is built today — lives in a detail doc the ADR points at.

That changes the dominant verb from *demote* to **cut**. Cutting reaches the same smaller
constitution the first draft wanted, without dropping teeth, because the constraint layer is
explicitly retained rather than implicitly assumed. Dispositions below use four verbs:

- **cut** — the ADR survives *as itself*, re-cut to [`_TEMPLATE.md`](../decisions/_TEMPLATE.md); construction moves to a named home.
- **split** — one document is carrying two decisions that should be independently replaceable; each half then takes its own verb.
- **supersede** — the decision is replaced by one of A–J. The old file is marked `superseded` with a link, never rewritten, and **its constraint column moves into the replacement's `## Constraints on any implementation`** — that carry-over is what makes supersession safe rather than lossy.
- **demote** — not an architectural decision at all; it becomes policy, config, or recipe.

`cut` and `supersede` are mutually exclusive: an ADR either survives under its own number or it does not. "Cut, fold into H" is not a disposition — it is two verbs disagreeing about whether the file still exists.

**Cut is gated on the construction home existing.** ✅ marks a home that already exists today.
Everything else lands its detail doc *with the feature polish that produces it* — which is why this
is a ratchet (`pnpm check:adr`, baseline `ci/adr-shape-baseline.json`) rather than a migration.

| ADR | Disposition | Invariant **and** the constraint that must survive the cut | Construction home |
|---|---|---|---|
| 0001 worktree write confinement | **cut** *(done)* | hard gate on **observed effect**, not requested intent; must **not depend on parsing tool inputs** (failed PR #112); ambiguity resolves to violation; advisory layers never load-bearing | `pipeline.md` § Worktree Isolation ✅ |
| 0002 untrusted input/tool scope | **cut** | repo/issue/PR content is untrusted; **content can never grant authority** | *home needed* |
| 0003 PR-gated default | **demote** to product default/config | a safe consumer default may remain PR | — (config) |
| 0004 review gate fails closed / shakedown fails safe | **cut**, amended by 0026 | irreversible advancement requires deterministic authorization; **parse-invalid is a real signal and must never be laundered into retry**. **Both halves survive:** the gate fails *closed* and shakedown fails *safe*, through **two separate role-appropriate parsers** — a single shared parser was the rejected alternative, because one default cannot serve both roles. `guarded-actions.md` § 7.2 covers only the gate half. | `guarded-actions.md` § 7.2 (gate half) + *home needed* (shakedown half) |
| 0005 branch-protection auto-merge | **cut**, narrow | external landing authority must be **positively verified, never assumed** — ADR-0025 *amends* this, it does not replace it: 0025 owns in-harness landing serialization, 0005 owns the platform gate and `TC-013`. Superseding would leave the external-gate decision unowned. | `flow.md` ✅ |
| 0006 no lifecycle scripts | **cut**, narrow | no install/lifecycle scripts in published manifests — externally auditable, so the mechanism *is* the decision | `architecture.md` § publishing shape ✅ |
| 0007 signed-tag provenance publish | **cut**, narrow | published artifacts carry verifiable provenance; **the signing format is externally load-bearing and stays named** | trust docs ✅ |
| 0008 control plane fail closed | **cut** | unauthenticated control authority must never be exposed | `docs/server.md` ✅ |
| 0009 claims are git branches | **cut**, narrow | the atomic git ref **is** the claim token — resolved by the authority, never by a pre-check; no registry | `roadmap-and-ship.md` ✅ |
| 0010 env allowlist / log scrub | **cut** | no ambient secret or environment authority; **evidence must not leak credentials** | `architecture.md` *(section needed)* |
| 0011 Andon not DoR | **cut** | charter inadequacy produces a **typed escalation**, never a guess | `flow.md` ✅ |
| 0012 readiness computed | **demote** to charter/recipe policy | readiness signals may inform scheduling | `flow.md` ✅ |
| 0013 reversibility-weighted gates | **supersede** by H | authorization rigor scales with consequence; **one cost model must not become doctrine** | *home needed* |
| 0014 mechanism/policy spine | **supersede** by C + H | agents judge; the harness owns authority and advancement | (spine — no single home) |
| 0015 autonomy / tolerance | **demote** to policy | recipes may permit autonomous progression **above a safety/authority floor policy cannot lower** | *home needed* |
| 0016 severity taxonomy | **cut**, retain the floor | the safety/judgment split is **not agent-contractible**; emission defaults to safety; **a lone judge cannot downgrade a safety class**. The class list is construction. | `adversarial-review-loop.md` ✅ |
| 0017 graceful degradation | **supersede** by D + H | degradation may reduce rigor and **must never broaden authority**; a degraded run emits a **visibly weaker** record | `adversarial-review-loop.md` ✅ |
| 0018 in-toto attestation | **split** from the dossier | the envelope format is externally verifiable and stays named; the rich dossier is a separate first-class artifact | trust docs ✅ |
| 0019 checkpoint restart | **supersede** by F | resume from accepted boundaries; never replay nondeterministic agents. **Mid-step WIP checkpoints on park are preserved** — F must not narrow to accepted-step outputs only | `pipeline.md` § Parking ✅ |
| 0020 provider seam / capabilities | **split**: philosophy **superseded** by E, seam ADR **cut** | provider-neutral invocation + factual capability telemetry; **a required capability with no harness equivalent still refuses seating** until equivalence is proven | `pipeline.md` § Step Providers ✅ |
| 0021 ocap / effects placement | **supersede** | explicit authority and typed boundary effects survive; the vocabulary does not | `pipeline.md` § Effects Manifests ✅ |
| 0022 pipeline shape + orchestrators | **split** | ordered, auditable delivery survives as A/B; **the cold gate's out-of-context isolation is a separate product guarantee** and must not be absorbed into the step envelope; the step *count* is construction | *home needed* — `pipeline.md` documents the run orchestrator, not the cold gate |
| 0023 contained execution | **supersede** by D | no ambient authority; explicit containment; the substrate is construction | `contained-execution.md` ✅ |
| 0024 adversarial authoring review | **split** | **constitutional:** review happens *during authoring*; the PR arrives converged carrying an auditable record — this is the shift-left promise and A–J must restate it. **Demoted:** the N-reviewers-plus-Judge algorithm and fingerprint-survival. | `adversarial-review-loop.md` ✅ |
| 0025 landing serialization | **cut**, narrow | git ref CAS with an **explicit `--force-with-lease`, never the implicit form**; ordering layers never replace the fence | `flow.md` ✅ |
| 0026 stateful guards | **cut** *(done)* | fence-or-reconcile incl. transitive derived-exclusive; typed absorbing states each naming clearer **and** actor; judgment ≠ disposition; default-deny over typed causes; **omission is never refutation** — a candidate blocker survives until a complete, valid isolated verification removes it, and an unavailable cell never clears one | `guarded-actions.md` ✅ |

The result is a smaller constitution *and* a stronger one: every row keeps its constraint, and the
ADRs that survive are shorter because construction left, not because decisions did.

**What this closes from the first trio review.** The layering dissolves the findings that were
"you dropped the tradeoff" rather than "keep the mechanism": C3/C14 (0001 confinement), C7 (0016
safety floor), C11 + N7 (0026 fence classes), C12/C21 (fail-closed advancement), N6 (0020 capability
routing), and N2 (the accepted-vs-proposed criterion becomes principled — the question is whether a
construction home exists, not whether the ADR is implemented).

**What the second review then found, and what changed here.** The first revision fixed §4 and
*asserted* closure elsewhere without editing the text that would deliver it. All 15 Judge-verified
blockers were accepted:

- `A–J` gained **I** (review happens during authoring) and **J** (cold evaluation is isolated),
  which §4 required but §2 never stated; §3 and §7 were reworded so they no longer demote the
  isolation guarantee along with the orchestrator topology.
- **F** no longer recovers only from accepted step boundaries — mid-step park checkpoints are
  explicit — and **H** no longer scopes fence-or-reconcile to external mutations only.
- Three ✅ construction homes were **false**: `guarded-actions.md` carries no gate-sizing content
  (0013), and `pipeline.md` carries no autonomy/tolerance (0015) or cold-gate content (0022) — its
  "orchestrator" material is `runOrchestrator`. All three are now *home needed*. The ✅ gate would
  have authorized exactly the unhomed cuts it exists to prevent.
- The verb set contradicted itself: "cut, fold into H" claims both that the ADR survives and that it
  is absorbed. Absorption is now **supersede**, with the constraint column carried into the
  replacement.
- 0005 is **cut, narrow**, not superseded — ADR-0025 *amends* it and owns a different problem.
- 0004 keeps **both** halves (gate fails closed, shakedown fails safe) and its two-role-parser
  constraint; 0026's row regained *omission is never refutation*.
- Stage 2 now requires **denial probes per authority axis**; Stage 3 gained **trust-claim rebinding**
  and a **`proposed` re-triage** step.

**A worked instance of the gate, found while cutting 0026.** Its decision 7 carried a five-rule
normative aggregation order that existed *nowhere else*; `guarded-actions.md` had the cause table
but not the precedence. Cutting first would have deleted it. It was back-ported to
`guarded-actions.md` § 7.2 in the same change. This is the rule earning its keep on its first use.

---

## 5. Review questions before swapping anything

This proposal should be attacked before implementation. A reviewer should try to falsify at least these claims:

1. **Is the step contract actually general enough?** Take current `pick`, `plan`, `implement`, authoring review, cold CI review, ship, direct-push landing, and a future security scan. Identify anything that cannot fit without turning `Step` into an untyped god-object.
2. **Can harness-owned authority really make providers interchangeable?** For Claude, Codex, Grok, Gemini, and OpenCode, enumerate what must happen outside the provider to enforce filesystem/process/network/credential/git authority. Identify any provider whose operation fundamentally requires ambient authority the harness cannot mediate.
3. **Does a uniform lifecycle accidentally destroy useful cold isolation?** Prove that a cold CI/review step can use the lifecycle contract without inheriting author context or mutable session state.
4. **Where should loops live?** Test whether authoring review, implement↔verify, and retries can remain internal controllers without hiding evidence or making recovery ambiguous.
5. **Is the dossier complete without becoming a transcript dump?** Define the minimum stable schema that supports custody and archaeology while allowing provider-specific raw logs to remain optional/retention-limited.
6. **Can the dossier be built incrementally and content-addressed?** Show how attempts, accepted outputs, supersession, and final attestation bind without mutable joins.
7. **Which current ADRs really are externally load-bearing?** Package publication, git claims, signing format, and landing CAS may deserve narrow ADRs. Challenge every proposed demotion where changing the mechanism would break an external verifier or trust claim.
8. **Does `H` over-centralize safety?** Try to find an irreversible effect whose correct authorization cannot be represented as harness-owned deterministic policy plus durable evidence.

A successful review should return counterexamples and required amendments, not merely `approve`.

---

## 6. Validation plan

Do not replace ADRs immediately. Validate the desired state in three stages.

### Stage 1 — document review

Run adversarial review of this proposal with explicit instructions to attack the ten candidate invariants (A–J) and the 26-row disposition table. The review should not be asked to preserve current ADR conclusions.

Acceptance: no unresolved counterexample showing that a required current/future behavior cannot be expressed by the proposed constitution.

### Stage 2 — architecture probes

Before writing replacement ADRs, build small proofs at the seams most likely to falsify the design:

- represent several heterogeneous current operations using a draft `Step` contract;
- run one existing skill through at least two materially different provider adapters under the same harness authority profile — and, on each adapter, **assert denial on every authority axis**: filesystem write outside the item workspace, process spawn, network egress, credential read, git mutation, and external effect. A probe that only shows successful invocation cannot falsify `C`/`D`; it shows the provider runs, not that the harness bounds it. Any axis a provider can reach *around* the harness is the finding this stage exists to produce;
- emit a prototype incremental custody dossier across plan → implement → review, including one retry/supersession;
- demonstrate a cold review/CI execution through the same lifecycle without inheriting author context.

These probes may be throwaway. Their purpose is to discover which proposed invariants are fiction before the ADRs claim they are decisions.

### Stage 3 — constitutional swap

Only after stages 1–2:

1. add the replacement ADRs;
2. mark displaced ADRs `superseded` with explicit replacement links rather than rewriting history;
3. move still-useful detailed mechanism material into `docs/agent-context/`, trust docs, recipe/skill docs, or implementation comments/tests;
4. **rebind the trust lane in the same change.** Every superseded, split, or demoted ADR that governs a `TC-` claim must have `docs/trust/trust-claims.yml` and the linking trust document repointed at its replacement. Live bindings today include `TC-011`→0001/0002, `TC-012`→0003, `TC-003`→0004, `TC-013`→0005, `TC-001`/`TC-014`→0010. No check infers a new owner: an unrebound claim is a broken cross-link in the lane whose whole job is verifiable provenance;
5. rewrite the ADR README so `proposed` means **under consideration**, or introduce a separate `decided-unimplemented` status. An unimplemented architectural hypothesis must not silently become settled merely by landing a document;
6. **re-triage every ADR that keeps `proposed` in the same change that redefines it.** Redefining the word without re-reading the documents that carry it converts decided-unimplemented decisions into under-consideration ones by side effect — the precise overclaim this reconciliation exists to remove, running in the opposite direction. At minimum 0008, 0018 and 0025 need an explicit re-read and a restated status;
7. update `AGENTS.md` so only implemented/current invariants are always loaded;
8. extend the ADR shape gate (`pnpm check:adr`) to cover supersession back-links and the status vocabulary, alongside the shape and construction-home rules it already enforces.

The history matters. Superseded ADRs are useful archaeology; deleting or silently rewriting them would undermine the very provenance principle this reconciliation is trying to establish.

---

## 7. What success looks like

A contributor adding Gemini or OpenCode should not need to understand a Claude-specific safety hook to make the provider safe. They implement the intelligence adapter, declare factual optional/native capabilities, and execute inside Pelaggio's authority boundary.

A contributor adding a new delivery activity should not edit a 3,500-line orchestration function or invent a new lifecycle. They implement a typed step/skill and receive budgets, containment, recovery, and provenance through the common envelope — and, where the activity is ordinary in-cycle work, checkpointing and effects too. A deliberately cold activity (`J`) takes the contract without the checkpoint/effects machinery; the envelope is a common *contract*, not a mandatory *enrolment*.

A reviewer looking at a landed change should be able to traverse one coherent custody dossier from charter to final commit and understand not only that the gates were green, but **how the artifact was authored, challenged, revised, and authorized**.

And a future maintainer should be able to replace today's review algorithm, provider mix, containment substrate, or landing implementation without first fighting ADRs that accidentally turned those replaceable mechanisms into the definition of Pelaggio.
