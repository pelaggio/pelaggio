# 01 · Metaphor

The name plays two notes. **Arpeggio leads; pelagos is character.**

## Arpeggio — the spine

An **arpeggio** is the notes of a chord sounded one at a time, in sequence — a
broken chord, rolled out in time. That is Pelaggio's operating model: every work
item is played through the same fixed progression — pick, plan, shakedown,
implement, review, ship — **note by note**, at a cadence the user sets.

Why it's load-bearing, not decorative: a chord **struck all at once** is a black
box — one sound, no legible parts. **Rolled as an arpeggio**, every note stands on
its own, in order; you can hear each one and stop between them. **Sequence is what
makes autonomous work inspectable and interruptible.** The name and the trust
thesis are the same idea.

This is where the product language draws its structure: named steps in a known
order, each producing evidence, each a place the user can intervene.

## Pelagos — the character

**Pelagos** is the open sea. It carries the warmth, not the machine:

- **Joe**, the pelican, guide at the boundary of supervision.
- The **onshore / offshore** model (below).
- The palette's water — foam at the shore, teal in open water.

Retired: "archipelago" (islands of work). Onshore/offshore already carries the
delegation model; arpeggio carries the sequence. Two metaphors, each with one job.

## Onshore / offshore

- **Onshore** — work under the developer's direct attention or judgment:
  active implementation, direct steering, code review, architecture and policy
  decisions.
- **Offshore** — work operating beyond immediate attention under Pelaggio's
  supervision. Offshore is never uncontrolled: it stays **bounded, attributable,
  observable, interruptible, recoverable.**

Work **moves offshore** when delegated with configured supervision, evidence, and
control points; it **returns onshore** when judgment is required, the user takes
control, a result is ready for review, execution can't safely continue in its
current authority, or a completed result is handed back with evidence.

## Constraints on metaphor

The metaphor is an **explanatory model, not a vocabulary substitution system.**

- Do not auto-replace technical language with musical or nautical words.
- Do not stack competing metaphor families (tides, captains, fishing for bugs,
  flocks for teams, storms for generic failures).
- **Prohibited** in raw errors, permissions, destructive confirmations, safety
  claims, logs, status labels, and evidence views.
- A metaphor earns its place only when it makes the operating model **easier to
  understand than plain language would.** Sequence/cadence language (from arpeggio)
  is the most natural fit for the pipeline; use it there, sparingly, and drop it as
  risk rises.

## The harmonic reading is deliberately unclaimed

The arpeggio has a second, vertical property — the notes belong to one chord, they
*resolve.* Pelaggio claims only the horizontal one: **sequence makes autonomous work
inspectable and interruptible.** The harmony is left on the table on purpose. It
declares that the steps cohere without explaining why they do, and — worse for the
trust thesis — it implies the parts are guaranteed to agree and resolve, when
independent review earns its trust precisely by its capacity *not* to. Do not reach for
"resolve," "in concert," "in tune," "harmonious," or "concord" around the pipeline,
review, or receipts.

The one sanctioned exception is **Joe.** "Keeping the pelagic in concordance" is his
character/brand-layer job, not a property of the pipeline — see
[`04-voice.md`](./04-voice.md) and [`../docs/brand/`](../docs/brand/). Concord belongs
to the character, never to a status label, a verdict, or an evidence view.
