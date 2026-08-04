# Flow Context

**Status: design record / target-state.** Unlike the other `agent-context` docs,
this one describes an architecture that is being chartered, not one that ships
today. Sections tagged **(planned)** are not implemented — do not assume
`FlowPolicy`, the flow projection, write-back, declared write-sets, or an
explicit landing queue exist in code yet. The invariants in this doc are
load-bearing **for the work that implements them**: pipeline cycles building
these items consume this file as context, so the rules must exist before the
first implement cycle, or that cycle can violate them.

This doc is the durable home for the *why*. A charter is a consumable work order
— read-only during `implement`, archived on ship — so design rationale written
into a plan disappears into the archive the moment the work lands. Enduring
decisions live here and as one-line invariants in `AGENTS.md`.

## The model

pelaggio is already a Kanban **pull** system; it just was not named as one.
`/pick` is a pull, `--parallel` is a WIP limit, the `feat/<id>` branch is the
in-progress column, `deps` is blocked-by, and `_rubric.md` is the Definition of
Done. The flow work is not "adopt Kanban" — it is to name the pull system that
exists, add the missing primitives deliberately, and reject the agile
conventions that only encode *human* bottlenecks (sprints, estimation-for-
capacity, standup). Those die under automation; prioritization, Definition of
Ready, WIP limits, and review survive with re-based rationales.

Concurrency has a second, precise framing: each cycle is a **transaction**
against a shared mutable store (the trunk). It reads a snapshot (branch off
`main` at T), computes (`implement`), and validates-at-commit (`ship` merges to
`main`). Today that is **Optimistic Concurrency Control with an unsound
validator**: git's textual merge is *syntactic*, so it bounces on textual
overlap and passes on semantic breakage (cycle A renames a symbol; cycle B calls
it from a file A never touched → clean merge, broken build). A `ship` post-merge
verify *would be* the real semantic validator, but today it is neither serial nor
reliably run — no harness land mutex, production `verify` hook unset, and
`verifyShipLanded` satisfied by any advance of `main`
([ADR-0025](../decisions/0025-landing-serialization-cas-fence-optional-ordering.md);
detail in Tier 2 below). The flow work makes that structure explicit and sound.

## Storage vs. Policy (the load-bearing seam)

Two seams, deliberately separated:

- **`RoadmapSource` = storage.** Provider-native. Leverage what Linear / GitHub /
  markdown already give you. Keep it the thin lowest-common-denominator it is.
  (Exception worth naming: **Beads** — see `coordination-spine.md`, #181 — is a
  first-class source that provides *more* than the LCD: a deterministic ready-set
  (`bd ready`), plus `bd merge-slot` as an OPTIONAL ordering layer above the
  harness's own landing fence (git ref compare-and-swap, ADR-0025 — never the
  exclusion primitive itself). Policy still consumes the snapshot, not the store;
  where Beads offers a sound primitive, flow *rides* it rather than
  reimplementing — the "best foundation, not novel" call.)
- **`FlowPolicy` = policy (planned).** pelaggio-owned, provider-neutral,
  pluggable. It decides readiness, class of service, swimlane, and pull order.

The rule of the whole design: **storage leverages the provider; policy is
yours.** The reason *not* to put hierarchy (initiatives, parent/child) into the
item model is the same reason to give flow policy its own home — adding
structure to `RoadmapItem` raises the LCD floor and forces every adapter to fake
what Linear/GitHub already model natively. An initiative is therefore a
**projection** (a read-only `group`/swimlane string each adapter maps from its
native container: Linear initiative/project, GitHub milestone/label, markdown
roadmap file), never a pelaggio-owned object.

`isQuickScope()` used to live on `RoadmapSource` — a policy decision on the
storage interface, the seam leaking. `#171` extracted it onto `FlowPolicy`
(`FifoPolicy.isQuickScope`) as a free cleanup the policy work paid for.

## FlowPolicy (planned)

Minimal-first, expand via strategies. `FlowPolicy` is a pure function of a
**snapshot** (items + projection + current WIP state) → a verdict (ready?, class,
swimlane, order, may-pull-given-WIP). It never reaches into git or the provider;
strategies see the snapshot, not storage. Ship `FifoPolicy` (deps-satisfied gate
+ upstream-priority tiebreak + FIFO) as the default; add `WsjfPolicy` and
classes of service later, once the projection can feed them.

