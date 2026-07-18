# CLI / Product Naming — Research & Recommendations

**Status:** **DECIDED — "Pelagic Autopilot"** (npm/command `pelagic`, mode `autopilot`) · **Last updated:** 2026-07-18

> **Decision (2026-07-18):** Chose **Pelagic Autopilot**. No paid trademark clearance; the **Pelagic AI**
> collision risk is knowingly accepted (see §3 and Caveats). Free/DIY hedges: self-search the public
> USPTO/CIPO registers; optionally DIY-file a Class 9/42 application later to secure priority; always
> brand "Pelagic Autopilot", never bare "Pelagic". Remaining work is mechanical (see Rename blast radius)
> plus a "pelagic depth" motif to replace the placeholder "A" icon.

## Problem

`pelaggio` is hard to spell and type — it's a coined Italian-flavored word (evokes *arpeggio*)
that gets mistyped as *pellagio / pelagio / pelaggio*. It's un-Googleable when heard aloud and
builds no muscle memory. The question: rename the CLI, and if so, to what — without trading the
spelling annoyance for a worse problem.

## Method

Every candidate was run through a consistent gauntlet:

- **Command namespace:** `command -v` on a stock system, npm registry, Homebrew formulae API, Debian package contents.
- **Domains:** DNS + live-site check across `.com/.io/.dev/.ai/.app/.sh/.co`.
- **Independent review:** two skeptical reviewers given the same brief — a subagent and Codex (`gpt-5.6-sol`, headless) — instructed to poke holes, not rubber-stamp.
- **Trademark:** US (USPTO) + Canada (CIPO) search focused on software classes (Nice 9 & 42), plus common-law / business-name search. *Non-lawyer search — see caveats.*

## Candidates evaluated

| Name | Namespace (npm/PATH/brew) | Domains | Blocking issue |
|---|---|---|---|
| `pela` | npm taken; command-clear | .com/.io/.ai live | **Pela Case** — strong consumer brand |
| `pelago` | command-clear | all major TLDs live | Brand-crowded (Pelago clinic $151M, Pelago travel, Pelago bikes) |
| `pelagit` | fully clear | **all TLDs free** | Awkward: inaudible "git" pun (soft-g → *pela-jit*), reads as typo or the mineral *pelagite* |
| `pelagic` | npm free, brew free | .io/.dev/.ai/.sh free | **Pelagic AI** — existing AI-software company, identical name + field |
| `pelajoe` | **fully clear** | **all TLDs free** | Whimsy / gravitas; "Joe" reads as a person |
| `pelijoe` | **fully clear** | **all TLDs free** | Cold-reads "pelly-joe"; arbitrary |
| `autopilot` (as command) | bin-clear (npm dead v0.0.9) | — | Generic/overloaded (Tesla/GitHub/GKE); un-ownable |
| `pelaggio` (incumbent) | published, owned | owns brand string | **Only flaw: spelling.** No collision. |

## Key findings

### 1. Package name ≠ typed command
The npm package and the invoked binary are decoupled (`bin` field). `pelaggio` already ships two
bins (`pelaggio`, `plg`). So a memorable/short **command** can differ from the **package** name —
but the split only works when the command is guessable from the package (`ripgrep`→`rg`,
`typescript`→`tsc`). An unrelated command (`pelagit`→`autopilot`) is a discoverability foot-gun.

### 2. `autopilot` is the *mode*, not the product
"autopilot" appears ~890× in the repo — the roadmap pickup label, the `AUTOPILOT_SERVER_*` env
prefix, and code concepts (`isAutopilotManaged`). `.pelaggio.yml` has an explicit comment:
*"label = the autonomous MODE ('autopilot'), not the product — kept deliberately."* **Both reviewers
independently rejected making `autopilot` the primary command** (generic, overloaded, Tesla baggage).
Consensus: keep it as the mode/subcommand (`<product> autopilot`).

### 3. Trademark — software classes are clear, but there's a common-law collision
- The scary **PELAGIC apparel brand** (Pelagic Ventures LLC, ~21 marks) is **apparel/eyewear/coolers
  only** (US Class 25/21/3; Canada Cl. 9 = *eyewear only*). It does **not** block software.
- **US Class 9 (software) & 42 (SaaS): no registered PELAGIC mark — appears clear.** Canada Cl. 42 clear.
- **Gating risk:** **Pelagic AI** (McLean, VA) — a real, unregistered company doing on-prem LLMs / AI
  automation. Identical name, identical field. Also nearby: Pelagic Data Systems, FishEye "Pelagic",
  Pelagic Software. This is why bare "Pelagic" is risky for an AI dev tool.

### 4. The `pelagit` etymology doesn't survive contact
Intended as "pelagic + git." But *pelagic* is soft-g (/pəˈLAJ-ik/), so `pelagit` is heard as
*pela-jit* — the "git" is inaudible. It also sits one keystroke from *pelagite* (a real mineral).
Verdict: it swaps pelaggio's "one g or two?" for "-it or -ite?" — a lateral move.

### 5. The `pelajoe` homophone
`pelaggio` (Italian `-aggio` = "ah-joh", like *arpeggio/formaggio*) ≈ **"pela-joe."** So a pelican
mascot named Joe is *pelaggio spelled how it already sounds*. Good compatibility bridge (keep
`pelaggio` as a quiet alias) — but Codex warns **not to make the homophone the headline story**
("correction fatigue"), and to keep the mascot as **visual flavor, not the credibility of the pitch**.
Between spellings: **PelaJoe > Pelijoe** (pelijoe cold-reads "pelly-joe"); use lowercase `pelajoe`.

