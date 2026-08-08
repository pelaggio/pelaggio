# Coherence audit: the code, the tests, and the docs describe three different systems

Status: analysis, pre-decision. Measured 2026-08-08 at `54fc61e`.

## The claim

Pelaggio has three descriptions of itself. They have drifted, the drift is **self-inflicting**,
and it is the common cause behind a class of failures this session hit repeatedly. Adding
more documentation makes it worse. The work is *subtraction* — shrinking the written surface
to what is true, and making target-state structurally separable from present-state.

## Measured

| | |
|---|---|
| source files / LOC | 78 / 25,983 |
| test files / LOC | 66 / **28,031** (1.08× source) |
| `pipeline.ts` | **3,498 LOC** — 13.5% of all source in one file |
| ADRs | **26 numbered**, of which **12 are `proposed`** (46%) |
| `AGENTS.md` Project Invariants | **24 bullets**, **9 tagged `(flow, planned)`** (38%) |
| `docs/agent-context/` | 13 docs / 2,555 LOC, **4 tagged `(design)`** |
| open issues | 93, **9 older than one month** (~10%) |

**Corrections after review — the first draft's inventory was wrong in four places and the
errors all flattered the argument:**

- ADRs are **26**, not 27 (the first count included `README.md`).
- `AGENTS.md` has 56 bullets *in the whole file*; the **Project Invariants section has 24**,
  of which 9 are tagged. Quoting 56/10 both mis-sized the problem and, ironically,
  *understated* the real ratio (38% of invariants are target-state).
- "63% older than a month" conflated *created in July* with *older than a month*. Measured
  today (2026-08-08), only **9 of 93** open issues predate 2026-07-08. The backlog is
  younger than claimed, and the staleness argument at the end of this document is
  correspondingly weaker.

What survives: **a substantial minority — not "roughly half" — of the always-loaded
invariants and nearly half the ADRs describe unbuilt work**, and the tags sit at the
definition site rather than where a reader acts on them.

## The drift is self-inflicting, with evidence from this session

**1. Issues outlive the code they describe.** #461's acceptance criteria required wiring the
liveness reader into `RECONCILE_ORDER`'s sessions slot and having reap consult it. Both
arrived with PR #449; when #449 was closed, `RECONCILE_ORDER` and `reap-sweep.ts` left the
tree — verified absent. The acceptance criteria survived, so work was chartered against
symbols that no longer exist, and I discovered this only after claiming the item.

**2. A skill body overstates what the pipeline owns, and the correcting issue was closed.**
`ship/SKILL.md:78` states *"The pipeline owns squash, commit, push, PR create/update, optional
auto-merge, mark-done, archive, cleanup … for PR targets."*

**Corrected after review: this is an overstatement, not a falsehood.** PR targets do run
`runShipPrEffects` (`ship/pr-effects.ts`), which genuinely owns squash, commit, push, PR
create/update and auto-merge. Only **mark-done, archive and cleanup** are unowned for PR
targets — which is the narrower claim #444 actually made, and which the first draft of this
document inflated into "the statement is false".

The drift is still real and still unfixed: three of the eight things that sentence claims are
not true for PR targets, #444 recorded it, #444 is now **closed** (folded into G6b), and the
sentence is still in a skill body agents execute against.

**3. Fixtures diverge from production, and tests pass because of the divergence.**
`makeTempRepoWithParent` did not gitignore `.dev/` while its sibling `makeTempGitRepo` did —
with a comment explaining precisely why it must. Two `#369` tests passed *because* harness
artifacts were being committed into the branch, satisfying the plan-only ship guard for a
reason unrelated to what they claimed to assert.

**4. Planned invariants sit inline with enforced ones.** `AGENTS.md` lists 10 `(flow, planned)`
bullets among 56, in one flat list, in the always-loaded file. A reader deciding whether a
guard exists must check the tag on every line — and the tags say "planned", not "absent",
which reads as "coming soon" rather than "do not rely on this".

## Why this produces the small issues rather than merely coexisting with them

The session's expensive defects share a shape: **the code was right about itself and I was
wrong about the code.** Six gate passes on #461, and every finding was a wrong model of the
surrounding system rather than a wrong implementation of my model —

- the default `listSessionFiles` probe swallows `readdir` errors into `[]`
- the session record holds the *provider child's* pid, overwritten per spawn
- `dispose()` deletes the record, so completed cycles leave none
- `runPipeline` catches registration failure and continues
- `/proc` cwd links are EACCES for most pids (25 of 32, measured)

**The first draft claimed none of these are documented. That was false, and it was the
central mechanism claim.** `docs/agent-context/pipeline.md:80` ("Cross-process peers (#369)")
documents the session-record shape `{sessionId, claimedItem, claimBranch, worktreePath, pid,
expiresAt}`, states that *"Claude refreshes `pid` to the SDK child … and heartbeats expiry
independently of step cadence"*, describes the fail-closed eligibility predicate, the `/proc`
binding with starttime watermark, and `/tidy` sweeping expired orphans.

