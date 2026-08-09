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

The measurements in `path-forward.md` make this reconciliation urgent: routed facts exist but are not reliably found, August parks concentrate in the authoring-review machinery, and the structural pressure is in the lifecycle envelope rather than evidence that today's exact topology is sacred.

This PR includes two deliberately small worked cuts plus prototype ADR-shape tooling because the review process exposed missing construction content while exercising the proposed rule. Treat that tooling as a **prototype of the maintenance model**, not proof that every heuristic it currently enforces is architectural truth.

---

## 1. Product target

Pelaggio should make one promise:

> **A charter becomes a change by passing through a sequence of well-defined, safely executed skills. Every execution occurs under harness-owned authority. Every consequential transition is reconciled and evidenced. The resulting provenance explains how the change came to exist.**

That implies three first-class systems plus one cross-cutting obligation.

### 1.1 Delivery harness

Work moves through an ordered pipeline of engineered steps. A step has explicit inputs, skill, context, authority, execution requirements, exit criteria, outputs, recovery behavior, and provenance contribution.

The architectural commitment is the **step contract**, not the exact count or names of today's steps.

### 1.2 Safe execution harness

Claude Code, Codex CLI, Grok ACP, Gemini CLI, OpenCode, and future runtimes are **Agent Drivers** behind a common execution contract. Provider and model are separate execution facts: OpenAI/Anthropic/Google/xAI are providers; a concrete model is another fact again.

Pelaggio owns the enclosing sandbox / authority boundary: filesystem, process, environment, network, credentials, git mutation, and external effects. Driver-native controls are defense-in-depth and telemetry; they may strengthen the boundary but do not silently broaden it.

### 1.3 Custody / provenance system

Every run contributes durable evidence to one coherent source-provenance lineage. The human-facing **Change Dossier** is the readable view of that lineage; a compact machine-verifiable **attestation** may bind claims about it to a commit.

These are different concerns:

- **provenance** — durable evidence of how the source revision came to exist;
- **Change Dossier** — the developer-facing explanation of that provenance;
- **attestation** — a small signed/machine-checkable claim about a subject and evidence;
- **telemetry** — traces/logs useful for observation and debugging, not the source of provenance truth.

The provenance is accumulated during execution, not reconstructed afterward by joining mutable provider, git, issue, PR, and log state.

### 1.4 Semantic reconciliation

A change does not finish merely because its code is correct. Charter and delivery must reconcile the semantic surfaces the change affects: runtime behavior, canonical documentation, architecture, trust claims, public contracts, migrations, and similar durable descriptions.

Implementation work reports **what actually changed**. Reconciliation owns **where that truth belongs**. Routine construction/behavior documentation may follow implementation autonomously; an implementation must not silently rewrite an architectural decision or trust claim merely to make the prose agree with itself.

---

## 2. Candidate architectural constitution

The labels are review handles, not proposed ADR numbers.

### A. Work executes as typed steps in an ordered pipeline

A pipeline orders typed steps. Pelaggio need not become a general DAG scheduler. Conditionality, fan-out, iterative review, and deterministic sub-work may live inside a step or a deliberately small pipeline construct.

The invariant is explicit lifecycle boundaries with typed inputs and outputs, not `STEPS.length === 6`.

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

This is the seam the current lifecycle envelope is trying to provide without forcing every internal algorithm into a generic node abstraction.

### C. Agents provide intelligence; Pelaggio retains authority

Agents may propose, implement, inspect, review, and judge. They do not grant themselves filesystem, process, network, credential, git, merge, or external-effect authority.

The harness decides whether an agent judgment is sufficient to advance and which requested effects are permitted.

The **blocking** decision is always deterministic — fingerprint survival, parse validity, network denial, integer spend caps, host-computed write-sets. The model is a policy *input* to the judgment band and is never itself the gate: probabilistic supervision of a probabilistic process furnishes no deterministic lower bound, and a lower bound cannot be prompt-engineered. **Policy is data, not code** — a posture expressed as configuration the harness evaluates, never as model discretion at the seam.

