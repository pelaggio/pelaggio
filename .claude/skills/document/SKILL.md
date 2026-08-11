---
name: document
description: Author or revise a repo document in the correct lane — ADR, agent-context, trust, or AGENTS.md — enforcing the three-layer seam so invariants, constraints, and construction each land in their home
argument-hint: "<what to document> [--adr | --context | --trust | --cut <ADR-NNNN>]"
disable-model-invocation: true
allowed-tools: Read Glob Grep Edit Write Bash(pnpm:*)
consumer: false
---

# /document — Author a Repo Document in Its Lane

> **Status: the shape convention this skill routes to has landed.** `docs/decisions/README.md`
> § "Required shape" (shipped with PR #479) now requires `docs/decisions/_TEMPLATE.md` and the
> `construction:` frontmatter field for new and re-cut ADRs; that README is the governing rule,
> and this skill follows it. What has **not** landed is the mechanical gate — `pnpm check:adr`
> and its `ci/adr-shape-baseline.json` ratchet are #481's chartered work — so the shape is
> reviewer-enforced for now and the [Absent artifacts](#absent-artifacts--do-not-execute)
> section at the end stays fenced. The wider re-cut of existing ADRs tracks
> `docs/plans/adr-reconciliation.md`, whose own header still reads pre-decision; if that
> sequencing settles differently, this skill changes with it.

A ship's papers are only useful if each one says the thing it is *for*. This repo has four
documentation lanes, and the recurring defect is not a missing document — it is content in the
wrong lane, or the same content in two lanes drifting apart.

Parse `$ARGUMENTS` for the subject and an optional lane flag. With `--cut ADR-NNNN`: follow
[Cutting an existing ADR](#cutting-an-existing-adr) near the end. Its ratchet bookkeeping is
blocked on #481 — skip that part and say so in your report.

## The governing test

For every sentence considered for an ADR, ask:

> **If the mechanism changed tomorrow, would this sentence still be required to avoid
> reintroducing a known failure?**

This is the semantic test — the README calls it the cut test. Everything else in this skill
exists to help apply it.

- **Yes, because it states what must remain true** → invariant / `## Decision`.
- **Yes, because it rules out a known-bad solution shape** → `## Constraints on any implementation`.
- **No, because it describes how today's mechanism achieves the property** → construction; move it
  out of the ADR.

Do not preserve an implementation boundary merely because it currently delivers a valuable
property. Preserve the **property**. For example, "independent evaluation receives no mutable author
session state" can be architectural; "therefore it must not use the common checkpoint/effects
machinery" is construction unless sharing that machinery has itself been shown to violate the
property.

Likewise, do not turn an observed strategy into a universal noun. A review panel, Judge, lock,
broker, parser, provider hook, queue, or particular orchestrator earns ADR status only when a
replacement would have to preserve that exact mechanism to avoid a demonstrated failure or to keep
an externally load-bearing contract.

## Step 1 — Route to the lane

The lane map below mirrors `docs/decisions/README.md` § "The four documentation lanes", which is
the governing copy.

| Lane | Holds | Test |
|---|---|---|
| `AGENTS.md` | the invariant **index** — one line, always loaded | Does every agent need this on every task? |
| `docs/decisions/*.md` | the settled decision and *why* | Is it hard to reverse, cross-cutting, or re-debated? |
| `docs/agent-context/*.md` | design/RFC exploration, **construction**, and operator how-tos | Would this need rewriting when the code changes? |
| `docs/trust/*` | the *what + proof* | Does an external party verify this claim? |

**RFC-before-ADR.** A design doc explores; an ADR records the decision it converged on. Do not
open an ADR for something still being explored — write it in `agent-context/` first.

Keep the ADR bar where it is. Do not lower it to log a routine choice, a current topology, or an
experiment that has not yet earned permanence through use.

## Step 2 — Apply the three layers

This applies whichever lane you land in, because it decides what *stays behind*:

- **Invariant** — what must always be true. → ADR `## Decision`.
- **Constraint** — what a *replacement* must also satisfy, phrased as a prohibition or required
  property, citing the failure that motivates it. → ADR `## Constraints on any implementation`.
- **Construction** — how it is built today. → `agent-context/` (or code, or a test).

Write constraints as negative constraints on the solution space. *"Must not depend on parsing tool
inputs (PR #112)"* — not *"uses the Git porcelain audit"*. The first survives a rewrite; the second
has to be deleted by it.

A constraint should normally answer **what failed, or what external contract would break, if this
constraint were removed**. If it cannot answer either, challenge whether it is actually a
constraint or merely a preference.

### Properties over topology

When reviewing an existing ADR, explicitly separate:

1. the **user/trust property** being promised;
2. the **negative constraint** learned from prior failures;
3. the **current topology/mechanism** delivering it.

Only (1) and justified parts of (2) belong constitutionally. The number of orchestrators, exact
step count, warm-vs-cold implementation plumbing, provider-native hook, retry algorithm, or current
storage layout are construction unless changing them would violate the property or a proven
constraint.

### Policy over premature constitution

A configurable posture is usually policy, not architecture. Review counts, model/provider mix,
readiness rubrics, severity tables, tolerance dials, retry counts, and similar values should stay in
policy/config unless the architecture genuinely depends on their exact shape.

The invariant may instead be something like "policy may reduce rigor but must never broaden
execution authority". Record that invariant; do not constitutionalize today's table merely because
it implements it.

## Step 3 — Write it

For an ADR, start from `docs/decisions/_TEMPLATE.md` and keep its six sections in order
(`Context`, `Decision`, `Constraints on any implementation`, `Alternatives not taken`,
`Consequences`, `Construction`). The governing rule is `docs/decisions/README.md` § "Required
shape": MADR 4.0.0 (`adr-template-minimal`), numbered sequentially; frontmatter carries `title`,
`status`, `date`, `claims`, and `construction:` — the path of the detail doc that holds the
mechanism (with a resolvable `#anchor` when given), or the literal `none` when nothing is built
yet; no source-file paths or code symbols outside `## Construction`. Add a row to the README's
index table — decision one-liner, a status from the README's vocabulary, and the `TC-` claim(s)
the ADR governs, if any. The shape is reviewer-enforced until the #481 gate lands (see
[Absent artifacts](#absent-artifacts--do-not-execute)); that is not license to drift from it.

For an `agent-context/` doc, check first whether the construction already has a home — the common
failure is a second copy that drifts. Extend the existing section rather than opening a new file.

Never restate a construction detail in the ADR "for convenience". One home, one copy, a link
between them.

### Do not write to the checker

The doc checks in Step 4 enforce a mechanical floor, not architectural truth. Do **not** contort
prose to satisfy a syntactic rule while preserving the wrong semantics, and do not infer that a
sentence is architectural merely because a checker permits it.

If a useful invariant or constraint trips a check, first apply the governing test above. If the
sentence genuinely survives mechanism replacement, **never weaken or narrow a checker to
accommodate the document under review** — escalate to the operator with the exact sentence and the
exact rule it trips, and leave the checker to change (or not) as its own reviewed change.
Conversely, passing the checks is not evidence that a document says the right thing.

## Step 4 — Verify

```bash
pnpm check:links        # link resolution
pnpm check:doc-claims   # TC-ids resolve
pnpm check              # formatting
```

(`pnpm check:adr` — the proposed ADR shape + ratchet check — does not exist yet; it is #481's
chartered work. Do not attempt to run it.)

If you superseded or folded an ADR that governs a `TC-` claim, rebind it in
`docs/trust/trust-claims.yml` and the trust doc that links to it in the same change. An orphaned
claim is a broken trust cross-link, and no check will infer the new owner for you.

Report which lane you wrote to, what moved between layers, what known failure each retained
constraint protects against, and anything you back-ported from the ADR into its construction home.

---

## Cutting an existing ADR

With `--cut ADR-NNNN`, re-cut an existing ADR to the required shape. The governing rules are the
README's cut test and its "Cut is gated on the construction home existing" section: an ADR is cut
when its detail doc lands, alongside the feature polish that produced it — never speculatively.

1. **Find the construction home.** If none exists, stop — the cut is gated on the home existing.
   Landing an ADR cut with the mechanism unhomed is the failure this whole rule prevents.
2. **Diff the ADR against the home.** For every mechanism paragraph in the ADR, confirm the home
   already says it. Anything present *only* in the ADR must be back-ported to the home **first**,
   in the same change. This step is not optional and it is where real content gets found.
3. **Promote the buried constraints.** Load-bearing properties are usually sitting in
   `## Alternatives not taken` as a parenthetical. Lift each into
   `## Constraints on any implementation` with its issue/PR citation.
4. **Challenge topology masquerading as a constraint.** Rewrite "must use X" into the property or
   failed alternative that made X necessary. If X itself is externally load-bearing, say why.
5. **Cut construction out**, leaving `## Construction` as pointers only, and set the
   `construction:` frontmatter to the home.
6. **Re-read the remainder using the governing test.** Every surviving sentence should still be
   useful if the current mechanism vanished tomorrow.

There is no ratchet bookkeeping yet: `ci/adr-shape-baseline.json` and `pnpm check:adr` are #481's
chartered work (see [Absent artifacts](#absent-artifacts--do-not-execute) below). Verify with the
Step 4 checks and note in your report that the shape was reviewer-checked, not gate-checked.

Amendment sections are a smell: an `## Amendment: …` heading is almost always construction that
accreted after the decision. Fold its invariant into `## Decision`, its property into
`## Constraints`, and its mechanism into the home.

---

## Absent artifacts — DO NOT EXECUTE

> **Blocked on #481 (the ADR shape gate). Nothing in this section is runnable today.** The
> artifacts it names — `ci/adr-shape-baseline.json` and `pnpm check:adr` — do not exist anywhere
> in this repo; the README (§ "Required shape") deliberately ships the convention
> reviewer-enforced until a gate lands with a real ratchet (a prototype was withdrawn on review —
> see `docs/plans/adr-reconciliation.md` §9.6). If you are an agent executing this skill, do not
> run or simulate anything below. When #481 ships, this section is promoted into the live steps
> above.

### Proposed: the shape checker

`pnpm check:adr` would enforce the mechanical floor for ADR shape (sections present, `construction:`
resolves, ratchet respected) and would join the Step 4 verify block. Everything in "Do not write to
the checker" above applies to it with full force.

### Proposed: the ratchet

`ci/adr-shape-baseline.json` would list ADRs not yet re-cut. A cut would remove exactly one entry
per change and verify with `pnpm check:adr`. Until it exists, a cut ends at step 6 above, with the
missing bookkeeping noted in the report.
