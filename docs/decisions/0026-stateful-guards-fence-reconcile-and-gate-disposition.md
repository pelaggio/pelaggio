---
title: "ADR-0026: Stateful guards — fence-or-reconcile classification and gate disposition"
status: proposed
date: 2026-08-07
claims: ["TC-003", "TC-013"]
---

# ADR-0026 — Stateful guards: fence-or-reconcile classification and gate disposition

This **amends [ADR-0004](./0004-review-gate-fails-closed-shakedown-fails-safe.md)**: the review gate still fails closed, but decisions 5-8 change *what it fails closed on*. Causes on the decision-7 allowlist stop producing a blocking verdict and become bounded, retryable `indeterminate`. ADR-0004's fail-closed posture for every other cause — including parse-invalid, which that ADR's two-parser rule governs — is unchanged.

## Context

Locking and fail-closed gating are not converging. Measured at `4a6ac3c`: 74 of the last 400 commits are `fix:` (`git log -400 --pretty=%s | grep -cE "^fix[:(]"`), and the lock/gate/race/claim/land cluster is the largest theme among them. "fail-closed" appears at 57 sites across 24 non-test source files (`grep -rn "fail-closed\|fail closed\|failClosed" packages/pelaggio/scripts/pelaggio --include=*.ts | grep -v __tests__`; hyphen-only 38/21, broadest case-insensitive 87/27) with **no shared type, no shared disposition, and no shared clearing contract** behind any of them. Each new failure mode produces a bespoke guard; each bespoke guard adds a blocking edge; the blocked population grows faster than the hazard population shrinks.

The cost is measured, not theoretical. #453 records ~$260 of stranded work-in-progress created by a fail-closed edge with no release edge. All four currently-open PRs are blocked, holding $136.29 of review spend, and **one of them (#428) is blocked in part by infrastructure failure misreported as a review verdict** — two of its six review cells are `block (infra)` from a grok balance/boot fault. Those two cells are what forced `agreement: invalid` and a terminal single-iteration outcome; the PR also carries one genuine codex red-team finding, so the reclassification changes *why* it is blocked and makes it revisable, not that it is blocked.

The defects are instances of three conflations, all modeling errors rather than coding errors:

