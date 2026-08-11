# Ticket collapse: the guard cluster under ADR-0026

Status: **executed 2026-08-07**; retained as the record of what was decided and why.
G1-G6b were created as #464-#470 and ten subsumed issues were closed with supersession
notes. The roadmap snapshot below is as read *before* execution, at `4a6ac3c`.

## Claim under test

ADR-0026 asserts that eleven open issues are instances of six primitives. If the model
does not collapse most of that list it is the wrong model. This document tests the claim
honestly, including where it fails.

## The collapse

**Seven primitives (G1–G6b) absorb twelve point-fix issues**, and an eighth item, G7,
handles one more as a classification fix rather than a new primitive. Each is one shippable piece of mechanism
with named adopters, not an epic. The arithmetic is reconciled in the score table below.

### G1 — Fence: authority-validated compare-and-swap
Generalizes ADR-0025's `land(attempt) → Landed | Contended` executor into a reusable seam.
- Subsumes **#401** (`verifyShipLanded` ancestry-only) — becomes a test inside G1 rather
  than a standalone patch, since the fix is "the landing executor owns this predicate."
- Subsumes **#409**/**#410** (landing preflight + config matrix) as its admission half.
- Scope: M. Depends on nothing.

### G2 — Quota: reserve / settle-observed / refund-unused
- Subsumes **#402** (budget reservation ledger) — already scoped M and specified.
- Subsumes the **accounting half of #460** (#460 now closed; both halves owned) (spend abandoned at the cap). #460's *re-drain*
  half is not a quota question — its body specifies `campaignDrainDeferred = true` at the
  cap break — so it is co-owned with G6b, which supplies the reconciler that re-drives the
  abandoned drain. Splitting it across two primitives is the honest reading; assigning it
  to G2 alone silently dropped the transition that actually fixes it.
- Scope: M. Blocks G5 (ADR-0026 decision 6 — *a retryable outcome is bounded and actionable* — settles observed spend).

### G3 — Token: one-shot entitlement with pre/post-work split
- Subsumes **#453** (revision entitlement burned by a park). #453 already contains the
  correct design including the do-not-release-on-every-non-completion warning; G3 is that
  issue, promoted from "fix a label" to "add the primitive."
- Scope: M. Independent of G2 — opposite failure semantics, per the quota/token primitives now carried in `guarded-actions.md`.

### G4 — Attempt identity: agent-inaccessible register + consumer-side fencing
- Subsumes **#451** (resumed cycles reuse the prior `runId`).
- Subsumes **#450** (resume after review hard-block ships the checkpoint) — routing on
  persisted attempt state is what makes the resume correct; #450 is unfixable without it.
- **Scope correction (post-review).** #467's recorded charter predates the tightening of
  ADR-0026's attempt-freshness constraint and understates it: it asks for an atomic allocator plus consumer-side
  CAS. The item must also carry (a) an **agent-inaccessible** authoritative register —
  orchestrator-held, outside any agent-reachable path, with anti-rollback freshness, since a
  writer that merely *consults* an agent-writable register validates forged state and a signed
  blob alone is replayable after supersession — and (b) a **reconciled single writer** for
  consumers with no conditional write at all, GitHub commit statuses being the live case.
  #467's body cannot be amended through the sanctioned CLI (#473), so this document carries
  the correction.
