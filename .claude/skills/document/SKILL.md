---
name: document
description: Author or revise a repo document in the correct lane — ADR, agent-context, trust, or AGENTS.md — enforcing the three-layer seam so invariants, constraints, and construction each land in their home
argument-hint: "<what to document> [--adr | --context | --trust | --cut <ADR-NNNN>]"
allowed-tools: Read Glob Grep Edit Write Bash(pnpm:*) Bash(node:*) Bash(git:*)
---

# /document — Author a Repo Document in Its Lane

A ship's papers are only useful if each one says the thing it is *for*. This repo has four
documentation lanes, and the recurring defect is not a missing document — it is content in the
wrong lane, or the same content in two lanes drifting apart.

Parse `$ARGUMENTS` for the subject and an optional lane flag. With `--cut ADR-NNNN`, run
**Cutting an existing ADR** below instead of authoring.

## Step 1 — Route to the lane

| Lane | Holds | Test |
|---|---|---|
| `AGENTS.md` | the invariant **index** — one line, always loaded | Does every agent need this on every task? |
| `docs/decisions/*.md` | the settled decision and *why* | Is it hard to reverse, cross-cutting, or re-debated? |
| `docs/agent-context/*.md` | design/RFC exploration, **construction**, and operator how-tos | Would this need rewriting when the code changes? |
| `docs/trust/*` | the *what + proof* | Does an external party verify this claim? |

**RFC-before-ADR.** A design doc explores; an ADR records the decision it converged on. Do not
open an ADR for something still being explored — write it in `agent-context/` first.

Keep the ADR bar where it is. Do not lower it to log a routine choice.

## Step 2 — Apply the three layers

This applies whichever lane you land in, because it decides what *stays behind*:

- **Invariant** — what must always be true. → ADR `## Decision`.
- **Constraint** — what a *replacement* must also satisfy, phrased as a prohibition or required
  property, citing the failure that motivates it. → ADR `## Constraints on any implementation`.
- **Construction** — how it is built today. → `agent-context/` (or code, or a test).

The cut test, per line: **if someone replaced this mechanism tomorrow, would they need this line to
avoid reintroducing a known failure?** Yes and mechanism-free → Decision. Yes but only as "not X" →
Constraint. No → Construction.

Write constraints as negative constraints on the solution space. *"Must not depend on parsing tool
inputs (PR #112)"* — not *"uses the Git porcelain audit"*. The first survives a rewrite; the second
has to be deleted by it.

## Step 3 — Write it

For an ADR, start from `docs/decisions/_TEMPLATE.md` and keep the six sections in order. Set
`construction:` to the detail doc that holds the mechanism, or the literal `none` when nothing is
built yet.

For an `agent-context/` doc, check first whether the construction already has a home — the common
failure is a second copy that drifts. Extend the existing section rather than opening a new file.

Never restate a construction detail in the ADR "for convenience". One home, one copy, a link
between them.

## Cutting an existing ADR

The ratchet in `ci/adr-shape-baseline.json` lists ADRs not yet re-cut. Remove exactly one entry per
change, and only alongside the feature polish that produced its detail doc.

1. **Find the construction home.** If none exists, stop — the cut is gated on the home existing.
   Landing an ADR cut with the mechanism unhomed is the failure this whole rule prevents.
2. **Diff the ADR against the home.** For every mechanism paragraph in the ADR, confirm the home
   already says it. Anything present *only* in the ADR must be back-ported to the home **first**,
   in the same change. This step is not optional and it is where real content gets found.
3. **Promote the buried constraints.** Load-bearing properties are usually sitting in
   `## Alternatives not taken` as a parenthetical. Lift each into
   `## Constraints on any implementation` with its issue/PR citation.
4. **Cut construction out**, leaving `## Construction` as pointers only.
5. **Drop the baseline entry** and verify.

Amendment sections are a smell: an `## Amendment: …` heading is almost always construction that
accreted after the decision. Fold its invariant into `## Decision`, its property into
`## Constraints`, and its mechanism into the home.

## Step 4 — Verify

```bash
pnpm check:adr          # ADR shape + ratchet
pnpm check:links        # link resolution
pnpm check:doc-claims   # TC-ids resolve
pnpm check              # formatting
```

If you superseded or folded an ADR that governs a `TC-` claim, rebind it in
`docs/trust/trust-claims.yml` and the trust doc that links to it in the same change. An orphaned
claim is a broken trust cross-link, and no check will infer the new owner for you.

Report which lane you wrote to, what moved between layers, and anything you back-ported in step 2.