1. **A check is not a hold.** `canRetryWithinBudget` (`helpers.ts`) is a pure predicate over shared spend; two `--parallel` workers both pass it (#402). `verifyShipLanded` answers "did my ship land?" with "did `main` move?" (#401). By contrast `createClaimWorkspace` is sound because git's ref creation is atomic — the race is resolved by the *authority*, not by the pre-check.
2. **An attempt marker is not an outcome marker.** `autopilot:revised` is written *before* the work it authorizes, so a park burns the only revision entitlement with no revision having run (#453). A resumed cycle reuses the prior attempt's `runId`, colliding on execution receipts (#451).
3. **"Cannot evaluate" is not "evaluated as bad."** `pr-review-cli.ts` already distinguishes `failureKind: "infra"` from a findings block, but that distinction reaches *agreement* computation and stops there — infra still emits `effectiveVerdict: "block"`. Adjacent causes do not even reach that seam: `error_diff` fails closed on a pre-matrix early return (`agreement: "invalid"`, no pass and so no `failureKind` at all), so the taxonomy is incomplete as well as inert. `.pelaggio.yml` records the consequence in writing: *"an exhausted grok Build balance blocks every PR — a 402 surfaces as `block (infra)`, not a real finding."* `doc-review-cli.ts` carries the same conflation in a starker form — its `PASS_OUTCOMES` set maps crash, rate-limit park and genuine hard-block to one exit code — but it is a read-only path with no merge consequence, so decisions 5-8 are scoped to the merge gate and `doc-review` follows only if it later gains one.

ADR-0025 solved exactly one instance of (1) — landing — well. Nothing in it generalized, because the class of thing landing *is* was never named. Detail, evidence, and the full guard audit live in [`guarded-actions.md`](../agent-context/guarded-actions.md), whose §8 is the new-guard checklist this ADR delegates to.

That document recommends one ADR per primitive. This ADR deliberately bundles them, because the primitives are not independently decidable: the classification rule (decisions 1-3) is what makes any single primitive *justified*, and the gate work (5-8) depends on two others (9, 10). Splitting would produce six ADRs that each restate the same context. The implementing items are split; the decision is one.

## Decision

1. **The load-bearing rule.** Every guarded action must be either **fenced** — the authority owning the state rejects a stale actor — or **reconciled** — the effect is idempotent and a converging observer repairs drift. An action that is neither is a **hint**; a hint may reduce contention but is never load-bearing for correctness. **Derived exclusivity satisfies the rule transitively**, not as an exception to it: the target is not itself an authority that rejects stale actors, so it is load-bearing only while it reduces to a fenced claim under the three conditions in decision 2. When that reduction fails the action is a hint, whatever it looks like locally. This is an audit that sorts every existing guard, not a new abstraction.

2. **Four classes, not three.** `fenced` (ref CAS, `--match-head-commit`, content-bound receipts), `derived-exclusive` (safe because the target is uniquely owned by a *fenced* claim — worktree writes), `reconciled` (`review-request-queue.ts`), `hint` (`withFileLock`, labels, budget predicates). Derived exclusivity is sound only when the deriving claim is fenced, the target is a total function of that claim, and liveness is verified before reuse or destruction. #435 fails the premise: `pick` runs with `cwd=MAIN_REPO`, derived from no claim at all.

3. **`review-request-queue.ts` supplies the reconciler *contract*** — idempotency key, claim-with-crash-reclaim, rollback edge, and *"completion always requires a POSITIVE terminal check — never 'absent from the forge listing'."* Every reconciler adopts that contract.

   **It is not, as written, a safe template, and the generalized version must fix what it gets wrong.** Both its claimed-record lease and its drain lock are fixed four-hour expiries with no heartbeat, so a review that genuinely runs longer is reclaimed while still live, duplicated, and — because reviews are nondeterministic — the two runs then race last-writer-wins on the terminal status post. That is the same time-lease fail-open this ADR rejects in `file-lock.ts` (§ Alternatives), reappearing in the exemplar. Generalizing it unchanged would propagate the defect.

   So the contract additionally requires: **reclaim gated on a positive P6 liveness verdict rather than elapsed time alone** (a heartbeat is the minimum; liveness is the correct gate), and **terminal effects that are idempotent or fenced**, so that even a duplicated runner cannot produce a last-writer-wins outcome. Adopting the queue's shape without these is adopting its bug.

4. **Absorbing states are typed, and the blocking ones carry their exit.** A state is *absorbing-with-progress* (`completed`, `committed`, `released`, `Landed`, and attempt-level `superseded`/`abandoned`) or *absorbing-without-progress* (`blocked`, `parked`, `Contended`, `indeterminate`, `reapable`, entitlement `consumed`). **Every absorbing-without-progress state must name its clearing transition and the actor authorized to fire it.** Completion states are exempt — the earlier formulation ("no terminal state without a recovery edge") was incoherent and is rejected. The invariant binds this ADR too, so the instances are normative here rather than delegated:

   | State | Clearing transition | Actor |
   |---|---|---|
   | `blocked` (gate, **findings**) | `new-head-sha` — a revision that fixes or validly refutes every carried blocker | `harness` (revise sweep) or `human` |
   | `blocked` (gate, **non-actionable**: parse-invalid, `error_diff`, budget refusal, diversity misconfiguration) | `operator-remedy` — re-run, fix config, or raise the cap; **never** a code revision | `human` |
   | `parked` (attempt) | `resume` | `harness` (sweep) or `human` |
   | `Contended` (landing) | `retry` under the ADR-0025 ladder, claim retained | `harness` |
   | `indeterminate` (gate) | `retry` while `attemptsRemaining > 0`, else demotion per decision 8 | `harness` (retry actor) |
   | `reapable` (claim) | `reap`, gated on a positive P6 liveness verdict | `harness` (reconciler) or `human` (`/tidy`) |
   | `consumed` (P3 token) | `grant-additional-entitlement` | `human` |

5. **Judgment is separated from disposition (ADR-0014 applied to the gate).** The model emits `judgment: pass | block` — a *policy input*. The harness computes `Disposition` deterministically from judgments, evidence, configured policy, typed per-cell causes, **the carried candidate-blocker set, and the isolated-verification result**. The last two are not optional inputs: the standing invariant is that *PR candidate blockers may be removed only by a complete, valid isolated verification report, and verifier failure retains them* — the merge-gate `pr-verify` contract in `AGENTS.md` and `docs/pr-review.md`, distinct from ADR-0024's authoring-loop fingerprint-survival rule. A disposition function keyed only on the current pass would let a later reviewer's silent omission clear a blocker that was never refuted — omission is never refutation. The merge path reads only the disposition, never raw model output. `Disposition` is a **discriminated union** so that `clearedBy` is compiler-enforced rather than an optional field every call site can stub:
   `{ kind: "merge" } | { kind: "block"; reason; clearedBy } | { kind: "indeterminate"; cause; clearedBy; attemptsRemaining }`
   where `clearedBy = { transition, actor }` on **both** blocking variants. Decision 4 requires an authorized actor, not just a transition, so the actor rides on `clearedBy` rather than in a separate `retryActor` field that only one variant carries — otherwise the `indeterminate → block` demotion in decision 8 produces a blocking state with no one named to clear it.

6. **Evidence is completeness, not diversity.** `complete | partial | unavailable` describes how much of the required (driver × label) matrix returned a valid result. Provider diversity is *policy*, entering the deterministic function as configuration — `provider-diversity: require` plus a softened realization resolves to `block`. This is a **prerequisite, not a description**: `DiversityStatus.softened` lives in `review/loop.ts`, which `pr-review-cli.ts` does not import, so plumbing realized diversity onto the merge-gate path is work this decision requires.

7. **Evidence and disposition are computed separately, and the disposition allowlist is default-deny.** These are two columns, not one; collapsing them is what made today's gate unreadable. *Evidence* is arithmetic over the matrix — how many required cells returned a valid result — and is computed **independently of cause**. *Disposition* is then applied from an enumerated, default-deny map over typed per-cell causes:

   | Cause | Evidence contribution | Disposition |
   |---|---|---|
   | provider transport/boot failure (#434) | invalid cell | `indeterminate` |
   | balance exhaustion / 402 (#455) | invalid cell | `indeterminate` |
   | rate-limit park | invalid cell | `indeterminate` |
   | SDK outage | invalid cell | `indeterminate` |
   | parse-invalid / no findings block (ADR-0004) | invalid cell | **`block`** |
   | `error_diff` (pre-matrix diff read failure) | no matrix ran | **`block`** |
   | budget refusal | invalid cell | **`block`** |
   | provider-diversity misconfiguration | invalid cell | **`block`** |
   | *anything unlisted* | invalid cell | **`block`** |

   **Aggregation over a mixed matrix is ordered, and the order is normative.** #428's shape — some cells pass, one carries a real finding, two are transport failures — is the motivating case, so leaving precedence undefined would let an implementer re-terminalize real findings, launder them into retry, or merge on a partial pass. The disposition function resolves in this order and stops at the first match:

   1. **Any retained blocker → `block` (findings).** Decision 5's invariant is absolute and is evaluated *before* the availability allowlist: an unavailable cell never clears a blocker, because omission is never refutation. **"Retained" spans passes *and* the current one** — it is every ≥-bar finding that has survived isolated verification and has not been explicitly refuted, including first-pass survivors. Reading it as "carried from a prior pass" would make rule 3 launder a first-pass findings-block sitting alongside transport/402 cells into `indeterminate`, which is precisely the #428 shape this ordering exists to fix.
   2. **Any cell with a non-allowlisted cause → `block`**, per the decision-7 table.
   3. **Any allowlisted `unavailable` cell → `indeterminate`**, provided 1 and 2 did not match.
   4. **All required cells valid and passing, but configured policy unsatisfied → `block`** (reason `policy`, cleared by `operator-remedy`). The live case is `provider-diversity: require` with a softened realization: the matrix is complete and green, and it still must not merge. Stating it explicitly matters because rules 1-3 fail closed on this input only *by omission*, which leaves an implementer without a default.
   5. **All required cells valid and passing, policy satisfied → `merge`.**

   A partial pass never merges: rule 4 requires the *required* matrix complete, so a matrix short of it falls to 3 (retryable) or 2 (blocking) by cause. Under this order #428 resolves to `block` with a live carried blocker — revisable, which is the point — rather than to `invalid`, which is terminal.

   Two further consequences. **Low evidence never implies `indeterminate`:** an all-parse-invalid and an all-transport-failure matrix both have zero valid cells and identical evidence, yet must resolve to `block` and `indeterminate` respectively — which is only possible if the disposition input carries per-cell causes. And `error_diff` blocks because retrying cannot make an unreadable diff readable; it is not a retryable unavailability.

8. **`indeterminate` requires a retry actor as a precondition, and is bounded.** It never posts `success`. It leaves the status pending *only* where a retry actor exists. Where none exists the disposition is **not** `indeterminate` at all — it is a `block` with `clearedBy: { transition: "operator-rerun", actor: "human" }`, because "retry" with no retry actor is precisely the exit-less state decision 4 forbids and decision 5's union is designed to make unrepresentable. `attemptsRemaining` is bounded and backed by **durable state with an atomic decrement** — today's queue key `(prNumber, headSha)` carries no counter — and on exhaustion becomes `block` cleared by `human-review`. It settles **observed** P2 spend rather than releasing a whole reservation, and releases a P3 token only on a pre-work abort. The minimum shippable unit is `indeterminate` **plus** its retry actor **plus** the decision-9 quota primitive (settle-observed) **plus** decision 10's attempt identity — a retried evaluation that reuses the prior attempt's `runId` reproduces #451's receipt collision, so bounded retry without attempt identity is not shippable — scoped to the local runner: the CI runner is one-shot and has no reconciler, so shipping there would either collapse back to `block` or strand a permanently-pending PR.

   The split matters operationally: `findRevisablePrs` today treats *any* `review` FAILURE as revisable, so a non-actionable block currently consumes a P3 revision token on work no revision can fix — #453's defect in a second location. A non-actionable block must not enter the revise sweep.

9. **Quota and token are two primitives, not one.** P2 quota (dollars) is divisible and refundable: reserve, settle observed, refund unused (#402). P3 token (revision entitlement) is indivisible and one-shot, with *opposite* failure semantics — a pre-work abort releases it, a post-work failure consumes it (#453). `consumed` is absorbing-without-progress and clears by `grant-additional-entitlement`, actor `human`.

10. **Attempt identity is an authority, not a naming convention.** A monotonic `(itemId, attemptSeq)` requires (a) atomic allocation, (b) a **harness-owned, agent-denied register**. `blockForeignRootWrite` does deny Write/Edit into `MAIN_REPO` and every foreign worktree root, so a generic `MAIN_REPO/.dev/` path is already protected *from worktree steps*. The residual is narrower but real, and it decides the remedy: `foreignRoots.delete(cwdAbs)` means a **main-cwd step** (`pick` — #435) may write there freely.

   **The Bash half of that denial cannot carry the authority, and this decision does not rely on it.** The existing denials for `.dev/sessions/` and `docs/decision-log/` are literal-substring regexes over an opaque command string, so an agent can reach the same path through shell indirection — variable splitting, `.dev/./attempts`, quote insertion — and forge or unlink the current-attempt token, defeating consumer fencing entirely. Extending that regex is worth doing as defence-in-depth and is explicitly **not** sufficient.

   The load-bearing enforcement must be independent of command text — **and, critically, the authority must be somewhere an agent cannot write at all, not merely somewhere it is asked not to.** A single writer that *consults* the register to decide the current attempt is validating against state the agent can rewrite; it would faithfully accept a forged-current stale request. Write/Edit denial plus a single writer is therefore not sufficient on its own, and an earlier draft of this decision wrongly implied it was.

   The register's authoritative state must be **agent-inaccessible by construction**: held by the orchestrator process (in memory for the life of the run, persisted outside every path any agent tool can reach — *not* under `MAIN_REPO/.dev/`, which is exactly where the `review-request-queue.ts` template puts its own state), or else authenticated, so a rewritten copy fails validation rather than being believed. Consumers validate against *that*, never against a repo-tree file.

   The three supporting measures remain, in descending strength: **(i)** allocation performed only by the harness, never by an agent-invoked command; **(ii)** absolute resolved-path Write/Edit denial (the `sessionsDir` precedent — a path check, not a string match); **(iii)** the Bash-string denial, defence-in-depth only. An implementation that rests authority on (ii) or (iii) has not met this decision. And (c) **authority-bound current-attempt fencing at every effect consumer** — CAS where the authority supports a conditional write, and a **reconciled single-writer** design where it does not. The distinction is load-bearing rather than pedantic: a GitHub commit-status POST has no attempt-token conditional update, so "check the local register, then post" is itself TOCTOU and would let a superseded attempt post `success` after the current attempt blocked. Consumers without a conditional-write primitive must therefore route through a single harness-owned writer (the `review-request-queue.ts` pattern), not through an unspecified CAS. Self-validation is not fencing: an old attempt passes its own check, a newer sequence is allocated, and the old actor still posts (#451, #450).

## Alternatives not taken

- **A bigger/better lock.** `file-lock.ts` is careful and honest about its residual (a holder suspended past `staleMs` loses exclusion by definition). It is fail-open by construction and sound only as a contention reducer. The problem is that it is the *only* mutual-exclusion noun available, so it gets reached for where a fence or reconciler is required — across sixteen call sites once `withMutationLock`'s eleven are counted. No change inside `file-lock.ts` fixes that.
- **One FSM over "the cycle."** Re-encodes `STEPS`, which `config.ts` already owns, and touches none of the three conflations.
- **Reclassifying `failureKind: "infra"` wholesale to `indeterminate`.** Reopens genuine fail-closed merge paths — parse-invalid and `error_diff` are infra-flavoured but are real signals. Hence the default-deny allowlist in decision 7.
- **Shipping `indeterminate` before its retry actor.** Recreates stranding in a new cell: on the CI path it is either still a block or an indefinitely pending PR.
- **Continuing to point-fix.** Each defect does eventually close. Rejected on the composition argument, which stands on its own: #401, #402, #435, #439, #444, #450, #451, #453, #455, #460 and #461 are eleven instances of six primitives (#461 supplies the liveness reader that decision 2's third condition depends on rather than being re-decided here), so eleven point-fixes buy six primitives' worth of leverage at eleven times the cost. The stranding figures (4/4 open PRs blocked; ~$260 in #453 plus $136.29 currently) are a point-in-time snapshot over possibly-overlapping PRs and are offered as corroboration, not as a trend.

## Consequences

- (+) The audit is finite and mechanical: every guard sorts into one of four classes, and each class has a known remedy. New guards get a checklist (`guarded-actions.md` §8) instead of a precedent search.
- (+) Decision 4's invariant is what converts "fail-closed" from a terminal verdict into a state with an exit; it would have prevented #453 and #460 from existing.
- (+) Decisions 5–8 unstrand PRs whose *blocking* is caused by provider incidents rather than findings. #428 is the live instance: its infra cells forced `agreement: invalid`, which is deliberately terminal, so the one real finding it carries could never be revised against. The decisions make it revisable; they do not merge it, and its carried blocker must still be fixed or validly refuted.
- (−) Decision 6 requires plumbing realized diversity onto the merge-gate path, which does not exist today.
- (−) Decision 8 requires durable retry state keyed alongside `(prNumber, headSha)`, and constrains the local runner first — the CI runner keeps today's behavior until a durable CI-side retry actor exists.
- (−) Decision 10's consumer-side CAS touches every effect consumer (receipts, ship, write-back, status-posting). The smallest useful subset is an open question, tracked with the implementing item.
- (−) This is target-state, not a description of current code. It binds new guard work; it does not attest existing behavior. #445 (a flaky lock *test*) and #458 (park-log reconciliation) are in the Context defect cluster but are **not** subsumed — the model collapses most of the cluster, not all of it.
