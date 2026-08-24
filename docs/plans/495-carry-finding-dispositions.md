# Plan — #495: Carry PR-gate finding dispositions across re-pushed SHAs

> Item: [#495](https://github.com/pelaggio/pelaggio/issues/495) · scope M · plan authored on
> `feat/issue-495-carry-finding-dispositions-across-shas`.
>
> **Dependency:** PR #592 (adjudicable disagreement shapes, #525) lands before this item's
> implement begins. Everything below is designed against the **post-#592** shape of
> `review/adjudication.ts` — `PrAdjudicableAgreement = "consensus-block" | "disagreement"`,
> the sidecar accepting both, and `INELIGIBLE_BREAKERS` reduced to `provider-diversity`.
> Nothing here edits those seams, but tests must cover carry runs that terminate in the
> #592 disagreement/`invalid-pass` split, and the implement step should rebase on main
> after #592 merges before wiring.

Plan-path note: `npx pelaggio roadmap plan-path --id 495` resolves to the gitignored
`.dev/plans/495.md` (github-issues adapter). This plan stage must commit and push a durable
artifact, so the plan lives at the committed `docs/plans/` convention instead; the canonical
`.dev` path cannot hold a committed doc.

## Problem

Each PR-gate run starts discovery from scratch: `carried` in `runPrReviewGate`
(`pr-review-cli.ts`) is a per-invocation `Map`, so a re-pushed PR (new `headSha`) re-rolls
the full drivers × labels fan-out. Every run samples a different subset of the
plausible-finding pool, findings refuted at real cost in run N are re-discovered and
re-verified in run N+1, and consensus-pass across ~6 fresh cold cells is an exponential bar
in diff size. This mechanizes what the operator does by hand in pass-fix-go adjudication:
read the interdiff, confirm each fix addresses its finding, and don't re-open the world.

## Invariants (binding, restated from the charter)

- **I1 — Fail-closed preserved.** Carry may auto-refute a previously-refuted finding
  **only** when its anchoring context is untouched by the interdiff; anything the interdiff
  touches is re-verified fresh. Every failure of the carry machinery (missing, malformed,
  stale, unbindable, ambiguous, non-ancestor) degrades to today's cold behavior with a
  diagnostic — never to a weaker gate.
- **I2 — Survivors persist.** Carried survivors persist until explicitly refuted by a
  complete, valid verification report — the existing within-run carry contract
  (`applyReviewPass`: omission never refutes) extended across runs. This preserves the
  repo invariant "PR candidate blockers may be removed only by a complete, valid isolated
  verification report; verifier failure retains them."
- **I3 — Safety-class never self-clears.** A safety-tier finding is never auto-refuted by
  carry, under **either** its recorded tier **or** the currently-configured taxonomy's
  resolution of its recorded class (belt-and-braces: a taxonomy edit between pushes cannot
  demote a safety finding into auto-refutable).
- **I4 — Local runner only.** Only local runs (`runner: "local"` — the drain and direct
  non-CI `pr-review`) read or write disposition records. CI's ephemeral checkout is a noted
  residual, out of scope; CI behavior is byte-identical.
- **I5 — Storage.** Durable per-run dispositions (survived + refuted fingerprints) bound to
  `(prNumber, headSha)`, in a sibling store of `.dev/pr-review-gate-records/`.
- **I6 — Mechanism/policy spine (ADR-0014).** The carry trigger, the untouched predicate,
  the auto-refutation, and the discovery-narrowing rule are all deterministic harness logic
  over git trees and validated records. No model ever decides whether or how far to narrow;
  models remain policy inputs (discovery findings, verification decisions) to a
  deterministic gate.

## Current mechanism (seams this plan builds on)

- `pr-review-cli.ts` / `runPrReviewGate`: per-invocation `carried:
  Map<fingerprint, ReviewFinding>`; `runVerificationPass` already merges `carried` into the
  candidate set (one batched `pr-verify` call per pass); `evaluateReviewConvergence` +
  `applyReviewPass` (`review/findings.ts`) remove a fingerprint only on an explicit
  `refuted` decision from a valid pass. Terminal aggregation builds the
  `verifications` map and the `adjudicationSource` draft, and returns them on
  `PrReviewGateResult`.
- `reviewFindingFingerprint` (`review/findings.ts`): identity is
  `(normalized message, path, line)` — deterministic, harness-owned.
- Persistence: `.dev/pr-review-gate-records/<pr>-<sha>.json`
  (`pr-review-gate-record.ts`, strict closed-key validation, atomic tmp+rename) and the
  SHA-bound adjudication sidecar `.dev/pr-review-adjudication-sources/<pr>-<sha40>.json`
  (`review/adjudication.ts`, digest-bound to the exact fleet-record bytes). Two write
  sites: `persistLocalGateEvidence` (direct CLI, `pr-review-cli.ts`) and the drain loop in
  `pipeline.ts` (`runLocalReviewDrainOnce`, ~L3656–3732).
- Trust: both stores are in the step-runner's #510 Bash register denial
  (`BASH_DENIED_DEV_REGISTERS`) and the semantic evidence-store write denial
  (`step-runner.ts` ~L178, ~L235); record selection never trusts `reviewedAt` (#510: a
  model-writable timestamp is not an ordering signal).
- `pr-adjudicate-cli.ts`: existing interdiff precedent — ancestry via
  `git merge-base --is-ancestor <reviewedSha> <headSha>`, interdiff via
  `git diff --no-ext-diff <reviewedSha>..<headSha>`.

## Design

### D1 — Disposition record: schema, store, binding, validation

New module `packages/pelaggio/scripts/pelaggio/review/carry.ts` (sibling of
`adjudication.ts`; named `carry` to avoid colliding with the existing
`PrReviewFindingDisposition` operator-adjudication type in `pr-review-gate-record.ts`).

Store: `MAIN_REPO/.dev/pr-review-finding-dispositions/<prNumber>-<headSha40>.json`
(gitignored via `.dev/`). Exported constant `PR_FINDING_DISPOSITIONS_DIR =
"pr-review-finding-dispositions"` so the step-runner deny list names the exact store path
(same contract as `PR_REVIEW_GATE_RECORDS_DIR`).

```ts
export interface PrCarryFindingEntry {
  finding: ReviewFinding;      // severity ("must-fix" only) / message / path? / line?
  fingerprint: string;         // must equal reviewFindingFingerprint(finding)
  class: ReviewFindingClass;   // well-formed class id (emission-time classification)
  tier: FindingTier;           // "safety" | "judgment", resolved at emission
}

export interface PrCarrySurvivorEntry extends PrCarryFindingEntry {
  /** Last survives-evidence when this run verified it; null when retained because the
   *  required pass was incomplete (retention-without-verification is toward blocking). */
  verification: { id: string; rationale: string } | null;
}

export interface PrCarryRefutedEntry extends PrCarryFindingEntry {
  refutation: {
    /** "verified": a complete valid verification report in the recording run refuted it.
     *  "carried": auto-refuted via untouched-path carry; chains back to a verified origin. */
    provenance: "verified" | "carried";
    id: string;           // candidate id (C<n>) in the originating verification report
    refutedAtSha: string; // 40-hex head of the run whose valid verification refuted it
  };
}

export interface PrFindingDispositionRecordV1 {
  schemaVersion: 1;
  prNumber: number;
  itemId: string;
  headSha: string;            // 40-hex, lowercased — the reviewed head this run bound to
  gate: "pass" | "block";
  agreement: PrReviewAgreement;
  ok: boolean;
  /** sha256 of the exact on-disk fleet gate record for (prNumber, headSha) — the same
   *  binding discipline as the adjudication sidecar's fleetRecordDigest. */
  fleetRecordDigest: string;
  reviewedAt: string;         // ISO; diagnostic only — NEVER a selection/ordering signal
  survived: PrCarrySurvivorEntry[];
  refuted: PrCarryRefutedEntry[];
}
```

Validation mirrors `validateAdjudicationSourceRecord` exactly in style: closed key sets at
every level (`requireClosedKeys`), 40-hex SHA, 64-hex digest, `fingerprint ===
reviewFindingFingerprint(finding)` recomputed, no duplicate fingerprints within or across
the two arrays, `severity === "must-fix"` on every entry, entry caps
(`FINDING_DISPOSITION_MAX_ENTRIES = 128` per array), byte cap
(`FINDING_DISPOSITION_MAX_BYTES = 1 MiB`, checked on read via `statSync` and on write),
`provenance`/`tier` from closed sets. `readPrFindingDispositionRecord` returns `null` on
any failure (caller emits a stderr diagnostic and runs cold — I1); write is atomic
tmp+rename with mode `0o600`, validating before serialize, exactly like the two existing
stores.

Record content rules (enforced at draft-build time, D4 below):

- `survived` = the terminal `carried` map, enriched with class/tier via
  `materializeAuthoringFinding` + `tierOf` (the same emission-time classification the
  sidecar uses) and the `verifications` evidence when present.
- `refuted` =
  1. every fingerprint explicitly refuted this run by a **valid** pass
     (`provenance: "verified"`, `refutedAtSha` = this run's head) — any tier;
  2. every auto-refuted-this-run entry (`provenance: "carried"`, origin `refutedAtSha`
     preserved) — necessarily non-safety with an untouched path (D4);
  3. every prior refuted entry not re-encountered this run whose `finding.path` is present,
     untouched by **this** hop's interdiff, and non-safety under I3 —
     carried forward (`provenance: "carried"`, origin preserved) so refutation memory
     survives reviewer-sampling gaps. Entries failing any of those conditions drop
     (their refutation could never auto-apply again; a later re-discovery is verified
     fresh, which is the safe direction).
- Refutation granularity is **per-pass validity**, mirroring `applyReviewPass`: an early
  valid pass's refutation is recorded even when a later pass makes the whole run
  `ok: false` — the same granularity the within-run contract already applies. An invalid
  pass never contributes a refutation (its dispositions are the synthesized
  retained-because-incomplete `survives` entries).
- Written on `gate: "pass"` **and** `"block"`; never on `park` (mirrors
  `persistLocalGateEvidence`'s park guard). A pass-record has empty `survived` and keeps
  the refutation memory.

### D2 — Prior-record selection: git ancestry, fail-closed

On a run for `(pr, itemId, reviewedSha)` with carry enabled (D7), the harness selects at
most one prior record:

1. `listPrFindingDispositionRecords(root)` filtered to `prNumber === pr && itemId ===
   itemId && headSha !== reviewedSha` (same-SHA reruns are deliberately excluded — the
   charter targets re-pushed SHAs; a same-SHA re-review behaves exactly as today).
2. Keep candidates where `git merge-base --is-ancestor <record.headSha> <reviewedSha>`
   exits 0 in the trusted local repo. This one call proves object presence **and**
   ancestry; a git error or non-zero exit drops that candidate with a diagnostic. No extra
   fetch is needed: `resolveReviewedHead` / `prepareReviewHead` already fetched
   `pull/<n>/head`, and an ancestor of the fetched head is reachable from it (the local
   main checkout is not shallow). A force-push/rebase makes every prior a non-ancestor →
   cold run (I1).
3. Pick the **maximal** candidate: the record `r*` for which every other candidate `c`
   satisfies `is-ancestor(c.headSha, r*.headSha)`. If no candidate dominates (the set is
   not totally ordered along the branch) → cold run with a diagnostic naming the files —
   the #510 ambiguity-refusal pattern. Ancestry is computed ground truth; nothing inside
   the records (notably `reviewedAt`) participates in ordering.
4. Bind: read `.dev/pr-review-gate-records/<pr>-<r*.headSha>.json` bytes;
   `sha256(bytes) === r*.fleetRecordDigest` or cold with diagnostic. This chains the
   disposition record to the deny-listed gate-record store and rejects mix-and-match
   staleness.

Selection lives in `review/carry.ts` as
`selectCarrySource(records, { prNumber, itemId, reviewedSha, isAncestor, readFleetBytes })`
with injected predicates so tests never shell out.

### D3 — Interdiff computation and the "anchoring context untouched" predicate

**The two SHAs:** `prior = r*.headSha` (full 40-hex from the validated record) and
`current = options.reviewedSha` (full 40-hex, already required for the adjudication
sidecar; absent `reviewedSha` → carry disabled, cold run).

**The command:** in the trusted local repo (never the PR-head data checkout):

```
git diff --no-ext-diff --no-renames --name-only -z <prior>..<current> --
```

parsed on NUL, each path through `normalizeGitPath`, into `touchedPaths: Set<string>`.

- **Two-dot, not three-dot.** Two-dot is the tree-to-tree diff — exactly the byte-identity
  question soundness needs ("is this file's content identical at both SHAs"). Three-dot
  (merge-base) would *exclude* content brought in by a freshness merge of `origin/main`,
  counting a file whose blob changed as "untouched" — unsound. Two-dot after a freshness
  merge classifies more paths as touched, which only forces fresh re-verification — the
  fail-closed direction. Same form `pr-adjudicate` already uses.
- **`--no-renames`.** Rename detection is a similarity heuristic (config- and
  version-sensitive), not a pure function of the two trees. With `--no-renames` a rename
  is a delete + create and **both** paths enter `touchedPaths`; a finding in a renamed,
  copied, created, or deleted file is therefore always "touched" → re-verified fresh.
  Binary changes and mode changes list their path like any change; no special-casing
  needed at path granularity.
- **"Anchoring context untouched" = path-level:** `untouched(entry)` :=
  `entry.finding.path` is present and `normalizeGitPath(entry.finding.path) ∉
  touchedPaths`. A pathless (repo-level) finding is never auto-refutable.

DECISION: untouched-predicate granularity | chose: path-level (file wholly absent from the
two-dot interdiff) | alternatives: hunk-overlap against recorded anchor hunks
(`evaluateInterdiffPolicy`-style); hunk-overlap plus line-shift tracking.

Rationale: path-level soundness is trivially provable — an untouched file has an identical
blob at both SHAs, so the prior refutation's complete valid verification examined exactly
the bytes present now. Hunk-overlap is unsound without line-shift tracking: fingerprints
are positional `(message, path, line)`, and an edit above an un-overlapped anchor shifts
content under a stable fingerprint, letting stale refutation evidence apply to different
code (fail-open) — and shift-tracking is precisely the coordinate arithmetic that bred the
ADR-0026 lock-and-gate defect cluster. The conservatism costs almost nothing: an
auto-refute denied by path-level merely re-enters the verification candidate set, and
`runVerificationPass` batches all candidates into **one** verify call per pass — the
marginal cost of a few extra candidates is ~zero, while the expensive thing this feature
kills (re-discovery fan-out) is unaffected. The recorded-hunk machinery stays where it is
(the adjudication sidecar), serving churn containment, a different problem.

Known residual of any per-finding anchor (path-level or hunk-level): a refutation's
*rationale* may rest on cross-file context ("caller X already handles this") that the
interdiff changed while the finding's own file did not. Accepted: whole-tree anchoring
would make carry never fire; the exposure is bounded by I3 (safety findings never
auto-refute) and by D5 (the changed file itself gets a full narrowed discovery pass, which
can re-raise the issue as a new finding at the changed site).

**Narrowed-discovery refs (D5):** the seats' review range for a narrowed run is
`prior..current` expressed through the existing `trustedLocalContext` base/head refs.
Deterministic preflight: `git -C <diffCwd> rev-parse --verify <prior>^{commit}` must
succeed in the seat-visible diff checkout; failure → cold run with diagnostic (I1). In
practice it succeeds at both call sites — the drain's `prepareReviewHead` checkout is a
`git worktree add` from the trusted repo and shares its object store — so the preflight is
a cheap belt-and-braces guard, not a new fetch path. The **inspection** diff
(`readInspectionDiff` over the original `diffBaseRef...diffHeadRef`) is unchanged and keeps
serving security classification, sidecar hunk-mapping, and disposition emission — two
ranges, two roles, both computed by the harness.

### D4 — Carry semantics inside `runPrReviewGate`

New option on `RunPrReviewGateOptions`:

```ts
carry?: {
  priorSha: string;                                  // 40-hex, validated ancestor
  seedSurvivors: ReadonlyMap<string, ReviewFinding>; // prior survived, fingerprint-keyed
  autoRefutable: ReadonlyMap<string, PrCarryRefutedEntry>; // eligible per D3 + I3 ONLY
  carriedForward: readonly PrCarryRefutedEntry[];    // rule-3 memory for the new record
  narrowed: boolean;                                 // D5: interdiff-scoped discovery
}
```

The caller (D6) builds it via `planCarry(record, touchedPaths, taxonomy)` in
`review/carry.ts`, which applies eligibility **before** the gate ever sees an entry:
auto-refutable requires path present ∧ path untouched ∧ `tier !== "safety"` ∧
`tierOf(class, currentTaxonomy) !== "safety"` (I3). Prior survivors seed unconditionally —
seeding is toward blocking, so no eligibility test applies (I2); safety survivors seed like
any other.

Inside `runPrReviewGate`:

1. **Seeding:** `let carried = new Map(options.carry?.seedSurvivors ?? [])` replaces the
   empty initializer. Everything downstream is existing machinery: seeded survivors join
   the first verification pass's candidates (`runVerificationPass` already merges
   `carried`), persist under `applyReviewPass`'s omission-never-refutes rule, and gate PASS
   still requires converged-empty + consensus-pass. A run whose complete valid verification
   refutes every seeded survivor passes — that is I2's explicit-refutation door, unchanged.
   `previousSurvivorCount` stays uninitialized (no diminishing-returns trip at iteration 1,
   same as today).
2. **Auto-refutation:** in `runVerificationPass`, after assembling `unique` (carried ∪
   this pass's must-fix findings), partition by `options.carry.autoRefutable`: matching
   fingerprints are **withheld from the model verifier's candidate set** and instead
   contribute synthesized dispositions
   `{ id: <fresh C<n> outside the model batch>, finding, decision: "refuted", rationale:
   "Auto-refuted by carry: refuted at <sha7> (<origin id>); <path> untouched by the
   interdiff." }` merged into `pass.dispositions`. The rationale is harness-authored from
   already-published values (candidate id, short SHA, finding path) — no prior model text
   is re-quoted into the public comment, so no new #536-class channel opens. The pass's
   `effectiveVerdict` is computed over the merged disposition set, so a pass whose every
   must-fix finding auto-refutes correctly lands `pass` (today it would dead-end as an
   unverified block). When withholding leaves **zero** model candidates, no verifier call
   is made and the verdict computes from the synthesized dispositions alone — distinct
   from the existing nothing-to-verify early return, which still applies only when nothing
   was withheld either. `applyReviewPass` then processes the synthesized refuted
   decisions identically to model ones — the blocking gate stays deterministic; the prior
   complete valid verification report is the refuting authority (I2's contract, satisfied
   by the recorded report rather than a fresh one).
   A fingerprint in `autoRefutable` that is **also** in `carried` cannot occur
   (`planCarry` asserts survivor/refuted disjointness; the record validator already
   forbids duplicate fingerprints across arrays).
3. **Emission:** terminal aggregation builds a `PrCarryDispositionDraft` — the record of D1
   minus `fleetRecordDigest` — via `buildCarryDispositionDraft` in `review/carry.ts`
   (pure; inputs: carried, verifications, per-pass valid refutations, auto-refuted set,
   `carriedForward`, inspection files, taxonomy, identity). Returned as
   `PrReviewGateResult.dispositionDraft?` — the exact `adjudicationSource` pattern. Track
   valid-pass refutations in the loop with a
   `refutedThisRun: Map<fingerprint, { id; finding }>` updated exactly where
   `evaluateReviewConvergence` applies a valid summary (harness-side mirror of
   `applyReviewPass`'s delete branch).
4. **Comment legibility:** the convergence summary line and the metrics comment gain a
   deterministic carry token — `carry=<priorSha7> seeded=<n> auto-refuted=<m>` (or
   `carry=none`) — so the operator can read from the PR why a run was narrow.

### D5 — DECISION: how far to narrow re-push discovery

DECISION: re-push discovery scope | chose: full drivers × labels fan-out over the
**interdiff only** (`prior..current`), no residual cold pass; cold-run fallback on any
carry-predicate failure | alternatives: (a) retain a reduced cold pass (one cold
full-diff cell + interdiff cells); (b) verify-only rerun, no discovery; (c) model-guided
scope.

Mechanism: when `carry.narrowed` (set by the caller iff carry validated **and** the
two-dot interdiff patch is non-empty), discovery seats receive
`trustedLocalContext` refs `base = priorSha, head = reviewedSha` — they review the delta.
Labels are unchanged: the security signal stays classified over the **full** inspection
diff, so a security-sensitive PR keeps its red-team cell (which also reviews the delta).
Verification, seeding, and auto-refutation are as in D4 and run identically in narrowed
and cold modes. An empty interdiff (rare — e.g. an empty commit) seeds and auto-refutes
but discovers cold, since there is no delta to scope to.

Rationale:

- **The throughput goal is only reachable with a bounded pool.** The series contracts to
  ≤1 re-review pass per landing only if the re-review's finding pool is bounded by the
  delta. A reduced cold pass (a) keeps the pool at full-diff size — it re-rolls the
  lottery with fewer dice, lowering the base of the exponential without removing it, and
  any brand-new cold finding restarts the verify/refute cycle the charter is eliminating.
  `throughput-economy.md`'s data locates landing cost in review and repeat cycles; (a)
  retains the repeat-cycle generator.
- **The risk envelope is precedented and strictly smaller than what we already accept.**
  The operator's pass-fix-go adjudication — which this item explicitly mechanizes — reads
  only the interdiff, and `pr-adjudicate` already re-authorizes a head with **zero**
  discovery, on deterministic churn containment alone. A narrowed #495 run is strictly
  stronger than that accepted path: the full reviewer fan-out plus fresh verification
  runs over every changed line. Cumulatively the whole final diff has full-fleet
  coverage: SHA₀ got the complete cold read, and every subsequent delta gets a complete
  narrowed read.
- **(b) verify-only is rejected** because the fix itself is new, unreviewed code:
  without `pr-adjudicate`'s churn bounds, skipping discovery over the interdiff would
  land arbitrary new code checked only by refute-questions about old findings — weaker
  than both the current gate and `pr-adjudicate`.
- **(c) model-guided scope is barred** by ADR-0014 / I6: the narrowing rule must be
  deterministic harness logic over the interdiff, never a model's call.

**Accepted failure mode (explicit):** a defect *introduced by the fix* whose cause is in
the interdiff but whose symptom lives in unchanged code (e.g. a touched helper's changed
contract silently breaking an untouched distant caller) may escape narrowed discovery —
seats can read the whole repo, but their mandate is the delta, and no cold cell backstops
them. Accepted because: (1) it is the same class of escape already accepted, in larger
form, for `pr-adjudicate` and operator pass-fix-go; (2) the deterministic full-head gates
(typecheck ratchet, tests, CI) are untouched and still run on every head; (3) the first
review of any PR, and any re-push failing the carry predicate (force-push, rebase,
malformed record, digest mismatch, ambiguity), is always a full cold read. Not mitigated
by a reduced cold pass by design — see above.

### D6 — Wiring: two read/write sites, CI guard, config

Carry is threaded only where evidence persistence already lives; the ship-tail cold
pre-flight and any caller not passing `options.carry` are byte-identical to today.

- **Direct CLI (`pr-review-cli.ts` `main()`):** when `!deps.isCi() && head.itemId &&
  reviewedSha` and `policy.carry` (below), resolve priors (D2, via `deps.execFileSync` in
  `REPO`), compute `touchedPaths` (D3), `planCarry`, and pass `options.carry` into
  `runPrReviewGate`. After the run, `persistLocalGateEvidence` gains
  `dispositionsRoot` + `writeDispositionRecord` and writes
  `result.dispositionDraft` with `fleetRecordDigest` computed from the just-written fleet
  record bytes — under the same consistency guard style as the sidecar (identity fields
  must match the gate record; park already returns early). `PrReviewDeps` gains
  `dispositionsRoot?` and `writeDispositionRecord` so tests pin the store away from the
  host repo (the existing `gateRecordsRoot` pattern and warning comment apply verbatim).
- **Drain (`pipeline.ts`, `runLocalReviewDrainOnce` ~L3576–3743):** same resolution before
  `review.runReviewGate(...)` (the drain already holds `pr.headSha`, `pr.itemId`, and the
  prepared refs) and the same draft write after `review.writeGateRecord`, next to the
  sidecar write. The drain's injected `review` deps bundle (~L2574/L3462) gains
  `dispositionsRoot` + `writeDispositionRecord` (hermetic-guarded like `gateRecordsRoot`).
  No refactor of the drain's inline gate-record construction — additive only.
- **Config:** `ReviewConfig.carry: boolean` (default `true`) in `config.ts` +
  `.pelaggio.yml` parsing + `docs/config.md`. A kill-switch for a mechanism that changes
  merge-gate behavior; `false` restores today's behavior exactly (no reads, no narrowing —
  records still written, so re-enabling has priors).
- **Trust (#510 parity):** add `PR_FINDING_DISPOSITIONS_DIR` to
  `BASH_DENIED_DEV_REGISTERS` and the new root to the semantic evidence-store denial list
  in `step-runner.ts` (~L178, ~L235) — a seat that could write this store could forge an
  auto-refutation of a real finding, the exact fail-open #510 closed for gate records. The
  `fleetRecordDigest` binding additionally rejects records that don't chain to a real
  reviewed SHA, but the deny list is the load-bearing control, same as for the existing
  stores.

### D7 — Interactions and accepted limitations

- **Sidecar with carried survivors:** a carried survivor's `line` is in prior-head
  coordinates; if its file was touched, `mapFindingToInspectionHunk` may fail against the
  current inspection diff and `buildAdjudicationSourceDraft` returns `undefined` — no
  sidecar, `pr-adjudicate` refuses, full review remains the fallback. Fail-closed;
  accepted (the sidecar is an optional fast path). Untouched files map cleanly.
- **Stale-line carried survivors** are harder for a verifier to refute (positional drift)
  and therefore stay blocking — annoying, not unsafe; resolved by refutation at the
  shifted reality, operator adjudication, or re-scope.
- **Disagreement/invalid terminals (post-#592):** carry activates regardless of the prior
  record's `agreement` — survivors seed (toward blocking) and `refuted` entries were
  per-pass-valid by construction (D1). A carried run can itself terminate in the #592
  disagreement shape and still emit both sidecar and disposition record.
- **Store hygiene:** no GC in this item — consistent with the gate-record and sidecar
  stores (`/tidy` sweep is a possible follow-up, out of scope).
- **Guard classification (ADR-0026):** the carry predicate is a *derived-exclusive* guard
  (derived from git trees + validated records; exclusively harness-computed; degrades to
  the stricter cold behavior). The implement step should walk the
  `docs/agent-context/guarded-actions.md` new-guard checklist against D2–D4 before
  shipping.

## File-by-file change list

1. **NEW `packages/pelaggio/scripts/pelaggio/review/carry.ts`** — everything in D1–D3:
   types (`PrFindingDispositionRecordV1`, `PrCarrySurvivorEntry`, `PrCarryRefutedEntry`,
   `PrCarryDispositionDraft`, `CarryPlan`), constants (`PR_FINDING_DISPOSITIONS_DIR`,
   byte/entry caps), `prFindingDispositionsDir(mainRepo)`,
   `validatePrFindingDispositionRecord`, `writePrFindingDispositionRecord` (atomic),
   `readPrFindingDispositionRecord`, `listPrFindingDispositionRecords`,
   `selectCarrySource` (injected `isAncestor`/`readFleetBytes`),
   `computeTouchedPaths` (parses `-z` name-only output; the git invocation itself lives
   with the callers' exec seams), `planCarry` (eligibility I3/D3, disjointness assert),
   `buildCarryDispositionDraft` (pure emission incl. rule-3 carry-forward).
2. **`packages/pelaggio/scripts/pelaggio/pr-review-cli.ts`** —
   `RunPrReviewGateOptions.carry?`; seeded `carried` init; `runVerificationPass` withheld
   set + synthesized dispositions + verdict-over-merged-set; `refutedThisRun` tracking in
   the convergence loop; `PrReviewGateResult.dispositionDraft?`; carry token in
   summary/metrics; `main()` prior-resolution + threading; `persistLocalGateEvidence`
   extension; `PrReviewDeps.dispositionsRoot?`/`writeDispositionRecord`.
3. **`packages/pelaggio/scripts/pelaggio/pipeline.ts`** — drain-site prior-resolution +
   `carry` threading into `review.runReviewGate`; disposition write after the fleet
   record write; `review` deps-bundle fields + hermetic defaults.
4. **`packages/pelaggio/scripts/pelaggio/step-runner.ts`** — deny-list additions (D6).
5. **`packages/pelaggio/scripts/pelaggio/config.ts`** — `ReviewConfig.carry` + default +
   yml parsing.
6. **Docs** — `docs/pr-review.md`: new "Cross-push carry" section (record, selection,
   predicate, narrowing, fallbacks); `docs/agent-context/roadmap-and-ship.md`: one
   paragraph in the PR Review Loop section; `docs/config.md`: `review.carry`.
7. **Tests** — NEW `__tests__/review-carry.test.ts`; extensions to
   `__tests__/pr-review-cli.test.ts` and the drain coverage in the pipeline/review-sweep
   test suites (whichever file exercises `runLocalReviewDrainOnce`'s persistence today).

## Test plan (node:test; exact scenarios)

`review-carry.test.ts` (pure/unit):

- Record round-trip; strict validation refuses: unknown key (every level), non-40-hex SHA,
  fingerprint mismatch, duplicate fingerprint (within and across arrays), non-must-fix
  severity, bad provenance/tier, oversized file, entry-cap overflow.
- `selectCarrySource`: single ancestor → selected; force-push (no ancestors) → none;
  two ordered priors → maximal wins; unordered set → ambiguous-refusal with diagnostic;
  same-SHA record excluded; wrong pr/item excluded; digest mismatch → refused;
  missing fleet record → refused; `reviewedAt` never consulted (forged-future timestamp
  does not change selection).
- `computeTouchedPaths`: NUL parsing, `normalizeGitPath` application; rename-as-two-paths.
- `planCarry` eligibility: pathless entry never auto-refutable; touched path not
  auto-refutable; safety by recorded tier excluded; safety by current-taxonomy resolution
  of the recorded class excluded (taxonomy-shift case); survivor/refuted disjointness.
- `buildCarryDispositionDraft`: refuted rules 1–3 (incl. carry-forward drop of touched /
  safety / pathless entries); survived enrichment; pass-record shape.

`pr-review-cli.test.ts` (gate behavior, pinned deps/roots as existing tests do):

- **carry-refuted-untouched → auto-refute:** prior-refuted F (untouched path)
  re-discovered → withheld from the verifier's candidate JSON (assert prompt), synthesized
  refuted disposition in the comment, gate PASS with consensus-pass; new record carries F
  with `provenance: "carried"` and origin SHA.
- **carry-refuted-touched → re-verify:** F's path in the interdiff → F reaches the model
  verifier; survives → BLOCK.
- **survivor persists absent explicit refutation:** seeded survivor + verifier omission →
  pass invalid (missing-decision) → survivor retained, BLOCK; explicit valid refutation →
  PASS (I2 both directions).
- **safety never self-clears:** prior-refuted safety finding, untouched → still verified
  fresh, never synthesized.
- **malformed/stale record → cold with diagnostic:** malformed JSON, digest mismatch,
  non-ancestor — each asserts a stderr diagnostic, no seeding, no narrowing, gate result
  byte-equal to a no-priors run.
- **first-run-no-priors → cold unchanged:** no store → result deep-equals today's
  (regression guard), no disposition read attempted; record still written.
- **narrowing mechanics:** valid priors → seats' trusted-context base ref = priorSha while
  inspection diff/security signal/anchors use the full range; prior unresolvable in
  `diffCwd` → cold; empty interdiff → seeding without narrowing; `review.carry: false` →
  no reads/narrowing, record still written.
- **park → no disposition write; CI (`isCi`) → no read and no write.**
- **post-#592 disagreement terminal:** carried run ending in the `invalid-pass`-breaker
  split writes record + sidecar; refuted entries from its valid passes recorded.
- **auto-refute-everything pass:** a discovery pass whose every must-fix finding
  auto-refutes lands `effectiveVerdict: "pass"` (the D4-2 dead-end guard).

Drain-site test: drain run persists the disposition record next to gate record + sidecar;
disposition-write failure warns and does not change status posting (best-effort parity).

Step-runner test: Bash/semantic denial covers the new store path.

## Non-goals

- CI-runner persistence (I4's noted residual) — CI neither reads nor writes.
- Cross-PR carry; carry across force-push/rebase (deliberate cold reset).
- #593's relabel; any change to `pr-adjudicate`'s evidence chain or churn policy.
- Hunk-level untouched precision (rejected in D3); store GC; same-SHA rerun carry.
- Any change to CI workflow files, the required-status contract, or comment markers.

## Migration / compat

- Absent disposition files → behavior exactly as today (every new path is gated on a
  validated record; the first release only starts writing).
- No changes to existing record schemas; `PrReviewGateResult` and `RunPrReviewGateOptions`
  gain optional fields only; all existing callers compile and behave unchanged.
- Store is auto-ignored via `.dev/`; no `.gitignore` change. Disabling `review.carry`
  restores prior behavior without cleanup.

## Rubric self-check

- **Correct:** I1–I6 each mapped to a mechanism (D1–D6) and at least one test; the two
  known dead-ends (auto-refute-everything pass; carried-survivor sidecar mapping) are
  handled fail-closed. Spine preserved: every new decision point is deterministic harness
  logic; models only supply findings/decisions.
- **Well-typed:** closed-key validated schema, `provenance`/tier unions, optional-field
  seams; no `any`; draft/record split mirrors the sidecar's.
- **Well-factored:** one new module owning schema+policy, pure with injected effects;
  gate changes ride existing seams (`carried` init, `runVerificationPass`, result draft);
  no drain refactor.
- **Well-tested:** every charter scenario named with its asserted observable; unit/pure
  coverage separated from gate-behavior coverage; hermetic roots pinned.
- **Concise:** reuses `reviewFindingFingerprint`, `materializeAuthoringFinding`, `tierOf`,
  `normalizeGitPath`, atomic-write pattern, `merge-base --is-ancestor`; rejects the
  coordinate-arithmetic variant that would have doubled the surface.
- **Idiomatic:** deferred to `/shakedown` per the two-pass contract.

## Open questions

None blocking. One operator-decidable default: `review.carry` ships `true` (throughput is
the point; `false` is the documented rollback). If the operator prefers a canary period,
flipping the default to `false` at ship time is a one-line change with no design impact.
