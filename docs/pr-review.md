# PR review gate — `review` required status check

An automated, **out-of-context** agentic review that runs on every same-repo pull
request and reports a `review` status check. Wired into branch protection alongside
`ci`, it is the enforced second opinion the autonomous recipe
(`ship.target: auto-merge-pr` + branch protection) needs so an unattended run can
never merge on CI-green alone.

It is deliberately **not** the in-pipeline `shakedown-code` review: that pass reviews
the pipeline's own work *in-context*, before ship. This gate is a fresh SDK session
that reads the PR diff cold — the same shape that has caught things the in-context
review missed.

## In-cycle advisory pre-flight (#424)

PR-mode cycles also run this same gate core **before** ship, from detached cold seats
over `origin/main...<artifact-sha>`, with `skillArguments: --preflight` (no forge PR
number, no `gh pr *`, no comment or `review` status). That pass is **advisory**: one
author revision plus one recheck is the in-cycle cap; leftover findings still open the
PR so the required forge gate can independently recompute and enforce. Pre-flight
output lives only in the cycle log. It must not emit or post the
`<!-- pr-review-metrics ... -->` marker anywhere durable — including the ship PR body —
or it would contaminate the gate dataset.

Pre-flight `pr-review` / `pr-verify` spend is already in cycle cost summaries (nested
`step()` rows plus one `review.cost` add). Do not invent a second ledger.

**First-pass cohort** (reproducible from forge data; do not fabricate missing history):
a PR whose **first** clean (`ok=true subtype=success`) `pr-review-metrics` marker is
`gate=pass` **and** that has no `autopilot:revised` label and no
`pelaggio-revise-invocation` comment with `disposition=accepted-*` **before** that
marker. Record the baseline window and sample size when forge data is available.
Formal efficacy analysis is #291.

Example marker query once a one-week baseline window exists:

```text
<!-- pr-review-metrics gate=pass ok=true subtype=success ... -->
```

Join to the PR's labels/comments and keep only PRs whose first such clean marker is
`gate=pass` with no automated-revision disposition preceding it. Leave #291 as the
formal analysis of that cohort.

## Authoring-time adversarial loop

`review.authoring.enabled: local` replaces the single `shakedown-code` session with
two bounded cold-review/Judge passes and at most one author revision. Omission never
clears a carried fingerprint; malformed or incomplete Judge output fails closed.
Safety-class survivors always hard-block. Judgment dissent may continue only for PR
ship targets; direct-push parks.

Concurrent reviewer (and Judge) seats each run in a throwaway detached worktree under
`.dev/authoring-review-seats/<reviewed-sha>/` pinned to the reviewed commit, so
independent agents do not contend on the artifact worktree's git index (#269). Author
revisions still run on the real item worktree (they must commit). Seats are cleaned up
after the loop.

### Report contract (schema v3) and fail-closed classification

Authoring reviewers emit `AUTHORING_REVIEW_FINDINGS` with `schemaVersion: 3`. Each
finding carries `severity`, `message`, optional `path`/`line`, and optional structured
evidence (`ruleId`, `cwe`, `classHint`). Wire fields `class` and `fingerprint` are
rejected. The harness classifies each finding before ingestion (fingerprint / CWE /
exact rule-id / path-signal rules; safety-dominant; unmatched →
`correctness-regression` + `default-safety`). Effective class — not the reviewer's
hint — is what the loop, Judge anti-downgrade, and dissent routing consume. Mixed or
legacy (v2) schemas fail the seat closed. Optional Judge `class` remains an elevation
request only; it does not mutate the harness-owned candidate class. Full taxonomy:
[ADR-0016](./decisions/0016-severity-taxonomy-and-owner.md); design residuals:
[adversarial-review-loop.md](./agent-context/adversarial-review-loop.md).

The `prefer` diversity policy records the run as softened whenever the author,
reviewers, and Judge span fewer than three distinct providers (a same-provider
degrade). It reflects the configured seats, not a runtime credential probe. Each run
writes an atomic, unbound `.dev/review-records/<run-id>.json`; PR targets append the
same deterministic record to the PR body. This is a review record, not an
identity-bound attestation.

`local` is the explicit subscription-or-keys opt-in for attended, worktree-backed,
operator-initiated execution. It is refused fail-closed on any unattended signal:
CI/single-shot mode, daemon-spawned runs (`PELAGGIO_SUPERVISED_RUN=1`), multi-cycle
campaigns, and headless (no interactive TTY) execution such as cron. The headless
signal alone is operator-attestable — bare `isTTY` cannot tell an operator-initiated
piped/backgrounded invocation from cron — via `PELAGGIO_OPERATOR_ATTENDED=1` (exact
value; anything else fails closed). The suppression is logged at resolution time and
recorded on the execution result in the cycle log; it never overrides the other
signals, so an attested multi-cycle, CI, or daemon run still refuses. Use `keys` for
unattended, CI, or shared execution: the runtime requires direct provider API keys
for the Judge and at least one reviewer, omits reviewer seats whose keys are
unavailable, and records that omission as softened diversity. `off` (the default)
keeps the ordinary single review. Legacy `true`/`false` values map to `local`/`off`.

## Runner modes

The required `review` context is **always a commit status** — posted by exactly one
runner. `review.runner` selects which:

- `ci` (default): `.github/workflows/pr-review.yml` runs the `pr-review` CLI in
  GitHub Actions and posts the `review` **commit status** (pending → success/failure)
  for the PR head SHA.
