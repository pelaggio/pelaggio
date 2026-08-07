# Guarded actions: a fencing/reconciliation model for pelaggio's locks and gates

Status: design exploration, pre-decision. v3, revised across two provider-diverse review
passes (see the revision log). Verified against `4a6ac3c` unless noted.

**Scope of confidence.** These parts are not equally settled, and the review passes made
that split visible rather than closing it:

- **§1–§4 (diagnosis, rule, guard classification) are the load-bearing claim.** They
  survived both passes essentially intact; the corrections were to counts and attributions,
  never to the argument. If only one thing is taken from this document, take the audit.
- **§5–§10 (primitives, lifecycles, gate, sequencing) were design directions.** Both passes
  found real defects there, sharper in pass 2 because they were grounded in code the design
  had not been checked against (`blockForeignRootWrite`'s denied-root set; `softened`'s
  absence from the merge-gate path; `error_diff`'s zero-cell failure).

**Superseded in part by [ADR-0026](../decisions/0026-stateful-guards-fence-reconcile-and-gate-disposition.md).**
Those sections have since been decided. Where this document and ADR-0026 differ, **the ADR
governs** — it carries later corrections (the disposition allowlist as two columns rather
than one; `clearedBy` naming an actor on every blocking variant; the minimum shippable unit
including attempt identity; the precise `blockForeignRootWrite` residual). This document
remains the evidence base, the full guard audit, and the §8 new-guard checklist. Its earlier
recommendation of "an ADR per primitive" was **not** taken, deliberately: the primitives are
not independently decidable, and ADR-0026 records why.

## 1. The complaint, stated precisely

Locking and fail-closed gating in pelaggio are not converging. Each new failure mode
produces a bespoke guard; each bespoke guard adds a blocking edge; the blocked
population grows faster than the hazard population shrinks. Discovery is finding real
defects, but the defects are instances of a small number of shapes we have never
named, so we pay full price for each one and bank no leverage.

Evidence, measured:

- 74 of the last 400 commits are `fix:` (`git log -400 --pretty=%s | grep -cE "^fix[:(]"`). The lock/gate/race/park/claim/land cluster is
  the single largest theme in them (`fail closed when the PR review gate step itself
  errors`, `claim git-authoritatively before GitHub write-back`, `retain claim branch
  when mark-done fails`, `guard repairMainNodeModules's pnpm install with a
  cross-process lock`, `exempt concurrent peer worktrees from confinement snapshots`,
  `fail closed when captureShipState returns null`, …).
- "fail-closed" appears at 57 sites across 24 non-test source files
  (`grep -rn "fail-closed\|fail closed\|failClosed" packages/pelaggio/scripts/pelaggio
  --include=*.ts | grep -v __tests__`; hyphen-only gives 38/21, the broadest
  case-insensitive variant 87/27). There is no shared type, no shared disposition, and no
  shared clearing contract behind any of them.
- Open issues in this exact cluster: #401, #402, #435, #439, #444, #445, #450, #451,
  #453, #455, #460, #461, plus the planned-but-unbuilt #409/#410 admission work.
- The cost is measurable, not theoretical. #453: *"6 open PRs hold ~$260 of stranded
  work-in-progress"* — created by a fail-closed edge with no release edge.

ADR-0025 is the counter-example that proves the point: it is a genuinely good piece of
design, and it is scoped to exactly one action (landing). Nothing in it generalizes,
because we never wrote down what class of thing landing *is*.

## 2. Diagnosis: three conflations

Every defect in the cluster is an instance of one of three conflations. None is a
coding error; all three are modeling errors.

### 2.1 A check is not a hold (predicate/reservation)

We repeatedly write `if (allowed) { act }` against state held by another authority and
call the `if` a guard. It is not — nothing prevents a peer from passing the same check
before we act.

- `canRetryWithinBudget` (`helpers.ts`) is a pure predicate: `maxBudget - spent >=
  stepBudget`. Two `--parallel` workers both pass. `review/loop.ts`'s `phaseReservation`
  has the same shape. Accrual is post-hoc at four sites, so admission is decided against
  stale spend (#402).
- `verifyShipLanded` (`helpers.ts`) answers "did my ship land?" with "did
  `main` move?" A sibling's merge satisfies another worker's gate (#401).
- `createClaimWorkspace` pre-checks `branchExists` then runs `worktree add -b`. This one
  is sound — git's ref creation is atomic, so the race is resolved by the authority, not
  by the pre-check, and `git-claim.ts` says so explicitly ("git's own ref locking makes
  creation atomic"). What is missing is not that note but the *general rule* it is an
  instance of: nothing tells the next author that this is the property their guard needs,
  so the same shape gets rewritten without it.

### 2.2 An attempt marker is not an outcome marker (at-most-once/at-least-once)

We mark intent and read it as completion.

- `claimRevision` adds `autopilot:revised` *before* revision work, so a crash or park
  burns the entitlement without a revision ever running. `findRevisablePrs` partitions on
  label presence, so the PR is permanently stranded (#453). The issue is exact about the
  naming: *"A GitHub label has no CAS, no holder, and no TTL. Calling this a 'lease'
  would be a naming lie."*
- A resumed cycle reuses the prior attempt's `runId`, so a superseded attempt's execution
  receipts collide with the live one's (#451).
- Resume reconstructs "where am I" from filesystem heuristics (`detectResumeStep`) rather
  than persisted attempt state, so a park at a review hard-block resumes straight to ship
  and skips the blocking findings (#450).

### 2.3 "Cannot evaluate" is not "evaluated as bad" (verdict/evidence)

This is the fail-closed complaint proper, and it is the most expensive of the three.

A gate outcome has two orthogonal axes: the **judgment** about the artifact
(`pass | block`) and the **completeness of the evaluation** (`complete | partial |
unavailable`, §7). We collapse them into one bit.

- `doc-review-cli.ts`: `PASS_OUTCOMES` = {converged-clean, converged-with-notes,
  ceiling}; *everything else* exits 1. A crash, a rate-limit park, and a genuine
  hard-block are the same exit code.
- `pr-review-cli.ts` is further along — it has `failureKind` ("Distinguishes
  infrastructure failure from a model findings block") and a `park` disposition. But
  `failureKind: "infra"` still yields `effectiveVerdict: "block"`, and
  `buildFailClosedComment` posts `gate: "block"`. The distinction reaches *agreement*
  computation and stops there; it never reaches disposition. Only rate-limit escapes,
  via a special case.
- The consequence is in our own config, in writing: *"this is fail-closed, so an
  exhausted grok Build balance blocks every PR — a 402 surfaces as `block (infra)`, not a
  real finding"* (`.pelaggio.yml`, on the `pr-review` pool). #455 confirms the 402 does
  not even match the shared rate-limit regex, so it is not parked either.

Fail-closed is correct for "the artifact might be bad." It is a category error for "we
could not look." Applying it to the second case converts every provider incident into
permanently stranded PRs and burned entitlements.

## 3. The load-bearing rule

One sentence, and everything else follows from it:

> **Every guarded action must be either *fenced* — the authority that owns the state
> rejects a stale actor — or *reconciled* — the effect is idempotent and a converging
> observer repairs drift. An action that is neither is a *hint*, and a hint may reduce
> contention but must never be load-bearing for correctness.**

This is not new theory (it is the fencing-token argument), but we have never applied it
as an audit. Applied, it makes the work finite: every guard in the codebase sorts into
exactly one of the four classes in §4, and each has a known remedy.

## 4. The map: classifying what we already have

The audit sorts every guard into **four** classes, not three. The fourth was missed in
the first draft and is the one that fails silently.

**Derived exclusivity** — an action is safe because its target is uniquely owned by a
*fenced* claim (a worktree path is a total function of `feat/<id>`). This is sound, and
it is not a hint. But it is sound only under three conditions: (a) the deriving claim is
fenced, (b) the target is a total function of the claim, (c) liveness is verified before
any reuse or destruction. #435 is exactly a (b) violation: `pick` runs with
`cwd=MAIN_REPO`, which is derived from no claim at all — so the premise fails before (b) is
reached, `blockForeignRootWrite` permits main-tree mutation, and the audit only trips
later, in a different cycle.

| Guard | Authority | Class | Status |
|---|---|---|---|
| `git push --force-with-lease=main:<sha>` (ADR-0025) | git ref | **fenced** | correct, unbuilt |
| `gh pr merge --match-head-commit <oid>` (applied in `land-cli.ts`; `ci-guard.ts` supplies the verified head) | GitHub | **fenced** | correct, built |
| `feat/<id>` branch creation (`git-claim.ts`) | git ref | **fenced** | correct — by accident, undocumented |
| execution receipts (content/challenge-bound) | harness | **fenced** | correct |
| worktree writes under `blockForeignRootWrite` | derived from claim | **derived-exclusive** | sound in worktrees; broken for `cwd=MAIN_REPO` steps (#435) |
| review-request queue (`review-request-queue.ts`) | filesystem | **reconciled** | correct — our one real reconciler |
| `withFileLock` / `withMutationLock` | none | **hint** | correctly labelled a "contention reducer" in ADR-0025; used as a lock in `worktree-deps` and roadmap RMW |
| `autopilot:revised` label | none | **hint** | load-bearing → #453 |
| `canRetryWithinBudget`, `phaseReservation` | none | **hint** | load-bearing → #402 |
| `verifyShipLanded` (SHA-advanced branch) | none | **neither** | wrong predicate → #401 |
| PR-merge observation (PR mode) | GitHub | **missing** | no observer at all → #444 |
| claim liveness for destructive reap | none | **missing** | → #461 |

Two things fall out.

**`review-request-queue.ts` is the template.** It already has every property the rest of
the system lacks: an idempotency key `(prNumber, headSha)`; a claim protocol (atomic
rename to `.claimed`); a crash protocol (reclaim after `REVIEW_CLAIM_STALE_MS`); a
rollback edge (rename back on park); and — critically — *"Record completion always
requires a POSITIVE terminal check … never 'absent from the forge listing'."* That
docstring is the whole design, written once, for one queue, never generalized.

**The file lock is not the problem.** `file-lock.ts` is careful and honest about its
residual. The problem is that it is the only mutual-exclusion noun we have, so it gets
reached for where a fence or a reconciler is required. `withFileLock`/`tryWithFileLock` have five
direct call sites, but `withMutationLock` layers eleven more on top (`decisions.ts` x4,
`roadmap/markdown.ts` x3, `roadmap/stale-quarantine.ts` x3, `ship/bookkeeping.ts` x1), so
the migration surface is sixteen. In `worktree-deps` and every `withMutationLock` site the
*protected* mutation (a shared `pnpm install`; a file RMW plus git commit) is unfenced. You cannot fix this inside
`file-lock.ts`.

## 5. The missing primitives

**P1 — Fence.** `fence(authority, observedToken, action)`. The action is submitted *with*
the token to the authority owning the state; the authority rejects it if the token is
stale. Not a lock: no `acquire()`, optimistic. Instances: ref CAS,
`--match-head-commit`, receipt content-binding, conditional writes with `If-Match`.
ADR-0025's `land(attempt) → Landed | Contended` is the shape, generalized.

**P2 — Quota (divisible, refundable).** Reserve/settle/refund-unused over a *divisible*
resource: dollars. `reserve` debits atomically and returns a handle; on completion the
handle settles **observed** spend and refunds only the unused remainder. This matters for
the failure path specifically: an evaluation that ends `unavailable` may still have
billed real tokens before dying, so "release the whole reservation" is wrong. Adopter:
#402.

**P3 — Token (indivisible, one-shot).** A single-use entitlement with *distinct
pre-work and post-work semantics*: aborting before the work starts **releases** the
token; failing after the work has begun **consumes** it. Adopter: #453, whose own text
warns that releasing on any non-completion reintroduces the double-revision hazard.

P2 and P3 were one primitive in the first draft. They are not: dollars are divisible and
refundable, a revision entitlement is neither, and their failure semantics are opposite.

**P4 — Attempt identity.** A monotonic `(itemId, attemptSeq)` from an **authoritative
atomic allocator**. Three properties are required; the first draft had only the first,
and the second is what makes the allocator trustworthy rather than merely atomic:

1. *Allocation is atomic* — concurrent resumptions cannot mint the same sequence.
2. *The allocator lives in a harness-owned, agent-denied register.* An O_EXCL create in a
   generic `.dev/` path gives atomicity but **not authority**: `blockForeignRootWrite`
   denies agent writes only under `MAIN_REPO/.dev/sessions/` and `docs/decision-log/`, so
   anywhere else the very agent being fenced can unlink or forge the sequence. The
   allocator must join that denied set, on the same footing as session records.
3. *Every effect consumer fences against the current attempt, at the authority.*
   Carrying identity into artifact paths only stops collisions. Inertness requires an
   authority-bound current-attempt compare-and-swap — a superseded attempt must be
   rejected by receipts, ship, write-back and status-posting, not by asking the attempt to
   validate itself. Self-validation is not fencing: an old attempt passes its own check, a
   newer sequence is then allocated, and the old actor still posts.

Adopters: #451, #450, #458.

**P5 — Reconciler.** A converging observer over declared-vs-actual, for every transition
that happens off-process. Contract, generalized from the review queue: idempotency key;
claim-with-crash-reclaim; positive terminal check only; rollback edge. The set needing
one is enumerable today: PR merged (#444), CI completed, review backlog across
day-budget rollover (#460), confinement sessions expired (#439), worktrees/claims
reapable (#444/#461), **and gate retry after `indeterminate` (§7)**.

**P6 — Liveness.** One trustworthy reader destructive operations may rely on: record
identity + pid + start-time (PID-reuse resistant) + heartbeat + expiry. #461 scopes this
correctly and states why the existing `SessionRecord` disclaimer ("diagnostic
corroboration only") cannot be quietly upgraded: it is sound for audit, where a wrong
answer degrades a report, and unsound for reap, where a wrong answer deletes work.

## 6. Lifecycles: what is, and is not, terminal

One big FSM over "the cycle" would be wrong — it would re-encode `STEPS` and touch none
of the three conflations. The right shape is several small per-resource lifecycles.

The first draft's rule ("no terminal state without an outgoing recovery edge") was
incoherent: `completed`, `committed` and `released` are terminal and *should* have no
recovery edge, while `parked` is terminal yet `--resume` plainly leaves it. The rule has
to distinguish two kinds of absorbing state:

- **Absorbing-with-progress** — the resource's purpose was discharged. `completed`,
  `committed`, `released`, `Landed`. Also `superseded` and `abandoned`: the *attempt* is
  over, but the item-level lifecycle continues, so progress is not withheld.
- **Absorbing-without-progress** — the resource is stuck and something is being withheld.
  `blocked`, `parked`, `Contended`, `indeterminate`, `reapable`, and P3 `consumed`.

> **Invariant: every absorbing-without-progress state must name its clearing transition
> and the actor authorized to fire it.** No such state may exist without both.

That is the constraint that would have prevented #453 and #460. It says nothing about
completion states, which is why the first draft's version did not survive contact.

The lifecycles:

- **Attempt**: `created → running → { completed | parked(cause) | superseded | abandoned }`.
  `parked` is absorbing-without-progress → clearing transition `resume`, actor `harness | human`.
- **Claim** (`feat/<id>`): `unclaimed → claimed(attempt) → { released | reapable }`.
  `reapable` clears by `reap`, actor `harness` (via `/tidy`, actor `human`), **gated on a
  P6 liveness verdict** — the liveness check is its precondition, not its clearing edge.
- **Landing**: ADR-0025's `attempt → Landed | Contended`; `Contended` clears by `retry`,
  actor `harness`, claim retained.
- **Entitlement**: P2 `available → reserved → { settled | refunded }`; P3
  `available → held → { released | consumed }`. `consumed` after a *post-work* failure
  withholds progress — it is #453's stranded-PR state — and clears by
  `grant-additional-entitlement`, actor `human`. Without that edge P3 reproduces the
  defect it exists to fix.
- **Gate evaluation**: §7. `block` clears by `new-head-sha`, actor `harness | human`;
  `indeterminate` by `retry`, actor per §7.3.

## 7. The gate: separating judgment from disposition

The first draft mapped a model `verdict: pass` directly to `merge`. That violates
ADR-0014, whose whole point is that the LLM is a *policy input* and the blocking gate is
deterministic. The corrected shape names the two layers separately:

```
// Policy input — model output. Never consulted directly by the merge path.
Judgment = { seat: SeatId, judgment: "pass" | "block", rationale: string }

// Harness fact — how much of the required (driver × label) matrix returned
// a VALID result. Nothing to do with provider diversity.
Evidence  = "complete" | "partial" | "unavailable"

// Deterministic function of (judgments, evidence, diversityStatus, config).
// This is the only thing the merge path reads.
type Disposition =
  | { kind: "merge" }
  | { kind: "block";         reason: BlockReason;      clearedBy: ClearingTransition }
  | { kind: "indeterminate"; cause: UnavailableCause;  clearedBy: ClearingTransition;
                             retryActor: RetryActor;   attemptsRemaining: number }
```

`merge` carries no clearing transition (it is progress). `block` and `indeterminate` both
*require* one — a discriminated union, so the §6 invariant is enforced by the compiler
rather than by an optional field every call site can fill with a stub.

### 7.1 Evidence is not diversity

The first draft equated `evidence: degraded` with `DiversityStatus.softened` and let that
cell merge. Both halves were wrong.

- `softened` is a **complete** evaluation under weaker configured diversity. It is a
  *policy posture*, not missing evidence. Auto-merging it universally bypasses
  `provider-diversity: require`, which this repo sets — and hard-coding that disposition
  would itself violate ADR-0014's policy-as-data requirement.
- An **incomplete matrix** is not `degraded`; it is `partial` or `unavailable`, and which
  one it is depends on *why* cells are missing.

So diversity does not appear on the evidence axis at all. It enters the deterministic
function as configuration, and `provider-diversity: require` + `softened` should resolve
to `block`, not `merge`.

**This is a prerequisite, not a description.** `DiversityStatus.softened` exists only in
`review/loop.ts` — the authoring/doc-review path — and `pr-review-cli.ts` does not import
it; the merge gate's `provider-diversity: require` is a binary preflight with no softened
state. Plumbing realized diversity onto the merge-gate path is therefore work this design
*requires*, and until it exists the rule above is unimplementable there.

### 7.2 `unavailable` is an allowlist, never a default

Today's `failureKind: "infra"` is much broader than "we could not look." It also covers
parse-invalid (ADR-0004), security-diff failure, budget refusal, and provider-diversity
config errors. Reclassifying `infra` wholesale to `indeterminate` would reopen genuine
fail-closed merge paths — the single most dangerous idea in the first draft.

The map must be explicit, enumerated, and **default-deny**: a subtype not on the list is
`block`.

| Subtype | Evidence | Disposition | Rationale |
|---|---|---|---|
| provider transport/boot failure (#434) | unavailable | indeterminate | we could not look |
| balance exhaustion / 402 (#455) | unavailable | indeterminate | we could not look |
| rate-limit park | unavailable | indeterminate | already the existing `park`; this generalizes it |
| SDK outage (#458) | unavailable | indeterminate | we could not look |
| parse-invalid / no findings block (ADR-0004) | partial | **block** | the reviewer misbehaved — that *is* a signal |
| security-diff failure (`error_diff`) | unavailable | **block** | inspection failed before any cell ran — unavailable, but a *diff we cannot read* is not retryable-by-waiting, so it blocks |
| budget refusal | partial | **block** | a policy decision, deterministic |
| provider-diversity config error | partial | **block** | misconfiguration, not unavailability |
| *anything not listed* | partial | **block** | default-deny |

Note this review is itself an instance: in pass 1 the claude seat returned "authoring
review findings block not found." Under the table that is `parse-invalid → block`, and
correctly so — it must not be laundered into `indeterminate`.

Two consequences for the seam. First, `unavailable` does not imply `indeterminate`: the
`error_diff` row is unavailable *and* blocking, because retrying cannot make an unreadable
diff readable. The disposition function must therefore key on the typed cause, not on the
evidence label alone. Second, **the input must carry typed per-cell outcomes**, not an
aggregate: an all-parse-invalid matrix and an all-transport-failure matrix both contain
zero valid cells, yet must resolve to `block` and `indeterminate` respectively. An
aggregate evidence value cannot distinguish them, so default-deny classification is only
implementable if each cell's failure cause survives into the disposition input.

### 7.3 `indeterminate` requires a retry actor as a precondition

`indeterminate` is not a disposition that can ship on its own. The two runners have
different status contracts and only one has a reconciler:

- **local runner** — the review-request queue drain (#387) already *is* the retry actor.
  It leaves the status pending and re-drains. `indeterminate` is expressible here today.
- **CI runner** — one-shot, maps every non-success to `failure`, and has no reconciler.
  Shipping `indeterminate` there would either collapse back to `block` (no gain) or leave
  a permanently pending PR — recreating the stranding problem in a new cell.

So the rules are:

1. `indeterminate` **never posts `success`**. It is not a pass.
2. It posts nothing (leaves pending) **only where a retry actor exists**; otherwise it
   posts `failure` and is a `block` with `clearedBy: retry`.
3. `attemptsRemaining` is bounded; on exhaustion it becomes `block` with
   `clearedBy: { transition: "human-review", actor: "human" }`. Unbounded pending is the
   failure mode we are trying to eliminate, not a state we may enter. This requires
   **durable retry state with an atomic decrement**, and today's queue key
   `(prNumber, headSha)` does not carry one — re-draining the same request would produce
   `indeterminate` forever. The counter must be persisted against that key and decremented
   under the existing drain lock before the local-runner slice can be called shippable.
4. It settles **observed** P2 spend and refunds only the unused remainder; it releases a
   P3 token only on a *pre-work* abort. An evaluation that died after billing has spent
   real money and burned real work.

The minimum shippable unit is therefore **`indeterminate` + its retry actor**, scoped to
the local runner first. That is a correction to the first draft's sequencing, not a
detail.

## 8. Failure-mode taxonomy to implement against

The checklist a new guard must pass.

1. **TOCTOU** — check and act against a remote authority are not atomic. *Detector:* the
   act does not carry the observed token. *Closes with:* P1.
2. **Lost update** — two actors' writes interleave. *Detector:* no CAS at the authority.
   *Closes with:* P1.
3. **Quota overdraw** — a divisible resource is checked, not held. *Detector:* a predicate
   over shared spend. *Closes with:* P2.
4. **Entitlement burn** — a one-shot marker written before the work it authorizes.
   *Closes with:* P3.
5. **Identity collision / zombie actor** — two attempts share a name, or a superseded
   attempt still lands effects. *Closes with:* P4 (both halves).
6. **Unobserved transition** — state changes off-process and nothing converges.
   *Closes with:* P5.
7. **Stale-actor destruction** — a delete guarded by less than a liveness verdict.
   *Closes with:* P6.
8. **Broken derived exclusivity** — an action assumes unique ownership of a target not
   derived from a fenced claim. *Detector:* a step whose cwd is not claim-derived (#435).
   *Closes with:* making the derivation total, or a fence.
9. **Terminal-block accretion** — a blocking edge added with no clearing edge.
   *Detector:* an absorbing-without-progress state lacking `clearedBy`. *Closes with:*
   the §6 invariant, enforced by the §7 discriminated union.

## 9. What this subsumes

- P1 fence: #401, ADR-0025 implementation, #409/#410.
- P2 quota: #402, #460.
- P3 token: #453.
- P4 attempt identity: #451, #450.
- P5 reconciler: #444, #439, #460, plus the gate retry actor (§7.3).
- P6 liveness: #461, and the destructive half of #444.
- Derived exclusivity: #435.
- Gate disposition: #455, #434, the `block (infra)` note in `.pelaggio.yml`, and #297
  (the *policy* layer over this *mechanism*, expressible only once the mechanism exists).
- **Not subsumed, and honestly so:** #445 (a flaky multi-process lock *test*) is a test
  hardening job, not a modelling gap; #458 (sustained SDK-outage parks never persisted
  with `parkClass sdk-outage`) is a park-log reconciliation defect in `pipeline.ts` that
  neither P4 nor the gate-disposition work owns. Listing them in §1's cluster and not
  here is the honest outcome: the model collapses most of the cluster, not all of it.

If a proposed model does not collapse most of that list, it is the wrong model.

## 10. Sequencing

Revised: the first draft put the gate change first on the grounds that it was a pure type
change. It is not — it needs a retry actor (§7.3) and it needs attempt identity, because
a retried evaluation that reuses the prior attempt's `runId` collides on receipts (#451).

1. **P4 attempt identity, both halves** — atomic allocator plus consumer-side fencing.
   Small, mechanical, and a precondition for anything that retries. Unblocks #450/#451.
2. **P2 quota** — required by step 3, because §7.3 rule 4 makes `indeterminate` settle
   observed spend rather than release a whole reservation. (P3 the token is *not* on this
   path: no gate evaluation consumes a revision entitlement. Its adopter is #453 alone and
   it can land independently, at step 4.)
3. **Gate disposition type + `unavailable` allowlist + `indeterminate`, local runner
   only**, shipped together with the queue drain as its retry actor and the durable retry
   counter of §7.3 rule 3. Stops stranding PRs on provider incidents without touching CI.
4. **P3 token**; adopter #453.
5. **P1 fence**, generalized from ADR-0025's executor, landing #401 inside it.
6. **P6 liveness**, then **P5 reconcilers** on top (reap is destructive; it must not
   precede its safety primitive).
7. **CI-runner `indeterminate`**, only once a durable CI-side retry actor exists.

Steps 1–3 are independently valuable if the rest is never built.

## 11. Questions still open

1. Is the four-class taxonomy (fenced / derived-exclusive / reconciled / hint) now
   exhaustive for this codebase?
2. Is the §7.2 allowlist right at its boundaries — specifically, is `parse-invalid` truly
   a `block`, or does a reviewer that reliably fails to emit a findings block under load
   become a de-facto availability fault we have merely renamed?
3. Does `attemptsRemaining` belong on the disposition, or is it reconciler state? Putting
   it on the disposition makes the type self-describing but couples the gate to retry
   bookkeeping.
4. Is consumer-side attempt fencing (P4's second half) affordable, or does it mean
   touching every effect consumer at once — in which case what is the smallest useful
   subset?
5. What is the strongest argument for building none of this and continuing to point-fix?
   The primitives cost real work, and the current approach does eventually close each
   defect.

## Revision log

**v3** — second `doc-review` pass, 3/3 seats (claude + codex + grok), 13 must-fix and 8
notes. Accepted:

- P4's allocator moved into a harness-owned, agent-denied register: an O_EXCL create under
  a generic `.dev/` path has atomicity but no authority, because `blockForeignRootWrite`
  denies agent writes only under `.dev/sessions/` and `docs/decision-log/`. *(claude)*
- P4 consumer-side fencing restated as an authority-bound current-attempt CAS —
  self-validation lets a superseded attempt pass its own check and keep posting. *(codex)*
- §7.2's seam now carries typed per-cell causes: an all-parse-invalid and an
  all-transport-failure matrix both have zero valid cells but must resolve differently, so
  an aggregate evidence value cannot implement default-deny. *(codex)*
- `security-diff failure` relabelled — `error_diff` is a `readSecuritySignal` throw with
  zero cells run, so "complete / a real finding" was false; disposition stays `block`, and
  the row now shows that `unavailable` does not imply `indeterminate`. *(claude, grok)*
- `indeterminate` given durable retry state with an atomic decrement; the queue key
  `(prNumber, headSha)` carries no counter, so re-draining would loop forever. *(codex)*
- §7.1 marked a prerequisite rather than a rule: `softened` lives in `review/loop.ts`,
  which `pr-review-cli.ts` never imports. *(claude)*
- §6 invariant applied to the document itself: `reapable`, `blocked` and P3 `consumed`
  now name clearing transitions and actors. *(claude, codex)*
- §10 resequenced — P2 precedes the gate slice, since §7.3 rule 4 makes `indeterminate`
  settle observed spend; P3 moved off that path entirely. *(grok)*
- Vocabulary unified to `complete | partial | unavailable`; §3 corrected to four classes;
  #435 recast as a premise violation; call-site count corrected to sixteen; #445 and #458
  explicitly listed as *not* subsumed. *(grok, codex)*

Rejected, with evidence: the note that §1's figures "do not reproduce at 4a6ac3c". They
reproduce exactly — `git log -400 --pretty=%s | grep -cE "^fix[:(]"` gives 74, and the
three-variant fail-closed grep gives 57 sites / 24 files. The reviewers ran hyphen-only
(38/21) and a broader variant (87/27). The legitimate complaint underneath it was that the
grep was not published, so the figure was not falsifiable; §1 now publishes both.

**v2** — first `doc-review` panel (grok + codex; the claude seat's findings block failed to
parse — itself an instance of §7.2's `parse-invalid → block`). Ten must-fix, all accepted:

- Split the single entitlement ledger into P2 quota / P3 token (opposite failure
  semantics).
- Separated model judgment from harness-computed disposition (ADR-0014 violation).
- Removed the `degraded ≡ softened` conflation; diversity is policy, not evidence.
- Replaced the blanket `infra → indeterminate` reclassification with a default-deny
  allowlist.
- Made `indeterminate` require a bounded retry actor, scoped it to the local runner, and
  specified the never-success / who-retries / spend-settlement rules.
- Redefined the terminal-state invariant over absorbing-without-progress states only.
- Made the gate type a discriminated union so `clearedBy` is compiler-enforced.
- Gave P4 an atomic allocator and a consumer-side fencing requirement.
- Added the fourth guard class (derived exclusivity) and #435 as its failure mode.
- Reordered §10: attempt identity before the gate change.
- Fixed two drifted line anchors.