**Prioritization: offload the inputs, own the decision.** Value / urgency /
deadline / initiative membership legitimately live upstream in the ticket
system. The *ranking function* stays local, because a wholesale offload caps you
at the weakest adapter's fidelity, discards the agent-computed job-size estimate
(pelaggio's edge over a human PM staring at a backlog), forecloses portfolio-
level sequencing the ticket system cannot express, and — worst under autonomy —
depends on human backlog grooming that no one is doing overnight. Offload the
data; keep the verdict. Readiness is therefore a *computed* FlowPolicy verdict, not a
human-groomed Definition-of-Ready gate, and spec defects are caught at runtime by
produce-or-escalate (Andon) rather than an upstream gate — see
[ADR-0011](../decisions/0011-andon-not-dor.md) and [ADR-0012](../decisions/0012-readiness-computed-not-groomed.md).

## Signals and the projection (planned)

The genuinely local signals — the ones the ticket system structurally cannot
give you — are **job-size** (agent-computed, quantized to XS–XL, *sticky*:
computed at plan-time and cached, never recomputed per-pick or the ranking
thrashes), the **dependency graph** (edges are upstream free-text `deps`; the
local value is the reasoning — unblocking-value, critical path, cycle
detection), and an **aging clock**.

These are not a new store. The projection folds a **purpose-built flow-event
log** (`#170`). pelaggio today writes only a *cycle-outcome summary*
(`.dev/pelaggio-log.jsonl`, one terminal line per cycle), **not** the transition
log this needs; #170 adds `.dev/flow-events/` (one append-only segment file per
writer process) as *separate* storage sharing one envelope and one reader library
with the summary log. The memory hierarchy:

```
L1  in-memory projection      this process's read-model, folded on startup
L2  .dev/flow-events/         this machine's transition history (per-writer segments)
    .dev/pelaggio-log.jsonl   the cycle-log; gitignored, ephemeral, local-only
L3  the ticket system         durable, portable, shared — via write-back
```

**Two populations, opposite storage rules** (full #170 spec:
[`flow-event-catalog.md`](./flow-event-catalog.md)): *current-state* fields
(readiness, live WIP, `lifecycleState`) are non-authoritative and reconciled from
git/provider on read — much of it derivable today with no events at all;
*historical/time-series* fields (lead/cycle time, flow efficiency, aging) are
authoritative in the append-log and must be carried by **fat, self-contained**
events, because the transition being measured mutates or deletes its own join
target (ship deletes the `feat/<id>` branch, so "claimed-at" is unrecoverable
later).

There is **no persisted L1.5 ledger file.** Building one re-imports every
problem the append-only log does not have (cache invalidation, drift, and — in a
worktree world — a "which copy wins" merge-conflict magnet). The durable version
of flow memory already has a home at L3, which is why **write-back is the durable
telemetry** — telemetry-out and write-back are one mechanism seen from both ends.

Correctness rules for the projection:

- **Non-authoritative for current state.** git (branch exists ⇒ in-progress) and
  the provider (closed ⇒ done) are ground truth for claim/done; the projection's
  *current-state* fields are a cache, rebuildable from git + provider at any time.
  Its *historical metrics* are the opposite — authoritative in the append-log and
  NOT rebuildable by join (the measured transition deletes its own join target),
  so those events must be fat and self-contained. Either way the projection is
  never the git-native claims registry the invariants forbid.
- **Reconcile on startup.** A cycle that dies mid-transition leaves a dangling
  state; reconcile against ground truth, ground truth wins. Never diverge
  silently.
- **Workers append, orchestrator folds.** Workers only emit append-only events
  (safe, matches today); the single orchestrator materializes the projection and
  owns write-back. No worker write-contention, respects worktree isolation.
- **Aging runs on logical/active time, not wall-clock** — a rate-limit park
  ages items through no fault of their own, and infinite aging-boost is a
  pathology (a should-die item floats to the top by waiting). Aging *flags for
  attention* (a write-back), it does not auto-promote past everything.
- **Bounded log growth.** The log is append-only and unbounded; startup fold
  cost grows with it. Snapshot the projection periodically as a pure cache
  (rebuild from snapshot + tail) or rotate — the snapshot is an optimization,
  never truth.
- **Versioned envelope, tolerant reader.** One envelope version now; per-event-
  type `schemaVersion` is deferred until an event actually diverges (the tolerant
  reader makes that non-breaking). The reader skips unknown types *with a
  diagnostic* — never silently — and back-compatibly reads untyped legacy cycle
  records so existing `/stats` history never vanishes.
