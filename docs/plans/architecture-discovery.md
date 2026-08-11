# Pelaggio architecture discovery

Status: discovery report, pre-decision. Companion to PR #480 (`docs/plans/adr-reconciliation.md`), which it treats as **hypotheses A–K, not requirements**. No production code was changed. Every load-bearing claim below was verified against code on `main` (2026-08-10); where docs and code disagree, code wins and the disagreement is itself reported.

Method: six parallel read-only code surveys (lifecycle envelope; drivers/containment; state/identity/provenance; review; roadmap/ship/landing; skills/server/docs/tests) plus direct measurement (LOC, branch counts, dead-code checks, issue-tracker cross-reference). File:line references are to the current `main` checkout.

---

## A. Executive summary

**What is actually wrong.** One thing dominates: the lifecycle *envelope*. `runPipeline` is a single 1,815-line function (`pipeline.ts:219–2033`) and `runOrchestrator` a single 1,214-line function (`pipeline.ts:2254–3467`); between them they hold ~140 closure bindings, 40 exit points through `finish()`, 17 `parkExit` call sites, 45+ `worktree!`/`itemId!` non-null assertions, and ~34 conditionals that branch on ship-target, provider, review-escalation, roadmap-source, or step names. Everything the system knows eventually leaks into these two closures, because the interfaces around them are one size too small: `ShipTarget` exposes only `buildPrompt`/`interpretResult`, so ~190 lines of direct-push behavior live in the orchestrator as `if (target.name === "direct-push")` (10 sites); the review subsystem's own orchestration (~580 lines) lives in `pipeline.ts`, not `review/`; and provider identity carries a `codexModel`-vs-`model` union asymmetry that forces the same ternary at 12+ sites and already corrupts provenance (#454). The test suite proves the diagnosis: the envelope needs a 3,767-line test file, a 25-seam injection record, and a mutable test hook compiled into production source (`pipeline.ts:214`), and it still leaked live agents from tests (#420).

Three second-order problems follow. (1) **Lifecycle ownership is inverted relative to production**: the well-tested post-landing tail (`ship/bookkeeping.ts`) runs only on `direct-push`, while the configured target is `auto-merge-pr` — on the production path *no code owns merged→done*; the stale-quarantine heuristic is the accidental reconciler. (2) **Provenance durability is inverted**: the strongest machine-checkable evidence (execution receipts, review records) lives in the item worktree and is destroyed by the ship that makes it interesting, while the cycle log is keyed by an unsalted run id that doesn't equality-join to the attempt-salted artifacts. `verifyExecutionReceipt` and the PR gate records have zero production readers — write-only evidence. (3) **Planned and shipped are indistinguishable to an agent reader**: 86% of `docs/agent-context/` describes target-state design; AGENTS.md states a CAS landing fence (`--force-with-lease=main:<sha>`) that exists nowhere in code (the direct-push push is a plain `git push` with pull-retry; the only true fence is `gh pr merge --match-head-commit` in `land-cli.ts:81`); the skills doc describes include expansion that never runs.

**What is not wrong.** The concept layer is genuinely good and largely matches #480's vocabulary already: a clean one-line provider dispatch over a typed `StepProvider` registry; typed capabilities with native/degraded realization; fail-closed effects manifests dispatched by the harness with collision-guarded receipts; a pure, well-factored authoring review loop; a pure flow policy; a git-native claim primitive with correct atomicity; hardened TOCTOU-safe file transports; an Ed25519-gated severity-taxonomy floor. The pipeline is honestly linear (no DAG pressure anywhere), scale is single-host, and the daemon is strictly observational. Step-name branching is nearly zero because config is map-driven. Test discipline is strong (1.07:1 test:source).

**Top opportunities:** widen `ShipTarget` and close the merged→done gap; extract the review orchestration and re-base the merge gate on the shared loop (which also fixes a real hardening asymmetry — `modelAuthoredText` and the parrot guard protect only one of the two engines); introduce a cycle-context + per-step spec so the envelope becomes six phase functions over one typed record; unify driver identity; give evidence a durable home keyed by attempt id.

**Top things to resist building:** a DAG scheduler, an event bus, a workflow DSL, a plugin framework, CQRS, an actor system, a generic effect algebra, and any new "semantic reconciliation" runtime machinery ahead of its probe. Every one of these fails the "which concrete failure returns if it disappears?" test today.

---

## B. Current-state system map

### B.1 Delivery lifecycle (what actually happens)

```mermaid
flowchart TD
    OP[operator: pnpm pelaggio / daemon spawn] --> ORCH[runOrchestrator\npipeline.ts:2254 · 1,214 LOC]
    ORCH --> W[worker pull loop ×N\npipeline.ts:2519]
    W --> RP[runPipeline — one cycle\npipeline.ts:219 · 1,815 LOC]
    RP --> PICK["pick (cwd = MAIN repo)\nagent shells `roadmap claim` →\nfeat/&lt;id&gt; branch + worktree"]
    PICK --> PLAN[plan → shakedown-plan\nVERDICT scrape]
    PLAN --> IMPL[implement\nplan read-only, hooks+revert]
    IMPL --> SHAKE[shakedown-code\n= adversarial loop when enabled:\nN seats + Judge, pipeline.ts:1512–1804]
    SHAKE --> SHIP{ship target}
    SHIP -->|direct-push| DP[agent merges locally →\nverifyShipLanded + ship-merged marker →\nrunShipBookkeeping tail]
    SHIP -->|pull-request / auto-merge-pr| PR[SHIP_DECISION file →\nrunShipPrEffects: squash, push, PR upsert,\ngh pr merge --auto]
    DP --> DONE[markDone·archivePlan·pushMain·\nworktree+branch cleanup]
    PR --> DRAIN[review drain (orchestrator):\nqueue ∪ gh pr list → cold gate →\ncommit status `review`]
    DRAIN --> MERGED[GitHub merges when protection satisfied]
    MERGED -.->|no owner| GAP[/"merged→done: NO CODE PATH\nissue stays open, claim branch persists;\nstale-scan quarantine is the accidental reconciler"/]
    ORCH --> REVISE[revise sweep: red `review` PRs →\nscrape findings comment → resume from implement]
    RP --> PARK[park: wip commit + log line;\nreset time in-memory only]
    PARK --> RESUME[4 resume implementations]
```

Selection is delegated to the `/pick` agent even though the eligibility policy is a deterministic, tested pure function (`flow-policy.ts:71–115`): the pipeline shells an LLM turn that itself shells `npx pelaggio roadmap next`, then re-parses `pick-item:`/`pick-result:` markers and defends against the agent diverging (`pipeline.ts:952–977`); `continuous.ts:264–272` re-implements the over-scope gate separately to probe the queue without agent spend. Chartering has no pipeline phase at all — it exists only as skills (`/charter`, `/decompose`) plus one race guard (`isCharterPickRace`).