In other words: the pid-lifetime and heartbeat facts that cost six gate passes on #461 were
**already written down, in a routed doc, at the granularity needed** — and I did not read it
before implementing a liveness reader.

**So the mechanism is not "present-state is undocumented". It is that present-state
documentation is not FOUND.** The distinction matters because it inverts the remedy: the
problem is discoverability and routing, not volume of writing. `AGENTS.md` routes to
`pipeline.md` for "pipeline steps, step-provider seam, worktree isolation…" — a description
that does not obviously cover "how session liveness works", which is where the facts live.

What survives from the original argument: **a large written surface whose target-state and
present-state material is interleaved, with routing descriptions that do not reliably lead a
reader to the present-state facts they need.** Tests are 1.08× source by line count with five
known-vacuous cases, so volume is not assurance there either.

## What "clearing the cruft" should mean

Not a rewrite. Four separable moves, cheapest first:

**A. Route target-state OUT of `AGENTS.md`, not into a section of it.**
Move the 9 `(flow, planned)` invariants out of the always-loaded file entirely, into a routed
target-state doc. The first draft offered "a clearly-labelled target-state section **or** a
separate routed doc" while simultaneously requiring the always-loaded file to assert only
current truth — a contradiction review caught. The section option is withdrawn. Same for
`(design)` agent-context docs: a reader arriving at `flow.md` should not have to infer that
none of it is built.

**B. Reconcile the ADR ledger.** 12 of 26 are `proposed`. For each: is it *decided but
unbuilt* (keep, with the implementing item linked) or *stale* (supersede or withdraw)?
ADR-0026 amends ADR-0004 and required a manual bidirectional annotation — that should be
mechanical.

**Correction:** the first draft added "a `proposed` ADR with no open implementing item is
cruft by definition". Withdrawn. `docs/decisions/README.md` defines `proposed` as *decided,
not yet implemented*, and the rule would pressure settled decisions whose implementing work
was collapsed into G-items (ADR-0025/0026) or which are already shipped but still labelled
proposed — ADR-0003's pull-request default is live in `config.ts` today. Keep the
keep-vs-stale triage; drop the mechanical test.

**C. Make present-state behaviour FINDABLE — reconcile, do not duplicate.** Since
`pipeline.md` already documents much of it, this is mostly routing and gap-filling, not
writing:
- Fix the `AGENTS.md` routing descriptions so "how session liveness / records / pids work"
  visibly points at `pipeline.md`, rather than being implied by "worktree isolation".
- Reconcile the genuinely-missing facts against what `pipeline.md` already says — the
  registration-skip paths, `dispose()` deleting the record, probe error-swallowing — rather
  than adding a competing account.
- The claim-release sequence (#422) is genuinely unwritten and belongs in the runbook.

**D0. Correct `ship/SKILL.md:78`** to say what PR targets actually own. Review noted this was
missing from the first draft's move list despite being one of its own evidence items — and
that it needs `pnpm check:skills`, so this move is **not** doc-review-only.

**D. Audit the tests for vacuity and fixture drift** (#478, #420). 28k LOC of tests that
include five known-vacuous cases is a measurement problem, not a coverage problem.

## Sequencing, and the honest cost argument

A, B and C are documentation-only and cheap. **D0 is not** — correcting a skill body requires
`pnpm check:skills` and touches the packaged skill tree. D is a real engineering pass.

The argument for doing this *before* more primitives: G2 and G5 are next, both touch the
review gate and budget seams, and both will be implemented by someone reading `AGENTS.md`
and the ADRs. On this session's evidence, that reader will be wrong about what exists, and
will find out at review prices. The three-way drift is a **cost multiplier on every
subsequent item**, which is why it outranks the next primitive.

The argument against: none of this ships behaviour, and the backlog is already 92 items with
63% older than a month. Adding a coherence epic to a stale backlog is how backlogs get
staler. **Mitigation: A, B and C are one item, not an epic, and are scoped to a single pass.**

## What I am least sure of

Whether the backlog is a problem at all. The first draft implied it was, on a staleness figure
that turned out to be wrong: only 9 of 93 issues are older than a month. I have no measurement
supporting a staleness claim and am withdrawing it.

More honestly: **the largest uncertainty is now how much of this document's remaining argument
survives its own errors.** Four of the five measurements were wrong, the central mechanism
claim was false, and one headline example was overstated — all in the direction that made the
case look stronger. The surviving claims (interleaved target/present state, routing that does
not lead to the facts, vacuous tests, an uncorrected skill body) are real and independently
evidenced, but a reader should weight this document accordingly.