- **Identity, not a global clock.** Events carry a unique `eventId` and a
  writer-local `(streamId, seq)`; `seq` is never globally monotonic (the server
  spawns one process per run against one repo log). `claimId` is delivery
  identity; `executionId` is per-process. See the catalog for the full contract.

Starting taxonomy for the first item to refine (not a frozen API): events
`became-ready`, `claimed`, `plan-published`, `plan-rejected`, `shakedown-fail`,
`suspended`/`resumed` (paired, with a typed reason), `in-review`,
`blocked-discovered`, `claim-released`, `shipped`. Per-item projection record:
`lifecycleState`, `firstReadyAt` (logical), `agingTicks`, outcome counts
(`parks`, `shakedownFails`, `planRejections`), and `jobSize` (sticky, plan-time).
The envelope, identity/ordering contract, fat-vs-derive split, emission model,
and extension seam are the load-bearing #170 spec in
[`flow-event-catalog.md`](./flow-event-catalog.md); this is only its starting
event list.

The single-orchestrator model makes projection reads in-process and serialized —
no distributed-consistency problem. If `packages/server` ever fans out multiple
orchestrators, the read-model becomes a distributed concern and *that* is where a
real store (e.g. SQLite) earns its place. It is a server concern, downstream, and
must not drive the core primitive.

## Write-back (planned)

Write-back is how outcomes reach durable memory and how stalled work escalates:
outcome feedback ("harder than the ticket thought"), aging escalation,
discovered dependencies, estimate correction, and lifecycle transitions
(`In-Review`, `Blocked-discovered`) the adapters do not surface today. Only one
write-back exists now — shakedown's `deferred` `createItem`.

Constraints:

- **Typed and item-scoped.** A narrow `annotate(id, {...})` vocabulary, never
  free-form tracker mutation. An LLM drives write-back and it reads untrusted
  issue bodies (already injected into plan prompts), so a poisoned issue must not
  be able to steer cross-item mutations ("close all other issues"). Least
  privilege by construction.
- **Off the hot path.** Network mutation to GH/Linear is async, best-effort,
  bounded, failures swallowed with one warning — mirror the existing `notify`
  webhook. It adds latency, a failure dependency, and rate-limit surface
  otherwise.
- **Idempotent — fire on state *transition*, not every evaluation.** Reuse the
  revise-sweep pattern: mark-before-act, filter-marked, one handoff comment.
- **Projection-tolerant.** Each adapter maps `annotate` onto native (Linear:
  field/comment; GitHub: label+comment; markdown: a committed sidecar, since a
  doc cannot hold structured flow metadata). No-op where unsupported — the same
  discipline as reads. The committed sidecar is markdown's portable L3.
- Re-hydrated values are advisory and clamped, never trusted verbatim.

## Concurrency: from bandaids to a provable strategy (planned)

Conflict risk splits into two classes with *different* answers:

| Class | Example | Predictable? | Treatment |
|---|---|---|---|
| **Write-write** | Two cycles edit the same lines | Yes — statically, pre-implementation | *Prevent* by scheduling disjoint write-sets |
| **Read-write (semantic)** | A changes an interface B depends on, disjoint files | No — only integration + verify settles it | *Detect* via a verified landing queue |

**Tier 1 — declared, enforced write-sets (prevents write-write).** The plan
already implicitly enumerates the files it will change. Promote that to a
declared write-set *contract*: the plan states the paths it writes, the worktree
write-guard enforces it, and the scheduler refuses to co-schedule cycles with
intersecting declarations. Disjoint parallelism is then *provably* free of merge
conflicts — declared-and-enforced, not predicted-and-hoped (the sound version of
an effect system: declare and check, do not infer). The enforced guard doubles
as a capability boundary that shrinks a confused agent's blast radius — but it is
git-write confinement, not process confinement, so defense-in-depth, not a
sandbox.

Soundness rides on the plan step, which is an LLM. Under-declare + enforce →
`implement` blocks and churns; under-declare + no enforce → unsound. The release
valve is **write-set amendment**: `implement` may re-acquire more paths mid-
flight — a lock upgrade re-checked against in-flight cycles that yields/reparks
on conflict. Tractable, not free.