### D. Agent execution has no ambient authority

Each agentic step executes inside a harness-controlled sandbox / authority boundary. Authorities are explicit grants; the execution environment cannot broaden its own authority.

The constitution should preserve this property and any proven negative constraints, not freeze bubblewrap vs Podman vs Landlock, broker topology, package-store layout, or credential plumbing.

**Containment is not permission.** A sandbox bounds what execution *can* reach; it establishes nothing about whether that execution is contractually permitted. An authority boundary that fully satisfies D can still be running work a provider's terms forbid in that context. The permission question is decided separately, on its own evidence, and must never be treated as answered by the strength of the sandbox.

### E. Agent Drivers are interchangeable intelligence adapters

An **Agent Driver** is the runtime integration Pelaggio invokes. Provider/model are recorded separately. The driver reports factual optional/native capabilities and telemetry.

A missing driver-native hook is not automatically a safety failure if the harness supplies an equivalent authority boundary. Conversely, a required capability with **no proven harness equivalent** must refuse seating rather than being silently emulated or downgraded.

### F. Durable recovery follows run/attempt lineage, not deterministic replay

A completed step produces an accepted artifact/checkpoint. Nondeterministic agent execution is not replayed as if it were deterministic.

Accepted step outputs are not the only durable state: an interruption that does not impugn the worktree may preserve resumable WIP. Retries are new attempts in the same lineage, not mutations of historical evidence.

### G. Every change accumulates self-contained source provenance

The final lineage must be sufficient, without mutable external joins, to answer:

- why the work existed and what outcome/scope were chartered;
- what context and skill were supplied;
- which Agent Driver / provider / model acted;
- under what sandbox and authority profile;
- what each step and attempt produced;
- what deterministic checks ran;
- what reviewers found and how findings were fixed/refuted;
- what retries, parks, resumptions, or superseded attempts occurred;
- what semantic surfaces were reconciled;
- why the final candidate was authorized to land;
- what exact commit/tree resulted.

Provenance is worth exactly what the identity vouching for it is worth. Where an artifact leaves the system for external consumption, the lineage must bind a **trusted builder identity**: a signature and attestation produced by an opaque or attacker-controlled builder give a consumer nothing to verify against. The signing format, attestation envelope, and runner topology are construction; that the builder is identified and independently trustworthy is not.

### H. Consequential effects require deterministic authorization and durable evidence

Agent judgment may be an input to policy; it is not itself authority. Consequential mutations require harness-owned authorization and evidence appropriate to the effect.

Stateful mutations — external **or shared local harness state** — must have real ownership semantics: fence stale actors at the authority or make the operation idempotently reconcilable. Observational pre-checks and expiring hints are not correctness boundaries.

Required rigor scales with the **consequence and reversibility** of the effect, not with its position in the lifecycle. An easily reverted mutation and an irreversible publish do not warrant the same gate; sizing by lifecycle stage rather than by consequence produces ceremony where it is cheap and gaps where it is not. The particular cost model used to weigh consequence is policy, not doctrine.

**Degradation reduces rigor; it never broadens authority.** Under resource or availability loss a recipe may fall back to a *previously verified* surface, and must then record a **visibly weaker** result rather than reissuing the same badge. Falling back to an unverified or uncontained surface is never permitted, at any availability cost. A verified-but-stale fallback is **bounded**: it carries a staleness ceiling and an active re-verification trigger, and parks rather than running indefinitely once the ceiling is exceeded. Silent, unbounded pinning to a stale surface is precisely the failure this permission must not become.

Every non-success terminal state identifies its recovery transition and the actor authorized to perform it.

### I. Review is part of authoring; its record travels with the change

A change is challenged, revised, and resolved during authoring rather than presenting a raw first draft as the finished artifact. The resulting review record contributes to source provenance.

