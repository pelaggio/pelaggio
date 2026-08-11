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

## 1.5 Positions settled outside the probe set

PR #482 §K litigated the open product questions on 2026-08-10. They are **settled unless a named probe falsifies their premise**, and they constrain §6 — recorded here so the constitution is not written as though they were still open.

| # | Position | Carried by |
|---|---|---|
| K1 | `direct-push` is product-grade under single-integrator semantics, fenced. Landing gets **one lifecycle closer** with two triggers, not two tails | H; the 0025 row in §6 |
| K2 | Roadmap adapters are tiered, insured by a shared conformance suite over fake seams | construction |
| K3 | The attempt register gets **no bespoke protection** — properties 2–3 are inherited from the authority-profile work | C + D |
| K4 | Skills stay single-file; sync is enforced by lint | construction |
| K5 | The daemon is observational only | C |
| K6 | Evidence is written durable **at emission**; failed and superseded attempts retain theirs | G |
| K7 | The metrics/projection surface is a product commitment | G |

K3 and K6 are load-bearing here: K3 means C and D share one probe, and K6 is G's capture obligation stated as a write-time rule. **K6 constrains K1's cleanup half**: *the closer may reconcile immediately; it must not remove a worktree until its evidence is durable elsewhere.* The justification is **failed and superseded attempts** — abandoned worktrees no closer ever touches, so promote-at-cleanup cannot cover them and only write-at-emission can. Not a #483 inference: `runShipBookkeeping` has run `git worktree remove --force` (`bookkeeping.ts:284`) on every successful direct-push ship since it landed, destroying identical evidence, so the hazard predates the closer. K1's reconcile half is unblocked today.

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

Two constructions were held open for a probe; **§3 closes the fork on evidence already in hand** — narrow phase functions over a shared typed cycle/run context, not a lifecycle wrapper. The rejected alternative is recorded so the reasoning survives:

1. ~~a small lifecycle wrapper / `StepRun` abstraction around the existing execution seam~~ — rejected: it would have exactly six consumers, each re-specializing it; or
2. narrow phase functions over a shared typed cycle/run context — **chosen**, with the falsifiers stated in §3.

For example, `plan(ctx) → PlanResult`, `implement(ctx) → ImplementResult`, `review(ctx) → ReviewResult`, `ship(ctx,target) → ShipResult` may prove clearer than a deeply generic `Step<Input, Output, Authority, Recovery, …>`.

**Constraint:** do not enlarge `RunStepFn` into a universal optional-field record, and do not hide today's special cases inside a new lifecycle god-object.

### C. Agents provide intelligence; Pelaggio retains advancement authority

Agents may propose, implement, inspect, review, and judge. They do not grant themselves authority.

**C1 — the resolution is harness-owned (holds by inspection; untested by probe).** No probe exercised C1: P2 tested D (ambient authority) and P5 tested C2 (the state resolved over). It must not enter Stage 3 as evidence-backed. Advancement authority resolves through deterministic harness semantics. Model judgments may be required evidence, but cannot themselves exercise authority to advance. Policy is explicit, inspectable, versioned, and evaluated outside model discretion; its representation is construction.

**C2 — the state resolved over must not be agent-writable — target state.** A deterministic resolution over agent-writable inputs is not harness authority, and **C as previously written is currently violated in production**. **Measured on #483 (2026-08-11):** the issue closed one second after merge because GitHub honoured a `Closes #483.` line the **ship agent wrote into the PR body** — no harness code templates one. A model-authored artifact performed a roadmap state transition, which is precisely what C forbids. The surrounding conditions are the same class: P2 measured git mutation succeeding on all three drivers, claims *are* git branches (ADR-0009), `pick` runs with `cwd = MAIN_REPO`, and `attempt-identity.ts` records that its register "is an identity, never an authorization."

C2 is bound to the same probe as D, and §1.5 K3 makes the dependency explicit: the register needs no bespoke mechanism because the authority profile is what makes it unwritable.

**A daemon may improve latency or visibility, never correctness or authority** (§1.5 K5). Authority-bearing processes are harness-spawned and run-scoped; every reconciler is a CLI verb, and no pipeline correctness may depend on daemon liveness.

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

