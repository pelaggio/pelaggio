# Pelaggio — Brand Brief

The working brand system for Pelaggio: what it is, what it stands for, how it
looks, and how it sounds. This is the **brand / marketing layer**. The
**product-language layer** — how in-product strings are written — lives in
[`../../voice/`](../../voice/) and governs wherever copy sits near
machine-verifiable state.

This brief and [`palette.md`](./palette.md) are the source of truth. The visual
concept, name-story, and logo-exploration pages were working artifacts; their
durable content lives here — including the design tokens in `palette.md` and the
image-gen prompts in the appendix below.

---

## 1. Positioning

- **Tagline:** *Extend how much one developer can ship.*
- **Category (for technical evaluators, second):** a control plane for coding agents.
- **Core promise:** extend a developer's reach without requiring them to surrender control.
- **Who it's for:** the solo developer (or small team) who has to live with the
  result — where there's no one else to catch a bad merge and a runaway agent is
  nobody's problem but yours.

Reach is the outcome; automation is only the mechanism. **Reach** = the amount
of consequential work a developer can responsibly set in motion beyond their
immediate attention. It grows through delegated execution, bounded autonomy,
independent review, recoverability, evidence, and intervention — not through
maximizing code volume.

## 2. The name

Pelaggio plays **two notes at once**:

- **arpeggio** *(the spine)* — the notes of a chord sounded one at a time, in
  sequence. That is the product: every work item is rolled through its steps —
  pick, plan, shakedown, implement, review, ship — note by note, so you can
  follow each one and stop between them. A chord struck all at once is a black
  box; rolled as an arpeggio, every note is legible. **Sequence is what makes
  autonomous work inspectable and interruptible.** The name and the trust thesis
  are the same idea.
- **pelagos** *(the character)* — the open sea. Where Joe comes from, and why
  work runs *offshore*. It carries the warmth; it does not run the machine.

Say it **peh-LAH-joh**. The orchestrator answers to **Joe**.

> Decision on record: the metaphor split is **arpeggio leads (name, pipeline
> visual, icon grammar); pelagos is character (Joe, palette, onshore/offshore)**.
> "Archipelago," used in earlier drafts, is retired.

## 3. The operating model — onshore / offshore

- **Onshore** — work under the developer's direct attention or judgment:
  implementation they're steering, code review, architecture and policy calls,
  the merge decision.
- **Offshore** — work running past their attention under Pelaggio's supervision.
  Offshore is never uncontrolled: it stays **bounded, attributable, observable,
  interruptible, recoverable.**

Work **moves offshore** when delegated with its guardrails set; it **returns
onshore** the moment it needs judgment. Moving offshore never means giving up
control; coming back never means losing context. Joe stands watch at that line.

## 4. Trust is the product

Trust is an **architectural property**, not a message — communicated through
inspectable state, not reassurance. Every offshore run answers four questions
you can check. When they collide with convenience, they win.

| | Question | |
|---|---|---|
| **Bounds** | What can it touch? | worktree, budget, reach — drawn before work starts |
| **Attribution** | Who did it? | every action/claim/verdict names its author |
| **Evidence** | Where can I check? | commits, diff, passing tests — inspectable, not asserted |
| **Control** | When do I step in? | you always know when the call is yours |

This posture wasn't reverse-engineered to fit the metaphor. The
pick → plan → implement → review → ship cycle and its propose-then-confirm discipline
came out of Fathom, the app Pelaggio split from; the control model predates the name.

## 5. Voice (summary)

Full guide: [`../../voice/04-voice.md`](../../voice/04-voice.md). The short form:

- **Designed against the default.** Cut the tells of machine-written prose:
  "X, not Y" contrast formulas, tricolons, "the X is the Y" aphorisms,
  abstract-noun fog, em-dash asides, hype filler.
- **Name the thing, not the concept** (the worktree, the diff — not "isolation").
- **Understate. Earn a contrast; never manufacture one. Vary the rhythm.**
- **Two registers today:** the *System* (plain, literal, operational) and *Joe*.
  The real product speaker model has more — see the voice layer.
- **Trust through evidence, not reassurance. Silence is better than filler.**

## 6. Joe

