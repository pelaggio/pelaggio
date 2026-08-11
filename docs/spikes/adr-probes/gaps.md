# Gap ledger — findings to charter

Defects and unmet claims surfaced by the probe campaign that are **independent of whether A–K ever
ship**. Collected here rather than chartered one at a time; the campaign proposes, it does not file.

Each entry records what is wrong, how it was found, and why it is not merely an ADR-text problem.

---

## G1 — `TC-014` is a `guarantee` that does not hold on the default driver

**Severity:** trust-claim failure. **Found by:** P2.

`TC-014` claims spawned driver subprocesses receive a deny-by-default allowlisted env — *"PATH/HOME
plus explicitly configured vars only, never the full parent `process.env`"* — at status
**`guarantee`**. The claude child returned the exact literal value of a canary set only in the parent
environment and absent from the allowlist. Disk/output confirmed, not self-reported.

`buildAgentEnv` is correct and unit-tested. It is called by `codex-provider.ts`, `grok-provider.ts`,
`opencode-provider.ts` and `contained-execution.ts`. The claude path forwards `spawnOpts.env` as the
SDK constructed it.

**Why it survived:** `TC-014`'s `evidence_command` runs `secret-hygiene.test.ts`, which tests
`buildAgentEnv` in isolation plus log scrubbing. No test asserts that a driver path *calls* it — a
verified mechanism with unverified application.

**Charter shape:** route the claude adapter through `buildAgentEnv`; add a per-driver conformance
test asserting every registered adapter applies it; re-evidence `TC-014` at the call sites or
downgrade it from `guarantee` until it holds.

---

## G2 — no per-driver authority conformance test exists

**Severity:** structural. **Found by:** P2.

The gap in G1 is one instance of a missing class of test. Nothing asserts that a new Agent Driver
adapter applies the harness's authority construction, so the next adapter can omit it exactly as the
claude path does, and every existing test will still pass.

**Charter shape:** a driver-conformance suite parameterized over the registered adapters, asserting
the harness-owned controls that must hold regardless of driver-native behavior.

---

## G3 — `StepResult` text fields carry unresolved provider variance

**Severity:** correctness hazard. **Found by:** P1.

`text`, `fullText` and `assistantText?` have semantics that differ **by provider**: `text` is the
final chunk on some and truncates a block split across parts; `fullText` carries repository-controlled
tool data on others; `assistantText` is documented as "the only field safe to parse structured model
output from" yet is optional, with cross-provider conformance still chartered (#418).

Any code parsing structured output from the wrong field is provider-conditionally wrong. This is
adjacent to the repeated parse-invalid review failures observed during the #480 review passes, though
this campaign has not established that link.

**Charter shape:** finish #418 — make `assistantText` required and assert it cross-provider.

---

## G4 — `RunStepOpts.onChildSpawn` is driver-specific on the driver-neutral contract

**Severity:** design. **Found by:** P1.

Documented as *"register the Claude SDK child PID"*. Optional, so no other adapter fails a type check
by ignoring it — which is how a driver-specific concern persists inside a shared seam indefinitely.

**Charter shape:** express the PID-observation concern through the claude adapter rather than the
shared step contract, or generalize it to an adapter-supplied capability.

---

## G5 — a non-recoverable step abort strands claim state across three systems

**Severity:** operational, compounding. **Found by:** P3 (self-inflicted, then reproduced).

An `error_confinement` abort is correctly non-recoverable — ADR-0001 forbids checkpointing onto a
tree proven contaminated. But the claim state it already created survives it:

| Stranded | System | Consequence for the next run |
|---|---|---|
| claim worktree + branch | git | `pick:worktree-exists` |
| `in-progress` roadmap label | GitHub | `pick:diverted` — pick claims a *different* item |
| the diversion's own claim | git + GitHub | a **second** item is falsely marked in-progress |

Observed as four consecutive failed cycles ($0.19, $0.09, $0.26, then the real run), each caused by
the previous one's debris. Every guard fired correctly; none has a clearing transition wired to it.
Recovery required manual action in both git and GitHub with no single command.

This is the ADR-0026 decision-4 shape — an absorbing-without-progress state with no exit — appearing
in the claim/pick path, which that decision currently scopes out.

**Also observed:** the diverted pick marked the wrong item `in-progress` **before** the guard refused
it — an attempt marker written ahead of the work it authorizes, which is conflation #2 from
ADR-0026's own context section, live.

**Charter shape:** a claim-release edge on non-recoverable abort (worktree, branch, and roadmap
label together), and move the in-progress marker to *after* the pinned-item check.

---

## G6 — the charter is never captured into the lineage

**Severity:** provenance. **Found by:** P3.

G requires the dossier to answer "why did this work exist / what was chartered" without mutable
external joins. The charter lives in a GitHub issue body, editable after the fact, and nothing copies
it into the record at claim time. The first question on G's own list is unanswerable durably.

Same class: landing authorization lives in branch-protection status checks on GitHub and is never
mirrored into the record.

**Charter shape:** capture-at-the-boundary — snapshot the charter (with digest) at claim, and the
landing authorization at ship.

---

## G7 — no authority profile is recorded per step

**Severity:** provenance + safety. **Found by:** P2 and P3 independently.

No step declares or records the authority profile it ran under, so the dossier cannot answer "under
what authority/sandbox profile" — and, per P2, there is largely no profile to record on the bare
`runStep` path. The provenance gap and the enforcement gap are the same gap seen from two sides.

---

## G8 — no typed record of which deterministic checks ran

**Severity:** provenance. **Found by:** P3.

Check invocations happen inside step execution. Nothing records *which* gates ran for a given step,
so "what deterministic checks ran" is unanswerable from durable state. Cheap to close at emission
time; requires no transcripts.

---

## G9 — the status vocabulary cannot express "partially implemented"

**Severity:** documentation integrity. **Found by:** P4, and independently by the third trio review.

ADR-0026 is `status: proposed` (*decided, not yet implemented*) while #475 has implemented the
atomic-allocation half of its attempt-identity construction — decision 10's promoted form, the
*attempt-freshness-unforgeable* constraint, remains unmet, but part of the construction is real.
Bundling ten decisions into one ADR makes partial implementation the norm rather than an edge
case, and the vocabulary has no term for it.

The third trio review reached the same conclusion from the document side (finding C17). Two
independent methods, one defect.

**Charter shape:** resolve alongside Stage 3's status re-triage; consider whether a bundled ADR
should carry per-decision status.

---

## G10 — two changes landed with no reconciliation of the claims they altered

**Severity:** documentation integrity / trust. **Found by:** P4.

- **#475** shipped the atomic-allocation half of ADR-0026's attempt identity (never the authority
  half); neither the ADR status nor `guarded-actions.md` was updated when it merged.
  `guarded-actions.md` gained its #475 status note only later, from this campaign's revision.
- **#427** pinned third-party workflow actions to immutable commit SHAs — a supply-chain posture
  change under ADR-0007 / `TC-005`. No trust document records it.

Both belong to the class K says must **escalate**. The six construction/behavior changes in the same
sample all reconciled correctly, so the failure is not noise — it is silence on the highest-stakes
class.