Note the gap between *written* and *checked*: receipts are collision-guarded and content-bound, and `verifyExecutionReceipt` has **zero production callers** — evidence written and never verified. **Measured (#483):** the join is already broken before any destruction (`receipts: 3 (0 present on disk)` read from main while the worktree still existed), and "what caused this lifecycle transition" is a new unanswerable — the ship-authored PR body that closed the issue lived in `.dev/ship/pr-body-483.md`, now deleted, surviving only as mutable GitHub state. Per §1.5 K6 the write happens at emission, including for failed and superseded attempts.

Claim snapshots charter intent; step boundaries bind attempt/input/output; review binds clearing evidence; ship/landing binds authorization and final subject. The Change Dossier is a projection over these records, not a transcript/event-log requirement.

Externally consumed provenance binds a builder identity whose trust basis the consumer can independently verify.

### H. Consequential transitions require authorization, evidence, and an owner/reconciler

Consequential mutations require harness-owned authorization and evidence appropriate to consequence/reversibility.

Stateful mutations are fenced at the state-owning authority or idempotently reconciled. Pre-checks, locks, ordering, and expiring hints do not substitute for authority.

**Safe refusal is incomplete without recovery ownership.** Every non-success absorbing state names a clearing transition and authorized actor.

The same principle applies to successful external transitions: **a lifecycle transition that completes outside the current process must have an explicit owner/reconciler for the next state.** PR #482's clearest example is production `auto-merge-pr`: GitHub can merge the PR, but no code currently owns `merged → done`; stale quarantine is the accidental reconciler.

**Measured (#483):** the transition does not merely stall — it **tears**. The issue closed via model-authored PR-body prose while `in-progress`, both claim branches and the worktree all persisted, leaving a tracker that reads done over an item still ineligible for re-pick. The fallback does not catch it either: `scanStaleItems` filters `item.status === "open"` (`stale-scan.ts:106`) while `github-issues.ts:64` maps `state === "closed" → "done"`, so the prose does not *race* the stale scan — it removes the item from the fallback's candidate set entirely. The residue is an orphan worktree, local and remote claim branches, a lying `in-progress` label, and evidence stranded where `/tidy` will delete it.

The owner is therefore **one** idempotent reconciler owning all four transitions, `reconcileLanded(item, evidence)`, **exposed as a CLI verb** so any scheduler may invoke it (§1.5 K5) — and *not* sited in the review drain, which requires `review.runner === "local"` (`pipeline.ts:2821`) while the default is `"ci"` (`config.ts:224`). A drain-sited closer would never run on default config, reproducing this defect for every consumer who did not opt into local review, and would miss the `--item N` case where the cycle exits before auto-merge completes.

Its duty is **post-merge reconciliation only**. Suppressing the model-authored `Closes #N` cannot be its job — its trigger is observed forge merge, so it runs *after* the transition and cannot win that race by ordering. That belongs at the ship-decision effect boundary: `ship/decision.ts` already validates the body file's path, symlink status, regular-file-ness and size and validates nothing about its content, so it is one more check in an existing validator chain, plus a matching negative instruction in `.claude/skills/ship/SKILL.md`. No new abstraction.

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

### K. Semantic reconciliation is a delivery obligation — target state

Chartering identifies potentially affected semantic surfaces; execution records realized impact; delivery reconciles the two.

Implementation reports what changed rather than discovering an unbounded prose graph. Reconciliation owns canonical placement/deduplication.

P4 found reconstruction tractable across eight historical PRs but did not prove autonomous reconciliation. The load-bearing rule is:

> **Conflict with architecture, trust, or an external contract escalates rather than silently rewriting the authoritative statement to fit implementation.**

PR #482 supplies further evidence for why this matters: agent-facing docs currently blur planned vs shipped behavior, including a landing fence and skill expansion behavior that code does not implement.

Routine construction/behavior reconciliation may be autonomous. Noise suppression is optimization, not the safety property.

## 3. Construction bias from architecture discovery

PR #482 changes the default refactoring posture:

> **Before creating a new abstraction, ask whether a sound existing boundary is merely underspecified. Prefer widening that boundary when doing so restores singular ownership and removes leaked orchestration without making the interface incoherent.**

`ShipTarget` was the canonical example — but the widening does **not** survive its own evidence. The real count is 7 ship-phase branches, one of which is a log-string suffix; `:1755` is a review-policy decision and `:2250` a banner builder outside `runPipeline`. No measured failure is attributed to the inline branching (F2/H measured a lifecycle failure a closer alone closes), the widening would relocate roughly 4 of 7 and leave the PR side inline, and `verify` would be a no-op member on PR targets — the optionality-carries-heterogeneity smell P1 flagged on `RunStepOpts`. **`ShipTarget` stays at three members.** The example survives as a *cautionary* one: widening beats a framework, and still has to be paid for by measured leakage.

The same test applies elsewhere:

- provider dispatch: preserve it; fix authority around it;
- review core: preserve/reuse it; extract duplicated orchestration;
- flow policy: preserve its pure deterministic core rather than delegating policy back through an agent turn;
- attempt lineage: preserve the semantics; fix durability/join ownership around it.

**The B-construction fork is closed by evidence already in hand** — §2.B, §8 and #482 §G/§I are aligned to this, not to a live probe. P1 established that nine heterogeneous activities share the *execution* seam and that the step-indexed maps are config-fanout **orthogonal to B**. The halves have different shapes — execution is uniform, phases are not — so a generic `Step<Input, Output, Authority, Recovery>` wrapper would have exactly six consumers, each re-specializing it. The smallest construction is one `CycleContext` record, one `Record<Step, StepPolicy>`, six phase functions, and today's `step()` unbundled into thin audit/run/effects wrappers: widening, not a new layer.

Two corrections to the payoff, so this does not become an implementation plan on bad figures. **The consolidation is 3, not 11:** only `budgets`, `turnLimits` and `effort` are one-dimensional; the other 8 at `config.ts:77–89` are `Record<string, Partial<Record<Step, T>>>` profile overlays whose resolution is two-dimensional, and they remain a separate dimension. **The phases are not already delimited:** the first `// ──` marker is `pipeline.ts:904`, so 685 lines (38% of `runPipeline`, including the nested `step()` closure at :337) precede any marker, and `:1084` is a mode check rather than a phase. That prologue is where the `CycleContext` god-object risk lives, so the construction carries hard falsifiers: **any `StepPolicy` field meaningful for fewer than three steps means the per-family split wins**, and a `CycleContext` whose field count exceeds the phase count means the closure was renamed rather than decomposed.

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
| 0025 landing serialization | **cut / re-check against current code** | landing must be positively fenced at the authority; do not state the planned direct-push CAS as shipped behavior (decision 8's landing receipt is likewise unimplemented); **`direct-push` is a product target under single-integrator semantics (§1.5 K1)**; **one closer owns merged→done for both targets**, preserving the #205-derived ordering — roadmap failures warn once the merge is verified, push/integration failures block, branch deletion is gated on mark-done | self + H | `flow.md` / landing construction |
| 0026 stateful guards | **cut** | fence-or-reconcile; typed recovery across guard lifecycles including claim/pick; judgment/evidence/disposition separation; bounded retry; omission never refutation | self | `guarded-actions.md` ✅ |

## 7. Immediate correctness findings

Independent of the architecture choice:

1. **TC-014's guarantee outranks its own scope note.** `buildAgentEnv` is correct and unit-tested; the claude path forwards `spawnOpts.env` as the SDK built it. `known_limits` names only "codex today, grok via the ACP client", which is **wrong in both directions**: `opencode-provider.ts:438` and `contained-execution.ts:200` also call it, and the claude exclusion appears only by omission. A field that inaccurate cannot carry a softening, so this stands as `gaps.md` G1 records it — a trust-claim failure. The remedy: route the claude adapter through `buildAgentEnv`, add the per-driver conformance test, and delete the limit. Until then downgrade the claim rather than reword it.
2. **Confinement abort strands claim state across worktree, branch, and roadmap.** This is a missing clearing transition under H/ADR-0026, not a guard failure.
3. **Production `auto-merge-pr` has no explicit `merged → done` owner.** This is a lifecycle/reconciliation gap, not merely a shipping implementation detail.
4. **Durable evidence is currently inverted.** Execution receipts/review records may be destroyed with the successful worktree; evidence required for custody needs a durable home.
5. **The cold merge gate lacked two hardening measures the authoring loop has, and one was a fail-open.** The v1 parser had **no schema-example guard at all** while v3 fails closed on one, and `.claude/skills/pr-review/SKILL.md:187` ships a schemaVersion:1 example carrying the exact sentinels — a parroted *fake-clean echo* would record a clean review that never happened. **Measured:** transferring the hardening naively is itself unsafe — `assistantText` accumulates every assistant turn while the v1 regexes match a block anywhere, so an early clean block or `refuted` verification stays gate-authoritative despite a non-report final answer. The transfer requires a tail rule plus a guard on `parseReviewVerification`, the one parrot direction that fails open (#483/#484). `parseJudgeReport` still lacks both — pre-existing, and worth chartering.

6. **Agent-facing docs contain planned-as-shipped claims.** In particular, the ADR-0025 direct-push CAS fence and skill include expansion must not be treated as current-state guarantees without production evidence.

## 8. Remaining probes / architecture discovery

**P5 (ship-through, #483/#484) has since run** and measured H, re-measured F5/G on the real path, and exercised I/J. Do not re-test what P1–P5 answered. What remains:

- seat at least two materially different Agent Drivers behind one **real harness authority construction** and repeat authority-denial probes — P2's diversity was three CLI-over-stdio agents and OpenCode was absent, so this is blocked on substrate rather than effort;
- run an autonomous semantic reconciler on representative changes, prioritizing escalation correctness — P4 measured reconstruction, not autonomy;
- use reconciliation output to derive canonical document ownership rather than designing the doc tree first.

**Struck:** comparing a minimal lifecycle wrapper against narrow phase functions — existing evidence decides it (§3). **Reclassified as implementation, not probing:** exercising the containment path through ordinary step execution is building D. **Scoped:** "capture-at-boundary provenance including successful worktree destruction" tests a path the production target never takes — on `auto-merge-pr` nothing cleans up, and the #483 dossier was byte-identical before and after merge; scope it to `direct-push` or to the post-closer world. **Answered:** `merged → done` for the production PR target — it tears (§2 H).

Architecture discovery should use PR #482 as the current-state evidence anchor and this document as the target/tradeoff anchor. Candidate refactors should state which assumptions remain probe-dependent.

## 9. Stage 3 gate

Do not perform the constitutional swap merely because an item is desirable target state.

Before a replacement ADR lands:

1. every surviving old constraint is present in its named carrier;
2. current-state vs target-state language is explicit;
3. target-state claims with material implementation risk have probe evidence or are clearly recorded as unimplemented decisions;
4. affected trust claims are rebound or weakened in the same change;
5. `proposed = decided-unimplemented` is replaced and existing ADRs are re-triaged;
6. mechanical ADR checks remain narrow; semantic layering stays review/skill territory unless a heuristic proves high-signal. The prototype `check:adr` gate **was removed from this PR** on trio review. Beyond being absent from `.github/workflows/ci.yml` (which runs `check:skills`, `check:trust`, `check:links` and `check:doc-claims`) and exempting 24 of 26 ADRs, its advertised ratchet did not exist: the banner printed "baseline may only shrink" while nothing compared against a prior baseline and `writeBaseline()` re-seeded the exemption set from whatever currently failed — a claimed mechanism whose production path does not implement it, inside the PR that names that pattern as the campaign's headline lesson. Re-land at Stage 3 with a real ratchet and without the `construction-leak` regex, the prose-distorting proxy this clause warns about;
7. planned-vs-shipped facts in always-loaded/agent-facing docs have production-seam evidence.

Superseded ADRs remain archaeology.

## 10. What success looks like

Adding a runtime means implementing/preserving an Agent Driver and proving it seats behind the same declared authority construction, not editing orchestration around its peculiarities.

Adding a delivery activity means using the narrow execution seam plus explicit lifecycle state/ownership without extending a monolithic controller or inventing a framework.

Shipping through any target leaves the item in a reconciled terminal lifecycle state, even when completion occurs asynchronously outside the process.

Provenance facts are captured once where they become authoritative, survive successful worktree destruction, and project into one coherent Change Dossier.

Implementation can report **what changed** without discovering every prose surface; reconciliation updates routine canonical material and escalates architecture/trust/external-contract conflict.

And a future maintainer can replace today's driver, review, containment, landing, or documentation machinery without fighting ADRs that accidentally made those mechanisms Pelaggio's identity.