This does **not** constitutionalize N reviewers, a Judge, fingerprint survival, provider diversity, or any other particular convergence algorithm. Those are strategies that must earn their keep.

One property is not strategy: **the actor that authored a change cannot be the actor that clears it.** Author, evaluator, and whoever rules the terminal outcome must be separable actors, whatever the algorithm. Without that separation a recipe could satisfy I by having a change review and approve itself — the pre-review posture with extra steps and a provenance record attesting to it. This is distinct from J: role separation is required of *any* review claimed under I, whereas J's isolation applies only where policy demands independence.

### J. When policy requires independent evaluation, independence is a property of the execution

An evaluation required to be independent receives only explicitly declared inputs and must not inherit mutable author-session state or hidden author context.

This is conditional: I does not imply that every recipe requires a second independent review system. When a recipe/policy requires independence, the isolation property is load-bearing.

The property does **not** prohibit reusing generic lifecycle, storage, checkpoint, effects, budget, or provenance machinery if those mechanisms can preserve independence. Topology is construction; independence is the guarantee.

### K. Semantic reconciliation is a delivery obligation

Chartering identifies the semantic surfaces the intended change may affect; execution records the realized impact; delivery reconciles the two before the change is considered complete.

An implementation agent is responsible for reporting facts about what changed, not for discovering and rewriting an unbounded graph of prose. A reconciliation capability owns canonical placement and deduplication.

Routine construction/behavior reconciliation may proceed autonomously. A discovered conflict with an architectural invariant, trust claim, or external contract must be surfaced as a typed conflict/escalation rather than silently rewriting the authoritative statement.

The exact impact taxonomy, whether reconciliation is a dedicated pipeline step, which driver performs it, and the concrete documentation-routing map are construction/policy to be proven by the Stage 2 probe.

---

## 3. What should not be constitutional

Examples of replaceable construction/policy unless evidence later proves otherwise:

- exactly six pipeline steps or a particular orchestrator count;
- a required N-reviewers-plus-Judge algorithm or fingerprint convergence rule;
- provider diversity as a permanent safety primitive rather than a measured review strategy;
- ocap/algebraic-effects terminology or exactly two handler kinds;
- a particular containment substrate or broker topology;
- a readiness rubric such as INVEST;
- a particular retry count or cross-driver retry policy;
- today's exact severity table or signed-contraction ceremony;
- the detailed landing admission lattice/retry arithmetic;
- current Agent Driver capability limitations;
- a dedicated `reconcile-docs` step, exact `DocumentationImpact` enum, or current documentation filenames;
- a prohibition on cold evaluation sharing generic lifecycle machinery.

These belong in policy, skill/design docs, construction docs, trust/conformance docs, or tests.

---

## 4. Disposition of the current ADRs

The trio reviews corrected the first draft's over-simplification: **shrinking an ADR must not delete the reason a replacement would otherwise repeat a known failure.** The resulting model is invariant + constraint + construction, with construction outside the ADR.

The third review found the same error one level up: the swap *rules* were sound and the *text* had not executed them. Seven of its nine blockers were supersede rows whose constraint A–K never stated — 0014's deterministic-gate corollary, 0017's staleness ceiling, 0023's containment-≠-permission reframe, 0007's trusted builder, 0013's consequence-scaled rigor. Those clauses are now written into C, D, G and H, and the Carried-by column below makes the binding checkable rather than promised.

Its one novel finding was structural: with I mandating authoring review and J making independence conditional, nothing required the author and the evaluator to be different actors — a recipe could have satisfied I by reviewing its own change. Role separation is a property, not topology, and it is now stated in I.

One accepted finding is deliberately **not** yet fixed: the ADR-0026 worked cut still packs multi-primitive construction (quota/token, attempt register, cause-allowlist detail) into `## Decision` rather than Constraints or its home. ADR-0001 is the honest exemplar of the method; 0026 is shape-compliant but not yet method-compliant. Re-cutting it needs the same back-port discipline that found the missing aggregation ordering, so it is queued as its own change rather than done in haste here.