**Tier 2 — an explicit verified landing queue (detects read-write).** Read-write
hazards are unpreventable by scheduling (read-sets are unbounded — B reads half
the codebase transitively). They must be *detected* by verifying each candidate
against the real post-merge state before it lands. **`ship` is *not* already this
queue** — that claim, made in earlier revisions of this doc, was false and is
corrected by [ADR-0025](../decisions/0025-landing-serialization-cas-fence-optional-ordering.md):
there is no harness land mutex, the merge is performed by the model inside the one
shared `MAIN_REPO` checkout (`ship/direct-push.ts:8`, `roadmap/git-claim.ts:73`),
the post-pull `verify` hook is unset in production (`pipeline.ts:1786`), and
`verifyShipLanded` accepts any advance of `main` so a sibling's merge satisfies
another worker's phantom-ship gate (`helpers.ts:1109-1112`). Tier 1 still lightens
Tier 2's load: disjoint write-sets mean the queue rarely bounces on text and can
spend verify budget on semantic hazards.

**The landing queue is target-agnostic and defers to the provider's merge queue
in PR mode.** In `pull-request` / `auto-merge-pr`, the provider's merge queue is
the landing queue WHERE ONE IS ENABLED — speculative verified landing already
exists; do not rebuild it. Where no provider queue is enabled, admission is the
ADR-0025 lattice (required checks + the harness CAS fence for any direct write).
pelaggio owns a landing queue only for `direct-push`. The queue sits *above* the
`ship.target` seam. Same leverage principle as storage and initiatives.