### 6. The realization: `pelaggio` was never the one with a collision
`pelagic` dies on Pelagic AI; `pelajoe` dies on whimsy. The incumbent `pelaggio` is unique,
published, npm-owned, and effectively coinage — **its only weakness is spelling**, which a short
command alias (`pela`/`plg`) solves without any rename.

### 7. There is no design system to preserve
`packages/web` is stock Tailwind slate, system font, no brand tokens. The app icon is a placeholder
letter **"A"** (for Autopilot, not "P"). Nothing to migrate — a rename costs nothing visually, and
the existing deep-slate palette is already on-theme for an ocean motif.

## Reviewer verdicts (summary)

**Round 1 — pelagic / pelagit / autopilot:** Both reviewers independently → drop `pelagit`; do
**not** make `autopilot` the primary command; prefer the real word. Codex: use `pelagic` for
brand+command, `autopilot` as the mode.

**Round 2 — mascot (PelaJoe):** Codex — mascot viable for a developer audience, weaker for
enterprise/defense trust; pelican in the icon, not carrying the pitch; lowercase `pelajoe`;
`PelaJoe > Pelijoe`. Rankings:
- **Under the Pelagic AI collision risk:** `PelaJoe > Pelijoe > Pelagic Autopilot > pelaggio`
- **With credible legal clearance:** `Pelagic Autopilot > PelaJoe > Pelijoe > pelaggio`

## The decision reduces to one variable

> **Will you pay for a trademark knockout search (~$300–500) to clear the Pelagic AI overlap?**
> - **Yes, and it clears →** ship **Pelagic Autopilot** (clearer, more serious).
> - **No / unwilling to gamble →** ship **PelaJoe** (own everything outright), or keep **Pelaggio Autopilot**.

## Options & recommendations

### Option A — "Pelagic Autopilot" (pending clearance)
- Product = **Pelagic Autopilot**; npm + command = `pelagic`; mode = `autopilot`; tagline "go pelagic".
- **Pro:** strongest, most serious name; real word; pairs naturally with the mode.
- **Con / gate:** requires an attorney knockout search on **Pelagic AI** before investing. Fallback: PelaJoe.
- Best if this is a funded business.

### Option B — "PelaJoe" (own everything now)
- Product/command = `pelajoe` (lowercase); mode = `pelajoe autopilot`; `pelaggio` kept as quiet alias.
- **Pro:** pristine namespace + every domain; zero collision; no lawyer needed; strong, defensible mark; mascot fixes the icon gap.
- **Con:** whimsy / lost gravitas; "Joe" reads as a person; needs sober positioning and restrained mascot art.

### Option C — "Pelaggio Autopilot" (keep the incumbent) — *the sleeper / lowest-risk*
- Product = **Pelaggio Autopilot**; keep npm `pelaggio`; type `pela` / `plg`; mode = `autopilot`.
- **Pro:** no rename, no republish, **no collision** (pelaggio is unique), zero blast radius; serious framing; you only ever *spell* "pelaggio" in the npm name / wordmark / URL, never in the terminal.
- **Con:** the original spelling remains in those three places; not evaluated by the reviewers (emerged late).

### Option D — Keep `pelaggio`, just add aliases
- Package unchanged; add `pela`/`pelajoe` bin aliases. ~2-line change. Defers the branding decision.

## Cross-cutting decisions (hold regardless of the name)

- `autopilot` stays the **mode**, never the primary command → `<product> autopilot`.
- Keep a short command alias (`pela` / existing `plg`); the brand word need not be the typed word.
- If a mascot is used, it's **visual identity only** — don't personify destructive actions ("Joe swallowed the backlog").
- Replace the placeholder "A" icon; the existing deep-slate palette suits an ocean/depth motif.

## Rename blast radius (measured)

- `npx pelaggio`: **30 files** (skills/docs/templates). `pnpm pelaggio`: **21 files**. Any mention of "pelaggio": **165 files**.
- `bin` map lives in `packages/pelaggio/package.json` (currently `pelaggio` + `plg`), plus a `bin/pelaggio.js` shim.
- Invariant to respect: skill bodies must call `npx <product>`, never `pnpm <product>`; `pnpm check:skills` gates this.

## Caveats & limits

- The trademark search was **non-lawyer**. The apparel + Canadian registrations are high-confidence;
  "no PELAGIC software mark in Class 9/42" is an **inferred negative** (USPTO/CIPO are JS databases
  that couldn't be fully wildcard-queried; some sources returned HTTP 403).
- A proper clearance would run wildcard + phonetic sweeps (PELAGIC/PELAGIK/PELAGO/PELAGOS…) across
  Cl. 9/35/38/41/42, pull the full Pelagic Ventures docket, and run a common-law/state/domain search
  **prioritizing Pelagic AI** — the real exposure.

## Suggested next step

Decide the one variable (appetite for clearance). If **yes** → commission the knockout search on
Pelagic AI, hold PelaJoe as fallback. If **no** → choose between **PelaJoe** (fresh, ownable, mascot)
and **Pelaggio Autopilot** (zero-risk, keep the incumbent). Then scope the mechanical change
(`bin` map, shim, `npx pelaggio` → `npx <product>` across ~30 bodies, `autopilot` as mode/subcommand).