Dispositions use four verbs:

- **cut** — the ADR survives under its number, reduced to invariant + constraints; construction moves to a named home;
- **split** — one file carries independently replaceable decisions;
- **supersede** — a **named** A–K clause owns the decision; the old ADR remains as superseded history, and each of its constraints is written into that clause *before* the supersession lands. "Its constraints move forward" is a promise the Carried-by column has to cash;
- **demote** — it is policy/config/recipe rather than architecture.

`cut` is gated on a construction home existing. The current `pnpm check:adr` ratchet is a prototype of that maintenance rule; its semantic authority is intentionally weaker than the cut test in the document skill.

**Carried by** names the clause that will actually hold each constraint after the swap. A `supersede`
or `split` row without a named carrier is not a disposition — it is a deletion with a citation. `self`
means the ADR survives under its own number and carries its own constraints. Three rows previously
read `supersede` with no carrier at all; the third trio review found that every one of them orphaned
a constraint A–K did not state, which is why this column exists rather than the prose promise it
replaces.

| ADR | Disposition | Invariant / constraint that survives | Carried by | Construction home |
|---|---|---|---|---|
| 0001 worktree write confinement | **cut** *(worked example)* | hard gate on observed effect, not requested intent; must not depend on parsing tool inputs; ambiguity resolves to violation | self | `pipeline.md` § Worktree Isolation ✅ |
| 0002 untrusted input/tool scope | **cut** | repo/issue/PR content is untrusted; content can never grant authority | self | *home needed* |
| 0003 PR-gated default | **demote** | safe consumer default may remain PR | policy — no A–K clause required | config |
| 0004 review gate / shakedown parsing | **cut**, amended by 0026 | irreversible advancement fails closed; parse-invalid is real; gate/shakedown may require distinct role-appropriate parsers | self | gate half in `guarded-actions.md`; shakedown home needed |
| 0005 branch-protection auto-merge | **cut**, narrow | external landing authority positively verified, never assumed | self | `flow.md` ✅ |
| 0006 no lifecycle scripts | **cut**, narrow | published manifests carry no install/lifecycle scripts | self | `architecture.md` ✅ |
| 0007 signed-tag provenance publish | **cut**, narrow | published artifacts carry externally verifiable provenance from a **trusted builder identity**; externally load-bearing signing format remains named | self + **G** ¶ trusted builder | trust docs ✅ |
| 0008 control plane fail closed | **cut** | unauthenticated control authority is never exposed | self | `docs/server.md` ✅ |
| 0009 claims are git branches | **cut**, narrow | atomic authority owns the claim; no pre-check/secondary registry | self | `roadmap-and-ship.md` ✅ |
| 0010 env allowlist / log scrub | **cut** | no ambient secret/environment authority; evidence must not leak credentials | self | `architecture.md` section needed |
| 0011 Andon not DoR | **cut** | charter inadequacy produces typed escalation rather than guessing | self | `flow.md` ✅ |
| 0012 readiness computed | **demote** | readiness signals may inform scheduling | policy — no A–K clause required | `flow.md` ✅ |
| 0013 reversibility-weighted gates | **supersede** by H | rigor scales with consequence and reversibility, not lifecycle stage; one cost model is not doctrine | **H** ¶ *Required rigor scales…* | home needed |
| 0014 mechanism/policy spine | **supersede** by C + H | agents judge; harness owns authority/advancement; **the blocking gate is always deterministic and the model is never the gate**; **policy is data, not code** | **C** ¶ *The blocking decision…* | cross-cutting |
| 0015 autonomy / tolerance | **demote** (dial) above a **constitutional floor** | the tolerance dial is policy; the floor beneath it is not — policy may reduce rigor but can never broaden execution authority | floor: **H** ¶ *Degradation reduces rigor…* + **D**; dial: policy | home needed |
| 0016 severity taxonomy | **cut**, retain floor | safety/judgment boundary is not agent-contractible; ambiguous emission fails toward floor; lone judge cannot downgrade safety | self | `adversarial-review-loop.md` ✅ |
| 0017 graceful degradation | **supersede** by D + H | degradation may reduce rigor, never broaden authority; record becomes visibly weaker; last-verified-pin permitted but **bounded by a staleness ceiling + re-verification trigger**; uncontained fallback never | **H** ¶ *Degradation reduces rigor…* | `adversarial-review-loop.md` ✅ |
| 0018 in-toto attestation | **split** | envelope/signing decision remains narrow; rich source provenance is G | narrow half: self; rich half: **G** | trust docs ✅ |
| 0019 checkpoint restart | **supersede** by F | no deterministic LLM replay; accepted boundaries + valid mid-step WIP durability survive | **F** ¶ *Accepted step outputs are not the only durable state* | `pipeline.md` § Parking ✅ |
| 0020 provider seam / capabilities | **split** | runtime seam becomes Agent Driver (E); factual capability telemetry survives; no-equivalent hard requirement refuses seating | **E**; seam half: self | `pipeline.md` § Step Providers ✅ |
| 0021 ocap / effects placement | **supersede** by C + D + H | explicit authority survives (C/D); typed boundary effects requiring authorization and evidence survive (H); ocap/algebraic-effects vocabulary does not | **C** + **D** + **H** | `pipeline.md` § Effects Manifests ✅ |
| 0022 pipeline shape + orchestrators | **split** | A/B own ordered lifecycle; J owns conditional independence; exact topology is construction | **A** + **B** + **J** | cold-evaluation home needed |
| 0023 contained execution | **supersede** by D | no ambient authority / explicit sandbox boundary survive; **containment ≠ permission** survives independently of substrate; substrate is construction | **D** ¶ *Containment is not permission* | `contained-execution.md` ✅ |
| 0024 adversarial authoring review | **split** | I owns review-during-authoring + provenance **and author ≠ evaluator ≠ outcome-ruler**; algorithm/provider mix are strategy | **I** ¶ *One property is not strategy* | `adversarial-review-loop.md` ✅ |
| 0025 landing serialization | **cut**, narrow | actual ref fence remains load-bearing; ordering never substitutes for fence | self | `flow.md` ✅ |
| 0026 stateful guards | **cut** *(worked example)* | fence-or-reconcile; typed recovery; judgment ≠ disposition; default-deny typed causes; omission is never refutation | self | `guarded-actions.md` ✅ |