**Substrate (amended by [ADR-0025](../decisions/0025-landing-serialization-cas-fence-optional-ordering.md)
— the landing half of the Beads decision is demoted from *mechanism* to
*optimization*; the work-store half, #181, is untouched).** The exclusive-access
primitive for `direct-push` is **git ref compare-and-swap**, built in the harness
and always available: verification bound to the exact candidate SHA; before the
push the executor independently requires the observed SHA to be an ancestor of the
candidate (the lease fences lost updates, not ancestry); then an explicit
`--force-with-lease=main:<observed-sha>` (never the implicit form, which
compares a remote-tracking ref a background fetch can advance). `bd merge-slot`
remains available as an **optional ordering layer above** that fence — an atomic
exclusive slot (spike-proven: exactly one winner under an 8-way simultaneous
acquire) with a typed contract (`exit 1` + `{"acquired":false,"holder":…}`) and a
waiter list, over which pelaggio owns the policy Beads omits: fair ordering (release
does not hand off; the orchestrator polls `check`, picks the next waiter,
re-acquires), waiter-list hygiene (re-acquire does not self-remove), and
dead-holder reconcile. It never *replaces* the CAS fence, because a slot orders
pelaggio's own workers without fencing an external pusher. Availability is a
**positive typed-output probe**: the `@beads/bd` npm wrapper exits 0 while printing
"binary not found", so exit status fails open. **Load-bearing constraint when it is
used:** the slot must live in one shared `MAIN_REPO/.beads`; per-worktree `.beads`
copies are eventual-consistent via `refs/dolt/data` and cannot back it. PR-mode
deferral to the provider (`bd gate`, `--type=gh:pr` / `--type=gh:run`) is unchanged.

**Landing mechanism (ADR-0025 detail).** Three layers with distinct jobs: the CAS
fence above (mandatory, fail-closed); an optional local-file-lock **contention
reducer** taken before merge+verify, whose `staleMs` must exceed a worst-case
attempt rather than the roadmap lock's 120 s, and which is **fail-closed** for
dependency-changing landings because the fence protects the ref but not the
verification environment (worktree `node_modules` symlink into `MAIN_REPO` and
lockfile-touching merges install there — `worktree-deps.ts`, `ship/SKILL.md:114`);
and optional `bd merge-slot` ordering. The seam is an executor,
`land(attempt) → Landed | Contended`, not a lock: CAS is optimistic (the fence is
the rejected push at the end) while a slot is pessimistic, so no acquire/release
contract spans both.

Each attempt integrates in a **dedicated detached-HEAD worktree** cut from the
observed remote SHA — two worktrees cannot both check out `main`, and integration
must leave the shared checkout. After a confirmed push, `MAIN_REPO`'s `main` is
fast-forwarded to the landed SHA (`--ff-only`, idempotent, under the reducer);
failure there warns rather than contending, but ownership cannot be implicit because
claims are cut from that literal ref and a stale checkout misleads the operator
(`pipeline.ts:783-787`).

A receipt `(item, attempt, observedBase, candidateSha)` is persisted **before** the
push and confirmed with `landedSha` on success. Receipts follow ADR-0025 §8's trust
model: harness-issued and harness-stored outside any model-writable worktree,
validated fail-closed on read (typed challenge/content binding as in
`execution-receipt.ts`), and never sufficient alone — `Landed` additionally requires
the recorded candidate to descend from the recorded `observedBase` and be confirmed
against the actual remote, rejecting records that name a pre-existing `main` commit.
Before each attempt the remote is re-read: if a **validated** receipt's candidate
SHA is already an ancestor of remote `main`, the attempt returns `Landed` and runs
the idempotent write-back — an ambiguous push outcome must never be re-merged onto a
base containing its own merge. Reconciliation on
startup/resume follows the same rule; a claim with no landed SHA on the remote is
retained for retry. Where a `RoadmapSource` produces commits (`MarkdownRoadmap`'s
`markDone`/`archivePlan`) they are **staged into the candidate before verification**
(the executor invokes them against the attempt worktree while building the
candidate — ADR-0025 §8), so they land atomically with the work and no unverified
second push exists; an adapter without the staging seam terminates `Contended`
rather than pushing unverified commits. API-backed sources write back after
confirmed landing.

**Why the retry ladder is shaped this way.** Measured on this repo: a full verify is
~195 s (median of 14 `ci.yml` runs — CI wall time used as a proxy for a local
post-merge verify) and cycle wall time ~26 min (median of 61 cycle-log gaps), so a
~4-minute landing window is ~15% occupancy per worker and at `--parallel 3` about
28% of landings lose a race. Three bounded attempts put worst-case give-up near
`0.285³ ≈ 2%` — a floor, not an estimate, since a loser re-enters synchronised with
the winner's release. Serialized landing consumes ~45% of one lane at N=3 and
saturates near N=6–7, so ordering is affordable and retry policy is what matters.
A clean re-merge with passing verification retries mechanically; a merge conflict or
verification failure is a judgment act (`ship/SKILL.md:110`, `:116`) and terminates
as `Contended`, routed to the existing `shipwreck`-style action — `Step` already
admits non-`STEPS` actions (`config.ts:53`), so `STEPS` stays the fixed six.

**Admission placement.** Landing admission is *run-scoped*, resolved before workers
start, reusing `ship/ci-guard.ts`'s fail-closed forge-read helpers. It does not
belong on `ShipTarget` (`types.ts:410-414` is a prompt/parse seam with no I/O), on
the provider-capability registry (`CapabilityAxis = keyof ProviderCapabilities`,
`types.ts:363`, describes drivers), or on `effects.ts`'s `ship.ShipDecision` (which
rejects `direct-push` outright and runs after the ship step). The lattice is trigger
(`pelaggio | provider | human | no-forge`) × ordering (`queue | latest-base |
pelaggio-serial | unordered`) against evidence (`readable | unreadable |
unsupported`); `latest-base` is admitted only where up-to-date is enforced
server-side at merge time **and** no bypass is in use (`enforce_admins: false` is
one; so is `land-cli.ts`'s opt-in `gh pr merge --admin`, which checks CI-green but
not base freshness). A successful read showing enforcement off is `unordered`, not
`unreadable`. The `provider`+`unordered` cap is evaluated per enqueue against a
harness-held in-flight count, never a forge poll.