Joe is Pelaggio's **guide at the boundary of supervision** — the pelican who
stands where onshore meets offshore, keeping the pelagic in concordance. His
character is in **conduct, not performance**: an excitable little seabird, curious
and big-hearted, doing his best — the honest shape of an autonomous agent, with the
arpeggio as the rail that keeps him honest. When something breaks, his eyes go white
and he recites the recovery manual, then he's back to himself; the composure is a mode
he drops into, not his temperament.

- **Presence is rationed.** Silent marker most of the time; he speaks only at
  orientation, handoff, and recovery. The default state is Joe quiet.
- **Never** impersonates the harness or the reviewer, and never trades evidence
  for reassurance.
- **Draw him** flat and geometric — foam-white body, amber beak/pouch, calm eye.
  No gradients, gloss, or feather detail. Amber is his alone.

Mascot-illustration polish is out of scope for this doc; use the mascot prompt in
the appendix.

## 7. Logo

The chosen mark is **Notes → Wing**: an arpeggio of three climbing notes whose
top note lifts into a wing — the rolled chord (the pipeline) becoming the bird
(Joe). It's the one mark where both halves of the name meet, and it can't read
as a whistle. Run the logo prompt in the appendix to produce polished candidates
before final lock. The working SVG — mark in `currentColor`, eye knocked out to
the ground color:

```svg
<svg viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
  <rect x="14" y="58" width="11" height="30" rx="5.5" opacity="0.45"/>
  <rect x="31" y="42" width="11" height="46" rx="5.5" opacity="0.7"/>
  <rect x="48" y="26" width="11" height="62" rx="5.5"/>
  <path d="M59 30c9-6 18-8 27-6 -6 5 -9 11 -9 18 -7-4 -13-8 -18-12z"/>
  <circle cx="72" cy="34" r="3" fill="var(--bg)"/>
</svg>
```

Use deep teal `#0A6E60` on foam and bright teal `#2BD9C2` on abyss (see
`palette.md`). Four other directions were explored and set aside: **Flight**
(a gliding seabird), **Little Joe** (a plump-beaked pelican), **Waterline**
(a wading bird on the shore), and **Roundel** (a bird-over-horizon seal).
Notes → Wing won for fusing the arpeggio and the bird in one mark.

## 8. Color & type

Full tokens, hexes, and WCAG ratios: [`palette.md`](./palette.md). In short —
a *pelagic* palette that runs warm foam (shore) → cool teal (open water) → deep
→ abyss, with amber reserved for Joe. Every pairing is contrast-tested; the
signature is the **warm-foam + teal + amber** combination, which reads as
trustworthy and human in a niche that defaults to the cold terminal. Type:
a geometric display, a humanist body, and monospace as a load-bearing voice for
anything technical.

## Appendix — image-gen prompts

For polishing the logo and mascot with an image model (ChatGPT / Midjourney),
past the ceiling of hand-drawn SVG while staying on-model.

**Logo mark** (swap in the chosen direction, e.g. *Notes → Wing*):

> Minimalist vector logo mark: an arpeggio of three climbing note-bars whose top
> note lifts into a wing. Single flat color, geometric, confident negative space;
> no gradients, outline, 3D, or text. Must read at 16px. Personality: calm,
> trustworthy, a little dry — a working seabird, not cute. Brand is Pelaggio, a
> control plane for coding agents; nautical but restrained. Palette: mark in deep
> teal `#0A6E60` on warm foam `#F4F0E6`, plus a reversed version in bright teal
> `#2BD9C2` on ink `#061423`. Avoid: a whistle, a duck, a dove, a thumbs-up/down.
> Centered, generous clearspace, SVG-ready, flat.

**Mascot — Joe character sheet:**

> Character sheet for "Joe", the mascot of Pelaggio (a control plane for coding
> agents). Joe is a pelican — an excitable, curious, big-hearted little seabird,
> warm and eager rather than slick, doing his best; bright-eyed enthusiasm by
> default, with calm competence surfacing only under pressure. Flat geometric
> vector, clean rounded shapes, one
> continuous beak, NO gradients / gloss / feather detail. Foam-white body
> `#FBF9F2`, amber beak and pouch `#E7862A`, calm dark eye, subtle unbothered
> brow. Three poses on one sheet: (1) heading out, leaning toward open water;
> (2) back with the catch, facing you, pouch full, at ease; (3) on watch, upright,
> eyes on the horizon. Plain warm-foam background, no text, consistent character,
> vector / sticker-ready, flat.
