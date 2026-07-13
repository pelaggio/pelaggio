# Pelaggio — Product Language & Joe Voice System

This is the **product-language layer**: how Pelaggio's own strings are written,
wherever copy sits near machine-verifiable state (CLI, daemon, web UI, notifications,
logs, review verdicts). It governs the *machine*. The **brand / marketing layer**
— positioning, visual identity, Joe's illustration, the sea imagery — lives in
[`../docs/brand/`](../docs/brand/) and fills Joe's "brand storytelling" slot.

The two layers meet at one rule: **the closer a string is to a verifiable event,
the less it sounds like Joe.**

## Why this exists

A serious tool for people who will *live with what it ships* cannot sound like it
was written by the thing it is selling. The goal is not to make every string sound
like a mascot — it's to make Pelaggio's model of **supervised autonomy** clear,
trustworthy, and recognizably its own, through **attribution, evidence, bounded
scope, and respect for control**.

## Strategic decisions on record

- **Second pillar is control / trust**, not observability. Observability is the
  *Evidence* leg of the trust model, not the headline.
- **Metaphor: arpeggio leads, pelagos is character.** The pipeline is an arpeggio
  — a chord rolled note by note, legible because it's sequenced. Onshore/offshore
  is the supervision model. See [`01-metaphor.md`](./01-metaphor.md).
- **Speaker model is load-bearing.** There is no single "Joe voice." See
  [`02-speakers.md`](./02-speakers.md).
- **Joe's character is conduct, not performance**, rationed to Level 2 moments.

## Phase status

The full build program is nine phases (tracer → audit → strategy → patterns →
surfaces → corpus → prompt → lint → evals). This directory is **scaffolded**, not
complete.

Only the strategy docs exist today. The later phases' directories are created
when their phase runs — not pre-stubbed.

| Phase | State |
|---|---|
| 2 · Strategy docs (`00`–`05`) | **done** — drafted from settled decisions |
| 0 · Tracer bullet | **next** — one surface, end to end |
| 1 · Audit | **next** — requires repository inspection; timeboxed |
| 3 · Patterns | planned |
| 4 · Surfaces | planned |
| 5 · Proposed corpus | planned |
| 6 · Prompt assembly | planned |
| 7 · Lint | planned |
| 8 · Evals | planned |

The recommended first executable step is the **Phase 0 tracer** on the
**session-completion / review-summary** surface — it exercises three speakers
(System facts, Review verdict, an optional Joe observation) at once and surfaces
spec gaps while they're cheap.

## Planned layout

The directories below are created as each phase produces its first real file.
`SPEC.md` is the authority on what each holds.

```
voice/
├── 00-strategy.md        # posture, promise, trust model          (done)
├── 01-metaphor.md        # arpeggio (spine) + pelagos (character) (done)
├── 02-speakers.md        # System · Harness · Review · Joe · source (done)
├── 04-voice.md           # attributes, hard rules, the tells       (done)
├── 05-tone-and-risk.md   # register shifts by risk                 (done)
├── SPEC.md               # condensed plan of record                (done)
├── audit/                # Phase 0–1 (needs codebase inspection)
├── product-language/     # glossary, hierarchy, state labels
├── patterns/             # orientation · receipt · progress · control-point · recovery
├── surfaces/             # per-surface specs (from the audit)
├── corpus/proposed/<speaker>/   # rewritten strings, by speaker
├── prompt/               # assembled generation prompts
├── styles/Pelaggio/      # Vale lint package
└── evals/                # rubric, golden, adversarial
```