Step outputs flow through **five ad-hoc mechanisms**: closure `let`s, stdout text scraping (`parsePickResult`, `parseVerdict`, `parseShipMerged`, `parseDeferredItems`, `extractPrUrl`), the filesystem (plan file, PR-body file, findings file), git itself (SHA captures, `filesChangedSince`), and re-reading the JSONL cycle log to reconstruct which driver authored an artifact (`helpers.ts:1333–1357`).

### B.2 Execution and authority

Provider dispatch is already a real seam: `StepProvider { name, capabilities, runStep }` (`step-runner.ts:89–94`), a frozen registry, and a one-line dispatcher (`step-runner.ts:681`). Four drivers: Claude via the Agent SDK `query()` (the only SDK call in the repo), Codex via `codex exec --json -s workspace-write`, Grok via ACP over stdio (agent-neutral JSON-RPC client in `acp-client.ts`), OpenCode via `opencode run --format json` (argv/event shape self-admittedly unverified, `opencode-provider.ts:10–19`).

Authority, however, is **per-driver accident rather than harness policy**:

| Driver | Actual containment on the pipeline path | Env allowlist | Session/PID evidence |
|---|---|---|---|
| claude | No OS isolation; `PreToolUse` hooks only (foreign-root write deny, install deny, plan-polish deny); `canUseTool` allow-all | **No** — inherits full parent env | yes (`onChildSpawn`) |
| codex | Vendor `workspace-write` sandbox (no network) | yes | no |
| grok | Vendor Landlock profile, fail-closed unless configured fallback; ACP permission prompts auto-approved by the provider (`grok-provider.ts:340–348`) | yes | no |
| opencode | **None** (`OPENCODE_PERMISSION={"*":"allow"}`) | yes | no |

`RunStepOpts`' containment fields (`foreignRootDenial`, `mainCheckoutObserver`, `onChildSpawn`) are consumed **only** by the Claude runner — for the other three drivers those guarantees silently do not exist, and the provider-agnostic backstop is a post-hoc git-porcelain snapshot diff (`pipeline.ts:426–631`) — detection, not prevention. The real containment stack (bwrap + systemd scope + `.git` masking + write-set accounting + egress broker with hard spend caps) is fully built (`contained-execution.ts`, `egress-broker.ts`) but reachable only via `pelaggio run-contained`; no code path connects it to the pipeline, and its single egress policy is hard-wired codex→OpenAI. The capability router is barely load-bearing: the only production caller passes no predicates (`pipeline.ts:1549–1555`), `matchEligibleProviders` has zero production callers, and the one real capability gate is a hardcoded Landlock check inside the grok provider. Two seating systems coexist (rotation in `driver-assignment.ts`, capability overlay in `provider-routing.ts`).

Context assembly is split three ways: pipeline owns skill body + harness-injected item context (`expandSkill` strips frontmatter — all skill metadata is **inert** at runtime; `!cat` includes are never expanded and ship as literal text), a shared module owns the autonomy/worktree/plan-lock append, and each provider does final assembly with three ~95%-identical sandbox appends triplicated across driver files.

### B.3 State and durability

The single most load-bearing fact: **two `.dev/` roots**. `MAIN_REPO/.dev` survives (cycle log, attempt allocator, session records, review-request queue, gate records, quarantine, flow-event segments); `WORKTREE/.dev` is destroyed with the worktree at ship (effects manifests, **execution receipts**, **review records**, PR-body file). Citations to review records embedded in effects and the committed decision log therefore outlive their referents.