The worked cuts of 0001/0026 are evidence for the method, not authorization to mechanically cut the rest without the constitutional/probe work below.

---

## 5. Questions for the next trio review

Attack the proposal; do not preserve existing conclusions by default.

1. Can heterogeneous current/future work fit B without `Step` becoming an untyped god-object?
2. Can the harness actually bound every Agent Driver across filesystem/process/network/credential/git/effect authority?
3. Is E honest about capabilities that have no harness equivalent, or does it still overpromise driver neutrality?
4. Does J state only the independence property, or does any topology leak back into the constitution?
5. Do I and J accidentally mandate two review phases, or is J clearly conditional on a policy requiring independence?
6. Is G a stable source-provenance model rather than a transcript dump or telemetry schema?
7. Can run/step/attempt lineage preserve WIP without laundering a failed attempt into an accepted artifact?
8. Does K identify a real delivery invariant, or is documentation reconciliation better left entirely to pipeline policy?
9. Can K reconcile canonical docs without creating a second unbounded agent task or letting implementation rewrite architecture/trust to match itself?
10. Which surviving ADR rows still name a mechanism where only a property/failed alternative should survive?
11. Which `pnpm check:adr` rules are safe mechanical floors, and which are syntactic proxies likely to distort prose?
12. Does the proposed document dedupe/routing direction require another architectural decision? The default answer should be **no** unless a canonical-ownership property is genuinely hard to reverse.