- Scope: M/L. The allocator is small; the register's storage boundary and consumer-side
  fencing are the open sizing question (ADR-0026's attempt-freshness constraint).

### G5 — Gate disposition: judgment/evidence split, allowlist, bounded `indeterminate`
- Subsumes **#455** (balance exhaustion has no distinct class) — #455's detector work is
  the `unavailable` allowlist's first entry.
- Subsumes **#434** (grok concurrent-boot race) *as a gate concern only*: G5 stops the
  race from blocking PRs. It does **not** fix the race, which remains its own item.
- **Also in scope, and previously missing:** ADR-0026 decision 4's prerequisite (*judgment, evidence completeness and disposition are distinct*) — plumbing
  realized provider diversity onto the merge-gate path (`softened` exists only in
  `review/loop.ts`, `bench.ts` and `record.ts`; `pr-review-cli.ts` never imports it) — and
  decision 5's mandatory disposition inputs, the carried candidate-blocker set and the
  isolated-verification result. Neither had a G-item or a residue entry, which left the
  mutation set incomplete against the ADR it collapses.
- **Depends on #461 (liveness) too.** G5 ships a retry actor, which is a reconciler, and
  ADR-0026's *a time lease is not liveness* constraint now requires every reconciler to gate reclaim on a positive liveness
  verdict rather than elapsed time — precisely because the queue template's fixed four-hour
  lease reclaims live work. An earlier draft's dependency graph omitted this.
- Scope: L. Depends on **G2, G4, #461, and its own retry actor** — ADR-0026 decision 6 (*a retryable outcome is bounded and actionable*) makes the
  minimum shippable unit `indeterminate` + retry actor + settle-observed quota + attempt
  identity, so the queue drain and a durable retry counter keyed alongside
  `(prNumber, headSha)` ship inside G5, not after it. Local-runner-only.

### G6a — Liveness reader → **this is #461 itself**
- **#461** (trustworthy session-liveness primitive), already correctly scoped, is the item.
  No wrapper G-item: #469 was created as one and closed as redundant. Strict precondition
  for every destructive operation in G6b.
- Scope: M. Depends on nothing.

### G6b — Reconcilers over off-process transitions
- Subsumes **#439** (sweep expired confinement sessions at run start).
- Co-owns the **re-drain half of #460** with G2.
- **#444** is already implemented as PR #449, which is *not* purely a reconciler — it
  deletes worktrees and claim branches. Per #461's `## Blocks`, it must not land armed
  before G6a. See `open-pr-collapse.md`.
- Scope: M. **Depends on G6a.** These are two separately shippable items, not one epic —
  an earlier draft bundled them, which contradicted this document's own one-primitive-
  per-item rule and hid the ordering that matters most.

Plus one classification fix that is not a new primitive:

### G7 — Close broken derived exclusivity
- **#435** — already implemented as PR #452. Needs CI fixed and re-review, not re-design.

## Honest residue

Two groups: one member of the cluster that resists collapse, and three adjacent issues
that are commonly mistaken for cluster members. Listing both matters more than the
collapse score does — a model that appears to absorb everything is not being tested.

- **#445** (flaky `file-lock` multi-process race test) — test hardening under CI
  contention. No modelling content. Stays as-is, scope XS.
- **#458** (sustained SDK-outage parks never persisted with `parkClass sdk-outage`) — a
  park-log reconciliation defect in `pipeline.ts` after `finish()` with `resetsAt=0`.
  ADR-0026 v1 wrongly filed this under attempt identity; it belongs to neither G4 nor G5.
- **#297** (first-class tolerance policy) — the *policy* layer above G5's mechanism. It
  becomes expressible once G5 lands but is not subsumed by it (ADR-0014 keeps them
  separate by construction).
- **#434** (grok boot race) — the underlying race survives G5.
- **#438 / #440** (run-root main auto-sync + staleness preflight; the operator-workbench
  runbook) — **not in the §1 denominator, but they belong to this model.** #438's auto-sync
  is a P5 reconciler (`main` advancing on the forge is an off-process transition nobody
  observes) and its preflight is an admission check in G1's half. Live evidence, 2026-08-07:
  `npx pelaggio` executed pre-fix code because the main checkout was left on a feature
  branch — a variant #438 does not currently cover, since its problem statement is `main`
  never *advancing* rather than HEAD not *being* main. The preflight must assert HEAD
  identity, not just freshness. Left as their own items; #438 gates #440 by its own terms.
- **No new ticket for single-iteration termination.** An earlier draft filed one, on the
  theory that `evaluateReviewConvergence`'s ordering made `max-passes: 2` unreachable. That
  was a misdiagnosis: `pr-review-cli.ts:675/696` makes disagreement and invalid terminal
  *deliberately*, and reordering `findings.ts` would not run a second pass for any of the
  four open PRs. The residual defect — an infra fault producing `agreement: invalid` — is
  already G5's, fixed at the source. What remains is a documentation/budget note:
  `.pelaggio.yml` budgets $120 for two iterations that the observed PR population never
  reaches. See `open-pr-collapse.md`.

**Score, with the denominator stated so it can be checked.** The cluster is the fourteen
issues named in `guarded-actions.md` §1 — #401, #402, #409, #410, #435, #439, #444, #445,
#450, #451, #453, #455, #460, #461:

| Outcome | Count | Issues |
|---|---|---|
| Collapse into G1–G6b | 12 | #401, #402, #409, #410, #439, #444, #450, #451, #453, #455, #460, #461 |
| Handled by G7 (classification fix, not a new primitive) | 1 | #435 |
| Do not collapse | 1 | #445 |

