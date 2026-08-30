# Guarded actions: a fencing/reconciliation model for pelaggio's locks and gates

Status: living construction home under ADR-0026's semantic rules (see the Division
of authority below). **v10** — v3 was revised across two provider-diverse review
passes; v4 added §8.1; v5–v7 applied three further review passes; v8 added §8.2; v9
repaired §8.2's examples after its review (2026-08-24); v10 records the two-channel
Git-porcelain snapshot (2026-08-27, see the revision log). **Verification baseline, honestly:** the
code-referencing claims in §1–§7 were verified against `4a6ac3c` (2026-08-06) and have
drifted — the issue cluster was closed and re-cut into the G-series on 2026-08-07
(e.g. #466 "G3 — Token"), and `blockForeignRootWrite`'s denied-root set has grown. The
audit's *shape* stands; treat its counts and issue pointers as the 2026-08-06 snapshot
and follow the G-series for current work. Claims marked **(v6)** or **(v7)** were
verified at head on 2026-08-22 and are exceptions to that snapshot scoping.

**Scope of confidence.** These parts are not equally settled, and the review passes made
that split visible rather than closing it:

- **§1–§4 (diagnosis, rule, guard classification) are the load-bearing claim.** They
  survived both passes essentially intact; the corrections were to counts and attributions,
  never to the argument. If only one thing is taken from this document, take the audit.
- **§5–§10 (primitives, lifecycles, gate, sequencing) were design directions.** Both passes
  found real defects there, sharper in pass 2 because they were grounded in code the design
  had not been checked against (`blockForeignRootWrite`'s denied-root set; `softened`'s
  absence from the merge-gate path; `error_diff`'s zero-cell failure).

**Division of authority with [ADR-0026](../decisions/0026-stateful-guards-fence-reconcile-and-gate-disposition.md), stated exactly.**
The ADR owns the *semantic rules and constraints* (its ten decision slots and
implementation constraints: fence-or-reconcile, typed recoverable blocking state,
judgment/evidence/disposition separation, time-lease-is-not-liveness, the clearing actor
belongs to the blocking state, …); its own Construction section designates **this
document as the canonical construction/evidence home**. So there is no "route around
§5–§10": constructions live here, and where a construction contradicts an ADR rule it is
*defective here* and must be repaired *here*, against the ADR's rules as the test. This document
remains the evidence base, the full guard audit, and the §8 new-guard checklist. Its earlier
recommendation of "an ADR per primitive" was **not** taken, deliberately: the primitives are
not independently decidable, and ADR-0026 records why. The v4/v5 review passes
*confirmed* internal defects in the construction sections; because this document is the
canonical construction home, **v6 repairs them in place** — each at its site, marked
"(v6)": the §6 gate-block clearer is now typed per block class; §7.1 states the
softened-split prerequisite; §7.3's retry counter is re-homed off the drain lock.

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
- Open issues in this exact cluster *(2026-08-06 snapshot — most closed as COMPLETED
  on 2026-08-07 and re-cut into the G-series, e.g. #466 "G3 — Token"; the evidence
  stands as history, the pointers do not route to current work)*: #401, #402, #435,
  #439, #444, #445, #450, #451, #453, #455, #460, #461, plus the then-planned
  #409/#410 admission work.
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

- `canRetryWithinBudget` (`cycle-outcome.ts`) is a pure predicate: `maxBudget - spent >=
  stepBudget`. Two `--parallel` workers both pass. `review/loop.ts`'s `phaseReservation`
  has the same shape. Accrual is post-hoc at four sites, so admission is decided against
  stale spend (#402).
- `verifyShipLanded` (`ship/freshness.ts`) answers "did my ship land?" with "did
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
any reuse or destruction. #435 fails at (a): `pick` runs with `cwd=MAIN_REPO`, which is
derived from no claim at all — there is no fenced deriving claim, so (b) is never reached, `blockForeignRootWrite` permits main-tree mutation, and the audit only trips
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

**`review-request-queue.ts` supplies the contract** (but see ADR-0026 decision 3 — its own
four-hour fixed leases carry the time-lease fail-open this document criticises elsewhere,
so the shape is the template, not the implementation). It already has every property the
rest of the system lacks: an idempotency key `(prNumber, headSha)`; a claim protocol (atomic
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

> *(v7 note: the §4 audit predates the per-item revision execution lease
> (`revise-sweep.ts`), which cites §3–§4 for its guard class but has no row here —
> one known omission from "every guard sorts into four classes," to be added when
> the table is next re-verified.)*

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
   denied agent writes at the 4a6ac3c baseline only under `MAIN_REPO/.dev/sessions/` and
`docs/decision-log/` — the deny set has since grown (`step-runner.ts` now also denies
the gate-records, adjudication-sources, and freshness-gate-records registers, with
matching Bash patterns) — so
   anywhere else the very agent being fenced can unlink or forge the sequence. The
   allocator must join that denied set, on the same footing as session records.

   *Status (#475, and the ADR's attempt-freshness constraint):* property 1 shipped —
   `attempt-identity.ts` allocates atomically via O_EXCL under `MAIN_REPO/.dev/attempts/`.
   Properties 2 and 3 did **not**, and the module says so in its own header: the register is
   *not* in the denied set, because `blockForeignRootWrite` protects it from worktree steps but
   not from a main-cwd step or an opaque Bash command — so the attempt number "is an identity,
   never an authorization." #435 closes that by giving `pick` a bounded fs scope; per #482 §K3
   the register inherits protection from the authority-profile work rather than getting a
   bespoke mechanism. Read the paragraph above as the requirement, not as the current state.
3. *Every effect consumer fences against the current attempt, at the authority.*
   Carrying identity into artifact paths only stops collisions. Inertness requires an
   authority-bound current-attempt compare-and-swap — a superseded attempt must be
   rejected by receipts, ship, write-back and status-posting, not by asking the attempt to
   validate itself. Self-validation is not fencing: an old attempt passes its own check, a
   newer sequence is then allocated, and the old actor still posts.

Adopters: #451, #450. (Not #458 — that is a park-log reconciliation defect in
`pipeline.ts`, outside this collapse; see §9.)

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
- **Gate evaluation**: §7 — the clearer is typed by block class (v6, corrected v7;
  ADR-0026's clearing-actor constraint): an **artifact-judgment** `block` is
  *re-evaluated* on `new-head-sha` — the new sha triggers a fresh evaluation but
  **never itself clears a retained blocker**, which survives until complete, valid
  isolated verification explicitly refutes it (ADR-0026 decision 7; the repo's
  PR-candidate-blocker invariant); actor `harness | human`. A **policy** block (e.g.
  `provider-diversity: require` unmet, §7.2 rule 4) clears by `operator-remedy` — a
  new head sha changes nothing about unmet policy. **Indeterminate** clears by
  `retry` where §7.3 supplies an actual retry actor; where **no retry actor exists,
  it is a block whose clearer is `human` from the start** — never an actor-less
  `retry`, which would be the exit-less state this invariant exists to prevent (v7).
  **Named open construction (G-series):** §7.2's remaining cause-class blocks —
  parse-invalid, `error_diff`, budget-refusal, diversity-config-error, default-deny —
  each still owe a named clearer and actor; until assigned they violate this
  invariant, and assigning them is G-series work, not a gap this bullet hides.

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

// Every blocking variant names its clearing transition AND the actor authorized
// to fire it (§6 invariant; ADR-0026: "the clearing actor belongs to the
// blocking state").
ClearedBy = { transition: ClearingTransition, actor: ClearingActor }

// Deterministic function of (judgments, evidence, diversityStatus, config).
// This is the only thing the merge path reads.
type Disposition =
  | { kind: "merge" }
  | { kind: "block";         reason: BlockReason;      clearedBy: ClearedBy }
  | { kind: "indeterminate"; cause: UnavailableCause;  clearedBy: ClearedBy;
                             retryActor: RetryActor;   attemptsRemaining: number }
```

`merge` carries no clearing transition (it is progress). `block` and `indeterminate` both
*require* one, with its authorized actor — a discriminated union, so the §6 invariant is
enforced by the compiler rather than by an optional field every call site can fill with a
stub. (Known gap, unchanged since v7: this sketch pairs any `BlockReason` with any
`ClearedBy`; binding each reason to its one legal clearer per §6/§7.2 is G-series work and
must be done against the clearer table there, not improvised here.)

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

**This is a prerequisite, not a description — twice over (v6).** First:
`DiversityStatus.softened` exists only in `review/loop.ts` — the authoring/doc-review
path — and `pr-review-cli.ts` does not import it; the merge gate's
`provider-diversity: require` is a binary preflight with no softened state. Second, and
sharper: `review/loop.ts` sets `softened` for seat *incompletion* as well as for
weaker-configured diversity, so plumbing it as-is would read missing evidence as a
policy block — exactly the completeness/cause conflation ADR-0026 forbids.
`softened-by-configuration` must be split from `softened-by-incompletion` upstream
before `require` + `softened` → `block` can be policy; until both exist the rule above
is unimplementable there.

> **Known-open (v7, G-series):** the type sketch above still takes *aggregate*
> evidence (and `diversityStatus`) as the disposition input, and the cause table
> below labels an all-parse-invalid matrix `partial` and an all-transport matrix
> `unavailable` despite both having zero valid cells — the completeness/cause
> entanglement ADR-0026 forbids, confirmed by three review passes. The repaired
> seam carries **typed per-cell causes** into disposition; that construction is
> G-series work and the sketch/table stand as the defective baseline it replaces.

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
| SDK outage | unavailable | indeterminate | we could not look |
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

#### Aggregation over a mixed matrix is ordered

The cause table classifies one cell. A real matrix mixes them — #428's shape is some cells
passing, one carrying a real finding, and two transport failures — so precedence has to be
stated or an implementer is free to re-terminalize real findings, launder them into retry,
or merge on a partial pass. The disposition function resolves in this order and **stops at
the first match**:

1. **Any retained blocker → `block` (findings).** Evaluated *before* the availability
   allowlist: an unavailable cell never clears a blocker, because omission is never
   refutation. **"Retained" spans prior passes *and* the current one** — every ≥-bar finding
   that has survived isolated verification and has not been explicitly refuted, including
   first-pass survivors. Reading it as "carried from a prior pass" would let rule 3 launder
   a first-pass findings-block sitting alongside transport cells into `indeterminate`, which
   is precisely the #428 shape this ordering exists to fix.
2. **Any cell with a non-allowlisted cause → `block`**, per the §7.2 table.
3. **Any allowlisted `unavailable` cell → `indeterminate`**, provided 1 and 2 did not match.
4. **All required cells valid and passing, but configured policy unsatisfied → `block`**
   (reason `policy`, cleared by `operator-remedy`). The live case is
   `provider-diversity: require` with a softened realization: the matrix is complete and
   green, and it still must not merge. Stating it explicitly matters because rules 1–3 fail
   closed on this input only *by omission*, which leaves an implementer without a default.
5. **All required cells valid and passing, policy satisfied → `merge`.**

A partial pass never merges: rule 4 requires the *required* matrix complete, so a matrix
short of it falls to 3 (retryable) or 2 (blocking) by cause. Under this order #428 resolves
to `block` with a live carried blocker — revisable, which is the point — rather than to
`invalid`, which is terminal.

### 7.3 `indeterminate` requires a retry actor as a precondition

`indeterminate` is not a disposition that can ship on its own. The two runners have
different status contracts and only one has a reconciler:

- **local runner** — the review-request queue drain (#387) already *is* the retry
  actor. It leaves the status pending and re-drains. The retry *actor* exists here
  today; per rule 3 (v6) the bounded *counter* does not yet, so `indeterminate` is
  expressible but not shippable until the harness-owned register lands — the same
  condition, stated once (v7).
- **CI runner** — one-shot, maps every non-success to `failure`, and has no reconciler.
  Shipping `indeterminate` there would either collapse back to `block` (no gain) or leave
  a permanently pending PR — recreating the stranding problem in a new cell.

So the rules are:

1. `indeterminate` **never posts `success`**. It is not a pass.
2. It posts nothing (leaves pending) **only where a retry actor exists**; otherwise it is a
   `block` from the start with `clearedBy: { transition: "human-review", actor: "human" }` —
   there is no retry actor to name, so per §6 (v7) the clearing actor cannot be `retry`.
3. `attemptsRemaining` is bounded; on exhaustion it becomes `block` with
   `clearedBy: { transition: "human-review", actor: "human" }`. Unbounded pending is the
   failure mode we are trying to eliminate, not a state we may enter. This requires
   **durable retry state with an atomic decrement**, and today's queue key
   `(prNumber, headSha)` does not carry one — re-draining the same request would produce
   `indeterminate` forever. The counter must be persisted against that key and
   decremented **in a harness-owned register with an atomic check-and-decrement** (the
   G-series attempt/quota machinery), *not* merely under the drain file-lock — §4
   classifies that lock as a hint, and its fixed lease is exactly the
   time-lease-is-not-liveness shape ADR-0026 bars from carrying correctness (v6).
   Until that register exists the local-runner slice is not shippable.
4. It settles **observed** P2 spend and refunds only the unused remainder; it releases a
   P3 token only on a *pre-work* abort. An evaluation that died after billing has spent
   real money and burned real work.

The minimum shippable unit is therefore **`indeterminate` + its retry actor**, scoped to
the local runner first. That is a correction to the first draft's sequencing, not a
detail.

*Later correction, carried by ADR-0026 and restated here so this section does not read as
the whole unit:* the unit is **`indeterminate` + its retry actor + settle-observed quota +
attempt identity**. Quota and token are two primitives, not one — P2 quota (dollars) is
divisible and refundable while a P3 token is not — and an evaluation that dies after billing
has spent real money, so the retry actor is unsound without settle-observed quota beneath it.
Attempt identity belongs to the same unit because a retry that cannot distinguish its own
superseded predecessor's artifacts is not a retry.

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

### 8.1 The over-refusal taxonomy — the second half of the checklist

Items 1–9 catch guards that are **unsound** (they lose correctness). This half catches
guards that are sound but **over-aggressive** (they lose work). The operating history
funds it: the ship dirty-refusal exit stranding authored revision work, the confinement
audit learned as a before/after delta rather than absolute-dirty, cycle aborts on
sibling-worktree writes, `block (infra)` burning entitlements (§2.3), and — in the
runner-protocol design (recorded publicly as the work-preservation and no-false-refusal
requirements on issues #606/#607; the design ADRs live in the operator's private
notebook) — a transient heartbeat blip expiring a healthy lease. Each was
re-derived separately; this section hoists the lesson so a new gate inherits it instead.

The bar, one sentence, in §3's spirit:

> **A gate earns its place by being *early* (it fires at the cheapest point — no later
> than the first moment the violation is knowable, before further work compounds on
> it), *narrow* (it refuses the violating dimension, never the work), *preserving* (a
> refusal never destroys or strands state, and names the resume path), and
> *falsifiable* (it ships with proof it does not fire on legitimate input).** Judgment
> informs and mechanism gates (ADR-0014); this bar governs how gates behave, never
> whether to add more — the check-ratchet hypothesis was found unsupported at the
> measured citation-edge proxy (`throughput-economy.md` §0/§1.3; a small residual
> effect is not ruled out), so the bar is a quality floor for necessary gates, not a
> license to multiply them. An artifact-review gate (pr-review, doc-review) meets
> "early" by firing before the artifact's *next* investment — merge, revision, landing
> — not by predating the artifact.

As failure modes, checklist-style:

10. **Late gate** — the check fires after work is invested when it could have fired
    before any exists. *Detector:* refusal cost scales with work done, not with the
    violation; verification is not the first act of the guarded unit. *Closes with:*
    verification-before-work ordering — checks precede the guarded unit's expensive
    act (the first seat spawn for execution gates; the merge/landing for artifact
    gates, per the bar's artifact-review clause).
11. **Broad refusal** — the gate refuses the work when only a dimension of it violates.
    *Detector:* the refusal message offers no proceed path; the check evaluates absolute
    state rather than the delta the guarded action introduced (the `.dev/`
    confinement lesson: audit before/after, never absolute-dirty). *Closes with:*
    redirect-over-discard (block the auth class, the target, the dimension — run the
    work another way) and delta-scoped predicates.
12. **Destructive refusal** — the refusal path destroys or strands uncommitted state.
    *Detector:* a refusal exit that neither checkpoints/parks, quarantines, nor
    provably leaves local state intact; a message that does not name the preserved
    state and the resume path. *Closes with:* the park-checkpoint discipline
    (`parkExit()`'s shape, not the literal closure — it is `runPipeline`-local today)
    generalized to every refusal exit, in whichever of three forms the refusal
    permits: **checkpoint-and-park** where committing is safe;
    **preserve-without-commit** where it is not; **leave-intact** where the state is
    already durable. Honesty about the second form (v6, corrected v7 against
    `pipeline.ts`/`git.ts` at head): `quarantineCheckpoint` *commits*, so it is
    not a preserve-without-commit; and `error_confinement` exits via `finish()`,
    which deregisters and disposes but never deletes or resets the worktree — the
    state is **left intact in effect**. What that path is missing is not
    preservation machinery but the *contract*: the refusal does not name the
    preserved state or the resume path, and nothing guarantees the intact worktree
    against later cleanup (`/tidy` is operator-invoked and never auto-deletes, which
    is a habit, not a fence). The open work is the naming + a reap-guard — and a
    true non-committing preserve for any future case where leave-intact is
    insufficient. Refusal ≠ discard, in all three forms.
13. **Irreversible-too-early** — a tripped guard becomes final before any successor has
    consumed the contested resource. *Detector:* no reclaim window between trip and
    consequence. *Closes with:* reversible-until-consumed (lease expiry reclaimable
    by the holder until a successor is granted — the work-preservation *requirement
    comment* on #606, which the spec item must reconcile with its own
    revoke-grants-at-expiry rule: reclaim preserves the working state and returns the
    lease at epoch+1 with **re-minted** grants, the originals having died at expiry;
    entitlements burn on outcome, not attempt — P3's twin).
14. **Untested for false fire** — the gate ships with true-positive tests only.
    *Detector:* no test asserts the gate stays silent on legitimate input at the
    operating envelope's edge (budget-edge liveness, sub-reclaim-window blips,
    clean-baseline deltas). *Closes with:* no-false-fire tests as a shipping
    requirement — a gate that cannot afford its false-positive tests does not ship;
    where a conformance suite exists (the runner track, #607), a tracked
    false-refusal metric joins the tests — the metric is the suite-level form of
    this item, not a universal precondition.

§2.3 is the bridge between the halves: collapsing "cannot evaluate" into "evaluated as
bad" is simultaneously unsound (a verdict without evidence) and over-aggressive (work
lost to an outage). A gate that passes both halves cannot make that collapse.

### 8.2 Construction over enumeration — the structural companion

§8 and §8.1 take an individual guard as given and constrain how it *behaves* — soundly
(§8), and without losing work when it fires (§8.1). This section asks the prior
question: **how is a guard structured so its guarantee is *complete*?** A guarantee has a
*completeness surface* when there are many places the property could be violated — output
sinks that might leak a secret, config vars that might pass an untriaged value, HEAD
shapes that might smuggle an unproven merge. Enforced site-by-site, such a guard is never
done: adversarial review keeps finding one more site, and each round buys one patch and
no leverage — the §1 complaint, in the shape of a single guard rather than the whole
cluster. This is hoisted from the guard campaign of 2026-08 — #554 / PR #589 (rolls 7–10
each found one more unscrubbed sink), #435 (a chokepoint the `cwd=MAIN_REPO` path never
reached), #571 / PR #595 (one more HEAD shape) — where what repeatedly *failed* was the
next patch: each round closed the named sites and the next round found more. None of those
guards has been hoisted yet (the examples below say so); lifting the guarantee to one
chokepoint is the remedy this section proposes, with #615 as its first instance.
The intent half of this section — a guard may not derive its verdict from state the
guarded party can write, and enumerating such channels is no substitute — is recorded,
**non-authoritatively**, as `CON-0027` in the shadow assurance graph. Its authoritative home
would be an amendment to ADR-0026; this document proposes that and does not make it, and
cites the graph as an index of the proposal, never as authority.

The Git-porcelain confinement snapshot is the motivating completeness-surface measurement
for that second sentence. Two distinct observation failures of the same snapshot are
already in evidence:

- `.git/config` origin rewrite is state the guarded party can write that the snapshot does not report
- ignored `.dev/` write is state the guarded party can write that `git status --porcelain` is structurally unable to observe

Channel enumeration cannot close while whole path classes sit outside the snapshot's
observation surface — evidence for CON-0027's existing construction-over-enumeration
sentence, not a new constraint, and not the same finding as §8.1 item 11's delta-scoped
`.dev/` lesson (audit before/after, never absolute-dirty).

The bar, one sentence, in §3's spirit:

> **When a guard's guarantee spans many sites, paths, or inputs, establish it at a single
> construction-level chokepoint where it holds *by construction*, rather than enumerating
> and patching each site. An enumerated guard is falsified by "one more site"; a
> construction-level guard is falsified only by *escaping* the chokepoint — which the
> control flow or type system makes visible and testable in one place.**

**The diagnostic — when to hoist.** If review or testing keeps surfacing *one more*
instance of the *same class* — one more unscrubbed sink, one more untriaged var, one more
merge/HEAD shape — the guard is enumerated and its completeness is unbounded-in-practice.
That recurrence *is* the signal to hoist, not to add the next patch. It is §1's "we pay
full price for each one and bank no leverage," localized to one guarantee.

**The moves.** Four. Where an example is an existing mechanism it is named as one; where it
is a prerequisite that does not exist at head it is marked so, the way §7.1 and P4 mark theirs
— a construction document that describes a mechanism it wishes existed is the false chokepoint
of its own caveat. Code-referencing claims in this section were verified against
`7c92b03` (2026-08-24). The moves are not exclusive, and one guard may use several.

- **Chokepoint enforcement** — put the guarantee at the boundary every path funnels
  through, not at each producer. *Target, not yet built:* the §7 discriminated union — every
  blocking variant carrying its `clearedBy` so the §6 invariant holds at the type — is a
  sketch whose clearers §6 still lists as incomplete, not a shipped chokepoint.
  *Prerequisite, not a description (#615):* review and adjudication bodies
  reach their public sinks (stdout, the PR-comment upsert) through roughly nine independent
  call sites with no funnel; `secret-hygiene.ts`'s scrubber (ADR-0010) runs at the driver
  capture and transcript sinks, not at those writes. Funnelling the writes buys "every sink is
  scrubbed" — and only that: the #554 / PR #589 gate record (and `pr-review-cli.ts`'s own
  comment at its publish sites) established that sink-scrubbing cannot reverse padded or
  base64-encoded covert channels, so the property a write-boundary chokepoint can honestly
  promise is narrower than "no secret leaves", and it is the narrower property that should
  be typed.
- **Extract-and-require (conformance)** — do not hand-maintain the allowed set against a
  moving upstream; extract the full set mechanically and *require* every member be
  explicitly triaged, so a *new* member fails CI rather than slipping through. *Existing
  instance:* `shadow-assurance.test.ts` Q5 and Q16, which enumerate the trust registry and the
  AGENTS.md invariant index from their sources and fail on any record or bullet that is not
  classified (the ADR-0023 hostile-probe suite is *not* one: its cases are a fixed,
  manually invoked set, not an extraction of a moving upstream). *Prerequisite, not a
  description:* `DEFAULT_AGENT_ENV_ALLOWLIST` is a hand-maintained
  constant and no test scans the installed SDK; nor can a source scan be complete — the SDK
  reads `process.env[...]` dynamically and launches a native binary — so the honest form is an
  authoritative manifest from upstream or an enforced runtime boundary, not a grep.
- **Default-deny allowlist** — trust is an explicit, small set; everything else, *including
  unknown and future members*, is denied by construction. This is §7.2 already —
  `unavailable` is an allowlist, never a default, and "*anything not listed* → block." The
  move generalizes that row: consume evidence only from a store-trusted set, and let any
  other or unknown source default to untrusted rather than enumerating distrust one member
  at a time.
- **Recognize-by-invariant, not by-shape** — identify a thing by the property that
  *defines* it, not the incidental form it took this time. *The shape, as a prerequisite:*
  §7.2's "the input must carry typed *per-cell* causes" — key disposition on the cause that
  defines a cell, not on an aggregate label two materially different matrices happen to
  share; §7.1 records that the current sketch still aggregates evidence and the per-cell
  seam is G-series work. *Prerequisite, not a description (#571 / PR #595):* recognize an unproven `ours`-style
  merge by its merge-against-main second-parent signature plus a tree check, so every way
  HEAD can diverge collapses into one recognition rule; no such recognizer exists at head.

**Relation to the spine and to §8.1.** This is the construction reading of ADR-0014
(determinism lives in the harness): from *the gate's decision is deterministic* to *the
gate's completeness is structural, not enumerated*. It decides nothing new; the rule it
builds toward is the ADR-0026 amendment proposed above. It is the construction companion to §8.1's behavioral bar
— §8.1 governs how a gate behaves *when it fires* (early / narrow / preserving /
falsifiable); this governs how a guard is *structured so its guarantee is complete at all*.
The two meet at §8.1's fourth property: a construction-level guard is inherently more
**falsifiable**, because a chokepoint gives both its false-fire and its true-fire coverage
a single locus. In particular the chokepoint is the one place a mutation test can disable
to prove the *whole class* fails at once — which is exactly how you demonstrate that the
chokepoint, and not scattered per-site logic, is the control. An enumerated guard cannot
offer that test; its coverage is per-site and therefore never complete.

The document already contains instances of the move without having named it — the same
relation §3's rule bore to the guards §4 later sorted. §7.2's default-deny allowlist and
§4's derived-exclusivity condition (b) — *the target is a total function of the fenced
claim* — are construction-level completeness hoisted at the derivation level; the §7
discriminated union *would* make the §6 `clearedBy` invariant compiler-enforced rather
than a field every call site can fill with a stub, once it is built (it is a sketch today). Naming the move is what lets the
next guard reach for it deliberately instead of re-deriving it under review.

**Caveat — when not to over-reach.** Not every guard has a completeness surface worth
hoisting; a genuinely single-site check stays single-site. The trigger is *recurrence of
the same class*, not a prophylactic reflex — this section governs how a guard is
structured, never whether to add one, the same humility §8.1 keeps. And the sharp failure
of the move is a chokepoint the codebase cannot actually force all paths through: it reads
as a guarantee and is not one. #435 is exactly this — `blockForeignRootWrite`'s
derived-exclusivity chokepoint is a false guarantee for a `cwd=MAIN_REPO` step, because
that path never funnels through a claim — §4's premise, condition (a), a fenced deriving
claim, is absent, so (b) is never reached. So
the requirement is explicit: **name the property that all paths funnel through the
chokepoint, and make *that* the tested invariant** — an unenforced chokepoint is an
enumerated guard wearing a structural mask.

As a §8 checklist item: **enumerated guard with an unbounded completeness surface** —
*Detector:* the same finding class recurs across review rounds ("one more sink / var /
shape"). *Closes with:* hoist per this section, and test the funnel property itself.

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

**Routing note (v5):** the issue numbers in §9 and below are the 2026-08-06 snapshot;
that cluster closed on 2026-08-07 and was re-cut into the **G-series** (#466 and
siblings). An implementer follows the G-series; these sections remain as the mapping
from defect shapes to the primitives that closed them.

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

**v10** (2026-08-27) — added the two-channel Git-porcelain confinement-snapshot
measurement under §8.2 as grounded evidence for CON-0027's existing second sentence
(whole path classes outside the snapshot's observation surface). Distinct from
§8.1 item 11's delta-scoped `.dev/` lesson. Does not promote §8.2 or amend ADR-0026.

**v9** (2026-08-24) — two doc-review passes (3 seats each) found §8.2's worked examples
described mechanisms that do not exist at head: the scrub does not run at the public writes
(and #536 says scrubbing cannot close covert channels), no SDK env-var conformance scan
exists, no `ours`-merge recognizer exists, the §7 union is a sketch, the per-cell seam is
unbuilt, and the ADR-0023 probe suite is a fixed spike. Everything unbuilt is now marked
*prerequisite* or *target*; the only claimed existing instances are §7.2's default-deny row,
§4's derived-exclusivity condition, and the source-enumerating Q5/Q16 tests. The intent half
is pointed at as a *proposed* ADR-0026 amendment (indexed non-authoritatively as `CON-0027`
in the shadow graph, which is also where the AGENTS.md bullet maps under Q16). Also repaired:
§7.3 rule 2 (a no-retry-actor indeterminate is a human-cleared block from the start) and
§4's #435 sentence (it fails at (a), not (b)). The §7 sketch is left as v7 with its known
gap stated rather than re-guessed.

**v8** (2026-08-22) — added §8.2, the construction-over-enumeration principle ("type the
invariant out of the pipeline"): the completeness-surface diagnostic (recurrence of "one
more" instance of the *same class* is the signal to hoist) and the four moves — chokepoint
enforcement, extract-and-require conformance, default-deny allowlist, recognize-by-invariant
— each with a mechanism-true worked example. Hoisted from the multi-PR guard campaign where
adversarial review kept surfacing one more site of the same class per round. Framed as
§8.1's structural companion (§8.1 governs how a gate *behaves* when it fires; §8.2 how a
guard is *structured* so its guarantee is complete) and as an extension of ADR-0014 from
"the gate's decision is deterministic" to "the gate's completeness is structural." Names the
pre-existing instances the section generalizes — §7.2's default-deny allowlist, the §7
discriminated union that compiler-enforces the §6 `clearedBy` invariant, and §4's
derived-exclusivity condition (b) / #435 as the false-chokepoint failure — so it reads as
naming a move already in use, not a new claim. Routed from the AGENTS.md invariant added in
the same change. Doc-only: no new decision slot — ADR-0026's Construction section already
designates this document its canonical construction home.

**v7** (2026-08-22) — v6 confirmation pass (3 seats), 11 must-fix triaged: factual
fixes applied (header version tokens; §8.1 item 12 corrected against head —
`error_confinement`'s `finish()` leaves the worktree intact, so the path is de-facto
leave-intact and the open work is the naming contract + reap-guard, not preservation
machinery; the AGENTS.md invariant's preservation forms updated to match); two
decidable semantic corrections (new-head-sha triggers re-evaluation but never clears a
retained blocker — ADR-0026 decision 7; no-retry-actor indeterminate is a
human-cleared block from the start, never an actor-less retry); the remaining
state-machine construction (clearers for §7.2's cause-class blocks; typed per-cell
causes through the disposition seam; the zero-valid-cell labeling) is **named open
G-series work** at its sites rather than designed here — three passes have converged
this document's claims to code and ADR reality; the residual is implementation design
owned by the G-series issues.

**v6** (2026-08-22) — v5 confirmation pass (3 seats), 7 must-fix accepted. The
authority-cycle finding resolved by stating the ADR-0026 division exactly (the ADR owns
rules/constraints; this document is the canonical construction home per the ADR's own
Construction section) and repairing the confirmed construction defects in place: §6's
gate-block clearer typed per block class; §7.1's second prerequisite (split
softened-by-configuration from softened-by-incompletion); §7.3's retry counter re-homed
to a harness-owned register off the drain-lock hint. §8.1 corrected against code
reality: `quarantineCheckpoint` commits and `error_confinement` preserves nothing, so
it is the open instance of item 12, and the missing form is a non-committing preserve;
item 13's reclaim reconciled with revoke-at-expiry (re-minted grants) and attributed to
the #606 requirement comment; item 10's ordering clause aligned with the
artifact-review carve-out.

**v5** (2026-08-22) — v4 `doc-review` pass (3 seats), 10 must-fix accepted: header
re-dated with the verification-baseline staleness stated (cluster re-cut into the
G-series 2026-08-07; `blockForeignRootWrite` deny-set growth); §1 issue list marked as
snapshot; §9/§10 routed to the G-series; the §6/§7 internal defects the pass confirmed
recorded under the ADR-0026 supersession note rather than repaired; §8.1's "early"
relativized for artifact-review gates (and the AGENTS.md invariant reworded to match);
the runner-protocol evidence cite grounded in #606/#607; item 12 given three
preservation forms (park / quarantine / leave-intact — `error_confinement` may not
park); item 14's metric scoped to conformance-suite contexts; the check-ratchet claim
scoped to what `throughput-economy.md` measured.

**v4** (2026-08-22) — added §8.1, the over-refusal taxonomy: the gate-quality bar
(early / narrow / preserving / falsifiable) and failure modes 10–14, hoisting the
repeatedly re-derived lesson (ship dirty-refusal, delta-not-absolute confinement,
lease-blip expiry from the runner-protocol design) into the new-guard checklist.
Routed from the AGENTS.md invariant added in the same change.

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