**Prior art / reference design.** Gastown (`gt`), the sibling orchestrator on the
`bd` substrate, already ships this as its **Refinery**: a Bors-style
batch-then-bisect merge queue that rebases each MR onto latest main, runs
validation, merges when clear, and re-implements on conflict. pelaggio builds its
own landing discipline above the harness CAS fence (ADR-0025; `bd merge-slot` only
as optional ordering) rather than adopting `gt` (an all-or-nothing town), but the
Refinery + `gt done` (submit → notify → sync) + `gt mq` (ordered queue, `next` =
highest priority) are the design to mirror. Note the divergence that is *ours*:
Gastown handles conflicts **reactively** (Refinery re-implements); pelaggio adds
Tier-1 **prevention** via declared write-sets (#173) so intersecting work is never
co-scheduled. See `coordination-spine.md` (*Gastown: the sibling orchestrator*).

**Shared-by-construction files need an escape hatch.** This is a pnpm monorepo,
so `pnpm-lock.yaml` and generated/formatted files are touched by genuinely
disjoint feature cycles. They cannot be feature-owned in a write-set: give them a
shared-write allowlist whose members are serialized / regenerated deterministically
at the landing queue, not treated as a write-write conflict.

**The impossibility, stated plainly.** You cannot have both maximal parallelism
*and* a provably green trunk without either full read/write-set declaration
(impractical) or serialized verified integration (throughput-bound). This is the
isolation-level tradeoff. The autonomous setting biases toward *stronger*
isolation than a human team, counter to intuition: a red trunk poisons every
in-flight snapshot — each concurrent cycle branched off broken `main` inherits
the breakage — and agents cannot route around it the way humans do socially. The
blast radius is amplified and the immune system is absent, so the integration
gate should be *stricter* under automation, not looser.

## Non-goals / rejected alternatives

These were considered and rejected. They will be proposed again; the reasons are
here so they do not have to be re-litigated.

- **Composable / hierarchical `RoadmapItem` (parent-child, initiative objects).**
  Raises the LCD floor across all adapters and reimplements containment Linear
  and GitHub give natively. Use the swimlane/`group` projection instead.
- **A persisted flow-ledger store (file or DB) as the core primitive.** The
  projection is in-memory over the event log; durable memory is L3 (write-back).
  A store is a `packages/server` multi-orchestrator concern only.
- **Offloading the ranking *decision* to the ticket system.** Offload the inputs;
  keep the verdict local. Wholesale offload caps fidelity at the weakest adapter,
  drops agent job-size, forecloses portfolio sequencing, and depends on grooming
  no one does under autonomy.
- **Sprints / iterations / velocity / estimation-for-capacity / standup.** Pure
  human-coordination artifacts. Continuous flow replaces them.
- **Rebuilding a merge queue in PR mode.** Defer to the provider's.
- **Pessimistic locking of code regions.** Wrong granularity (contention is
  files/symbols, not work-items); coarse grain kills parallelism, fine grain
  deadlocks. Long-lived feature branches are exactly this, and are miserable.
- **Full read/write-set declaration for serializability.** Read-sets are
  unbounded. Prevent write-write statically; detect read-write at the queue.

## Invariants (mirror to AGENTS.md)

- Flow projection is a non-authoritative read-model for *current state* (git +
  provider are ground truth for claim/done, rebuildable, never a claims registry);
  its *historical metrics* are authoritative in the append-log and carried by fat,
  self-contained events — never re-derived by joining mutable git/provider.
- Flow-event identity is a unique `eventId` plus writer-local `(streamId, seq)`;
  `seq` is never globally monotonic. `claimId` is delivery identity,
  `readinessEpisodeId` correlates the pre-claim readiness window, `executionId` is
  per-process. Events emit harness-side by three producers — effect-confirmed
  (manifest-sourced), git-mutation (intent/confirmation bracket), and derived
  (readiness-diff) — never from "the step completed."
- Flow events live under `.dev/flow-events/` as one segment per writer process
  (single-writer-per-file, no shared-file concurrent append), separate from the
  cycle-log, sharing one envelope + reader library; they are local-only telemetry;
  `type` is namespaced (`pelaggio.*` closed/core-validated, consumer events
  vendor-prefixed and schema-registered), and the reader is tolerant-with-diagnostic,
  never silent. Full spec: `docs/agent-context/flow-event-catalog.md`.
- `FlowPolicy` is provider-neutral: strategies see a snapshot, not storage.
  Storage leverages the provider; policy is pelaggio's.
- An initiative is a projected swimlane/`group`, never a pelaggio-owned object.
- Write-back is typed and item-scoped; agents never issue free-form tracker
  mutations, and it runs off the hot path (async, best-effort, idempotent).
- Declared write-sets are enforced by the worktree write-guard; the scheduler
  will not co-schedule intersecting write-sets.
- The landing queue is target-agnostic and defers to the provider's merge queue
  in PR mode; pelaggio owns integration ordering only for `direct-push`, where the
  exclusive-access primitive is **git ref compare-and-swap** in the harness
  (verification bound to the candidate SHA; explicit `--force-with-lease`).
  `bd merge-slot` is an **optional ordering layer above** that fence, never a
  replacement, gated on a positive typed-output probe; when used, the slot lives in
  one shared `MAIN_REPO/.beads` and pelaggio owns ordering + waiter-hygiene +
  dead-holder reconcile. Amended by
  [ADR-0025](../decisions/0025-landing-serialization-cas-fence-optional-ordering.md).