**13 of 14 are absorbed by eight items; one resists.** Twelve collapse into the seven
primitives G1-G6b, and #435 is handled by G7 — which is an eighth item even though it is a
classification fix rather than a new primitive. #458, #297 and #434 appear in the
residue section above but are *not* members of this denominator — they were never part of the §1
cluster, and counting them as non-collapses (as an earlier draft did) inflated the failure
rate while making the arithmetic unreconstructible.

## Proposed roadmap mutations

Nothing below has been executed. All roadmap writes go through `npx pelaggio roadmap`.

1. **Create** G1, G2, G3, G4, G5, G6a, G6b as chartered items via
   `npx pelaggio roadmap create-item`, each naming ADR-0026 and enumerating its adopter
   issues in the charter body, and using `--deps` for the real ordering (G5 after G2 and
   G4). **Do not** encode G6b as hard-blocked on G6a: `open-pr-collapse.md` lands PR #449
   *unarmed* before #461, and a hard dep would forbid that safer path. The G6a→G6b
   constraint gates **arming** the sweep, not merging the reconciler, so it belongs in
   G6b's acceptance criteria ("reap stays disabled by default until a positive P6 verdict
   is wired into every deletion path"), not in `--deps`.
2. **Close the subsumed issues via `npx pelaggio roadmap mark-done`, with a superseded
   note naming the G-item that absorbs them.** An earlier draft kept them open to preserve
   their analysis. That was wrong on both halves: GitHub retains the bodies of closed
   issues, so nothing is lost — and leaving them open leaves them **pickable**. One-way
   references in the new G-item bodies do not affect readiness, so `roadmap next` would
   keep serving the point-fix issues alongside their replacements, letting workers execute
   duplicate or conflicting implementations. The ready queue would *grow*, which is the
   precise opposite of a collapse.

   **Both earlier "exceptions" were incoherent and have been corrected.** The reasoning was
   that #460 and #461 were not *fully* contained by a single G-item. But readiness does not
   care about that: all of #460's work is owned (accounting half → G2, re-drain half → G6b,
   each naming it) and all of #461's work is the liveness primitive — so leaving them open
   left them pickable **alongside their own replacements**, the precise failure this
   mutation exists to prevent.

   - **#460 is closed**, superseded by G2 + G6b jointly.
   - **#461 stays open and G6a (#469) is closed instead.** G6a was a thin wrapper whose own
     body said #461 "stays open as the item of record" — so it, not #461, was the duplicate.
     #461 has the fuller charter; G6b names it directly as its arming precondition.

   Caught by codex in the #463 review gate, after execution.

3. **Leave** #445, #458, #297 and #434 untouched. No new ticket for single-iteration
   termination — see the residue section for why the earlier draft's was withdrawn.

**Executability, checked rather than assumed.** Both mutations run entirely through the
required CLI. `roadmap create-item` takes `--deps/--after`, and `roadmap mark-done <id>
[--note <text>]` carries the supersession note — verified against `roadmap-cli.ts:261-265`.

One real limit remains, and it shapes mutation 1 rather than blocking it: the CLI exposes
`list, next, get, claim, plan-path, publish-plan, mark-done, create-item, archive-plan,
backfill-priority-labels, stale-scan, stale-list, stale-resolve, source` — **no item-edit,
no comment, no link**. Relationships are therefore expressible only at *creation* time and
only in the new-item → existing-item direction. So each G-item must enumerate its adopters
in its own charter body at creation; there is no way to add a reference later without a CLI
capability that does not exist. Filing `roadmap update-item`/`link` as its own item is
worthwhile but must not block the collapse.

## Sequencing against ADR-0026

```
G7  (#435 — PR #452 open, CI red)        ── independent
G1  (fence)                              ── independent
G3  (token)                              ── independent
G6a (#461 liveness) ──→ G6b (reconcilers; PR #449 open, must not land armed before G6a)
G2  (quota) ──┐
G4  (attempt id) ─┼──→ G5 (gate disposition + retry actor, local runner only)
#461 (liveness) ──┘   (G5's retry actor is a reconciler → liveness-gated reclaim)
```

Two primitives are already *written* and sitting in **open, blocked** PRs — G7 as #452 and
G6b as #449 — but neither is landed, and #449 must not land armed before G6a. Getting those
two merged proves the primitives before the harder ones are specified, which is the
argument for doing the PR collapse first. See `open-pr-collapse.md` for their dispositions
and the safety ordering.