A successful review returns counterexamples and amendments, not merely `approve`.

---

## 6. Validation plan

### Stage 1 — adversarial document review

Run the trio against A–K plus the disposition table. Acceptance means no unresolved counterexample showing a required behavior cannot be represented without freezing replaceable construction.

### Stage 2 — architecture probes

Before writing replacement ADRs:

- represent heterogeneous operations using a draft `Step` contract and explicit `Pipeline → Step → Run → Attempt` vocabulary;
- run one existing skill through at least two materially different Agent Drivers under one harness authority profile and **assert denial on every authority axis** (out-of-workspace write, process, network, credential, git, external effect);
- prove a required-independent evaluation can use the common lifecycle contract without author-state leakage; sharing generic machinery is allowed if the isolation property survives;
- emit prototype source provenance / Change Dossier across plan → implement → review, including a retry, WIP checkpoint, superseded attempt, and final attestation link;
- replay 5–10 representative recent changes through a proposed **semantic reconciliation** model: chartered impact → realized impact → canonical-doc/architecture/trust/public-contract reconciliation. Measure false-positive edits, missed stale docs, duplicate prose, and escalation quality;
- inventory living docs by canonical owner and identify dedupe candidates, but **do not redesign the document tree first**. Let the reconciliation probe tell us which canonical boundaries are useful.

The concrete `DocumentationImpact` taxonomy, reconciliation skill, routing index, and dedupe map are outputs of this probe—not prior decisions.

### Stage 3 — constitutional swap

Only after stages 1–2:

1. add the replacement ADRs;
2. mark displaced ADRs superseded with explicit replacement links;
3. **refuse any supersession whose carrier clause does not yet state the constraint.** For every `supersede`/`split` row, the named A–K clause must contain the surviving constraint *in the replacement ADR text* before the old ADR is marked. A row whose carrier is absent, unnamed, or silent on the constraint blocks that row — the rest of the swap may proceed. This is the ordering rule that keeps supersession from being deletion with a citation;
4. cut surviving ADR construction only when its canonical home exists;
5. rebind every affected `TC-` trust claim in the same change;
6. replace the current ambiguous `proposed = decided-unimplemented` vocabulary and re-triage every ADR carrying the old status;
7. update `AGENTS.md` so the always-loaded lane states implemented/current invariants only;
8. keep mechanical ADR checks deliberately narrow: shape, links, construction-home existence, status/supersession integrity. Semantic layering remains review/skill territory unless a heuristic proves high-signal;
9. establish the high-level canonical vocabulary once (`Pipeline → Step → Run → Attempt`, `Agent Driver → Provider → Model`, sandbox/authority boundary, provenance/dossier/attestation) and route other docs to it;
10. dedupe overlapping living docs based on the Stage 2 ownership inventory rather than adding another master document.

Superseded ADRs remain useful archaeology. Deleting or silently rewriting them would undermine the provenance principle this reconciliation is trying to establish.

---

## 7. What success looks like

Adding Gemini or OpenCode means implementing an Agent Driver, reporting factual capabilities, and running inside Pelaggio's authority boundary—not editing orchestration because the new runtime is shaped differently.

Adding a delivery activity means implementing a typed step/skill and receiving the common lifecycle, authority, recovery, provenance, and reconciliation contract—not extending a monolithic controller or inventing a second lifecycle.

An implementation agent can say **what changed** without having to discover every prose surface. Reconciliation updates the canonical construction/behavior docs automatically where safe and escalates when the implementation conflicts with architecture, trust, or an external contract.

A reviewer can traverse one coherent Change Dossier from charter to final commit and understand how the artifact was authored, challenged, revised, reconciled, and authorized.

A future maintainer can replace today's review algorithm, driver mix, containment substrate, landing implementation, or documentation layout without fighting ADRs that accidentally turned those mechanisms into the definition of Pelaggio.
