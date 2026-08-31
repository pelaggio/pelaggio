# Shadow artifact — experiment #752: minimum human decision for PR #325

Authorized by pelaggio/pelaggio#752. Frozen public corpus only: issue #308 (full comment
history), PR #325 (body, diff, conversation, reviews, checks), base
`477b7575c3fd6128771b002dbada8117d179047d`, head
`d9b04193eb7d3f6578c1ec2551721ec03f0aba1a`, and governing public project material at the
revisions visible from the case. Produced before any oracle access. No product changes.

Status vocabulary per the issue: established, contradicted, correctable, residual, not
material.

## Case timeline (evidence spine, all UTC)

- 2026-07-20 19:42 — issue #308 filed/labeled `autopilot`: grok fails `error_confinement`
  in any mutating seat; body theorizes the harness snapshot audit is misfiring under
  grok's jail.
- 2026-07-20 22:48 — root-cause comment (cdhorne): verbose capture shows the failure is
  **grok's own sandbox opt-in refusing** on a Landlock-less host at $0.00 / 0 turns; a
  0.3 s main-repo poller recorded **0** events; "not the pipeline's worktree-isolation
  audit"; resolution "**No code change**. Restore the `providers.grok` block … Closing as
  a config regression." Names one optional, separate follow-on: persist the
  confinement/refusal reason to the step log (relates #303).
- The issue is **not actually closed** — the timeline shows no `closed` event until the
  #325 merge.
- 2026-07-21 18:22 (07-20 18:22 -0600, commit `38ce26f`) — authoring-review loop enabled;
  message states grok host enablement "**stays uncommitted** — local supervised-dogfooding
  config, not a repo default."
- 2026-07-22 01:18 (base `477b757`, PR #324 "failure legibility Phase 1") — the tracked
  `.pelaggio.yml` **gains** `providers: grok: { bin, allow-unsandboxed-fallback: true }`
  as an unannounced rider; #324's message does not mention it.
- 2026-07-22 01:22 — autopilot plan comment posted on the still-open #308: "Fix Grok
  confinement snapshot false positives." It never acknowledges the root-cause comment.
- 2026-07-22 01:37 — head commit `d9b0419` authored. 01:38 — PR #325 opened ("Fixes
  #308"). 01:40 — `ci` check SUCCESS. 01:45:53 — automated review PASS comment
  (`providers=claude/claude`, $1.88, survivors=0). 01:46:32 — author (cdhorne) merges;
  merge commit `1dc85f7`; merge closes #308. No human review (`reviews: []`).
- 2026-07-22 01:46:34 — issue close comment: "Shipped via PR #325 … confinement snapshot
  retries on transient git-exec failure vs proven mutation. Helps parallel robustness."

## Question records

### Q1 — Does the change fix #308's reported failure (the "Fixes #308" causal claim)?

- **Question:** An accountable reviewer must establish whether the merged change fixes
  the reported symptom: grok deterministically failing `error_confinement` in any
  mutating seat.
- **Status:** Contradicted.
- **Basis:** The corpus refutes the PR's own causal story. #308's root-cause comment
  (2026-07-20 22:48Z) establishes with direct evidence (verbose capture "Grok sandbox
  requires Landlock…", $0.00 / 0 turns, poller recorded zero main-repo events, `git
  status` never failed) that the symptom was grok's own fail-closed sandbox opt-in
  missing from config — "not the pipeline's worktree-isolation audit", "No code change"
  needed. PR #325's summary re-asserts the refuted theory ("grok … could trip the
  confinement audit … transient `index.lock` collision") and claims "Fixes #308". No
  snapshot-execution failure was observed anywhere in the case evidence — the #308
  capture explicitly recorded none.
- **Closure:** Not closed as stated; see Q3 for the change's true merits and Q2 for the
  symptom's actual remediation. The gate outcome (merge) does not need reversal, but the
  causal record is false.
- **Residual:** Correct the record so PR #325 / #308 do not teach future readers (or
  future autopilot picks) the refuted cause.
- **Authority:** Maintainer (cdhorne) — owner of both artifacts.
- **Disposition:** Correct (record annotation), not reject.

### Q2 — Was the actual #308 symptom remediated, and with what custody?

- **Question:** The reviewer must establish that the real fix (restore
  `providers.grok` opt-in config) exists, is verified, and has auditable custody.
- **Status:** Established, with a material custody caveat.
- **Basis:** Root-cause comment: config restored and verified
  (`CONFIG.grokAllowUnsandboxedFallback = true`), full cycle previously landed with grok
  dropped. Tracked `.pelaggio.yml` at base/head contains `providers.grok.bin` +
  `allow-unsandboxed-fallback: true`; git history shows it entered the tracked file in
  base commit `477b757` (PR #324, an unrelated diagnostics change) with no mention in
  that commit's message — **directly reversing** commit `38ce26f`'s stated posture that
  this host-level enablement "stays uncommitted … not a repo default". The root-cause
  comment itself warns the flag is for "a supervised run with an external containment
  boundary" only.
- **Closure:** The symptom's remediation is established. The custody question is not
  closed: a security-posture default (`allow-unsandboxed-fallback: true`) became repo
  config as an unreviewed rider.
- **Residual:** Decide whether committed `allow-unsandboxed-fallback: true` is an
  acceptable repo default, or should return to local-only (untracked) supervised-run
  config per the 38ce26f posture.
- **Authority:** Maintainer as confinement-policy owner (ADR-0001 spine; "worktree
  isolation is load-bearing" invariant).
- **Disposition:** Escalate/decide (follow-up outside #325's diff; #325 itself did not
  introduce it).

### Q3 — Setting the false linkage aside, does the change fix a real defect on its own merits?

- **Question:** Whether the diff is justified by a defect actually present at base.
- **Status:** Established for the misclassification/diagnostics defect; residual for the
  retry's motivating incidence.
- **Basis:** At base, both the pre- and post-step `snapshotForbiddenRoots` catch blocks
  set `confinementRoots = forbiddenRoots.map(resolve)` — a snapshot **execution** failure
  was reported as `forbidden root changed during <step>` listing every root, i.e. an
  unproven mutation claim (visible in the diff's minus lines). The `index.lock` collision
  class is real and previously observed (the pre-existing `--no-optional-locks` comment
  documents concurrent-snapshot collisions). The diagnostics half (`errorDetail`
  persistence; replacing the stale provider tail) implements the exact follow-on the
  root-cause comment named as legitimate separate work (relates #303). However, the
  corpus contains **no observed** snapshot-execution failure after `--no-optional-locks`
  was in place — the retry is prophylactic hardening, not a fix for a reproduced failure;
  the issue-close comment's softened claim ("Helps parallel robustness") is the accurate
  one.
- **Closure:** Change is acceptable on the re-scoped rationale: correct classification +
  durable diagnosis + bounded prophylactic retry.
- **Residual:** None blocking; the honest rationale should replace the "Fixes #308"
  framing (folds into Q1's record correction).
- **Authority:** Maintainer.
- **Disposition:** Accept (with corrected rationale).

### Q4 — Does the retry weaken the fail-closed confinement gate?

- **Question:** The load-bearing invariant: the audit must stay deterministic and
  fail-closed; a retry must not convert real violations into passes.
- **Status:** Established — it does not.
- **Basis:** Verified in the head diff and tests: only runner **throws** are retried
  (fixed budget `3 × 25 ms`, constants not config); the first successful clean/dirty
  porcelain is returned immediately and never re-polled; exhausted attempts throw with
  the last concrete git diagnostic; pre- or post-snapshot execution failure still
  classifies the step `ok:false, subtype:error_confinement`; a proven status delta still
  fails with the distinct sorted changed-roots wording; effect dispatch remains
  suppressed on confinement (pipeline test injects a throwing `dispatchStepEffects` to
  prove it). Baseline semantics are unchanged as a delta gate: a write completing inside
  the 25 ms retry window becomes pre-step baseline exactly as a write completing just
  before a first-attempt success always did — no new masking class. The retry sits in
  the snapshot mechanism, provider-neutral, shared by the whole-step audit and the
  main-checkout observer (`createMainCheckoutDeltaObserver` → `snapshotForbiddenRoot`,
  helpers.ts:167).
- **Closure:** No human decision remains; the invariant holds by inspection and by
  independently executed tests (Q5).
- **Residual:** None.
- **Authority:** — (closed).
- **Disposition:** Accept.

### Q5 — Is the automated PASS trustworthy? (The issue forbids assuming it.)

- **Question:** Whether the green `ci` check and the automated review PASS actually
  reflect a passing, reviewed change at the merged SHA.
- **Status:** Established by independent re-execution, not by trusting the checks.
- **Basis:** I ran the two touched test files at the frozen head in the experiment clone
  (`npx tsx --test … helpers.test.ts pipeline.test.ts`): **246/246 pass, 0 fail**.
  Check-runs on `d9b0419`: `ci` SUCCESS (01:40:09Z), `local-mode-diagnostic` SUCCESS,
  `pr-review-ci` skipped by design; required `review` **status** SUCCESS posted by the
  local runner. The gate review's substance (no blockers; the `Atomics.wait` note) is
  consistent with my own reading of the diff.
- **Closure:** Content-verified. Note the PASS's *independence* is weak (Q6), but its
  *correctness* is corroborated.
- **Residual:** None for this PR.
- **Authority:** — (closed).
- **Disposition:** Accept.

### Q6 — Was the review/merge process conformant, given self-posted status, self-merge, and a dead reviewer seat under "Diversity: met"?

- **Question:** Whether an author-merged PR, whose required `review` status was posted by
  the author's own local runner, with gate providers `claude/claude` and an authoring
  loop where the codex seat produced a schema-echo stub (1/2 reviewers), satisfied the
  governing policy — and what decision, if any, remains.
- **Status:** Established policy-conformant, with a disclosed semantic gap; residual is a
  policy question, not a per-PR one.
- **Basis:** `docs/pr-review.md` at the case revision: local mode is the sanctioned
  runner for this repo (`review.runner: local`, trusted-tree, fail-closed-by-absence
  status design); and explicitly: the `prefer` diversity policy "reflects the
  **configured seats**, not a runtime credential probe." So "Diversity: met" alongside
  "pass 1 codex … the seat did not review the diff" is the documented semantics, and the
  seat failure is transparently disclosed in the PR's own review record. Substantively,
  effective runtime review of this Claude-authored change was Claude-only, with no human
  review (`reviews: []`) and an 8.5-minute open-to-merge window.
- **Closure:** No per-PR decision remains — the informed maintainer exercised acceptance
  by merging, and every deviation was disclosed in-corpus.
- **Residual:** Policy-level: whether diversity accounting should reflect realized seats
  rather than configured seats (a "met" record over a claude-only realized review is
  technically true but reads stronger than what happened).
- **Authority:** Maintainer as review-policy owner (pr-review.md / ADR-0016 lineage).
- **Disposition:** Accept the merge; flag the accounting-semantics question for policy
  review.

### Q7 — Revision freshness: was the work built on the issue's current state?

- **Question:** Whether the plan/PR reflect the freshest corpus state of #308 at
  authoring time.
- **Status:** Contradicted (stale record).
- **Basis:** The plan comment (2026-07-22 01:22Z) postdates the root-cause comment by
  ~26.5 h yet is titled "Fix Grok confinement snapshot false positives", opens with grok
  seat enablement as the outcome, and nowhere acknowledges the config-regression
  resolution or the "No code change" verdict. The issue remained formally open (the
  timeline shows no close event on 07-20 despite "Closing as a config regression" in the
  comment), so the autopilot re-picked it and executed the original theory. Per the
  experiment's exclusions I do not infer from the open state either that the human
  authorized code work or that they forgot to close — only that the record permitted the
  re-pick and the same human then merged the result.
- **Closure:** For this PR, subsumed by Q1's record correction and Q3's re-scoped
  acceptance.
- **Residual:** Process-level: whether an issue whose resolution comment says "no code
  change" should remain autopilot-pickable without the picker being required to
  reconcile the newest comments. (Observation only — #752 bars implementing anything
  from this.)
- **Authority:** Maintainer as pipeline/process owner.
- **Disposition:** Correct the record; escalate the pickability question as a process
  observation.

### Q8 — Do the shipped claims (PR body, docs) match the shipped behavior?

- **Question:** Whether the PR's factual claims and the amended docs describe what the
  code does.
- **Status:** Established.
- **Basis:** Verified against the head tree: retry shared with the main-checkout
  tool-window observer (claimed and true — the observer calls `snapshotForbiddenRoot`
  with default opts); `errorDetail` unbounded on the step log while `outputTail` is the
  bounded first-200-chars form (claimed and true; the first-vs-last-200 asymmetry with
  provider tails is deliberate and commented); `StepLog.errorDetail` optional/
  back-compatible; docs amendments (`pipeline.md`, ADR-0001 amendment) state the same
  mechanism-not-policy framing the code implements. Additionally, because the
  `errorDetail` condition is subtype-based, provider-sourced `error_confinement` results
  (like grok's own sandbox refusal) also get their text persisted — partially delivering
  the #303 follow-on the root-cause comment asked for (the content of provider-side text
  was not separately verified).
- **Closure:** No decision remains.
- **Residual:** None.
- **Authority:** — (closed).
- **Disposition:** Accept.

### Q9 — Synchronous `Atomics.wait` sleep on the event loop

- **Question:** Whether the sync sleeper is an acceptable mechanism.
- **Status:** Not material.
- **Basis:** Fires only on snapshot-execution failure, bounded at ≤ 2 × 25 ms per
  snapshot; required sync for PreToolUse-hook usability; surfaced and reasoned about by
  the automated review (note-level).
- **Closure:** Below decision threshold.
- **Residual / Authority / Disposition:** None / — / accept.

### Q10 — Did closing #308 leave the underlying failure class unresolved?

- **Question:** Whether anything about the original symptom or its recurrence class
  survives the close.
- **Status:** Residual, small.
- **Basis:** The symptom's fix is config (Q2), now tracked — which incidentally removes
  the recurrence class the root-cause comment described (local uncommitted config lost in
  a reconciliation merge). Whether grok seats actually succeed post-merge is outside the
  frozen corpus (no requirement to reconstruct later runs; no unresolved question here
  needs them).
- **Closure:** Close stands; attribution is Q1's problem, not the close itself.
- **Residual:** None beyond Q2's default-posture decision.
- **Authority:** Maintainer.
- **Disposition:** Accept.

## Metadata

- **Run start (UTC):** 2026-08-31T21:25:02Z (recorded before opening any corpus surface)
- **Run end (UTC):** 2026-08-31T21:33:00Z (artifact complete)
- **Elapsed:** ~8 minutes of agent wall-clock
- **Working copy:** `/home/chris/workspace/pelaggio-exp-752`, detached at
  `d9b04193eb7d3f6578c1ec2551721ec03f0aba1a` (verified before reading)
- **Oracle:** not accessed; Cloud repo and all `pelaggio-run-*` / main-workspace paths
  untouched.

### Opened source surfaces (complete)

GitHub (gh CLI, repo pelaggio/pelaggio):

1. `gh issue view 752` and `gh issue view 752 --comments` (no comments)
2. `gh issue view 308` and `gh issue view 308 --comments` (all 3 comments)
3. `gh pr view 325` (body) and `gh pr view 325 --comments` (both comments)
4. `gh pr view 325 --json state,mergedAt,mergedBy,mergeCommit,baseRefName,headRefName,reviews,statusCheckRollup,commits`
5. `gh api repos/pelaggio/pelaggio/issues/308/timeline`
6. `gh api repos/pelaggio/pelaggio/issues/325/timeline`
7. `gh api repos/pelaggio/pelaggio/commits/d9b0419…/check-runs`

Git objects (experiment clone):

8. `git cat-file -t 477b757…`; `git log -1` for `477b757…` and `d9b0419…`
9. `git diff 477b757…d9b0419` — stat and full content, all 8 changed files
   (helpers.ts, pipeline.ts, types.ts, helpers.test.ts, pipeline.test.ts, mocks.ts,
   docs/agent-context/pipeline.md, docs/decisions/0001-worktree-write-confinement.md)
10. `git log … -- .pelaggio.yml` (history to head)
11. `git show 38ce26f -- .pelaggio.yml` (message + diff)
12. `git show 477b757 -- .pelaggio.yml` (message + diff)

Head-tree files (frozen revision):

13. `AGENTS.md` (full)
14. `docs/pr-review.md` (lines 1–84 region via grep + reads)
15. `docs/config.md` (grep for `grok` only)
16. `.pelaggio.yml` (grep for `providers` block)
17. `packages/pelaggio/scripts/pelaggio/helpers.ts` (grep for
    `snapshotForbiddenRoot`/`createMainCheckoutDeltaObserver` call sites)

Local execution (analysis only, no tracked-file writes):

18. `pnpm install --frozen-lockfile`; `npx tsx --test` on
    `helpers.test.ts` + `pipeline.test.ts` at head → 246 pass / 0 fail
