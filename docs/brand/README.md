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

- **Tagline:** *Let the work run.*
- **Supporting line:** Your process, across pull requests.
- **Who it's for:** developers already using coding agents who want to delegate a
  worthwhile change without becoming the full-time coordinator.
- **Problem:** the developer keeps supplying the same working instructions, steering
  the next step, and reconstructing what happened when an agent says it is done.
- **Offer:** record the project's working instructions, review criteria, and check
  commands, then use that process across work items with the configured coding agents.
- **Desired benefit:** more attention available for work that needs the developer's
  judgment. We have not measured time saved or reduced supervision in the demo runs.
- **Category (for technical evaluators, second):** a control plane for coding agents.
- **Claims:** lead readers to [`../trust/limitations.md`](../trust/limitations.md) for
  current behavior, gaps, and failure modes. A configured process does not guarantee
  a correct result.

### Campaign brief

The founder's direction is **“codify the judgement in the harness, echo your process
across pulls.”** Here, codifying judgment means making a person's criteria explicit
and reusable in repository instructions, the quality rubric, and configuration.
The harness runs the configured process and enforces its deterministic gates;
workers interpret criteria and exercise judgment. This positioning does not change
that architectural division or imply that every written instruction is enforced.
It also does not imply automatic learning from earlier pull requests: improvements
carry forward when someone updates the shared instructions or configuration.

The campaign starts with the developer's repeated coordination work. Explain what
they can put into the process and what returns for their inspection. Then show an
actual execution, including where the person intervened. Invite them to try one
bounded work item they can judge themselves.

CSV export and interrupted import are ordinary supporting examples. Their value is
showing how repository context and explicit charter choices travel through a run.
Passing-check counts alone do not demonstrate the benefit. Preserve original inputs,
actual outputs, and operator interventions; do not invent customer testimony or
claim uninterrupted autonomy. Both demonstrations used local delivery, not GitHub
pull requests. Repeatable process is the offer; consistent success remains unproven.

### Show the process

Use a small workflow diagram to make the repeated review visible: plan → shakedown,
implement → shakedown, ship → PR review/revision when configured. Return arrows
represent working through findings. “Ship-shake” is shorthand for the founder's
process, not the name of a pipeline step. Planning depends on scope, and the PR loop
requires repository setup. The two public demos used local delivery.

The developer supplies the process and criteria; supported agents can be assigned
per step. Keep that distinction visible in the diagram and example. “Interchangeable”
means configurable providers at the supported step interface, not identical behavior,
capabilities, or setup. This is a view of the implemented cycle, not a promise of an
arbitrary graph editor.

Describe measurement concretely: the run records name the realized provider/model,
outcomes, attempts, turns, and available usage. Preserve missing measurements and
estimated-cost labels. Compare recorded runs with their task and settings attached;
do not turn two different demo tasks into a model ranking or a productivity claim.

Use this brief as the positioning source; the
[`voice strategy`](../../voice/00-strategy.md) describes how to apply it in copy.

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

The orchestrator answers to **Joe**.

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

The locked mark is **Notes → pouch**: three climbing notes (the arpeggio) whose
last note carries Joe — foam body, amber pouch, eye punched to the water. Teal
is the sea, not the bird. Do not add a wing; do not rotate the tile. Source
files and construction live in [`ASSETS.md`](./ASSETS.md).

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
  <rect x="12" y="58" width="17" height="27" rx="8.5"/>
  <rect x="39" y="41" width="17" height="44" rx="8.5"/>
  <rect x="66" y="14" width="17" height="71" rx="8.5"/>
  <path fill="#E7862A" d="M80 28 C92 28 98 36 98 46 C98 58 90 66 80 64 C76 52 76 36 80 28Z"/>
  <circle cx="74.5" cy="30" r="4.2" fill="var(--bg, #0A6E60)"/>
</svg>
```

Shipped copies: `packages/site/public/favicon.svg` and `packages/web/public/icon.svg`
(foam on deep teal `#0A6E60`). Dark twin is abyss `#061423` with pouch `#F6A340`.
Four earlier directions stay retired: **Flight**, **Little Joe**, **Waterline**,
**Roundel**, and the bolted-wing sketch that used to ship.

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

**Logo mark** (locked direction: *Notes → pouch*):

> Minimalist vector logo mark: an arpeggio of three climbing note-bars whose last
> note carries a pelican pouch. Foam-white notes `#FBF9F2` on deep teal water
> `#0A6E60`, amber pouch `#E7862A`, eye punched to the water. Geometric, no wing,
> no gradients, outline, 3D, or text. Must read at 16px. Personality: calm,
> trustworthy, a little dry — a working seabird, not cute. Dark twin: same drawing
> on abyss `#061423`. Avoid: a whistle, a duck, a dove, a toucan beak, a wifi glyph.
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
