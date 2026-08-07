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
- Subsumes the **accounting half of #460** (spend abandoned at the cap). #460's *re-drain*
  half is not a quota question — its body specifies `campaignDrainDeferred = true` at the
  cap break — so it is co-owned with G6b, which supplies the reconciler that re-drives the
  abandoned drain. Splitting it across two primitives is the honest reading; assigning it
  to G2 alone silently dropped the transition that actually fixes it.
- Scope: M. Blocks G5 (ADR-0026 decision 8 settles observed spend).

### G3 — Token: one-shot entitlement with pre/post-work split
- Subsumes **#453** (revision entitlement burned by a park). #453 already contains the
  correct design including the do-not-release-on-every-non-completion warning; G3 is that
  issue, promoted from "fix a label" to "add the primitive."
- Scope: M. Independent of G2 — opposite failure semantics, per ADR-0026 decision 9.

### G4 — Attempt identity: allocator + consumer-side CAS
- Subsumes **#451** (resumed cycles reuse the prior `runId`).
- Subsumes **#450** (resume after review hard-block ships the checkpoint) — routing on
  persisted attempt state is what makes the resume correct; #450 is unfixable without it.
- Scope: M/L. The allocator is small; consumer-side CAS is the open sizing question
  (ADR-0026 decision 10).

### G5 — Gate disposition: judgment/evidence split, allowlist, bounded `indeterminate`
- Subsumes **#455** (balance exhaustion has no distinct class) — #455's detector work is
  the `unavailable` allowlist's first entry.
- Subsumes **#434** (grok concurrent-boot race) *as a gate concern only*: G5 stops the
  race from blocking PRs. It does **not** fix the race, which remains its own item.
- **Also in scope, and previously missing:** ADR-0026 decision 6's prerequisite — plumbing
  realized provider diversity onto the merge-gate path (`softened` exists only in
  `review/loop.ts`, `bench.ts` and `record.ts`; `pr-review-cli.ts` never imports it) — and
  decision 5's mandatory disposition inputs, the carried candidate-blocker set and the
  isolated-verification result. Neither had a G-item or a residue entry, which left the
  mutation set incomplete against the ADR it collapses.
- Scope: L. Depends on **G2, G4, and its own retry actor** — ADR-0026 decision 8 makes the
  minimum shippable unit `indeterminate` + retry actor + settle-observed quota + attempt
  identity, so the queue drain and a durable retry counter keyed alongside
  `(prNumber, headSha)` ship inside G5, not after it. Local-runner-only.

### G6a — Liveness reader
- **#461** (trustworthy session-liveness primitive), already correctly scoped. Strict
  precondition for every destructive operation in G6b.
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

   Two exceptions stay open because a G-item does not fully contain them: **#460**, whose
   two halves are split across G2 and G6b, and **#461**, which *is* G6a rather than being
   absorbed by it.

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
              ├──→ G5 (gate disposition + retry actor, local runner only)
G4  (attempt id) ─┘
```

Two primitives are already *written* and sitting in **open, blocked** PRs — G7 as #452 and
G6b as #449 — but neither is landed, and #449 must not land armed before G6a. Getting those
two merged proves the primitives before the harder ones are specified, which is the
argument for doing the PR collapse first. See `open-pr-collapse.md` for their dispositions
and the safety ordering.
