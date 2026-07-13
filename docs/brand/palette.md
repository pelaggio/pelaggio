# Pelaggio — Palette & Tokens

A *pelagic* palette read as a water column: warm foam at the shore, cool teal in
open water, then down through deep and abyss. Amber is the one warm note and it
belongs to Joe. Every pairing below is WCAG-tested — the ratios are real, not
aspirational.

## Core colors

| Token | Hex | Role |
|---|---|---|
| Foam | `#F4F0E6` | Light ground, surfaces, breathing room |
| Foam-2 | `#FBF9F2` | Raised light surface |
| Signal Teal · deep | `#0A6E60` | **Text / links / UI on light** (the workhorse teal) |
| Signal Teal · mid | `#12B5A0` | Fills with dark text on them |
| Signal Teal · bright | `#2BD9C2` | **Dark-ground text, fills, decoration** |
| Beak Amber | `#E7862A` | **Joe only** — beak, pouch, mascot moments. Never UI chrome. |
| Beak Amber · lit | `#F6A340` | Amber on dark grounds |
| Deep | `#0B2440` | Section grounds, code surfaces, gradients |
| Abyss | `#061423` | Dark ground, deepest ink, text on light |
| Ink | `#071A2E` | Primary text on light |
| Ink-soft | `#3C566B` | Secondary text on light |

## The one rule that matters

**Teal splits in two.** Bright teal is beautiful on dark and unreadable as text
on light. Use **deep teal (`#0A6E60`) for text/links/UI on light**, and **bright
teal (`#2BD9C2`) for dark grounds and fills**. Dark ink sits on every teal or
amber fill — never white.

## Contrast (WCAG 2.1, tested)

| Pair | Ratio | Verdict |
|---|---|---|
| Abyss text on foam | 16.3:1 | AAA |
| Deep teal `#0A6E60` text on foam | 5.4:1 | AA |
| Bright teal `#2BD9C2` text on foam | 2.3:1 | ✗ fails — **never do this** |
| Bright teal text on abyss | 10.4:1 | AAA |
| Deep teal text on abyss | (use bright) | — |
| Abyss ink on teal fill (`#12B5A0`) | 7.2:1 | AAA |
| White on teal fill | 2.6:1 | ✗ fails — **never do this** |
| Abyss ink on amber fill | 6.9:1 | AA |
| Amber as text on foam | 2.4:1 | ✗ fails — amber is decorative / Joe only |

## CSS custom properties

Light is the default `:root`; dark overrides via `prefers-color-scheme` and the
`data-theme` attribute. `--accent` is always the text/UI-safe teal for the
current ground; `--accent-bright` is decorative; `--on-accent` is the dark ink
that sits on any accent fill.

```css
:root {
  /* raw palette */
  --foam:#F4F0E6; --foam-2:#FBF9F2; --ink:#071A2E; --ink-soft:#3C566B;
  --deep:#0B2440; --abyss:#061423;
  --signal-deep:#0A6E60; --signal:#12B5A0; --signal-lit:#2BD9C2;
  --beak:#E7862A; --beak-lit:#F6A340;

  /* semantic (light) */
  --bg:var(--foam); --surface:var(--foam-2); --text:var(--ink); --text-soft:var(--ink-soft);
  --accent:var(--signal-deep);      /* text / links / UI */
  --accent-bright:var(--signal);    /* decorative fills, glows */
  --on-accent:var(--ink);           /* text on a teal/amber fill */
  --joe:var(--beak);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:var(--abyss); --surface:#0A2036; --text:#E8F1EF; --text-soft:#8FA9B8;
    --accent:var(--signal-lit); --accent-bright:var(--signal-lit);
    --on-accent:var(--abyss); --joe:var(--beak-lit);
  }
}
/* the viewer's theme toggle stamps data-theme and must win both directions */
:root[data-theme="light"] { /* repeat the light block */ }
:root[data-theme="dark"]  { /* repeat the dark block  */ }
```

## Semantic (state) colors

Pass / warn / fail live in their own greens/ambers/reds and **never borrow the
brand teal**. Semantic color is separate from the accent. (Amber's brand use is
Joe; a semantic warning amber is a different, functional role — keep them from
colliding on the same surface.)

## Typography

| Role | Stack | Notes |
|---|---|---|
| Display | geometric sans, 800, tracking −0.03em | headings, wordmark |
| Body | humanist system sans, 1.65 line-height | ~62ch measure |
| Mono | `ui-monospace, "SF Mono", "JetBrains Mono", Menlo` | **load-bearing** — data, code, labels, the technical voice |

CSP blocks font CDNs; if a display/body face is licensed, inline it as a
`@font-face` data URI rather than linking a webfont URL.
