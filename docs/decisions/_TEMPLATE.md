---
title: "ADR-NNNN: <the decision, as a claim, in one line>"
status: proposed | accepted | superseded
date: YYYY-MM-DD
claims: []                                  # TC-ids this decision governs, [] if none
construction: <path#anchor> | none           # where the mechanism lives; `none` = nothing built yet
---

# ADR-NNNN — <title>

## Context

The forcing question, and what breaks without a decision. Evidence goes here — measurements,
incident numbers, the failure that made this worth deciding. Not a design narrative.

## Decision

The **invariant(s)**: what must always be true. Numbered if there is more than one.
No file names, no function names, no data-structure shapes. If a sentence would have to be
rewritten when the implementation is replaced, it is not a decision — it is construction.

## Constraints on any implementation

The properties a *replacement* mechanism must also have, phrased as constraints on the solution
space rather than as a description of the current one. This section is load-bearing: it is what
stops a future maintainer reintroducing a failure that was already paid for.

- **<Constraint, stated as a prohibition or a required property>.** The failure that motivates it,
  with its issue/PR number. Write "must not depend on parsing tool inputs (PR #112)", never
  "uses the Git porcelain audit".

## Alternatives not taken

- **<Option>** — why it was rejected. One line each.

## Consequences

- (+) What this buys.
- (−) What it costs, and what it leaves unsolved.

## Construction

A pointer, not content. One line per home:

`docs/agent-context/<doc>.md` § <section> — <what lives there>.

Use `construction: none` in the frontmatter when nothing is built yet, and add the home in the
same change that builds it.