- `local`: a normal local pelaggio run reconciles open PRs before revise, runs the
  same `pr-review` step from the trusted local tree, and posts the `review` **commit
  status**. The reconciler drains **at campaign start and after every cycle** (see
  [Mid-run posting](#mid-run-posting-387) below), so PRs opened mid-run — and the sole
  PR of an explicit `--item` run — are reviewed before the worker exits, not "next
  process".

**Branch protection: require the `review` _status_ context, not a check named
`review`.** No workflow job is named `review` (the CI job is `pr-review-ci`) precisely
because GitHub scores a *skipped* required-check job as success — so a job named
`review` gated off in local mode would silently green the gate (fail-open). Keeping
`review` a status posted only by the active runner closes that: before the runner
posts, the context is absent and merge is blocked (fail-closed-by-absence). Verify with
`gh api repos/{owner}/{repo}/commits/{sha}/status` (the `review` status) and
`.../check-runs` (should contain no check-run named `review`).

Local mode is deliberately trusted-tree: the CLI, skill, parser, rubric, and status
posting code run from local `main`; the PR head is fetched only as diff/file data.
Set the repo variable `AUTOPILOT_REVIEW_RUNNER=local` so the CI workflow leaves only
a diagnostic comment and does not execute review tooling from the PR branch. The
local `gh` auth needs permission to write commit statuses (`statuses: write`) and PR
comments.

### Mid-run posting (#387)

The local review reconciler drains at two moments — **campaign start** (cold-start
backlog + statusless PRs from prior runs) and **after every cycle inside each worker**
(the PR this cycle just shipped). This closes the earlier gap where the sweep ran
**once** at campaign start, before the pick worker pool: a multi-cycle, continuous
(#82), or `--item` run that opened PRs after that sweep left them statusless (auto-merge
queued but inert) until the *next* process. The `--item` path drains too — the `review`
status is a merge gate, not optional campaign work (revise keeps its `--item` exclusion:
"do exactly these").

**Enqueue / execute split.** The trusted-tree invariant is preserved by never running
review from a PR-branch worktree. After a successful PR ship, the harness ship-tail only
**enqueues** a durable review-request into the main tree at
`MAIN_REPO/.dev/review-requests/{prNumber}-{headSha}.json` (gitignored; redirected via
`mainWorktree()` like the decisions register / stale quarantine). It posts **no** status
from the ship path. The main-tree reconciler is the **sole** executor: it drains the
queue, runs `pr-review`, and posts the status from local `main`. The queue key is
`(prNumber, headSha)`, so the drain is idempotent — a re-push (new SHA) is new work; a
crash after posting the status but before dequeuing is reconciled by a positive terminal
status probe on that exact SHA (never "absent from the PR listing"), which deletes the
record without re-running the agent. A rate-limit park leaves the status pending and
hands the record back for the next drain. Parallel workers serialize one drain round
under `MAIN_REPO/.dev/review-requests/.drain.lock`; a losing worker skips the round (a
peer is already draining the shared queue). Enqueue failures and un-parseable
PR-number/HEAD inputs are non-fatal to the ship — the PR is already on the forge, and the
campaign-start drain's `findReviewCandidates` re-derives it from the forge and recovers.

Review always drains **before** revise, so a fresh local BLOCK is immediately revisable
in the same window; a just-shipped PR has no red `review` yet, so revise ignores it.

### PR-keyed gate-outcome record

Every terminal local-runner review also writes a durable, atomic record at
`MAIN_REPO/.dev/pr-review-gate-records/{prNumber}-{headSha}.json`. New writes are schema
v2; existing schema-v1 files remain readable and are never rewritten. The two-key file
name is unchanged: last write wins, including an operator record overwriting a fleet
record on the same `(prNumber, headSha)`.

A v2 record is a producer-discriminated union:

- `producer: "fleet"` — a completed local review-fleet attempt. It carries the fleet
  `pass`/`block` gate, `ok` and subtype, the four-value fleet `agreement`
  (`consensus-pass` | `consensus-block` | `disagreement` | `invalid`), optional
  convergence fields, cost/estimate/turn metrics, `runner: "local"`, and the review
  timestamp. A park is transient and writes no record; a crash writes a synthetic
  `error_crash` fleet block (`agreement: "invalid"`).
- `producer: "operator-adjudication"` — a human adjudication. No fleet ran:
  `agreement` is fixed to `"not-run"`. The record identifies the adjudicator, binds
  the inspected interdiff as `reviewedSourceSha` → `headSha` (equality is allowed;
  an identity/empty interdiff still has a digest), stores a 64-character lowercase
  SHA-256 `interdiffDigest` of the exact inspected bytes (no `sha256:` prefix), and
  retains a `dispositions` map keyed by `reviewFindingFingerprint` strings. Each
  entry is `fixed` (addressed in the interdiff), `refuted` (not a real defect), or
  `accepted` (real, shipping with it), plus a non-empty rationale. An empty map is
  valid. Operator `gate` is the adjudication outcome, not fleet consensus.

This store is the durable right-hand side of a post-cycle join. A consumer joins it to a
shipping `.dev/pelaggio-log.jsonl` cycle's `CycleProvenance` only when the record's PR
number equals the number parsed from `provenance.prUrl` **and** its `headSha` equals
`provenance.git.headSha`. Both predicates are required because one PR may have several
reviewed revisions; `itemId` is useful for grouping but is not an identity fallback.
Legacy provenance without a usable PR URL or head SHA remains unjoined rather than being
guessed.

An operator record is durable adjudication evidence, not a fleet run. It must never be
counted or rendered as `consensus-pass`, `consensus-block`, or disagreement. Only
`fleetAgreementOf` may supply a fleet consensus value (the stored four-value agreement
for historical v1 and v2 fleet records; `null` for operator adjudication). Operator
`gate: "pass"` is not consensus.

The projection that performs this join is deferred.

Only the local drain persists fleet files today. A CI runner has a read-only token and an
ephemeral checkout, so its durable outcome remains the forge metrics marker until a later
local materialization pass is implemented.

## Cross-push carry — finding dispositions (#495)

Without carry, every re-pushed head re-rolls the full drivers × labels fan-out from
scratch: findings refuted at real cost in run N are re-discovered and re-verified in run
N+1, and consensus-pass across fresh cold cells is an exponential bar in diff size. Carry
mechanizes what the operator does by hand in pass-fix-go adjudication — read the
interdiff, confirm each fix addresses its finding, and don't re-open the world — as
deterministic harness logic (ADR-0014: no model ever decides whether or how far to
narrow).

**The record.** Every completed local gate run (pass **and** block; never on park, never
on CI) writes `MAIN_REPO/.dev/pr-review-finding-dispositions/{prNumber}-{headSha40}.json`
(schema v1, strict closed-key validation, atomic 0600 write): the run's surviving
must-fix fingerprints (`survived`, with the latest survives-evidence or `null` when
retained without verification) and its refutation memory (`refuted`, each entry carrying
`provenance: "verified"` — refuted by this run's complete valid verification — or
`"carried"` — chained back to a verified origin id + SHA). The record is digest-bound to
the exact on-disk fleet gate record (`fleetRecordDigest`), the same discipline as the
adjudication sidecar. The store is seat-denied exactly like the other evidence stores
(#510): a seat that could write it could forge an auto-refutation.

**Prior selection (fail-closed).** A run for a new head separates two roles. The
**narrowing watermark** is the newest ancestor (same PR + item, different SHA, proven
ancestor via `git merge-base --is-ancestor` in the trusted repo) that is BOTH structurally
complete AND still digest-binds to its fleet record bytes; complete ancestors are ordered
along the branch (ancestry-sort + adjacent-pair verification; the scan is bounded at 50
priors per PR — beyond that carry refuses fail-closed with a prune hint, since there is no
store GC in this item — chartered as #613). The **blocking-only survivor overlay** is drawn
from every ancestor that CANNOT be a watermark — an incomplete run (its retained blockers
must still block even though its head is not a valid narrowing base) OR a complete record
whose fleet record no longer binds (superseded, typically by a later `pr-adjudicate`). Those
survivors seed toward blocking and veto auto-refutation of the same fingerprint, but nothing
from a non-watermark record ever CLEARS a finding — so `complete-A → incomplete-B(blocker)
→ C` seeds B's blocker at C, and only a complete valid report can refute it (an omission
cannot silently green it). Nothing inside the records orders candidates (`reviewedAt` is
diagnostic only — a model-writable timestamp is not an ordering signal, #510). Any failure
— malformed store file for the PR, force-push/rebase (no ancestors), a non-totally-ordered
complete chain, no complete bindable watermark, a prior that does not resolve in the diff
checkout — degrades to today's cold behavior with a stderr diagnostic, never to a weaker
gate. A first run (no priors) is byte-identical to today.

**What carries.**

- **Survivors seed unconditionally** (toward blocking): they join the first verification
  pass's candidates and persist under the omission-never-refutes rule until a complete,
  valid verification report explicitly refutes them.
- **Refuted findings auto-refute only when provably unaffected**: the anchoring file must
  be wholly untouched by the two-dot `--no-renames` interdiff (`prior..head` — an
  untouched file has an identical blob at both SHAs, so the recorded refutation examined
  exactly the bytes present now), and the finding must be non-safety under **both** its
  recorded tier and the current taxonomy's resolution of its recorded class. Eligible
  fingerprints are withheld from the model verifier and contribute synthesized `refuted`
  dispositions whose refuting authority is the prior recorded report (harness-authored
  rationale; chained origin id + SHA). Anything touched, pathless, or safety-tier is
  re-verified fresh.

  **Auto-refutation is DORMANT under the shipped default.** Production schema-v1 gate
  findings carry only `severity`/`message`/`path`/`line`, so emission-time classification
  resolves every recorded entry to the default-safety sink (`correctness-regression`) and
  the I3 predicate excludes it — nothing is currently eligible. The withholding/synthesis
  machinery is the seam a later classification enrichment lights up: eligibility requires
  findings that reach the cold gate carrying classification evidence (`ruleId` / `cwe` /
  `classHint`, as the schema-v3 authoring wire already does) whose class resolves
  judgment-tier under the configured taxonomy. That enrichment is separate, uncharted
  work. Seeding, narrowing, and refutation memory are taxonomy-independent and fully
  live today.
- **Discovery narrows to the interdiff**: the full drivers × labels fan-out reviews
  `prior..head` through the trusted-context refs, while the inspection diff, security
  classification, and sidecar anchoring keep the full PR range. An empty interdiff seeds
  and auto-refutes but discovers cold. **The narrowing base only ever advances on a
  structurally complete run.** Prior selection requires the record's run to have been
  complete — `ok: true` and a non-`invalid` agreement (`consensus-pass`/`consensus-block`/
  `disagreement`); an `invalid` / `ok: false` run (infra error, parse failure, budget
  preflight) still writes a record but is never selected as a watermark. So the base is
  always a SHA a full fleet completely read, and the next push narrows to
  `lastComplete..head` — whose delta (including any incompletely-reviewed intermediate
  pushes) a full fleet then reviews. The residual gap to "every line got a complete fleet
  read" is only the accepted per-finding anchoring exposure and the dormant-classification
  auto-refute path above, not incomplete watermarks. The deterministic full-head gates
  (typecheck ratchet, tests, CI) are unaffected and run on every head regardless.

The gate comment and metrics marker carry a deterministic token —
`carry=<sha7> seeded=<n> auto-refutable=<k> auto-refuted=<m>`, `carry=none`, or
`carry=refused-untrusted-pool` (a prior existed but the pool was store-writable, so
consumption was refused and the run went cold) — so the operator can read from the PR why a
run was narrow (or why it was not). `auto-refutable` is the eligible
count after the I3/interdiff filter: under the shipped default taxonomy it is always `0`
(dormancy above), which is deliberately visible so `auto-refuted=0` never reads as
"checked and none qualified".

**Kill-switch — ships default OFF.** `review.carry` defaults to `false` (canary-off):
carry makes these stores **authorization inputs**. Records are still written while off, so
enabling later has priors; `review.carry: true` turns on reads + narrowing. Local runner
only: CI neither reads nor writes the store.

**Store-trust is enforced by construction, not by the default.** Carry only *consumes*
evidence (seeds survivors, narrows discovery, auto-refutes) when **every** review/verify
provider in the run's pool has a *proven* store-write denial — the check is
`poolStoreTrust(providers)` at the gate's consumption site. If any pool provider is
store-writable, consumption is refused and the run goes cold (`carry=refused-untrusted-pool`
in the comment token; a stderr diagnostic names the untrusted provider). Record *writing*
is unaffected — the run still emits its own cold disposition record, it is simply not
trusted for seeding/narrowing. Default-DENY: an unknown/new provider is store-writable
until proven.

**Two honest limits on that guarantee.** (1) `poolStoreTrust` gates only the CURRENT run's
pool; disposition records carry no producer-pool provenance, so a record written earlier by
a store-writable pool (e.g. a grok-fallback run while carry was off) remains consumable by a
later all-trusted run. That is the pre-enablement-priors residual below, whose discard is a
#605 precondition — the current-pool gate is not a substitute for it. (2) The store-write
denial's *completeness* rests on #511 (harness-attested evidence): the Claude seats' Bash
register denial is textual (#510), so a composed-path shell command can still evade it until
#511 makes the store non-forgeable. Both are why `review.carry` ships off.

- **Store-trusted (proven denial): `claude`, `codex`.** Claude — the gate threads the
  foreign-root denial into every seat regardless of cwd, so the step-runner installs its
  PreToolUse hooks (Write/Edit/Bash denial on the gate-record, adjudication-source,
  finding-disposition, session, and decision-log registers; #510 parity; residual:
  hook-level Bash denial is textual, the documented #510 opacity residual). One accepted
  side effect: a cold-gate Claude seat reviewing a PR that *touches* one of those registers
  (e.g. `docs/decision-log/`) will have a `Bash` inspection command that literally names the
  path denied — but the review reads the diff via `git diff origin/main...HEAD` (no path in
  the command) and opens changed files with the `Read`/`Grep` tools (not `Bash`), so review
  capability is not meaningfully degraded; it is the same fail-closed #510 tradeoff. Codex —
  cold `pr-review`/`pr-verify` seats carry a harness-owned read-only workspace intent, so
  both main-checkout seats and data-only prepared PR-head worktrees run under the `read-only`
  OS sandbox (they produce a text report; repo checks/tests cannot run under read-only — the
  Claude seats in the fleet still run checks). Authoring-loop review worktrees remain writable.
- **Store-writable (no proven denial), so any pool containing them refuses carry
  consumption: `grok` (any mode), `opencode`, and every future/unknown provider.** Grok's
  builtin `strict` profile's write surface at the main-checkout cwd is unverified and
  `providers.grok.allow-unsandboxed-fallback: true` removes the sandbox entirely; OpenCode
  has no semantic deny, no OS isolation, and ignores `foreignRootDenial`.

The default is `false` because the current-pool consumption gate is necessary but not
sufficient on its own (the two limits above). **#605** narrows to: prove grok's store-write
denial at main cwd and add `grok` to the store-trusted set (else keep it excluded), discard/
re-validate pre-enablement priors (below) before flipping the default, and depends on #511
for the non-forgeable store. The current-pool gate already narrows #605 from "gate every
provider" to those residuals.

**Pre-enablement priors are not automatically trustworthy.** Records are written while
`review.carry` is off, including by pools that contained an unsandboxed or unverified seat
(grok fallback), so a poisoned disposition record could sit in the store before carry is
ever read. The `ok: true` + non-`invalid` watermark gate above raises the bar — a forged
record must now also look like a complete run to be selected — but it is not sufficient on
its own. **The enablement flow (#605) MUST discard or re-validate every disposition record
written before enablement whenever the pool that wrote it could contain an unsandboxed /
store-writable seat; pre-enablement priors are never trusted implicitly.** This item
documents the gate condition only; the discard/re-validation mechanism is #605.

## Operator adjudication — `pelaggio pr-adjudicate`

`npx pelaggio pr-adjudicate --pr <n> [--profile <name>]` is the local-runner “go” after a
narrow fix. It does **not** launch another discovery fleet. It binds the old reviewed SHA,
the current PR-head SHA, the exact interdiff bytes, every carried survivor, and the
authenticated operator; accepts only interdiff edits inside the recorded finding-bearing
hunks; re-runs one bounded `pr-verify` over every safety-tier survivor; then writes the
schema-v2 `operator-adjudication` record, upserts the marker comment, and posts
`review=success` to the pinned current SHA **last**.

### Local source-evidence contract

A complete, verified findings-terminal local fleet also writes a sidecar at
`MAIN_REPO/.dev/pr-review-adjudication-sources/{prNumber}-{reviewedSha}.json` (schema v1).
The file is content-digest-bound to the **exact on-disk** fleet-v2 bytes from the same
drain attempt (`fleetRecordDigest`, SHA-256 hex, no `sha256:` prefix). It records each
survivor’s v1 finding, recomputed fingerprint, emission-time class/tier, successful
`survives` verification, and the inspection-diff new-side hunk that is the repair
boundary. Locationless or unmappable survivors omit the whole sidecar — the ordinary red
gate still stands.

Dispositions are latest-per-fingerprint (#525): the latest iteration’s verification
decision wins, and within one iteration a `survives` outranks a `refuted` (the same
fail-closed dominance a valid summary gets). Carried findings whose latest decision is
`refuted` — the gate’s fail-closed invalid-summary rule re-adds them to the carried set,
so the fleet `survivorCount` includes them — are recorded in a separate `refuted` list
with their refutation evidence; they need no hunk, open no edit region, and require no
touch. This shape is not disagreement-only: a budget-cap overrun also invalidates the
final summary, so a `consensus-block` record’s carried set gets the same padding and the
`refuted` split un-suppresses its sidecar under the same evidence bar.
`survivorCount` = `survivors.length + refuted.length`, binding the fleet record’s
carried count; at least one genuine survivor is required. The fleet refutation is bound
to the **old** reviewed SHA and is provenance only, never the clearer: adjudication
re-checks every refuted entry in the live verification pass at the repaired head (an
allowed survivor-hunk edit can reactivate one), clears it only on a fresh live refuted
decision — recorded as the disposition rationale in the operator record — and refuses if
the live verifier finds it alive, exactly as for a surviving finding.

Forge comments are display/audit only. The command never scrapes Markdown or reconstructs
evidence from a CI-only / legacy fleet run. Those cases refuse with a full-re-review
instruction.

### Eligible / refusal matrix

Eligible: a complete v2 `producer: "fleet"` record with `gate: "block"`, structural
`ok: true`, `agreement: "consensus-block"` **or** `"disagreement"` (#525), `survivorCount
≥ 1` matching the sidecar (survivors + refuted), and a matching digest — the sidecar's
agreement must equal the fleet record's exactly. A `budget` / `max-passes` / `diminishing-returns` breaker is
eligible only with that complete matrix, and so is `invalid-pass`: the convergence loop
labels a terminal verdict split's breaker `invalid-pass`, but with `ok: true` every
required cell completed a structurally valid review — a genuinely broken run instead
carries `ok: false` / `agreement: "invalid"` and stays refused. The current head must be a
descendant of the reviewed SHA, and every interdiff edit must fall in a recorded hunk
(insertions may use the immediate start/end boundary).

Churn bounds are threefold and fail-closed: per hunk, added lines are capped by the extent
of the covering recorded hunks; across the whole interdiff, TOTAL added lines are capped by
the total deduped covering extent (so `--unified=0` anchor-splitting cannot multiply the
per-hunk allowance); and each added line's UTF-8 byte length is capped by a per-hunk
ceiling derived from the hunk's own replaced lines, clamped to a 200-byte floor / 1000-byte
ceiling (so one in-range line cannot be replaced with an arbitrarily large single line).

Refuses: v1 / operator / pass / `agreement: "invalid"` or non-`ok` (the broken-review
`invalid-pass` shape) / provider-diversity /
preflight budget / zero-survivor / digest or agreement or identity mismatch / missing sidecar /
force-push or rebase / extra file or hunk / binary, rename, copy, create, delete / any
file-mode metadata change (executable-bit or file-type transition, with or without hunks) /
per-hunk, aggregate, or byte churn-bound overrun / empty or malformed interdiff /
uncovered survivor. Broad churn returns to full `pr-review` or `pelaggio revise`.

### Safety re-verification and cost

Today’s schema-v1 fleet survivors have no `ruleId`/`cwe`/`classHint`, so emission-time
classification lands them in `correctness-regression` / safety. Live adjudication
therefore always spends **one** bounded `pr-verify` seat (the `--profile` scalar
`pr-verify` settings) whose candidates are every safety-tier survivor **plus every
refuted entry** regardless of tier (#525: a refuted entry’s only clearing evidence is the
live pass). A non-`ok`, parked, malformed, incomplete, or `survives` result refuses with
no authorization effects. A judgment-only survivor set with no refuted entries (taxonomy
extension / test) skips the model call. Line numbers are not remapped through the interdiff — they hint at
the pre-fix location; the verifier inspects the current head.

The verifier is confined the same way the pipeline confines its `pr-verify` seats: its cwd
is the detached data-only review-head checkout (at `.dev/review-heads/<sha>-adjudicate`,
disjoint from a concurrent drain’s checkout of the same SHA) — never the authenticated
main checkout — with foreign-root Write/Edit denial over main and every registered
worktree, a main-checkout delta observer around mutating tools, and a before/after
porcelain snapshot of main. Any observed main-checkout mutation or audit failure refuses
before any authorization effect.

### Status-last authorization and recovery

Effects are fail-closed and ordered: write the operator record first, require the marker
comment upsert second, post `review=success` to the **pinned** inspected SHA last. A
record or comment failure cannot green the PR. A status failure leaves the revision
blocked and safely retryable — re-run `pr-adjudicate`, never `revise`. The operator
comment carries its own `<!-- pelaggio-pr-adjudication -->` marker, distinct from the
fleet `<!-- pelaggio-pr-review -->` marker, so the `revise` seam (which scrapes only the
fleet marker) can never ingest a PASS body as findings; the fleet findings comment is left
in place as pre-adjudication history. A push in the irreducible API-call window cannot
green the new head: the status is keyed to the old pinned SHA, and a post-status head
mismatch returns 1.

The command is local-only (`review.runner: local`, PR ship target, main checkout, not CI /
`PELAGGIO_SINGLE_SHOT`). It is effectful in the same class as `pr-review` / `land`.

## CI runner flow

The `pr-review` subcommand is the CI/local-runner implementation of this gate. It is
not a read-only review preview: invoking `npx pelaggio pr-review --pr <n>` reads the
PR through `gh`, upserts the Pelaggio review comment, posts the `review` commit status
to the PR's head SHA, and exits non-zero when the gate blocks or the `review` status
write fails (the review-comment upsert is best-effort and does not affect the exit code).
Run it only where `gh` is authenticated for the repository with permission to read
the PR and write issue comments and commit statuses. In the normal `ci` configuration,
the workflow below owns the invocation; developers do not need to run it as part of
the ordinary `pelaggio run` pipeline.

1. `.github/workflows/pr-review.yml` triggers on `pull_request`
   (`opened`, `synchronize`, `reopened`, `ready_for_review`) targeting `main`.
2. The job id is **`pr-review-ci`** (deliberately *not* `review`). It posts the
   `review` **commit status** for the head SHA: `pending` before the agent runs, then
   `success`/`failure` after. The required-check context is that status, so the gate
   reports green or red and is never left perpetual-pending. Fork or draft PRs skip the
   agent and post a green `review` status (secrets are unavailable to forks; forks
   can't be pelaggio PRs).
3. For a same-repo, non-draft PR the job checks out the head SHA with full history,
   installs deps, and runs `npx pelaggio pr-review --pr <n>`.
4. The CLI reads the changed file list and diff, then runs one or more bounded, fresh-session
   discovery reviews through the same `runStep` machinery the pipeline uses (step
   `pr-review`: budget / turns / effort / model are first-class config, see below).
   The safe default is one iteration and one review driver; `review.max-passes` opts
   into at most three iterations, and `models.profiles.*.providers.pr-review: […]`
   opts into multi-driver **fan-out** (every listed driver **runs** the same
   discovery prompt — not author rotation). Launch is fully concurrent except when
   the pool contains both Claude and Grok: Grok waits for Claude discovery to
   finish, not merely to boot. If the deterministic classifier sees
   security-sensitive paths or diff keywords, the CLI runs a second fresh
   `pr-review --red-team` discovery label and fans that label across the same
   drivers. After discovery, every driver pass with `must-fix` candidates gets its
   own sequential fresh `pr-verify` session (verifier stays scalar). The verifier
   tries to refute each candidate against the repository and cannot introduce or
   rewrite blockers. The CLI posts the `review` commit status for the head SHA and
   all dispositions as one idempotently-upserted PR comment — independently, so a
   failure posting one does not drop the other — then sets the exit code.
5. **Exit code = gate = posted `review` status.** The CLI exits `0` only when every
   required `(driver × label)` cell emits a valid versioned findings report, every
   candidate blocker is refuted by a complete, valid isolated verification report
   (`agreement: consensus-pass`), and its own `review` commit status post succeeded.
   A surviving `must-fix`, multi-driver veto (`disagreement` or `consensus-block`),
   infrastructure-invalid cell (`invalid`), missing or malformed report, refusal,
   SDK error, max-turns, rate-limit park, inability to inspect the diff, or a failed
   status post exits `1`. The workflow also translates the CLI's exit code into the
   `review` commit status (`0` → success, else failure) as a second, independent
   poster, and posts `failure` if the job is cancelled after starting. The gate
   **fails closed**: ambiguity blocks the merge, and a crash before the final step
   leaves the earlier `pending` status.

## The fail-closed contract

The load-bearing invariant is that the gate can never go green on a phantom sign-off.
Two layers enforce it:

- `runStep` downgrades a refusal / decline to `ok: false`.
- Both schema-v1 parsers receive `modelAuthoredText(result)` — the required
  accumulated model-authored `assistantText`. `text` alone is not a safe parse
  source on streaming providers: it may be only the final chunk. `fullText`
  carries command/description tool input by contract and is never ingested as a
  findings or verification report.
- `parseReviewFindings(modelAuthoredText(result))` validates the delimited JSON report at
  the untrusted model-output boundary. Unknown versions, keys, severities, or malformed
  fields are rejected. A verbatim findings-schema example (the packaged summary sentinel
  or an exact example finding) is rejected as an incomplete/invalid review and therefore
  blocks. A valid report blocks only when it contains a `must-fix`; `nice` and `note`
  remain visible but non-blocking. `ok: false` and parser failures block separately.
- `parseReviewVerification(modelAuthoredText(result))` and reconciliation require exactly
  one decision for every orchestration-owned candidate ID. Only a complete valid report
  can remove a candidate; all verifier failures retain it. An echoed pr-verify example
  rationale is rejected: unguarded, it would refute a candidate and clear a real blocker —
  the one parrot direction that fails open.
- Because `modelAuthoredText` accumulates every assistant turn, both parsers additionally
  require their single block to be the **final** model-authored output. A report followed
  by a non-report answer is invalid, so an early draft block can never authorize a pass or
  clear a blocker that the seat's own final answer does not support.

A transient failure (rate limit, flaky SDK error) therefore shows red. If a security
diff triggers the red-team pass and that pass cannot complete, the whole gate blocks
even if the standard pass found no issues. Re-run the workflow once the cause clears —
the comment is upserted, not duplicated.

**Rate-limit is the one exception, and only in the local runner (#134).** A rate limit
during `pr-review`/`pr-verify` is transient, not a real BLOCK, so the gate reports a
third outcome — `park` — carrying the reset time. In the **CI runner** there is no wait
loop on a one-shot GitHub Actions job, so `park` maps to the same red `review` status and
exit 1 as a block (fail-closed, unchanged). In the **local runner** the sweep instead
leaves the `review` status **pending** (never red, never a revisable findings comment),
parks the run with the reset, and retries the review sweep in-process under the same
`park.auto-resume` / `--max-wait` / reset-time policy as item park-and-resume — or hands
back cleanly, leaving the PR pending for the next run. Pending PRs stay eligible for the
sweep, so nothing is lost. Real BLOCKs (must-fix survivors, invalid report, refusal,
max-turns, crash, diff-inspection failure) still post red and stay revisable in both
runners.

Candidate IDs are assigned by orchestration and verification returns only an ID,
`refuted`/`survives`, and a rationale. Surviving findings are reconstructed from the
original validated discovery report, preserving their message and location. Missing,
duplicate, unknown, or malformed decisions, refusal, truncation, rate limiting,
max-turns, or verifier execution failure retain every candidate and block. Verification
is a refutation filter, not a vote or a second finding pass; a clean or non-blocking-only
discovery report does not spend a verifier session.

Across iterations, orchestration fingerprints validated blockers by normalized message,
path, and line. Surviving fingerprints are carried forward and included in later
verification input even when discovery omits them; only an explicit complete `refuted`
decision removes one. The first blocking iteration establishes a baseline. A later
iteration continues only when the carried count strictly falls; an unchanged/larger
count or same-size replacement trips `diminishing-returns`. `max-passes`, `budget`,
`invalid-pass`, and `provider-diversity` are the other breaker reasons. No breaker can
yield PASS.

Before each iteration the CLI reserves the resolved discovery and verifier caps for
every required `(driver × label)` cell (standard, plus red-team when triggered), so
it never starts a partial fleet:

```
reservation = labels × drivers × (pr-review budget + pr-verify budget)
```

Actual costs and turns from every attempted discovery and verification call are
aggregated, and an actual overshoot remains red. Enabling a multi-driver pool
almost always requires raising `review.budget-cap` (defaults fit a 2-driver standard
pass but not red-team × multi-driver). `provider-diversity: prefer` uses independently
configured providers when they differ and otherwise retains the ordinary same-provider
fallback; `require` blocks before agent work only when **every** review driver equals
the scalar verifier provider (a mixed pool with at least one independent reviewer is
accepted). Metrics record the pairing as `claude+codex/codex`. The read-only gate
escalates by leaving the status red; it does not call pipeline-private `parkExit()`.
The separate revision pipeline retains rate-limit checkpointing and the label-bounded
human handoff.

### Multi-driver agreement (CI gate)

When `providers.pr-review` is a list, every required `(driver × label)` cell still
runs (private per-driver park signals; earliest positive `resetsAt` wins on merge).
Launch is fully concurrent except when Claude and Grok share the pool: non-Grok
seats start immediately and Grok waits for every Claude discovery promise to
settle. All-pass / fail-closed matrix semantics are unchanged. After sequential
per-driver verification, the gate computes a closed `agreement` field on the result
(and in the metrics marker) without scraping comment prose:

| Condition (first match wins) | `agreement` | Gate |
| --- | --- | --- |
| Any required cell is infrastructure-invalid (throw, non-ok, malformed, incomplete verify) | `invalid` | BLOCK |
| Every required cell has a valid effective PASS | `consensus-pass` | may PASS |
| ≥1 valid PASS and ≥1 valid findings-BLOCK (no infra) | `disagreement` | BLOCK (distinct; #244 later) |
| Every required cell is a valid findings-BLOCK | `consensus-block` | BLOCK |

Only `consensus-pass` may green the required `review` status. Scalar configuration
(`pr-review: claude`) is a one-element pool — behavior is unchanged aside from the
typed `agreement` field. `pr-verify` is never fanned out by the review pool.

## The review itself

The standard review is one fresh session, structured as three internal phases (see
`.claude/skills/pr-review/SKILL.md`):

- **Find** — read the diff cold; read every changed file in full at head; over-collect
  candidate findings against the rubric + `CLAUDE.md` invariants.
- **Verify (adversarial)** — switch to a skeptic stance and refute each candidate
  against the actual code; keep only findings that are both **real** and **blocking**
  (ships a bug, breaks a load-bearing invariant, or merges broken code). Style nits and
  speculation are dropped.
- **Report** — the final message ends in one versioned, delimited JSON report containing
  a summary and separate `must-fix`, `nice`, or `note` findings with optional locations.
  The CLI validates it and renders the human comment.

The review is **read-only by convention** — the CI checkout is ephemeral, so edits would
never be pushed. The CLI, not the agent, owns comment posting.

### Adversarial red-team pass

Security-sensitive diffs get a second independent pass. The classifier is deterministic
and conservative: it triggers on security-adjacent paths such as `.github/workflows/**`,
server auth/config/app files, pelaggio step runners, ship/roadmap tooling, and review /
ship / implement skills; it also triggers when added or removed diff lines (not context
lines or diff metadata) contain terms such as `auth`,
`token`, `secret`, `host`, `loopback`, `127.`, `localhost`, `fetch`, `exec`, `spawn`,
`shell`, `workflow`, `prompt injection`, `ANTHROPIC_API_KEY`, `GH_TOKEN`, or
`CONTROL_PLANE_TOKEN`.

The red-team mode assumes the change is wrong and tries concrete bypasses and fail-open
paths: hostname tricks like `127.example.com`, IPv6 loopback, wildcard binds, malformed
URLs, empty env vars, mixed-case headers, missing tokens, shell/path/cwd injection,
prompt-injection influence over commands, token exposure, workflow permission broadening,
fork/draft behavior, and checks that can report green without running. It still blocks
only on confirmed findings with `file:line` evidence; vague risk does not satisfy the
gate.

If the classifier does not trigger, the PR comment records that the red-team pass was
not run. If it does trigger, both the standard and red-team sections appear in the single
gate comment. Either pass can block, and both passes run even if the standard pass has
already blocked so the revise loop receives all confirmed findings. A triggered run costs
roughly twice a normal review for discovery. Each discovery pass that produces blockers
adds one `pr-verify` session, so total cost and turns vary with the number of
blocker-bearing passes. The comment metrics sum discovery and verification calls.

### Evidence marker

**How to aggregate.** The gate job runs on ephemeral GitHub-hosted `ubuntu-latest` with a
`contents: read` token — it cannot write a log file that survives the runner, and it must
not commit. The durable, zero-write-permission sink is the **PR comment** the CLI already
upserts: each carries a machine-readable marker as its final line —

```html
<!-- pr-review-metrics gate=block ok=true subtype=success cost=1.23 turns=42 -->
```

Recording `ok`/`subtype` is the disambiguation `gh run list` **cannot** provide: a red
job conclusion conflates a real `must-fix` report with a fail-closed transient (rate-limit
/ max-turns / refusal). Precision is only about the former, so filter to
`ok=true subtype=success` first. Enumerate the markers across recent PRs with:

```bash
# Pull the pr-review-metrics marker from every recent PR's gate comment.
gh pr list --state all --limit 50 --json number --jq '.[].number' |
  while read -r n; do
    gh pr view "$n" --json comments \
      --jq '.comments[].body | capture("(?<m><!-- pr-review-metrics [^>]*-->)").m // empty'
  done | grep 'ok=true subtype=success'   # clean runs only — the precision-relevant set
```

For multi-pass runs, the marker records aggregate `gate`, aggregate `ok`, summed cost /
turns, a subtype that identifies the blocking pass (`standard:<subtype>`,
`red-team:<subtype>`, `multiple`, or `success`), plus `agreement=…`, `providers=…`
(reviewer-set/verifier pairing), and convergence counters when multi-pass is active.
The comment body labels each section with its driver and lists per-driver effective
verdicts so duplicate standard/red-team sections stay attributable.

## Configuration

`pr-review` and `pr-verify` are first-class non-pipeline steps, so their budget / turns /
effort / model are set the same way as any step (see [`config.md`](./config.md)):

```yaml
budgets:      { pr-review: 5 }        # dollars (default 5)
turn-limits:  { pr-review: 60 }       # SDK turn cap (default 60)
effort:       { pr-review: xhigh }    # default xhigh
models:
  profiles:
    standard: { pr-review: claude-opus-4-8 }
    quick:    { pr-review: claude-sonnet-5 }
```

The verifier has independent global defaults (`pr-verify`: $5, 60 turns, `xhigh`).
When its profile slots are unset, its model, Codex model, and provider inherit the
resolved `pr-review` slots (the pool's first entry when `pr-review` is a list),
yielding a fresh same-provider session. Override `pr-verify` in the profile to use
another registered provider for cross-provider verification; see
[`config.md`](./config.md#pr-review-runner). `pr-verify` does **not** accept a provider
list.

Select the profile with `--profile <name>` (default `standard`).

For multi-driver CI discovery (fan-out, all-pass gate):

```yaml
review:
  budget-cap: 40   # labels × drivers × (review+verify); raise further if red-team triggers

models:
  profiles:
    standard:
      providers:
        pr-review: [claude, codex]
        pr-verify: codex
      codex:
        pr-review: gpt-5-codex
        pr-verify: gpt-5-codex
```

For local subscription review with a single Codex driver, configure the poster and
provider separately:

```yaml
review:
  runner: local
  statusless-after: 2h

models:
  profiles:
    standard:
      providers:
        pr-review: codex
      codex:
        pr-review: gpt-5-codex
```

When a local-mode PR has no `review` status for longer than `statusless-after`, the
orchestrator posts the local-mode diagnostic comment and emits the
`review-stranded` notification event if notifications are enabled.

## Runner & secrets (repo-admin, one-time)

The job runs on **GitHub-hosted `ubuntu-latest`** — deliberately not self-hosted. The
review agent executes PR-influenced code (the CLI runs from the checked-out tree), so
it must run on an ephemeral VM where a malicious PR's blast radius is one comment-scoped
token plus the API key — never on a machine holding real credentials. Hosted runners
are free on public repos.

The workflow needs one secret: `ANTHROPIC_API_KEY`. Use a **dedicated, spend-capped
key** (its own Anthropic Console workspace with a monthly budget), not a personal key —
the cap bounds the worst case if a reviewed PR ever exfiltrates it. Set it with
`gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>` (or an org-level secret to
share one key across repos). Until the secret exists, the gate fails closed: every
same-repo PR reports a red `review` check.

## Branch-protection setup (repo-admin, one-time)

Configuration of branch protection is a **repo-admin action** — it is documented here,
not automated. To make the gate enforced on `main`:

1. Settings → Branches → add / edit the protection rule for `main`.
2. Enable **Require status checks to pass before merging**.
3. Add **`review`** to the required checks (alongside **`ci`**).

With `review` required, `gh pr merge --auto` (the `auto-merge-pr` ship target) waits for
both `ci` and `review` to pass before merging — the enforced out-of-context gate the
autonomous recipe needs. This still depends on branch protection being configured; the
harness additionally refuses to *queue* `--auto` at all when a check has already reported
red (`ship/ci-guard.ts`, issue #292) — independent, in-code defense-in-depth that does not
assume branch protection is set up correctly.

> A required check must always report. That is why the workflow has **no path filter**
> and skips fork/draft PRs *inside* the job rather than via a job-level `if:` — either
> would leave `review` stuck pending and block every PR forever.

## Activating native CI-key review (repo-admin)

By default this repo posts `review` from the **local subscription sweep** (`AUTOPILOT_REVIEW_RUNNER=local`, `.pelaggio.yml review.runner: local`). Switching to the **native CI-key** posture — the `#214`/`#258` realization where GitHub Actions posts `review` on a metered key so `auto-merge-pr` can gate on an app-authored status — is a deliberate **repo-admin ops step, not a committed-config flip**.

**Three things must move together, or the gate breaks.** The GitHub job gates on the repo *variable* `AUTOPILOT_REVIEW_RUNNER` (`.github/workflows/pr-review.yml`, `if: vars.AUTOPILOT_REVIEW_RUNNER != 'local'`); `.pelaggio.yml review.runner` only controls whether the *local* sweep posts. So flipping `review.runner: ci` in committed config **alone** stops the local sweep posting while CI stays gated off (variable still `local`) → `review` is **never posted** → every same-repo PR blocks forever. Do all of these in one change window:

1. **Secret:** `gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>` with a dedicated, spend-capped key (see *Runner & secrets* above). Until it exists the CI gate fails closed (red `review` on every PR).
2. **Variable:** `gh variable set AUTOPILOT_REVIEW_RUNNER --repo <owner>/<repo> --body ci` (any value ≠ `local`). This is what actually moves posting from the local sweep to the CI job.
3. **Committed config:** set `.pelaggio.yml` `review.runner: ci` so the local sweep stops posting (avoids two runners racing the same status).

Verify with `gh api repos/{owner}/{repo}/commits/{sha}/status` after the next push — `review` must appear, posted by the GitHub Actions app, before enabling `auto-merge-pr`. To **restore** local posting, reverse the switch (set the variable back to `AUTOPILOT_REVIEW_RUNNER=local` — *not* unset it, since an unset variable satisfies `!= 'local'` and reintroduces the double-runner race; `review.runner: local`; the secret may stay). Auto-merge is an independent, later switch (`ship.target: auto-merge-pr`) — enable it only once native `review` is confirmed posting and required in branch protection.

### Alternative: local-review auto-merge (unpinned `review`)

`auto-merge-pr` also works **without** the CI-key switch: keep `review.runner: local`
and remove the *app pin* on the required `review` context (keep `ci` pinned to the
Actions app), so the local subscription sweep's status satisfies branch protection
directly and no `--admin` landing is ever needed:

```bash
gh api -X PATCH repos/{owner}/{repo}/branches/main/protection/required_status_checks \
  --input - <<'EOF'
{"strict": false, "checks": [{"context": "ci", "app_id": 15368}, {"context": "review", "app_id": -1}]}
EOF
```

The trade-off is status-poster integrity: any credential with `statuses: write` on
the repo can post a green `review`. That is acceptable on a solo repo where the only
such credential is the operator's own `gh` auth; the identity-bound fix is the
ADR-0018 attestation path (effects receipts under #188; gate-assertion binding and
merge enforcement still residual), which restores a verifiable pin and retires this
posture. Human supervision under this mode is retrospective (review merged PRs), per
ADR-0015.

## Closing the loop on BLOCK (issue #60 / #76)

A red `review` gate no longer just parks forever — it triggers **one** automated revision that
re-implements from the findings and re-pushes so the gate re-runs. The direct human/external entry
point is:

```bash
pnpm pelaggio --resume <id> --review-findings path/to/findings.md
```

When `--review-findings` is present, `--resume` defaults to the `implement` step so the revision
cannot auto-detect a later restart point and skip the findings. An explicit valid `--from` still wins
for advanced recovery.

There are **three** paths that use this same seam and the same one-pass bound (the
`autopilot:revised` PR label). The two automated paths also share the handoff marker
(`<!-- pelaggio-revise-parked -->`):

| Path | Runs on | Funded by | Trigger | Status |
|---|---|---|---|---|
| **Local sweep** (issue #76) | your local runner, in-process | your Claude **subscription** | orchestrator, at the start of an auto-pick `--cycles` run | **active** (this repo) |
| **CI workflow** (issue #60) | GitHub-hosted `ubuntu-latest` | the metered `ANTHROPIC_API_KEY` | `pr-review-revise.yml` on a red `review` status | present but **disabled** repo-wide |
| **Operator command** (issue #498) | your local runner, in-process | your Claude **subscription** | explicit `npx pelaggio revise --pr <n>` from the main checkout | **active** |

The two local paths — the sweep and the operator command — are both active by design: they share
the atomic one-pass label claim (`.dev/revise-claim.lock`) and the per-item execution lease, and
the lease is what serializes their execution in the same claim worktree (see *Execution
exclusivity* below). The CI workflow is the exception: it runs on a GitHub runner outside the
host's locks, so it must not be enabled while a local reviser is active. On this repo it is the
documented API-funded *alternative* — turned off (`AUTOPILOT_AUTO_REVISE=false`, no `GH_TOKEN`
PAT) so the local paths are the only active revisers. A repo without a local runner enables the
CI workflow instead (set the variable + PAT) and leaves `revise.local` moot (its markdown /
non-PR-target case is a no-op anyway).

### Local sweep (issue #76) — active

Gated on `revise.local` (default `true`; see [docs/config.md](./config.md#local-revise-sweep)), the
orchestrator sweeps for revisable red-review PRs **before** the pick worker pool and revises each one
**in-process** on the local subscription — no metered API key, no CI VM. It is a hard no-op unless the
run is `roadmap.source: github-issues` + a PR ship target + pure auto-pick mode (`--cycles`, no
`--item` / `--resume` / `--no-worktree` / `--dry-run`).

- **Trigger** — start of a normal `--cycles` run. One `gh pr list` finds open, non-draft,
  `feat/issue-<n>` PRs whose `review` check-run concluded `FAILURE`.
- **One-pass bound** — the shared `autopilot:revised` label, added **before** any work
  (`claimRevision`). Labeled-still-red PRs are filtered out of the candidate set and get one
  idempotent human-handoff comment instead. The label doubles as a manual kill switch and its
  absence gates the revise, exactly as in CI.
- **Reuses the resume plumbing** — each revision runs with a `--review-findings` file fetched from
  the PR-review comment. Findings imply `startFrom: "implement"` unless the caller explicitly passes
  `--from`, so parking, notifications, cost accounting, and the ship target all apply for free.
  Revisions don't consume `--cycles` but do count toward `--budget`.
- **Findings survive a park** — the findings file is written under `.dev/` (gitignored). If a revision
  parks and later auto-resumes, `resumeOne` re-injects the on-disk findings so the resumed implement
  still fixes the specific blockers.
- **Fail-soft** — any `gh`/git error in the sweep logs a warning and skips (that candidate or the whole
  sweep); the normal pick loop proceeds regardless.
- **Cross-process atomicity** (local vs a re-enabled CI) is out of scope: it is safe only because CI is
  disabled repo-wide, so local is the sole active reviser. Re-enabling CI while the local sweep runs is
  unsupported.

### CI workflow (issue #60) — API-funded alternative

A red `review` gate can instead be closed in CI: `.github/workflows/pr-review-revise.yml`
triggers on every completed `workflow_run` of the review workflow and, **exactly once per PR**,
re-implements from the findings and re-pushes so the gate re-runs.

- **Trigger** — `workflow_run: completed` on `"PR review gate"` (the `pr-review.yml` job's
  `name:`), gated to same-repo, non-fork, `feat/issue-*` branches whose linked issue carries the
  `autopilot` label, with CI-runner mode active (`AUTOPILOT_REVIEW_RUNNER != 'local'` — in local
  mode the local revise sweep owns revision). The run **conclusion** is deliberately not
  consulted: `pr-review.yml` keeps its run green on an ordinary BLOCK (the required `review`
  commit status is the gate, not the workflow conclusion), so the job's first step reads the
  `review` status on `workflow_run.head_sha` and proceeds only on `failure`/`error`.
- **SHA binding (ADR-0025)** — the reviewed `workflow_run.head_sha` is the candidate the red
  status, the findings, and the one-pass label are statements about. A trusted-phase guard
  verifies the PR's current head still equals it (mismatch → park naming both SHAs, label
  unspent — the newer push's own review run re-enters the loop), the privileged checkout binds
  that immutable OID (never the mutable branch name), and after the checkout's fetch the remote
  head is re-verified so the revise push's `--force-with-lease` retry can never clobber newer,
  unreviewed commits.
- **One-pass bound** — the workflow adds an `autopilot:revised` label to the PR **before** doing any
  work. On a second red review the label is already present, so the workflow posts a park-for-human
  comment and stops. A per-branch `concurrency` group (`cancel-in-progress: false`, which serializes
  rather than cancels) makes the label check effectively atomic. The label doubles as a **manual kill
  switch**: pre-apply `autopilot:revised` to opt a PR out of auto-revision entirely.
- **Global off-switch** — set the repo Actions variable `AUTOPILOT_AUTO_REVISE` to `false` to disable
  the loop repo-wide (the workflow's job `if:` checks `vars.AUTOPILOT_AUTO_REVISE != 'false'`).
- **The revision seam** — the workflow first checks out the **default branch** and, from those
  trusted bytes, writes the pr-review findings comment to `$RUNNER_TEMP/review-findings-<id>.md`
  (outside the workspace) via `ci/fetch-review-findings.ts`, which reuses the CLI's
  canonical author-trust rule (`fetchReviewFindings` → `isTrustedCommentAuthor`) so a PR
  participant's copied marker can never become the CI revise prompt. Running the selector from
  default-branch bytes is itself load-bearing: the selector is the gate that decides whether
  PR-head code may run in this privileged job, so the PR head (and the PAT) enter the job only
  **after** that trust decision. Post-gate, the workflow checks out the PR head and runs
  `pelaggio --resume <id> --no-worktree --target pull-request --review-findings <path>`.
  `--review-findings` is a **resume-only** flag: it reads the file best-effort and injects the findings
  into the implement step as revision input. With no explicit `--from`, it routes the resume to
  `implement`; an absent/unreadable file never crashes the resume. The `pull-request` ship is
  idempotent — it skips `gh pr create` when a PR is already open and just pushes to the existing
  branch.
- **PAT push is load-bearing** — commits pushed with the default `GITHUB_TOKEN` do **not** trigger
  `pull_request` workflows (GitHub anti-recursion). The re-review depends on a `synchronize` (push)
  event, so the workflow's **post-gate PR-head** `actions/checkout` uses
  `token: ${{ secrets.GH_TOKEN }}` (a PAT). Without it the ship pushes but the loop silently never
  re-reviews. Pre-gate steps authenticate with the scoped default `github.token` only.

Every failure branch terminates: if the revision run itself crashes/parks before pushing, no
re-review fires, the label is already set, and the `if: failure()` step posts a park comment — no
second attempt.

### Operator command (issue #498) — on-demand

When a managed PR is currently review-red, an operator can start one findings-driven revision
without waiting for the local sweep or re-enabling CI:

```bash
npx pelaggio revise --pr <number> [--allow-repeat]
```

Run it from the **main checkout** (the same station as `land` / `pr-review`) so `REPO` /
`WORKTREE_PREFIX` resolve the claim worktree. It does not add a pipeline step: it writes the latest
`<!-- pelaggio-pr-review -->` comment to `.dev/review-findings-<id>.md` and calls the public
`--resume <id> --review-findings <abs-path>` orchestrator in `operator-revision` mode.

- **Eligibility** — the PR must be open, non-draft, same-repository, on
  `feat/issue-<n>[...]`, currently review-red, linked to a pelaggio-managed issue, and the
  configured ship target must be `pull-request` or `auto-merge-pr`. Drafts, closed/merged PRs,
  forks, green/pending/missing review, unmanaged issues, `direct-push`, and `CI` /
  `PELAGGIO_SINGLE_SHOT` / `--no-worktree` all refuse before paid work.
- **Durable findings** — the marked gate comment is written verbatim under `.dev/` and left in
  place on every later outcome so a parked/retried revision keeps its task.
- **Execution exclusivity** — every revision attempt (a first pass, an `--allow-repeat`
  repeat, an in-run sweep revision, and every findings-driven resume — the auto-resume
  after a park and the advertised manual `--resume <id> --review-findings <path>`
  continuation alike) holds the per-item execution lease under `MAIN_REPO/.dev/revise-exec/`
  for the duration of the attempt, so two passes can never revise the same claim worktree
  concurrently. The lease is released when an attempt parks (never pinned across a
  rate-limit reset sleep) and **reacquired by every resume path** before it touches the
  worktree; a refused acquisition names the holder pid and the lease file and never proceeds
  unleased. There is no automatic reclaim — not even when the holder pid is gone: provider
  child processes can outlive a crashed orchestrator and keep mutating the worktree, so
  crash recovery is manual (verify nothing from the pass is still running, then remove the
  named lease file).
- **Head binding** — before any work, the claim worktree's branch and `HEAD` are verified
  against the PR's head branch and head OID from the same lookup. A stale or mismatched
  checkout fails closed naming both SHAs; nothing is ever reset or checked out over an
  existing tree.
- **Audit comment** — invocations append a new `<!-- pelaggio-revise-invocation -->` PR comment
  (`disposition=accepted-first-pass|refused-repeat|accepted-repeat`). `accepted-*` records are
  posted only after the pass is actually owned (label claimed, lease held), so a losing racer
  never leaves an audit record for a pass it did not run. Failure to post it fail-closes (no
  revision work).
- **`--allow-repeat`** bypasses only the `autopilot:revised` label — never the execution
  lease. It does not remove the label, skip review, or change the ship target.
- **Park handback** — a parked first pass is not a repeat. Continue it with the printed
  `pnpm pelaggio --resume <id> --review-findings <abs-path>`, which reacquires the execution
  lease before touching the worktree; running `revise --pr` again is a new pass and needs
  `--allow-repeat`.
- **Exit** — `0` success, `1` refused/unavailable/failed revision, `2` usage or ambient
  single-shot / missing repo / non-PR ship target.

## Document review — `pelaggio doc-review <path>` (#384)

```bash
npx pelaggio doc-review docs/plans/384.md [--profile <name>] [--json] [--out <report.json>]
```

A read-only, provider-diverse review of an **arbitrary document** (a design/plan/spec) — the same
Claude/Codex/Grok panel the authoring loop uses, aimed at prose instead of a branch diff. It reuses
`runReviewLoop` in its typed `mode: "no-revise"`: there is no author revision seat, no claim branch,
no feature worktree, no `Step` lifecycle, and no park/resume. The revision branch is unreachable **by
construction** (the no-revise options union has no `revise` prompt), not merely disabled at runtime.

- **Document snapshot contract.** The file is read once, its raw bytes hashed (sha256), and the
  identical content injected into every seat prompt under `## DOCUMENT UNDER REVIEW`. The digest is
  re-verified before the report is written; a file that goes missing or changes mid-review fails
  closed (exit 1, no success report). Missing / non-file / non-UTF-8 input is rejected (exit 2).
- **No safety floor.** The code-diff path-signal taxonomy is the wrong floor for bare prose (every
  unmatched finding would sink to the non-contractible `correctness-regression` class and become an
  un-refutable hard-block — park theater for a doc nit). So the run declares `safetyFloor: "disabled"`
  honestly on the result and report; the Judge's ruling governs. Emission-time classification still
  runs on the real taxonomy for the forensic `classification` on each finding. A signed
  document-domain taxonomy is deferred.
- **Report.** A path+digest-bound `DocReviewRecord` (never the roadmap-shaped `ReviewRecord.itemId`)
  is written to `.dev/doc-review-records/<runId>.json` under the cwd, with the document binding,
  diversity status, `safetyFloor: disabled`, and the loop outcome. Human markdown goes to stdout by
  default; `--json` prints the JSON record; `--out <file>` also writes it.
- **Exit codes.** `0` = `converged-clean` / `converged-with-notes` / `ceiling`; `1` = `hard-block` /
  `dissent` / `budget` (rate-limit park) / crash / digest-changed; `2` = usage / missing path.

The reviewer seats run the `pr-review` skill in `--document` mode; the Judge runs `pr-verify`
`--authoring-loop-judge` (same wire format as the authoring loop).

## Follow-ups (not in this gate)

- **Notifications** — surface a red gate as a park-for-attention alert (issue #34).
