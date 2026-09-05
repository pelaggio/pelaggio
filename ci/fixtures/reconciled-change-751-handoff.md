<!-- pelaggio-golden-handoff-v1 -->
## Canonical handoff — one golden reconciled-change run

**This section is the authoritative execution brief.** The remaining body preserves the product acceptance charter and design boundaries; the issue comments preserve preflight evidence. Claim and run **#751 only**.

### Mission

Deliver one real Pelaggio change as a **reconciled change**: the exact code result plus a bounded, content-addressed delivery Case that lets a cold developer adjudicate it without reconstructing project history, the agent session, or raw execution logs.

The selected payload is #706. It is an input to this campaign, not a second independently executing assignment.

### Golden payload

Use #706: quick-mode resume with a committed plan must not enter excluded `plan` or `shakedown-plan` steps, while standard-mode behavior remains unchanged.

Before authorizing implementation:

1. reproduce #706 against the chosen current base;
2. instrument the entry decision as #706 A-1 requires;
3. confirm later pipeline/module refactoring has not already removed the defect; and
4. if it does not reproduce, stop and report the task stale—do not manufacture a golden change or silently choose another issue.

### One-run boundary

- one claimed campaign: #751;
- one implementation branch and PR;
- one exact code change satisfying #706;
- one immutable Case for that exact result;
- one generated dossier and verifier result;
- no child issue unless a concrete independently landable blocker satisfies the child-issue rule below;
- no independent run of #706 while this campaign holds it.

The implementation PR should reference both issues. #706 may close when its defect is fixed; #751 closes only after the delivery Case, mutation oracle, and cold adjudication pass.

### Required prospective records

Capture real values during this run; do not reuse the synthetic green fixture conclusions:

- authorized-intent Decision;
- exact repository, base, result-tree, and diff binding;
- final-diff scope Assessment with accepted/excluded scope and residual uncertainty;
- deterministic governing-context resolver Observation;
- subject/configuration-bound observations for #706 AC-1 through AC-4;
- attributable final review Assessments and explicit finding dispositions;
- harness-issued Case closing obligations, admitted records, and residuals;
- Policy Decision over the Case digest;
- Human Decision over the Case digest;
- landing Effect if the change is merged during the experiment.

The four record kinds remain `Observation | Assessment | Decision | Effect`. Evidence is a basis role. Do not add new record classes unless the live run produces a falsifier that cannot be represented honestly.

### Selected envelope

Use a content-addressed object bundle rooted at:

```text
immutable records -> Case -> policy/human Decisions -> Effects
                         |
                         +-> deterministic human dossier
```

The dossier is a projection, not authority. The Case closes one decision boundary for one exact subject. Later Decisions and Effects extend lifecycle state without rewriting the Case.

Required transport behavior:

- canonical bytes and object digests verify;
- every admitted record and verification-required embedded attachment resolves;
- extra unattached objects cannot strengthen the Case;
- missing Case material localizes to `WITHHOLD`;
- established adverse evidence localizes to `REJECTED`;
- missing later authority/effect reports `AWAITING AUTHORIZATION` or `EFFECT UNPROVEN` without corrupting the Case;
- replay-only or drill-down evidence may be unavailable only when that reduced availability is explicit.

Local fixture identities and shadow records are sufficient for this milestone. Production PKI, Sigstore, transparency logs, and cloud storage are not required.

### Required verifier mutations

At minimum, demonstrate localized outcomes for:

1. changed result tree;
2. missing required evidence;
3. valid evidence for another subject/configuration;
4. open material finding or missing disposition;
5. wrong human authority or Decision for another Case;
6. landed result differing from the authorized result.

A hand-edited green dossier must be discarded and regenerated from the canonical roots.

### Default dossier

The default view must answer:

1. What exactly am I accepting?
2. Why is Pelaggio presenting it as acceptable, withheld, or rejected?
3. What remains for me to decide?

Prefer one subject header, one disposition, one obligation table of roughly 5–8 grouped rows, material residuals, authority, effect, and evidence-availability state. Store a fact once and reference it. Do not embed step timelines, transcripts, or raw logs by default.

### Cold adjudication gate

Give a fresh developer two packets in unknown order:

- the valid golden packet;
- the same packet with one consequential mutation.

Each packet contains only the generated dossier, verifier output, closed bundle, and record/attachment inspection command. Withhold issue/PR discussion, sessions, cycle logs, raw logs, this design history, and the expected answer.

The campaign passes only if the reviewer:

- identifies the exact subject;
- reaches the intended disposition for both packets;
- localizes the mutation;
- identifies material residuals and remaining human judgment;
- distinguishes Case completeness from authorization/effect lifecycle state; and
- does not need scattered history or raw logs to decide.

Reviewer disagreement with policy is not product failure if the Case and residual judgment are understood.

### Deliverables

The single PR/run must leave:

- the #706 behavior fix and regression checks;
- the smallest code/fixture path needed to emit and verify the golden bundle;
- canonical Case-rooted objects;
- deterministic one-screen dossier;
- verifier transcript for the valid Case and required mutations;
- valid and mutated cold-review packets;
- final human Decision and landing Effect when available; and
- a short result comment on #751 stating whether the product acceptance test passed, withheld, or was falsified.

### Explicit non-goals

Do not build a Ledger, Casebook, hosted registry, generalized workflow engine, production signing deployment, exhaustive corpus model, or complete retention system. Do not promote the paper schema merely because it is documented. Implement only the thinnest path required to make the real #706 delivery independently adjudicable.

### Stop conditions

Stop and report rather than broadening when:

- #706 no longer reproduces;
- the exact subject cannot be bound;
- required scope/context/evidence/authority cannot be established;
- a child slice would be necessary but does not satisfy the child-issue rule;
- the envelope becomes mostly ceremonial metadata; or
- the reviewer must reconstruct the case from history/logs.

### Invocation

> Run #751 as the single golden reconciled-change campaign. Do not run #706 independently.

### Preflight record

- retrospective reconstruction: https://github.com/pelaggio/pelaggio/issues/751#issuecomment-5473635471
- cold dossier and irreducible-record deletion: https://github.com/pelaggio/pelaggio/issues/751#issuecomment-5473988750
- dependency and compatibility counter-fixtures: https://github.com/pelaggio/pelaggio/issues/751#issuecomment-5474028093
- envelope topology comparison: https://github.com/pelaggio/pelaggio/issues/751#issuecomment-5474070870
- literal bundle and mutation oracle: https://github.com/pelaggio/pelaggio/issues/751#issuecomment-5474097230
- assertion authority, blind-review protocol, cost boundary, task selection: https://github.com/pelaggio/pelaggio/issues/751#issuecomment-5474107763
