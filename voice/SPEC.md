# SPEC · Product Language & Joe Voice System

Condensed plan of record. The strategic decisions are settled and drafted in
`00`–`05`; the phased build below turns them into linted, evaluated, in-product
copy. Markers: **[A]** agent-verifiable · **[O]** owner-approval required.

## Fixed foundations

- Posture, promise, and the four-part trust model — [`00-strategy.md`](./00-strategy.md).
- Metaphor: **arpeggio leads (sequence/pipeline), pelagos is character
  (Joe, onshore/offshore)** — [`01-metaphor.md`](./01-metaphor.md).
- Speaker model (System · Harness · Review · Joe · source), one speaker per block,
  Joe rationed to Level 2 — [`02-speakers.md`](./02-speakers.md).
- Voice attributes, hard rules, the tells to cut — [`04-voice.md`](./04-voice.md).
- Register shifts by risk — [`05-tone-and-risk.md`](./05-tone-and-risk.md).

## Phases & gates

0. **Tracer bullet** — one real surface (recommended: session-completion /
   review-summary), end to end: mini-audit → pattern draft → proposed copy →
   minimal Vale rules → one golden example passing the threshold. Record spec gaps
   in `audit/tracer-findings.md`. **[A]** Gate: tracer passes before Phase 1.
1. **Audit** *(timeboxed; needs codebase inspection)* — `audit/ontology-and-terminology.md`
   and `audit/surface-and-speaker-inventory.md`, every conclusion with a repo
   pointer. **[A]** discovered surfaces classified by speaker + presence; **[O]**
   any terminology change that renames a user-visible concept.
2. **Strategy docs** — `00`–`05` (drafted). **[O]** final canonical terms
   (roadmap? run/cycle collapse? shakedown product-facing?); exposing "receipt".
3. **Patterns** — the five pattern files, each demonstrated against ≥3 real
   current-copy entries. **[A]**
4. **Surfaces** — one spec per audited surface requiring authored language;
   provisional character budgets labeled. **[A]**
5. **Proposed corpus** — rewrites under `corpus/proposed/<speaker>/` with source
   path, speaker, pattern, rationale; no block conflates speakers; no ungrounded
   ETA. **[A]**
6. **Prompt assembly** — mechanical `prompt/assembly.md`; every example starts from
   structured input; Joe's prompt absent from non-Joe assemblies. **[A]**
7. **Lint** — deterministic rules only for high-confidence violations; each with
   pass/fail/exemption fixtures; CI proves Vale over the authored scope. **[A]**
8. **Evals** — six-dimension rubric (0–2, min 10/12, no dimension at 0, no
   auto-fail); golden + adversarial from real product states. **[A]**
9. **Implementation plan** — sequence the migration of production copy. **[O]**
   approval before modifying production strings.

## Open questions to resolve in the audit

run vs cycle (bias to collapse) · is "roadmap" canonical across sources ·
shakedown internal vs product-facing · provider/harness/agent consistency · which
states are offshore/onshore transitions · which review outputs are deterministic vs
model-generated · which summaries are harness- vs Pelaggio-derived · available
evidence pointers per surface · real character limits per surface · whether "Joe"
is an in-code orchestrator identity that should surface as a product concept.

## Non-goals

Redesign the visual identity (see `../docs/brand/`) · mascot illustration · Joe on
every surface · turn technical terms into metaphor · rename architecture to fit the
metaphor · obscure harness identities · rewrite production code before the audit is
approved · optimize for maximum charm.
