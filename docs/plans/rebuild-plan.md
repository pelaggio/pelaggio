# Guard audit + rebuild transfer plan

Status: proposal, pre-decision. Measured 2026-08-08 at `54fc61e` against
`.dev/pelaggio-log.jsonl` (115 cycles) and full git history.

## Part 1 — The guard audit

Question asked of every guard: **has it ever fired protectively, or only destructively?**

| Guard | Commits / `fix:` | Firings in log | Protective catches | Verdict |
|---|---|---|---|---|
| Confinement **snapshot-and-diff audit** — the ADR-0001 **hard gate** | **11 / 5** | 6 violations | **1** (#435) | expensive, and **the only guard with a protective catch** |
| Confinement **PreToolUse path check** (`blockForeignRootWrite`) | — | — | **missed #435**; Claude-only; Bash excluded | ADR-0001: "early diagnostic layer only", **not** the gate |
| File locks | **4 / 1** | 0 | **0 observed** | modest churn; no observed save |
| Execution receipts | 2 / 0 | 0 | **0** | **content-bound = fenced; keep** |
| Park machinery | 7 / 3 | **22 parks** | — | **unmeasurable: 0 of 22 have a recorded cause** |
| Claim = `feat/<id>` branch | 7 / 3 | 2 `pick:worktree-exists` | concept sound | failures are missing *cleanup*, not the guard |
| Plan-only ship guard | **0 fix** | 1 | **1 genuine catch** (#216) | positive |
| Red-merge guard | **0 fix** | 0 | silent; enforced correctly twice today | positive, cheap |
| Effects manifest | 3 / **0 fix** | 0 failures | stable | positive |

### The finding that should drive the rebuild

Sort that table by maintenance cost and a clean line appears:

- **Guards that ask an authority** — red-merge (asks GitHub), effects manifest (content-bound),
  plan-only ship guard (asks git for the diff) — have **zero `fix:` commits between them** and
  include the only unambiguous protective catch.
- **Guards that observe and infer** — the confinement *snapshot-and-diff audit* (observes the
  filesystem, infers ownership), file locks (observes a lock file, infers exclusivity) —
  account for **~15 commits and 6 `fix:` commits**, and produced one late catch between them.

**Corrections after review — three counts in the table above were wrong, all flattering:**

- **File locks are 4 commits / 1 `fix:`, not 18 / 6.** `grep -i lock` matched
  block/blocker/blocked/Landlock/unlock — 14 of 18 were false hits. "Highest churn of any
  primitive" is false and is withdrawn. The hint aggregate drops from 29/11 to ~15/6.
- **Execution receipts caused zero failures.** #435 and #437 are the *items being worked*
  (confinement pick-cwd, max-turns classification), not receipt commits. The receipt collision
  is **#451**, which is an *identity* defect — and `f121a0f` fixed the runId keying **today**.
  Content-bound receipts are exactly what ADR-0026 classifies as a correct fence. They move to
  the transfer list; the remaining work is authoritative attempt fencing, not removal.
- **Confinement is two guards — and the first draft got which to keep exactly backwards.**
  This is the most serious error in this document and it survived one round of correction.

  ADR-0001 (**accepted**) is explicit: the whole-step Git porcelain audit **is the hard gate**;
  the PreToolUse path check "remains as an early diagnostic block … **it is not the hard
  gate**"; and "path extraction from tool args as the hard gate (**failed PR #112 approach**) —
  bypassable via shell indirection … **independence from tool-input path parsing is the
  load-bearing property**."

  So "keep `blockForeignRootWrite`, drop the audit" proposes precisely the approach ADR-0001
  records as failed and rejects. Three further facts confirm it:
  - **The audit's one protective catch (#435) is the case `blockForeignRootWrite` missed** —
    `pick` runs with `cwd=MAIN_REPO`, and `foreignRoots.delete(cwdAbs)` exempts it. The first
    draft proposed keeping the guard that failed and discarding the guard that worked.
  - **Bash is outside the semantic hook entirely** (`pipeline.md`), and ADR-0026's attempt-freshness constraint
    rates the Bash string guard defence-in-depth only.
  - **OpenCode declares `isolation: []`** and `blockForeignRootWrite` is Claude-only, so
    dropping the audit leaves that provider with **no enforced isolation at all**.

  **The audit transfers.** Its 11 commits are the cost of the only guard that has ever caught
  anything, on the one boundary ADR-0001 makes non-negotiable. What is worth revisiting is its
  *expense and lateness*, not its existence.

That is ADR-0026's fenced/hint distinction, confirmed from the opposite direction: not by
reasoning about soundness, but by counting what each class cost and caught.

**Selection criterion — corrected to ADR-0026's four classes, not two.** The first draft said
"transfer fenced only", which would have dropped load-bearing machinery:

| Class | Rule | Examples |
|---|---|---|
| **fenced** | transfer | red-merge, effects manifest, content-bound receipts, `feat/<id>` creation, landing CAS |
| **derived-exclusive** | transfer — the ADR-0001 isolation spine | worktree confinement via the **whole-step porcelain audit** (hard gate), with `blockForeignRootWrite` retained as the advisory early layer it is |
| **reconciled** | transfer | `review-request-queue` drain (idempotency key, claim-with-reclaim, positive terminal check) |
| **hint** | do **not** transfer as correctness | `file-lock` as a correctness primitive |

### Two facts that block confident conclusions

1. **22 of 22 parks have no recorded cause.** Parks are 26% of August cycles and the single
   largest failure category; park-cause recording (#457) landed 2026-08-05, after them. We
   cannot say why the system stopped a quarter of the time.
2. **No guard has a recorded save except #216 and #435.** Absence of evidence here is weak —
   a guard that prevents an incident leaves no log line. The strong claim is only that guards
   *caused* more observed failures than they are *recorded* preventing.

## Part 2 — Throughput evidence

| month | cycles | done | rate | parked | spend | $/shipped | `pipeline.ts` |
|---|---|---|---|---|---|---|---|
| 2026-07 | 31 | 23 | **74%** | **0** | $267 | **$12** | 1,608 → 2,257 |
| 2026-08 | 84 | 38 | **45%** | **22** | $1,145 | **$30** | → 3,498 |

Confounders, corrected: **the three-driver widening (08-06) cannot be a confounder** — the
cycle log's last record is `2026-08-05T23:44:11Z`, so no post-08-05 cycle is in this
measurement. The first draft cited it anyway. What remains: August adopted a more expensive
dogfooding gate earlier in the month, and August's work is intrinsically harder. The
completion-rate drop and the 0→22 parks are not explained by either.

## Part 3 — What transfers

**Rescue whole (~9,500 LOC), these are the differentiated, working parts:**

| Layer | LOC | Evidence |
|---|---|---|
| Provider invocation — `step-runner`, `codex`/`grok`/`opencode` providers, `acp-client` | ~2,500 | independently confirmed as a real ADR-0020 boundary; the hard part |
| `review/` panel + judge | 2,229 | found ~20 real defects in one session, several data-loss class |
| `roadmap/` adapters | 2,732 | stable; shipped a clean fix today |
| `ship/` | 1,043 | `pr-effects` cleared the gate first pass |
| `.claude/skills/` workflow bodies | 1,448 | **already the pipeline-as-skills** |

**Transfer (fenced / derived-exclusive / reconciled):** red-merge, effects manifest +
provenance, content-bound execution receipts, plan-only ship guard, `feat/<id>` claim creation
(git-atomic), `blockForeignRootWrite` boundary denial, the `review-request-queue` reconciler,
landing CAS fence (ADR-0025, unbuilt).

**Also transfer — pipeline-owned seams the first draft omitted entirely.** Review caught that
discarding `runPipeline` discards these with it:

- **`parkExit` / checkpoint-restart.** ADR-0019 and a standing repo invariant require every
  rate-limit exit to checkpoint uncommitted work. Dropping it silently means a parked run
  **loses work**. This is the most serious omission in the first draft.
- **Attempt-identity allocator** (#467, landed today as `f121a0f`).
- **Session-record peer registry** (`pipeline.md:80`) — the input to any future liveness work.
- **Effects dispatch wiring.**

**Also transfer — further omissions caught in round two.** Discarding `runPipeline` also
discards: the ADR-0022 authoring-review loop wiring inside `shakedown-code`; the
`resume`/`detectResumeStep` half of ADR-0019 checkpoint-restart; and the direct-push handoff —
pre-ship capture, landing verification, `/shipwreck` recovery, and invocation of the
deterministic bookkeeping tail. Preserving `ship/` while discarding `runPipeline` does **not**
preserve the verified-landing contract.

**Do not transfer:** `file-lock` as a correctness primitive. It may return later as a fenced
design with a recorded incident justifying it.

**Transfer with mandatory corrections, not as-is:** the `review-request-queue` reconciler must
adopt ADR-0026's *a time lease is not liveness* constraint and its two fixes — liveness-gated reclaim instead of the heartbeat-less
four-hour lease, and idempotent-or-fenced terminal effects. Copying its current shape is what
that decision calls "adopting its bug".

**Discard:** `runPipeline` + `runOrchestrator` choreography (3,033 lines, 87% of `pipeline.ts`).

## Part 4 — Context hardening (the calibration gap)

**Measured:** the harness injects **no root instructions into any provider.** The only
`systemPrompt` is the Claude SDK's `claude_code` preset plus an append
(`step-runner.ts:430`). `AGENTS.md` appears nowhere in prompt construction — only in
`check-skills.ts`, a linter. So calibration is whatever each provider does natively:

- **Claude** auto-loads `CLAUDE.md` → imports `AGENTS.md`. Gets it.
- **Codex** reads `AGENTS.md` by convention. Probably gets it.
- **Grok** — no evidence either is read. **Unverified.**

And `docs/agent-context/*` is reference-only for all three: nothing guarantees an agent opens
the doc it needs. This session is the demonstration — six gate passes were spent rediscovering
session-record facts that `pipeline.md:80` already documents.

### What to build

**P-CTX1 — Explicit context assembly.** A primitive that composes the context a step requires
(root invariants + the routed docs for that step's surface) and injects it per provider, rather
than relying on native conventions. Provider-neutral input; per-provider delivery.

**P-CTX2 — Step→context routing table.** Declares which routed docs each step needs, so
"liveness work needs `pipeline.md`" is data rather than a reader's guess. This is the index
`system-map.md` argues for, in executable form.

**P-CTX3 — Calibration probe.** Ask each configured provider to quote a specific invariant
before a run. A driver that cannot is not calibrated and must be **refused a seat**.

*Corrected again:* ADR-0020's `degraded` means an *eligible* provider missing soft
preferences — such providers are still seated. Recording an uncalibrated driver as `degraded`
would let it run anyway, which is not fail-closed. The probe needs a distinct
**ineligible/unavailable** outcome plus an admission rule that excludes the seat.

*Corrected:* the first draft cited an `evidence: degraded` axis in ADR-0026 decision 4 (*judgment, evidence completeness and disposition are distinct*). **No
such value exists** — decision 6 defines evidence as `complete | partial | unavailable`,
computed from matrix completeness *independently of cause*, and putting provider degradation
there would recreate the evidence/disposition conflation decision 7 exists to prevent. I wrote
that ADR today and still misquoted it, which is its own argument for P-CTX2.

**Cheap, and it settles whether today's three-driver fan-out is three calibrated reviewers or
one plus two working from the diff.**

### Unit tests these need

- Assembly is deterministic and complete: for each step, the composed context contains every
  invariant the routing table declares.
- Each provider adapter *receives* it — asserted at the adapter boundary, not the SDK call, so
  the test cannot pass on a mock that never delivers.
- The probe fails closed: an unreachable/silent provider is `degraded`, never `calibrated`.
- **Anti-vacuity:** each test asserts against a real invariant string from `AGENTS.md`, so
  drift in the file fails the test rather than passing a stub. (Per #478 — three tests this
  session passed while exercising nothing.)

## Part 5 — Sequencing

1. **Park-cause recording is already landed (#457) — run a campaign and let 20+ parks accrue
   with causes.** Without this the largest failure category stays unmeasurable, and any
   before/after comparison of the rebuild is unfalsifiable. Cheapest, highest-information.
2. **P-CTX3 calibration probe.** One run; settles the fan-out question and may reframe the
   review economics entirely.
3. **P-CTX1 + P-CTX2** with their tests.
4. **New orchestrator** over the rescued layers, phases as units per `STEPS`.
5. **Re-introduce guards per the four-class rule above** — not "fenced only", which is the
   error corrected in Part 1 — each with the incident that justifies it.

## Part 6 — Where this could be wrong

- **The rewrite trap.** 3,033 discarded lines encode 74 `fix:` commits. The audit argues most
  of that is scar tissue from hint-guards, but "no recorded save" is weak evidence — a guard
  that works silently leaves no trace. The red-merge guard is exactly that case, and it is on
  the transfer list.
- **Confounded throughput.** July was simpler work with a cheaper gate. Attributing the 74%→45%
  drop to complexity alone overstates it.
- **My analyses this session have needed correction three times**, each on a load-bearing
  claim, each caught by review and not by me. This plan should be read with that prior.
