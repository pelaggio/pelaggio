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

Stateful external mutations must have real ownership semantics: fence stale actors at the authority, or make the operation idempotently reconcilable. Observational pre-checks and expiring hints are not correctness boundaries.

Every non-success terminal state must identify a recovery transition and the actor authorized to perform it.

---

## 3. What should *not* be constitutional

The following may be excellent implementations or policies, but should not be ADR-level commitments unless evidence later shows they are durable and externally load-bearing:

- exactly six pipeline steps;
- review being outside the step abstraction;
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

This is a review proposal, not an instruction to edit them in place yet.

| ADR | Proposed disposition | Durable content to preserve |
|---|---|---|
| 0001 worktree write confinement | **narrow / fold into D** | agent writes are bounded to the item workspace; harness owns broader mutation |
| 0002 untrusted input/tool scope | **retain, align with C/D** | repo/issue/PR content is untrusted; content cannot grant authority |
| 0003 PR-gated default | **demote to product default/config** | safe consumer default may remain PR; not architecture |
| 0004 review fails closed | **supersede into H + review policy** | irreversible advancement requires deterministic authorization; parser details are mechanism |
| 0005 branch-protection auto-merge | **supersede** | external landing authority must be positively verified/fenced |
| 0006 no lifecycle scripts | **retain narrow** | package publication/install attack-surface choice is concrete and independently auditable |
| 0007 signed-tag provenance publish | **narrow** | published artifacts require verifiable provenance; exact publication mechanism may remain a narrow ADR |
| 0008 control plane fail closed | **retain/narrow** | unauthenticated control authority must not be exposed |
| 0009 claims are git branches | **retain narrow** | atomic git ref is the claim token; unrelated to custody registry |
| 0010 env allowlist/log scrub | **fold into D** | no ambient secrets/environment authority; evidence must not leak credentials |
| 0011 Andon not DoR | **supersede** | charter inadequacy produces typed escalation rather than guessing |
| 0012 readiness computed | **demote to charter/recipe policy** | readiness signals may inform scheduling; no need to constitutionalize FlowPolicy/INVEST |
| 0013 reversibility-weighted gates | **narrow into H** | authorization/evidence rigor should match consequence; do not turn one cost model into doctrine |
| 0014 mechanism/policy spine | **supersede by C/H** | agents judge; harness owns authority and advancement |
| 0015 autonomy/tolerance | **demote to policy** | recipes may permit autonomous progression above an invariant safety/authority floor |
| 0016 severity taxonomy | **demote to review policy/config** | safety-relevant advancement fails closed; exact classes/ceremony should evolve independently |
| 0017 graceful degradation | **fold into D/H + policy** | degradation must never silently broaden authority |
| 0018 in-toto attestation | **retain narrow, split from dossier** | standard machine-verifiable envelope is useful; rich authoring history is a separate first-class artifact |
| 0019 checkpoint restart | **retain / generalize as F** | resume from accepted step boundaries; do not replay nondeterministic agents |
| 0020 provider seam/capabilities | **retain seam, rewrite philosophy as E** | provider-neutral invocation and factual capability telemetry; harness safety must not depend on Claude-shaped hooks |
| 0021 ocap/effects placement | **supersede** | explicit authority and typed boundary effects survive; implementation vocabulary does not |
| 0022 fixed six steps/review orchestrators | **reopen / supersede by A/B** | ordered, auditable delivery survives; exact topology does not |
| 0023 contained execution | **narrow / generalize as D** | no ambient authority and explicit containment survive; substrate/broker details move to design/conformance |
| 0024 adversarial authoring review | **demote to review strategy** | review belongs in authoring and produces evidence; N+Judge algorithm must earn its keep by benchmark |
| 0025 landing serialization | **split** | preserve narrow landing correctness ADR(s) only where mechanism is genuinely hard to reverse; move detailed policy/lattice to landing design |
| 0026 stateful guards/disposition | **extract small invariants into H** | fence-or-reconcile; typed recovery; attempt identity/evidence lineage; move merge-gate algorithm to design |

The expected result is **not** eight giant ADRs containing all of the old text. It is eight small architectural decisions plus a few narrow, mechanism-specific ADRs that genuinely deserve permanence.

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

Run adversarial review of this proposal with explicit instructions to attack the eight candidate invariants and the 26-row disposition table. The review should not be asked to preserve current ADR conclusions.

Acceptance: no unresolved counterexample showing that a required current/future behavior cannot be expressed by the proposed constitution.

### Stage 2 — architecture probes

Before writing replacement ADRs, build small proofs at the seams most likely to falsify the design:

- represent several heterogeneous current operations using a draft `Step` contract;
- run one existing skill through at least two materially different provider adapters under the same harness authority profile;
- emit a prototype incremental custody dossier across plan → implement → review, including one retry/supersession;
- demonstrate a cold review/CI execution through the same lifecycle without inheriting author context.

These probes may be throwaway. Their purpose is to discover which proposed invariants are fiction before the ADRs claim they are decisions.

### Stage 3 — constitutional swap

Only after stages 1–2:

1. add the replacement ADRs;
2. mark displaced ADRs `superseded` with explicit replacement links rather than rewriting history;
3. move still-useful detailed mechanism material into `docs/agent-context/`, trust docs, recipe/skill docs, or implementation comments/tests;
4. rewrite the ADR README so `proposed` means **under consideration**, or introduce a separate `decided-unimplemented` status. An unimplemented architectural hypothesis must not silently become settled merely by landing a document;
5. update `AGENTS.md` so only implemented/current invariants are always loaded;
6. add a mechanical check for ADR supersession/back-links and status vocabulary.

The history matters. Superseded ADRs are useful archaeology; deleting or silently rewriting them would undermine the very provenance principle this reconciliation is trying to establish.

---

## 7. What success looks like

A contributor adding Gemini or OpenCode should not need to understand a Claude-specific safety hook to make the provider safe. They implement the intelligence adapter, declare factual optional/native capabilities, and execute inside Pelaggio's authority boundary.

A contributor adding a new delivery activity should not edit a 3,500-line orchestration function or invent a new lifecycle. They implement a typed step/skill and receive checkpointing, budgets, containment, recovery, and provenance through the common envelope.

A reviewer looking at a landed change should be able to traverse one coherent custody dossier from charter to final commit and understand not only that the gates were green, but **how the artifact was authored, challenged, revised, and authorized**.

And a future maintainer should be able to replace today's review algorithm, provider mix, containment substrate, or landing implementation without first fighting ADRs that accidentally turned those replaceable mechanisms into the definition of Pelaggio.