Identity has 3.5 layers: unsalted `runIdBase` (cycle log), salted `attemptRunId = base-item-aN` (#467 — keys effects, receipts, sessions, review records), forge ids (PR/sha — records carry no runId), and ULID flow-event ids (disconnected; no emitted event carries an item id). The attempt allocator delivers atomic allocation only; the agent-denied register and consumer-side fencing named in its own header are explicitly not implemented, and `MAIN_REPO/.dev` is not covered by the write-guard.

Parking persists exactly two things — a `wip:` checkpoint commit and one cycle-log line — while the rate-limit reset time lives only in process memory. Resume is four separate implementations sharing heuristic step detection over the cycle log. Flow events: the substrate (writer, tolerant reader, diagnostics, legacy promotion) is fully implemented, but only one producer exists (continuous-mode lifecycle, 6 emit sites); 13 of 19 declared event types are never emitted and nothing reads the log.

### B.4 Review

Three engines plus a dev-only fourth: the authoring loop (pure core in `review/loop.ts`, wired by ~290 inline lines of `pipeline.ts`), the cold merge gate (`pr-review-cli.ts` — a second, independently-implemented loop), doc review (correctly reuses the shared loop in a typed `no-revise` mode), and `triad-review.js` (unshipped, third vocabulary, and the only one with retry-on-stub). Cold-gate independence is real and mechanical: separate process, packaged-skill prompt (consumer copies can't weaken the gate), zero authoring context, SHA-pinned detached checkout with a moved-branch bail-out. The deterministic parts are genuinely deterministic: harness-owned classification with a default-to-safety tier, Judge completeness checks that treat malformed output as invalid, carried blockers that only an explicit refutation in a complete verification report can clear, and an Ed25519-gated taxonomy floor. But the fork between the two engines has already produced a real safety asymmetry: `modelAuthoredText` (which exists specifically to stop a reviewed repo from planting findings blocks in transcript text) and the schema-parrot guard protect the authoring loop only; the merge gate parses raw `result.text`. The revise sweep round-trips typed findings through a rendered GitHub comment and re-parses them as prose.

### B.5 Provenance / evidence

What exists: collision-guarded execution receipts (worktree-local, die at ship; `verifyExecutionReceipt` unused), review records (same), PR gate records (durable but mutable last-write-wins, no reader), the cycle-log provenance block (durable, unsalted key), committed decision-log rows and review escalations (fingerprinted, committed-only reads — the only evidence that survives by design), `Assisted-by` trailers, and mutable GitHub statuses/comments. In-toto/DSSE exists as schema + fixtures with `signatures: []` and zero emitter code. Net: the most trustworthy evidence is the least durable, and nothing is signed.

### B.6 Responsibility map (consolidated)

| Component | Actual responsibility | State owned | Authority exercised | Mixes | Likely seam |
|---|---|---|---|---|---|
| `runOrchestrator` | campaign loop + continuous gate + review drain + revise sweep + park/resume + day budget + notify | shared mutable campaign state; `.dev/` main-side stores | gh statuses/comments, git worktrees, spawns review agents | orchestration+policy+persistence+presentation | split into 5 services (each already a closure boundary) |
| `runPipeline`/`step()` | one cycle; per-step confinement audit, effects, decisions, logging | 16 mutable lets; cycle log via `finish()` | spawns agents; git via helpers; effects → push/PR | all five concerns | CycleContext + 6 phase functions; step() → audit/run/effects decorators |
| `step-runner.ts` | provider registry (4%) + Claude runner (59%) + tool hooks | park signal | spawns Claude child; hook denies | mechanism+policy | registry / claude-provider / tool-hooks split; hooks are harness policy trapped in one driver |
| provider modules | subprocess/ACP transport + terminal classification | temp dirs | spawn, allowlisted env | ~80% identical classification ladders | shared ladder + shared sandbox append |
| `provider-routing.ts` + `driver-assignment.ts` | capability matcher (mostly dead) + rotation seating | ordinal | refuse-to-seat | two systems, one concern | keep one |
| `review/loop.ts` | pass loop, dedupe, carried set, outcome | none (pure) | none | — | **keep; make it the only engine** |
| `pr-review-cli.ts` | second loop engine + gate + posting | none local | PR comment + commit status + exit code | loop+transport+presentation | re-base on `runReviewLoop` |
| `ship/*` | prompt builders (thin) + PR executor + direct-push tail + CI guards | pr-body file; roadmap mutations | git push, gh pr create/merge, worktree/branch deletion | behavior lives above the interface | widen `ShipTarget`: preShip/verify/tail |
| `roadmap/*` | 4 adapters + claims + policy + quarantine | claim branches; quarantine store | gh issue writes | ~90-LOC clone pairs; gh runner exported as util | adapter base + `gh-runner.ts`; policy already pure |
| `effects.ts` | manifest schema+validation+dispatch+receipt issuance | worktree effects dir | **highest authority density** (commit, push, PR, enqueue) | schema+dispatch+orchestration | split schema/dispatch; the natural flow-event emission point |
| `helpers.ts` | 60+ exports: skill loading, parsers, git probes, confinement snapshots, resume detection | cycle log read/append | 29 `execSync` — largest git-authority holder | grab-bag import hub | split ≥5 ways |
| `config.ts` | YAML load + STEPS vocabulary + per-step/profile resolution | `REPO`+`CONFIG` at import time (#462) | `execSync` at import | vocabulary+IO+policy | steps.ts / loader / step-settings; one `Record<Step, StepPolicy>` |
| `decisions.ts` | committed decision/escalation authority | `docs/decision-log/**` | git commits | — | escalation half belongs to review/ |
| server/web | spawn CLI, tail logs, SSE, auth | run state store | none over pipeline | — | strictly observational; deletable without pipeline impact |

---

## C. Friction inventory (evidence-backed, ranked by impact)

Each entry: the friction, the hard evidence, and the failure it already caused or plausibly causes.

**F1 — The lifecycle envelope.** `runPipeline` 1,815 LOC / 71 bindings / 40 `finish()` exits; `runOrchestrator` 1,214 LOC / ~69 bindings / 11 mutable `let`s shared **unguarded** across parallel workers; nested `step()` 471 LOC closing over 20+ outer bindings; `worktree!`×20+/`itemId!`×25+ assertions substituting for a phase boundary. Consequences on record: `pipeline.test.ts` is 3,767 LOC (largest file in the repo); a 25-seam `PipelineDeps` with 8 fields labeled "Test seam"; `__setProviderAvailableForTests` mutable hook in production source (`pipeline.ts:214`); tests spawned real Claude+Codex+Grok agents (#420); `--continuous × --parallel>1` is refused outright because the serial free-probe and revise sweep are baked into the envelope (#404, `pipeline.ts:2066`).

**F2 — Production lifecycle gap (merged→done unowned).** `runShipBookkeeping` invoked exactly once, gated `target.name === "direct-push"` (`pipeline.ts:1946,1972`); production target is `auto-merge-pr`; no `Closes #N` templating anywhere; after merge the issue stays open, `in-progress` stays, the `feat/<id>` claim branch persists (blocks re-pick with exit 3), the worktree remains. The de-facto reconciler is the stale-scan `shipped-by-commit` heuristic feeding quarantine, then an operator `stale-resolve --as done`. The rigor is inverted relative to the configured path.

**F3 — `ShipTarget` too thin.** Interface = `buildPrompt` + `interpretResult` only; 10 `target.name === "direct-push"` branches in `pipeline.ts` (1755, 1823, 1832, 1837, 1846, 1859, 1867, 1946, 2250, 2817) carry pre-ship capture, verification, retry, shipwreck recovery, and the tail. `auto-merge-pr.ts` is a 30-line near-clone of `pull-request.ts`. Also: the documented git CAS fence for direct-push (**`--force-with-lease=main:<sha>`**) does not exist — `pushMain` is a plain push with pull-retry whose unverified-origin-merge risk is self-acknowledged (`bookkeeping.ts:52–63`); the only true fence is `gh pr merge --match-head-commit` (`land-cli.ts:81`). G1 (#464) is the open work to build the real fence.

**F4 — Review: three engines, divergent hardening, orchestration outside the subsystem.** ~580 lines of review orchestration in `pipeline.ts` (1512–1804, 2888–3074); the merge gate reimplements fan-out/dedupe/carry/convergence and consequently **missed** `modelAuthoredText` (anti-transcript-injection, `findings.ts:427–450`) and the parrot guard — both protect the authoring loop only. Two convergence vocabularies; three finding vocabularies; the revise sweep scrapes rendered markdown from a PR comment instead of reading the typed gate record; 11 of 17 `parkExit` sites are review-block bespoke reason strings round-tripped through regex back into a typed enum (`helpers.ts:640–652`).

**F5 — Provenance durability + identity join.** Receipts and review records die with the worktree (`git worktree remove --force`, `bookkeeping.ts:284`); committed citations outlive referents (`pipeline.ts:1645` → decision log); cycle log keyed by unsalted `runIdBase` while artifacts key on `attemptRunId` — prefix inference, not a join; `verifyExecutionReceipt` and `PrReviewGateRecord` have no production readers; gate records are mutable last-write-wins unlike the collision-guarded receipts; DSSE/in-toto is fixtures-only. Nothing signed.

**F6 — Driver identity asymmetry + Claude-shaped harness.** `provider === "codex" ? codexModel : model` at 12+ sites across 7 files; already emits `model:"default"` into provenance (#454). `RunStepOpts` containment fields consumed only by Claude; env allowlist applied to every driver **except** Claude; hooks (harness policy) live inside the Claude provider; pick step runs uncontained in the main checkout for every driver (#435); the built jail + egress broker are unreachable from the pipeline; capability matching is ceremonial (no predicates in prod; `matchEligibleProviders` dead; real gate is a hardcoded Landlock check).

**F7 — Config coupling and import-time effects.** 28 step-indexed constructs in `config.ts` (3 compiler-enforced dense maps + 8 silently-sparse profile maps + re-declared shapes + literals) plus 6 leak sites outside it, two already drifted/duplicated (`stats.ts` `STEP_ORDER` omits `pr-review`/`pr-verify`; `authorshipSteps` duplicated verbatim in `pipeline.ts:689` and `ship/assisted-by.ts:39`). `REPO` and `CONFIG` are computed at import time via `execSync`/file read (#462), making the module graph side-effectful and ambient.

**F8 — Planned vs shipped ambiguity.** 7 of 13 agent-context docs (2,192 of 2,555 LOC, 86%) are target-state design; AGENTS.md's `(flow, planned)` invariants sit beside real ones and include the nonexistent CAS fence; `skills.md` documents include expansion that has no runtime implementation (four skills ship literal `` !`cat …` `` text to non-Claude drivers); ADR-0025's "actual ref fence remains load-bearing" reads as shipped. For unattended agents this is operational risk, not just doc debt: agents plan against mechanisms that aren't there.

**F9 — gh/git invocation sprawl.** Four `gh` runner implementations; three modules import the *GitHub roadmap adapter* solely for its subprocess primitives; two `defaultExec`, two `short()`, two shell-quoting disciplines, 5× `isRecord`, 6× empty-ParkSignal factory, 3× `escapeRegex`, 3× `normalize`, 3× `PROVIDER_NAMES`, 2× `SHIP_TARGET_NAMES` (neither imports the other).

**F10 — Budget semantics.** Five mechanisms at four scopes; `--budget` means per-cycle inside `runPipeline` but campaign-total inside the orchestrator, where the check is warn-only and stops nothing (`pipeline.ts:2655–2660`); only the per-step provider cap and the day budget are hard. The day budget is the model citizen (durable ledger, W_OK preflight, receipt rows, campaign halt on unwritable).

**F11 — Selection detours through an agent.** Deterministic, tested eligibility (`flow-policy.ts`) is reachable in-pipeline only via an LLM turn that shells the CLI, forcing `pick:diverted`/unparsed-marker defenses and a duplicated over-scope gate (`continuous.ts:266`). The pick step also runs with `cwd = MAIN_REPO` — the one step with the most authority gets the least confinement (#435).

**F12 — Unused/dead mass.** 1,585 LOC of never-exercised roadmap adapters (markdown/linear/beads — linear even carries a claim-ordering bug: server-side projection before the git claim, `linear.ts:190–201`); dead `FlowReadiness "native"` branch; 13/19 flow-event types never emitted and no reader wired; `.dev/charter-reviews/` orphan; `.dev/review-findings-<id>.md` never deleted and silently re-routing later resumes; `verifyExecutionReceipt` unused.

---

## D. Modern-pattern comparison

Only patterns that map to a real Pelaggio problem, each with: problem solved → does Pelaggio have it → cost → simpler alternative → comprehension effect.

**Durable execution (Temporal) — borrow the vocabulary, not the machinery.** Temporal's core trick (deterministic replay against an event history) is *explicitly rejected* by ADR-0019, correctly: LLM steps don't replay. What transfers is the split it enforces — orchestration state that must survive restarts, typed per-activity retry policies, and a failure taxonomy. Pelaggio already has the non-replay analogue (checkpoint commits + accepted artifacts + typed `ParkClass`); what it lacks is a *persisted attempt/run record* the orchestrator reloads instead of four heuristic resume paths. Cost of full adoption: a workflow runtime and worker fleet for a single-host CLI — absurd. Simpler: one on-disk attempt record per item under `MAIN_REPO/.dev`, written at phase boundaries. Comprehension: high — "Run/Attempt lineage" (hypothesis F) is already #480's language.

**Kubernetes-style reconciliation — already half-adopted; finish the thought, skip the framework.** Level-triggered "observe actual vs desired, converge, re-check" is exactly what stale-scan/quarantine, the review drain's positive-evidence deletion rule, and ADR-0026's "fenced or reconciled" describe. The gap F2 exposes is precisely a *missing reconciler* (merged→done). The lesson worth taking: each reconciler owns one state kind, runs idempotently on a scan, and never trusts absence as evidence (already codified at `pipeline.ts:2930–2943`). The anti-lesson: informers/watch machinery, generic controller runtimes. Periodic scans are enough at this scale. Comprehension: high — it names what the code already does.

**CI engines (GitHub Actions / Tekton) — per-step contracts as data, not a DSL.** The transferable ideas: a step *contract* record (inputs, outputs, permissions, budget) declared as data (hypothesis B); per-step authority scoping like Actions' `permissions:` block (hypothesis D); uniform typed step outcomes. Pelaggio's per-step data already exists — budgets, turn limits, effort, models, pooled-provider lists — but scattered across 11 parallel maps; the consolidation is `Record<Step, StepSpec>`, not YAML. The anti-lesson: a workflow DSL. Steps are code + skill prose with exactly one consumer; a DSL adds a parser and a debugging layer for zero new capability.

**SLSA / in-toto — bind evidence to immutable subjects at effect time.** Already chosen for publish (ADR-0007/0018) and already half-practiced: doc-review binds reports to a sha256; receipts digest the manifest bytes. The generalizable rule: evidence is fat, self-contained, bound to a sha, emitted where the effect happens (which matches the flow-events "effect-confirmed producer" design — and `effects.ts` is the single point where that emission belongs). The distinction #480 draws (attestation ≠ dossier ≠ telemetry) matches what the code already separates poorly (receipts vs records vs stats). Local signing infrastructure per change is overkill; sha-binding + append-only + a durable home is the 90% version. Falsifiable by the provenance probe: if a useful dossier turns out to require transcript storage, the compact-evidence premise fails.

**LSP / driver architectures — capabilities as reported facts; refuse, don't infer.** Pelaggio's `StepProvider` + `ProviderCapabilities` + native/degraded realization *is* this pattern, and the refuse-to-seat rule is already implemented in the router. Two deviations from the pattern's discipline: the harness infers nothing but also *asks* nothing (no predicates passed in production — the machinery idles), and one driver's real gate bypasses the model entirely (grok's in-provider Landlock check). Either wire the router with real predicates derived from step authority requirements, or delete it; the half-state is the worst option. Comprehension: high — LSP is the shape every contributor already knows.

**Capability-based security — keep the property, skip the vocabulary.** #480 §3 already demotes ocap vocabulary; right call. The property that matters (authority = explicit grants constructed by the harness, execution can't self-broaden) currently holds per-driver by accident (B.2 table). The cheap consolidation is a single `AuthorityProfile` record built by the harness per step execution — env allowlist, fs scope, network policy, git authority — enforced by whatever mechanism the driver supports (hooks, vendor sandbox, jail) and recorded into provenance. That is data + a table, not a framework.

**Build systems (Bazel/Nix) — mostly not applicable.** Hermeticity-as-input-completeness and content-addressed incremental caching have no purchase on nondeterministic LLM steps. Borrow only content-addressing of evidence (done) and the "toolchain pinned outside the candidate tree" instinct (already stated in the taxonomy module's honesty note).

**Event sourcing / CQRS — deliberately rejected; keep the rejection.** The flow-events design (append-only fat events for *history*; git+forge remain ground truth for *current state*; projections non-authoritative) is a considered anti-CQRS stance and G6b/#470 reinforce it. Real event sourcing would invert the ground-truth spine. The friction is not the stance but the wiring: one producer, no readers. Either emit from the effects seam and grow a reader, or prune the enum.

**Actor systems / state machines — no framework; yes, one explicit transition table.** The disposition states already exist as types (`ParkClass`, `CycleDisposition`, review outcomes); what's implicit is the transition function, smeared across 40 `finish()` sites and 17 `parkExit`s with free-string reasons. Making park/disposition a typed value at the source (delete the string→regex→enum round-trip) is a state-machine *shape* worth having; an actor runtime is not.

**Verdicts on the challenge list** — DAG: **no** (linear STEPS, zero observed fan-out pressure outside the bounded review fan-out already local to the loop). Event bus: **no** (three named producers max; a log, not a bus). Actor system: **no**. Generic effect algebra: **no** (the closed effect-kind enum with an explicit dispatch switch is a feature — `effects.ts:297–298` says so). Workflow DSL: **no**. Plugin framework: **no** (four compiled-in drivers; the registry suffices). CQRS/event sourcing: **no** (see above). Generalized state machine: **no framework**, one typed transition table. Distributed coordination: **no** (single host; file locks + git ref atomicity + the gh merge fence cover the real races).

---

## E. Natural seam analysis — the #480 candidate concepts

For each: is it real in code today, what representation it deserves, and whether naming it removes or adds indirection.

**Pipeline** — real (the `STEPS` const + envelope). Deserves: *vocabulary + a module boundary*, not a runtime object. The ordered list is already data; what's missing is that the envelope isn't decomposed along it. No new type earns its keep here.

**Step** — real but scattered. Today a "step" is: an entry in 11 config maps + a phase block in `runPipeline` + prompt assembly + park/retry idioms + an effects allowlist implicit in pipeline literals. Deserves: **a data record (`StepSpec`) + a function signature**, not a class hierarchy. The god-object risk (#480 probe question 1) is real if `StepSpec` accretes behavior; the discipline is: spec = declared data (skill, cwd policy, authority profile, budgets, effects allowlist, retry/park policy), execution = one shared engine, step-specific behavior = the per-phase function. Naming it deletes duplication (11 maps → 1; 4 `planBlockActive` copies; scattered budgets) rather than adding indirection.

**Run / Attempt** — attempt identity is real (#467, property 1); run identity is real but unsalted in the one durable index. Deserves: **make `attemptRunId` the join key everywhere** (cycle log included) plus a small persisted attempt record replacing heuristic resume detection. Not a new abstraction — a key unification. The agent-denied register + consumer fencing (properties 2–3) remain open design work under G4/G5.

**Agent Driver** — real and mostly right (`StepProvider`). Deserves: staying an interface, with four fixes that are deletions not additions: unify `DriverIdentity` (one `model` slot; kills 12+ ternaries and #454), move the tool hooks out of the Claude module into harness policy, share the terminal-classification ladder and sandbox append, and either wire the capability router with real predicates or remove it. One seating system, not two.

**Sandbox / Authority boundary** — *not* real today as a concept; real as four unrelated mechanisms. This is the largest genuine gap between #480's language and the code. Deserves: **an `AuthorityProfile` record** (data) constructed by the harness per step execution, mapped onto whatever enforcement the seated driver supports, recorded into provenance — with refuse-to-seat when a step's required authority bound has no equivalent on the driver (the invariant already stated for capabilities). The jail becomes one enforcement option behind the same record, not a separate subsystem. Depends directly on hypotheses C/D/E and the cross-driver-denial + capability-equivalence probes.

**Review / Clearing judgment** — real and well-built once (pure loop, harness-owned classification, judge-completeness, safety floor), then forked. Deserves: **consolidation, not abstraction** — one loop engine with two configurations (authoring / cold), shared parsers and hardening, review orchestration living in `review/`. Hypothesis I's actual invariant (author ≠ clearing judgment, deterministic resolution) is already satisfied by existing pieces.

**Provenance / Change Dossier** — pieces real, home missing. Deserves: **a durable evidence directory keyed by `attemptRunId`** (receipts/records/gate records written or copied there at emission) plus a *read-side* assembler (a CLI that walks charter → attempts → review → landing for one item). The dossier is a view, not a store. No event bus required; `effects.ts` is the emission point if flow events are ever wired.

**Semantic reconciliation** — not in code (doc-review is a tool, not a delivery obligation). Deserves: **nothing in the runtime yet**. Its probe (replaying representative changes) hasn't run; building a `reconcile-docs` step or `DocumentationImpact` enum now would be exactly the premature constitutionalization #480 warns about. The only code-adjacent prerequisite worth noting: evidence of realized impact (changed files per attempt) already exists in receipts/`filesChangedSince` — a future reconciler consumes it; nothing needs to change today to keep that option open.

**One deliberate non-seam:** `expandPackagedSkill` vs `expandSkill`, the strict `ship/decision.ts` validator vs the looser effects validator (reconcile to strict, don't merge away), `assertCiNotRed` vs `assertCiGreen`, and doc-review's isolation from the pipeline are *protective* duplications guarding trust boundaries — flagged so consolidation zeal doesn't flatten them.

---

## F. Candidate architectures

Concept accounting counts *load-bearing named things a contributor must learn*. Current system: ~14 core concepts (Step/STEPS, StepProvider+capabilities, DriverIdentity split union, ShipTarget, RoadmapSource, FlowPolicy, effects manifest, execution receipt, review loop, merge-gate engine, park signal/classes, cycle log, attempt identity, sessions/confinement) **plus** the envelope's implicit ones (closure phases, five data-flow mechanisms, four resume paths).

### Candidate A — minimum refactor ("extract along existing lines")

Keep every current concept and store; move code to where its concept lives.

1. **Widen `ShipTarget`** to `{buildPrompt, interpretResult, preShip, verify, tail}`; move the 10 direct-push branches and the bookkeeping invocation behind it; merge `pull-request.ts`/`auto-merge-pr.ts`. Close F2 minimally: give the PR targets a `tail` that the review drain invokes on observed merge (reusing `runShipBookkeeping`'s ordering).
2. **Extract review orchestration** into `review/authoring-step.ts` and `review/drain.ts` (~580 lines out of `pipeline.ts`); revise sweep reads the typed gate record instead of scraping the comment.
3. **`CycleContext` + six phase functions** extracted from `runPipeline` (the phase blocks are already visually delimited); one `PipelineOpts` builder replacing four literals.
4. **`realizeDriverIdentity(settings, provider)`** helper; keep the split union but confine the ternary to one function (fixes #454's class of bug).
5. **`gh-runner.ts`** extraction (one hard + one soft runner); shared small utils (isRecord, escapeRegex, ParkSignal factory).
6. **Config hygiene**: one `Record<Step, StepPolicy>` for the 11 maps; lazy/injected `REPO`/`CONFIG` (#462); import `STEPS` where `STEP_ORDER`/`AUTHORSHIP_STEPS` drifted.

Concepts added: 2 data records (CycleContext, StepPolicy). Concepts removed: ~10 duplicate implementations. State/authority ownership: unchanged. Migration: incremental, each item independently landable behind existing tests; the envelope tests shrink naturally. Change surface for common tasks: "add a step" drops from ~17 edit sites to ~7; "why did this park" unchanged (still string reasons); "add a driver" unchanged.

Depends on A–K: none beyond what code already embodies (A, C, F, H, I hold as-is). Falsified by: essentially nothing — which is its weakness: it leaves F2 only patched, F5 and F6's authority asymmetry untouched, and planned/shipped ambiguity (F8) unaddressed.

### Candidate B — preferred simplification ("typed step lifecycle on existing bones")

Everything in A, plus four moves that change *boundaries*, not concepts:

7. **`StepSpec` + one step engine.** Per-step declared data — skill, cwd policy (worktree/main/seat), authority profile, budgets/turns/effort/models, effects allowlist, retry-park policy — consolidated from the 11 maps and pipeline literals; `runDeliveryStep(ctx, spec)` becomes the one engine wrapping confinement audit → provider call → effects → decisions → logging (today's `step()` unbundled into decorators). Step outputs become a typed `StepOutcome` (replacing the five ad-hoc flow mechanisms where cheap: verdicts and markers become parsed fields; files stay files). Park reasons become typed at the source; `classifyParkReason`'s regex round-trip is deleted.
8. **`AuthorityProfile` as harness policy.** One record per step execution: env allowlist (now including Claude), fs scope, network stance, git authority; enforcement mapped per driver capability (hooks / vendor sandbox / jail) with refuse-to-seat when a required bound has no equivalent. Tool hooks move out of the Claude provider into a harness policy module; the three sandbox appends unify in `step-runner-shared`; the jail becomes an optional execution profile behind the same record (still off by default). Fixes the pick-step containment hole (#435) by making "runs in main with X authority" an explicit, visible declaration instead of an accident.
9. **Durable evidence home + one join key.** `MAIN_REPO/.dev/evidence/<attemptRunId>/` receives receipts, review records, and gate records at emission (gate records become append-only like receipts); the cycle log records `attemptRunId`; a small persisted attempt record replaces heuristic resume detection; `pelaggio dossier <item>` assembles the read-side view. `verifyExecutionReceipt` gains its first caller (dossier and/or land path) or is deleted.
10. **One review engine.** `pr-review-cli` re-based on `runReviewLoop` (cold configuration: packaged prompts, matrix seats, no revision), inheriting `modelAuthoredText` + parrot-guard hardening; `findings.ts` split along its v1/v3 halves; one "ephemeral pinned checkout" primitive for seats + review heads. A single post-landing reconciler in the drain owns merged→done for PR targets (F2 closed properly, in reconciler form consistent with G6b/#470).

Concepts added: 4 (StepSpec, AuthorityProfile, evidence home, attempt record — all data records, no frameworks). Concepts removed: 6 (second review engine, DriverIdentity split union, one of two seating systems, four gh runners → one, five data-flow mechanisms → typed outcome + files, four resume paths → one over the attempt record). Net: **−2 concepts** with the safety-relevant properties (authority, evidence, lifecycle closure) made explicit.

Change surface: "add a driver" = implement `StepProvider` + capability descriptor + authority-enforcement mapping, zero pipeline edits; "add a step" = one `StepSpec` entry + one phase function; "why did this park" = one typed field in one attempt record; "why does this commit exist" = `pelaggio dossier`; "change containment" = swap the enforcement backing an `AuthorityProfile`.

Depends on A–K: B (step contract), C/D/E (authority profile bounding heterogeneous drivers), F (attempt-keyed durability), G (compact evidence), H (reconciler for merged→done), I/J (single loop serving both hot and cold review without state leakage). Falsifiers in §I.

### Candidate C — more structural alternative ("attempt ledger + explicit state machine")

Go one step further than B: make the **attempt record the single source of orchestration truth**. Every cycle transition (claimed → planned → implemented → reviewed → shipped/parked/quarantined) is a typed transition appended to a per-attempt ledger under `MAIN_REPO/.dev`; `runPipeline` becomes a thin driver that reads the ledger, computes the next transition from a declared table, executes it, appends the result; resume is "re-run the driver" with no heuristics; the cycle log and flow events become projections of the ledger; all reconcilers (drain, revise, stale, merged→done) read the same ledger.

Gains: one inspectable state home; resume/crash semantics become trivial to reason about; the flow-event catalog gets its producer for free; parallel workers coordinate through the ledger instead of shared closures. Costs: a genuinely new runtime concept (the ledger + transition table) sitting **in front of** git/forge ground truth, which collides with the settled invariant that git + provider are ground truth and projections are non-authoritative — mitigable (ledger records *observations* of git/forge facts, never asserts them) but that discipline must be enforced forever; a migration that rewrites the envelope rather than extracting it; and test-fixture churn across the two biggest suites. Concepts added: 3 heavyweight (ledger, transition table, projection discipline) on top of B's records. This buys elegance B doesn't, but the failure it prevents beyond B is narrow: cross-process orchestration races that today's file locks + git atomicity already fence at this scale.

### G. Preferred candidate: **B**, staged through A

- **Conceptual count:** B is net-negative (−2) while adding exactly the records (#480's own nouns) that make authority, evidence, and lifecycle inspectable. A is smaller but leaves the three inversions (F2, F5, F6) standing; C is net-positive in concepts and re-litigates a settled ground-truth invariant.
- **Inspectability:** B gives each question one home — attempt record (why parked), evidence dir (what proves this), AuthorityProfile (what could it touch), StepSpec (what was it allowed to spend). C matches this but at higher machinery cost; A does not.
- **Code locality:** A and B both collapse the envelope; only B collapses the *duplicated engines* (review, seating, resume).
- **Extension cost:** B's driver/step stories reach #480's stated success criterion ("adding a runtime means implementing a driver and proving its boundary"); A's do not.
- **Safety:** B is the only candidate that makes cross-driver authority uniform-or-refused rather than accidental, and the only one that stops evidence from being destroyed by the path that makes it interesting.
- **Migration:** every A item is also B's first stage and independently landable; B's items 7–10 are each separately abortable if a probe falsifies them. C is not incrementally abortable past its first step.

Sequencing note: A1–A6 are safe to start regardless of probe outcomes; B7–B10 should each wait for (or be run as) their named probe below.

---

## H. Deletion / consolidation list

**Disappears outright (dead or duplicated):**
- `ship/auto-merge-pr.ts` (30-line near-clone of `pull-request.ts`) — one parameterized target.
- `matchEligibleProviders` (zero production callers) — wire it with real predicates or delete; the half-state misleads.
- One of the two seating systems (`driver-assignment.ts` rotation vs `provider-routing.ts` overlay).
- The second review loop engine inside `pr-review-cli.ts` (re-based on `runReviewLoop`).
- `FlowReadiness "native"` branch + `not-native-ready` verdict (unreachable) — or wire Beads' `ready`; today it's dead either way.
- 13 never-emitted flow-event types (prune the enum to emitted + explicitly-planned-tagged), or wire the effects-seam producer.
- `.dev/charter-reviews/` orphan directory; `.dev/review-findings-<id>.md` residue (add deletion; its silent resume re-routing is a live trap).
- 3× `PROVIDER_NAMES`, 2× `SHIP_TARGET_NAMES`, 2+× `runGhSoft`, 2× `PR_REVIEW_MARKER`, 2× `defaultExec`, 2× `short()`, 5× `isRecord`, 6× empty-ParkSignal factory, 3× `escapeRegex`, 3× `normalize`, 4× `planBlockActive`, 2× `AUTHORSHIP_STEPS`, 7× codex-model ternary, 3× sandbox appends, 2× gh rollup shapes — each to one home.
- `classifyParkReason` string→regex→enum round-trip (typed park reasons at source).
- `__setProviderAvailableForTests` production test hook (falls out of envelope injection).
- The `revise-sweep` comment-scrape path (read the typed gate record).

**Merges:**
- `prepareAuthoringReviewSeat` + `prepareReviewHead` → one "ephemeral SHA-pinned checkout" primitive (keep the stricter validation).
- `github-issues`↔`linear` clone pairs (~90 LOC) → shared remote-issue base + `item-body` codec; `parseGhJson`/`parseBdJson` + `defaultGhRun`/`defaultBdRun` → one CLI-runner util; extract `gh-runner.ts` so ship/review stop importing a roadmap adapter for subprocess plumbing.
- `helpers.ts` (1,484 LOC, 60+ exports, 29 `execSync`) → git.ts / parsers.ts / confinement-snapshot.ts / skill-loader.ts / classify.ts.
- `step-runner.ts` → provider-registry / claude-provider / tool-hooks (hooks become harness policy usable by any semantic-deny-capable driver).
- `runOrchestrator` → CampaignRunner / ContinuousGate / ReviewDrainService / ReviseSweepService / ParkResumeLoop (each already a closure boundary).

**Candidates the user must rule on (product questions, not code facts):**
- 1,585 LOC of unexercised roadmap adapters (markdown/linear/beads). Linear self-describes as another product's consumer and carries a real claim-ordering bug; Beads is the named future work-store (#181). Park, fix-on-adoption, or delete.
- `packages/server` + `packages/web` (5,486 LOC): strictly observational, zero pipeline coupling — keep as operator convenience or drop.
- `triad-review.js`: unshipped third vocabulary; port its retry-on-stub into the product loop, then retire it.

**Must NOT be merged (protective duplication):**
- `expandPackagedSkill` vs `expandSkill` — the merge gate must not depend on consumer-editable skill copies.
- `assertCiNotRed` vs `assertCiGreen` — deliberate strictness asymmetry between deferred and immediate merge authority.
- `ship/decision.ts` strict transport vs `effects.ts` validator — *reconcile to the strict one*; don't average them.
- Doc-review's isolation from pipeline config; the taxonomy module's env-anchored key; seat-vs-author worktree separation.

---

## I. Probe dependencies

The Stage-2 probe suite from `docs/plans/adr-reconciliation.md` §6, plus live issues that already function as probes (G1–G6b = #464–470; #435; #454; #458).

| Architectural choice | Depends on hypothesis | Probe that decides it | If falsified |
|---|---|---|---|
| `StepSpec` + single step engine (B7) | A, B | **Step-contract conformance** — fit pick (main-cwd, claim authority), implement (worktree, plan-locked), review seat (ephemeral checkout, no commit), ship (effects-only) into one spec without optional-field sprawl | Keep Candidate A's phase functions; per-family specs (authoring / review / effectful) instead of one; no shared engine |
| `AuthorityProfile` bounding all four drivers (B8) | C, D, E | **Cross-driver authority denial** + **capability-equivalence matrix** (evidence already in hand: hooks are Claude-only; opencode has no isolation; #435; #279) | Refuse-to-seat non-boundable drivers for authority-sensitive steps rather than claiming harness equivalence; keep vendor sandboxes as the per-driver story and say so in docs |
| Jail as an execution profile behind the same seam | D | Same probes + the existing `run-contained` self-tests | Jail stays a standalone CLI for untrusted-input work only |
| Evidence home + attempt-keyed join + dossier (B9) | F, G | **Run/attempt recovery lineage** + **source-provenance / Change Dossier prototype** (assemble a dossier for one shipped item from surviving artifacts — today it fails at the destroyed review record) | Keep receipts worktree-local; promote only the gate record + cycle log; drop the dossier CLI; G shrinks to "log + trailers + committed escalations" |
| Persisted attempt record replacing resume heuristics | F | Recovery-lineage probe (replay: park at each phase, resume, verify no laundering of failed attempts) | Keep `detectResumeStep` heuristics; unify only the four `PipelineOpts` literals |
| Merge gate on `runReviewLoop` (B10) | I, J | **Cold-isolation reuse** — shared engine, injected transport; verify no author-session state can reach a cold seat | Keep two engines; share only parsers + `modelAuthoredText` + parrot guard (that hardening transfer is justified *today* regardless) |
| Merged→done reconciler on the drain | H | **G6b reconcilers (#470)** + #387's positive-evidence rules | Manual/skill-driven mark-done stays the contract; document `awaitingMerge` as terminal and make `/tidy` the sanctioned closer |
| Real CAS fence for direct-push (or its retirement) | H | **G1 fence (#464)**; also the open product question in §J | If single-writer assumption holds and direct-push stays dev-only: document plain-push semantics and delete the planned-fence bullet instead of building it |
| Typed park reasons + park-state durability | F, H | #458 (sdk-outage persistence) + recovery-lineage probe | Keep string reasons; fix only the in-memory relabel gap |
| Semantic-reconciliation step (deliberately NOT proposed) | K | **Semantic-reconciliation replay** + **canonical-doc ownership inventory** | Nothing to roll back — no runtime work proposed here until the probe reports |
| Doc restructure (shipped vs design split) | K (partially) | **Canonical-doc ownership/dedupe inventory** | Even if dedupe stalls, the cheap fix stands: status-tag every agent-context file and drop the never-built CAS bullet from AGENTS.md |

---

## J. Open questions (evidence genuinely insufficient)

1. **Is `direct-push` a product target or a dev convenience?** It has the good tail and the missing fence; `auto-merge-pr` has the fence (via GitHub) and no tail. Which path deserves the investment decides G1's priority and how much of B's ship work matters.
2. **Are the markdown/linear/beads adapters product surface?** 1,585 unexercised LOC with one known bug; Beads is named in the coordination-spine decision. Delete, park, or finish — a strategy call, not a code fact.
3. **What mechanism satisfies attempt-register properties 2–3** (agent-denied register + consumer-side fencing, G4/G5)? Options touched in code comments (hooks-extended coverage of `MAIN_REPO/.dev`, an external store, ownership bits) have different blast radii; needs its own small design note.
4. **Should skill metadata become a provider-neutral manifest or be deleted?** Frontmatter is 100% inert Claude vocabulary today; includes don't expand. Either make `check-skills`' schema actually bind (a `runtime:` block the harness reads) or strip to `name`/`description` and let config own the rest.
5. **Does anything ever need the daemon to be more than observational?** If supervised runs remain CLI-first, the server's REST surface can freeze; if remote control is coming, it becomes a real authority boundary and inherits ADR-0008 obligations beyond a bearer token.
6. **How much provenance must survive a *failed* attempt?** Receipts currently die with abandoned worktrees too. If failed-attempt evidence matters for the dossier (hypothesis F's "no laundering"), the evidence home must be written at emission, not promoted at ship — cost is small but nonzero.

---

## Appendix: documentation implications (input to the dedupe probe, not a redesign)

What the code architecture wants, per candidate — recorded for the semantic-reconciliation/doc probe rather than acted on:

- **One system map**: §B of this report is the shape — lifecycle, execution/authority, state/evidence, review — and under Candidate B it maps 1:1 to module boundaries.
- **Construction docs follow modules**: step engine + specs (absorbs `pipeline.md`), drivers & authority (absorbs step-provider notes + `contained-execution.md`'s shipped parts), review (absorbs `adversarial-review-loop.md`'s shipped parts), ship/landing (absorbs the ship half of `roadmap-and-ship.md`), state & evidence (new; absorbs the receipts/records/identity story told nowhere today).
- **ADRs keep invariants only** — #480's cut rule; this report supplies the "carried by" evidence for several rows (e.g., 0025's fence is aspiration, not construction).
- **Derivable from code, should stop being prose**: the `.pelaggio.yml` schema (1,094-line `config.md` vs the parser), step budget/turn/effort tables, capability matrices, the flow-event catalog (from types), the three decision-record representations (decision-log is source; `decisions.md` already generated; the ADR index could be).
- **Redundancy hotspots for the dedupe probe**: CAS-fence text in ~7 documents (5× within `flow.md` alone); fail-closed restated 9+ times; worktree confinement in ≥12 docs + 8 skill bodies; `docs/archived/` is 50% of all doc LOC.
- **Cheap immediate wins consistent with any candidate**: status-tag every `docs/agent-context/*.md` as shipped/design in its first line; correct `skills.md` (includes do not expand); move the CAS bullet in AGENTS.md from stated-mechanism to planned-work referencing #464.

---

## K. Product calls: positions taken (2026-08-10)

The §J questions were litigated; positions below are settled unless a named probe falsifies their premise. Where a position constrains Candidate B's work items, the constraint is stated.

**K1 — Direct-push is product-grade, with a narrowed contract.** Single-integrator semantics, fenced. G1 (#464) reduces to: lease `pushMain` against the observed SHA (`--force-with-lease=main:<observed>`) and replace the blind pull-retry with re-verify-and-re-observe; the SHA-capture half already exists in `captureShipState`. Landing gets **one lifecycle closer** serving both paths — the merged→done reconciler with two triggers (observed local merge for direct-push; observed forge merge for PR targets) — instead of two tails. `runShipBookkeeping`'s failure taxonomy (roadmap failures warn once the merge is verified; push/integration failures block; branch deletion gated on mark-done) is preserved verbatim in the closer; it is incident-derived (#205) and must not be re-learned.

**K2 — Adapters are tiered, insured by a shared conformance suite.** `github-issues` and `markdown` are tier 1 (dogfood + onboarding). `linear` is maintained-on-demand for its external consumer (fathom — wired, development paused); its claim-ordering bug is fixed *via* the conformance suite, which is both spec and regression test. `beads` stays behind the #181 decision; either wire `bd ready` into the dead `native` readiness branch or stamp the adapter dormant. The suite covers at minimum: claim ordering (git before projection), lost-race rollback, `markDone` idempotency, plan publish/fetch round-trip — and runs against fake forge/`bd`/fs seams only (no live services; the #420 lesson applies to adapters too).

**K3 — The attempt register gets no bespoke protection mechanism.** Properties 2–3 (agent-denied register, consumer-side fencing) are inherited from the `AuthorityProfile` work: once every step execution has an explicit fs scope and `pick` stops running with main-checkout authority (#435), `MAIN_REPO/.dev` is outside every agentic write scope by construction, uniformly across drivers. Consumer-side fencing (the receipt collision-guard pattern) remains as defense-in-depth. Bound to the cross-driver authority-denial probe; if that probe fails for any seated driver, this question reopens.

**K4 — Skills: no file split; sync is enforced mechanically.** A sidecar/manifest split is rejected — interactive Claude Code requires frontmatter in `SKILL.md`, so a split means either breaking the operator slash commands or introducing a generated canonical tree (which relocates drift into a build step). Instead: (a) `expandSkill` gains include expansion so `` !`cat …` `` behaves identically in both consumers — the only place the two contexts see different content today; (b) `SKILL_SCHEMA` in `check-skills.ts` tags every optional field `interactive-only`, and a new lint forbids frontmatter fields that share a name with a `.pelaggio.yml` step-setting key (`effort` is the live collision — resolve by removal or rename); (c) `.pelaggio.yml` is the sole pipeline authority, stated as such in `skills.md`, which is also corrected on includes. The linter, not a new file shape, is the sync mechanism.

**K5 — Daemon: observational only, with the trust rule written down.** No second daemon. Reconcilers (closer, drain, stale scan) are idempotent CLI verbs; any scheduler may invoke them — campaign boundaries always, a systemd timer optionally, the daemon optionally for freshness. Invariant to add:

> *A daemon may improve latency or visibility, never correctness or authority. Authority-bearing processes are harness-spawned and run-scoped (the egress-broker pattern). Every reconciler is a CLI verb; no pipeline correctness may depend on daemon liveness.*

Under this rule the daemon may grow (multi-repo views, scheduling, dashboards) without re-litigating trust: the answer to "what breaks if it's down" must always be "latency only."

**K6 — Evidence is written durable at emission.** Compact records (receipts, review records, gate records) go to the durable evidence home at write time — not promoted at ship — with age/count retention. Failed and superseded attempts retain their evidence; this is a debugging requirement ("the only way to debug reliably") and the precondition for the F-hypothesis probe to test the real design rather than a strawman. Fat transcript retention remains out of scope (the G-hypothesis boundary).

**K7 — The metrics/projection surface is a product commitment.** The insights are the differentiator, so flow events are wired, not pruned — sequenced along the anchors K1/K6 create:

1. **Effect-confirmed producer** lands with the evidence home (B9): emit alongside the receipt write at the `effects.ts` seam — the single point every consequential mutation already passes; single-writer segments are a solved problem there.
2. **Confirmation producer** lands with the closer (K1) and reconcilers (G6b/#470): `shipped`, `claim-released`, `state-observed`, `state-corrected`.
3. **Derived-readiness producer** lands together with its first consumer — the projection surface itself — rather than ahead of it.
4. All 19 event types stay declared; the unwired ones carry an explicit `(planned)` tag until their producer lands, keeping the shipped/design line honest (F8).
5. The first **reader** (a stats fold over events, then the dossier/projection view) is built early as the forcing function — write-only event streams are how the current half-built state happened.

The attempt-identity unification (B9) is what makes the correlation fields real: events carry `itemId`/`attempt` from the same key that names evidence, so insights join to provenance without inference.
