# P5 — Ship-through lineage on the production target

**Targets:** F (durability across ship), G (provenance on the real path), H (owner for a transition
that completes outside the process), I/J (clearing judgment; information isolation).

**Hypothesis.** A change can travel charter → merge on the configured production target
(`auto-merge-pr`) leaving a reconciled terminal lifecycle state and a dossier that survives.

**Falsification conditions.** No code owns the post-merge transition; provenance degrades or becomes
unresolvable across ship; clearing judgment fails to bind independently.

**Method.** Item **#483** chartered self-contained on `main` (P3's #481 failed only because it
targeted a file existing solely on an unmerged branch), then `npx pelaggio run --item 483`, then
three cold-gate passes, then `p3-dossier.ts --item 483` before and after merge. PR **#484**, merged
`2026-08-11T05:26:15Z`.

## H — falsified, in a worse form than predicted

One second after merge, issue #483 **closed**. Nothing in the harness closed it: GitHub honoured a
`Closes #483.` line on the third line of the PR body, which the **ship agent chose to write**
(`closingIssuesReferences: [#483]`). A grep across `packages/pelaggio/scripts/` and
`.claude/skills/` finds no closing-keyword templating.

Every deterministic transition failed to fire:

| Transition | Result |
|---|---|
| issue closed | ✅ — by model-authored PR-body prose |
| `in-progress` removed | ❌ still set |
| local claim branch deleted | ❌ present |
| remote claim branch deleted | ❌ present |
| worktree removed | ❌ present, with all four execution receipts |

So `merged → done` is not *unowned*; it is **torn** — partially owned, by a sentence. That is worse
than a stall: the tracker reads done while a live `feat/<id>` branch keeps the item ineligible for
re-pick (exit 3), and whether it happens at all depends on prose the model may not emit next time.

**This is also a measured violation of C.** C holds that "model judgments may be required evidence,
but cannot themselves exercise authority to advance." A model-authored artifact performed a roadmap
state transition on the production path. C must be split (C1 resolution / C2 the state resolved
over), and the closer must normalize or suppress model-authored closing keywords at ship time or
they will race it.

## F / G — the destruction case is untestable here

The dossier is **byte-identical** before and after merge: 7 durable / 2 mutable-join / 4
unanswerable. Nothing was destroyed because nothing cleaned up — worktree destruction exists only on
`direct-push`, where `runShipBookkeeping` removes it.

Two consequences. First, **K6 is a precondition for K1, not a parallel track**: today's production
path preserves receipts, review records and flow-event segments only because the merged→done gap
leaves the worktree standing, so a closer that reconciles and cleans up before the durable evidence
home exists converts a lifecycle bug into provenance loss. Second, the plan's probe bullet
"capture-at-boundary provenance … including successful worktree destruction" tests a path production
never takes; scope it to `direct-push` or to the post-closer world.

**F5 is stronger than written.** Run from main against a live item whose worktree still existed, the
assembler reports `receipts: 3 (0 present on disk)`: the durable cycle log cites paths that resolve
only inside the worktree while `MAIN_REPO/.dev/execution-receipts/` is empty. The join is broken
*before* destruction; ship merely makes it permanent.

**A new unanswerable:** *what caused each lifecycle transition.* The ship-authored PR body that
closed the issue lived in `.dev/ship/pr-body-483.md`, now deleted; the cause survives only as
mutable GitHub state.

## I — supported, and the only invariant supported by catching its author

Three cold-gate passes on #484:

| Pass | Head | Outcome | Cost |
|---|---|---|---|
| 1 | `e66d69b` | **block** — 2 isolated-verified `must-fix`, `agreement=disagreement`, 2 passing seats overridden | $23.84 |
| 2 | `824c312` | **block** — 1 isolated-verified `must-fix` | $35.20 |
| 3 | `40ff101` | **pass** — `consensus-pass`, 0 survivors | $21.50 |

Pass 1 found that the hardening transfer under review was itself unsafe: `modelAuthoredText`
accumulates every assistant turn (`step-runner.ts:499`) while the v1 regexes match a block anywhere
(`findings.ts:333–334`), so an early clean block — or an early `refuted` verification — stays
gate-authoritative despite a non-report final answer. The authoring loop is immune because its v3
parser unions blocks (#280).

Pass 2 found a **credential-exfiltration regression introduced by the author while fixing a
`note`-severity cosmetic mismatch**: rendering `modelAuthoredText` in the invalid-output diagnostic
published every assistant turn into a public PR comment and the CI log, and `pr-review.yml` hands
the seat inherited `ANTHROPIC_API_KEY` / `GH_TOKEN`. Reverted.

That is direct evidence for I that no static analysis produces: the independent clearing judgment
caught what the author could not, twice, and passed cleanly when the work was actually correct.

**The aggregation precedence back-ported into `guarded-actions.md` got its first live exercise** in
pass 1 — a mixed matrix (2 pass / 1 block, survivors retained) resolving to `block` by rule 1,
"a retained blocker beats passes; omission is never refutation." That rule was written from #428 and
had never run.

## J — exercised, still weak

Cold seats re-derived the blocking finding from the diff with no authoring context. Standing caveat 4
is unchanged: `sessionResume` is false on every provider, so there is no inheritance mechanism to
defeat and a green result remains weak evidence.

## Findings to charter

1. `parseJudgeReport` / `parseDelimited` have neither the tail rule nor a schema-example guard —
   the same fail-open direction #484 closed for verification, **pre-existing on `main`**.
2. Parrot guards are exact-string and non-fuzzy; a one-character near-miss parses. Deliberate, but
   undecided — accept as documented residual or strengthen.
3. `p3-dossier.ts` over-counts attempts (it counts `.marks/<n>` as an attempt).
4. The `renderPass` diagnostic mismatch remains open: the safe version needs scrub plus truncation.
5. #418 (`assistantText` cross-provider conformance) moves up — the cold gate's parse source now
   depends on a contract G3 recorded as provider-divergent.

## Cost

Cycle $33.29 + gate passes $23.84 / $35.20 / $21.50 ≈ **$113**, plus one pass stopped mid-flight
when CI went red on the head it was reviewing. Almost none of that was measurement; it was
remediation, because riding the production pipeline means fixing what it surfaces.
