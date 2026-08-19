# Plan — Positioning Tier 1: Ship the Story That Already Exists

**Status:** v5 — **operator-adjudicated 2026-08-15** after four doc-review rounds
(`doc-99c298553530` 11 must-fix → `doc-b4b375c2bd83` 4 → `doc-e943ffb0f10c` 4 →
`doc-6f5cf2b34893` dissent: claude/codex block, grok pass, judge escalated to human
adjudication). The dissent's five must-fix and four nice findings are incorporated below.
**Goal:** move the narrative assets Pelaggio already owns — the origin story, the
arpeggio thesis, the trust registry, the brand palette, the cost telemetry — onto the
surfaces where discovery actually happens. Tier 0 (PR #532) repaired the broken front
door; Tier 1 makes it compelling.

**Context:** the 2026-08-13 positioning research reached three conclusions. Trust is the
wedge for agent tooling in 2026 (the discourse turned hard against slop PRs and cost
blowouts; provenance and enforced budgets earn credibility). The unowned market position
is "gates are code, reviewers are rival models, every merge has a budget and a receipt."
And Pelaggio's gap is not quality but distribution of quality — the rigor is real and
invisible. Tier 1 is the distribution work.

**Non-goals:** the Tier 2 launch arc (manifesto essay, proof essay, Show HN, newsletter
submissions); any new product mechanism beyond output-surface polish; deciding the
product name (see Risks — an operator action, deliberately outside this plan's items).

**README ownership rule (collision control):** the repo has **two front doors** — the
root `README.md` and `packages/pelaggio/README.md` (the npm page, the only publicly
reachable surface while the repo is private). Exactly two items may edit either — T1-1
(the restructure, which defines the final hierarchy and synchronizes the npm README's
overlapping prose) and T1-5 (which fills the hero slot T1-1 reserves and embeds the T1-3
stats snapshot). T1-2 and T1-3 are product-output items and make no README edits.

**Dependency edges encode the order but are not self-resolving:** under
`ship.target: auto-merge-pr` the ship path neither calls `roadmap.markDone` nor emits a
closing keyword in the PR body, so a merged item's issue stays open until the operator's
mark-done relay (the supervised-run protocol step). T1-5's dep-eligibility therefore
arrives via that relay; running the relay after each T1 merge is part of this plan's
operating procedure, not an assumption.

---

## T1-1 — Invert the root README (scope M; no deps — lands first)

Restructure `README.md` so the story leads and reference follows. T1-1 is the sole
authority on README structure; it defines the final hierarchy once:

**tagline → reserved hero-media slot (HTML comment placeholder) → two-sentence problem →
name story → install (prerequisites + quickstart) → origin story ("Where it came from",
moved up to the fold-adjacent slot — it is the best writing in the repo) → table of
contents → what it does (pipeline steps) → bring your own agent → why/trust → "How it
compares" → "When not to use Pelaggio" → platform support → using it on itself → Stats
(prose + reserved snapshot placeholder, HTML comment) → reference links → license.**

This enumeration is complete — every section the bullets below add appears in it, every
section the README has today appears in it or has a named relocation destination, and
both reserved placeholders (hero slot, Stats snapshot) are structural requirements of
T1-1, since T1-5's acceptance fills them. **Preservation rule:** the restructure drops no
prose. The only content *leaving* `README.md` is the operator-command reference
(`pr-review` / `revise` / `pr-adjudicate`), destination `docs/pr-review.md`. Within the
README, re-nesting and merging are permitted and are not deletion (Platform support is
promoted out of Install; "Why Pelaggio" and "Trust is the product" may merge into the
single why/trust slot).

- **Synchronize the npm front door in the same PR:** `packages/pelaggio/README.md`
  keeps its condensed shape (no hero slot, no stats placeholder) but its overlapping
  prose — pitch, prerequisites, quickstart — is updated to match the restructured root
  README, so the two front doors never contradict each other.

- Move the "Where it came from" scar-tissue section above the fold-adjacent area — it is
  the best writing in the repo and currently sits at line ~150.
- Move the `pr-review` / `revise` / `pr-adjudicate` operator-command reference out of the
  README into `docs/pr-review.md` (merge with existing content; leave one link).
- Add a table of contents and badges. npm version badge is safe now (`pelaggio@0.0.1` is
  published); the CI badge 404s while the repo is private — include it commented-out with
  a note, or omit until the repo is public. License and Node-version badges are safe.
- Add a **"When not to use Pelaggio"** honesty section: tiny repos, no CI, no issue
  hygiene, cost floor per cycle, single-shot tasks better served by an interactive agent.
- Add a short **"How it compares"** table — raw agent-CLI loop (Ralph-style), OpenHands,
  GitHub Agent HQ — where every row is a falsifiable mechanism claim (gate determinism,
  model diversity, cost receipts, self-hosting), not adjectives. Date the table.
- The quickstart references the dry-run command as it behaves **today**; T1-2 improves
  the output later without further README changes.
- The Stats section keeps its current prose plus an HTML-comment placeholder for the
  T1-3 snapshot (embedded later by T1-5).
- **Make the acceptance gates actually cover the deliverable:** `pnpm check:links` and
  `pnpm check:doc-claims` today scan only `docs/trust/`, so they would stay green on a
  broken README. This item extends `ci/verify-links.ts` coverage to `README.md` and
  `docs/pr-review.md` for **internal** links. External URLs are deliberately outside
  `verify-links.ts`' scope (it skips scheme-qualified links by design), so competitor
  citations are **not** machine-checked: each comparison row carries an access-dated
  external source verified in review. Extending `check:doc-claims` beyond `docs/trust/`
  and adding an external-link checker are both out of scope.

**Acceptance:** final hierarchy exactly as enumerated above with BOTH reserved
placeholders present and no existing content deleted (preservation rule); operator-command
prose no longer in the README; every comparison row carries an access-dated external
source (review-verified — external URLs are deliberately outside `check:links`' scope);
`pnpm check` green, and `pnpm check:links` — with its scope extended to `README.md` and
`docs/pr-review.md` as part of this item — green on the restructured files' internal
links.

## T1-2 — Dry-run as the first-run ritual (scope M; no README edits)

`npx pelaggio run --dry-run --cycles 1` is the zero-risk taste of the pipeline and the
quickstart's trust ritual ("the flight plan before takeoff"). Today's reality, which this
item changes: `--dry-run` hardcodes a placeholder item id (`DRY`) and never consults the
roadmap, and a fresh `init` scaffolds only `{{PFX-1}}` placeholder rows — so "the item it
would pick" does not currently exist. Scope:

- When the roadmap resolves a next available item, the dry run names it (id + title) as
  the item it would pick — through a **pure preview seam**, not the existing
  `roadmap-next` path: that path refreshes stale quarantine and writes
  `.dev/stale-quarantine.json`, so reusing it would make the "zero-risk ritual" mutate
  repository state. The dry run uses (or introduces) a peek variant with no writes — no
  quarantine refresh, no claim, no lock, no `.dev` mutation.
- On a fresh scaffold (placeholders only, or an empty backlog), the dry run prints an
  explicit "backlog empty — showing a placeholder cycle" line instead of implying a real
  pick.
- The flight plan renders: the steps that would run, per-step provider/model, per-step
  budget and turn caps, the ship target, and the configured cycle budget **threshold —
  labeled accurately**: today, exceeding the aggregate budget warns and continues (the
  value gates max-turn retries only), so the flight plan must present it as a threshold,
  never as a hard ceiling. Hardening the budget into an enforced ceiling is explicitly
  out of Tier-1 scope; publishing it as one would be a false trust claim.
- clig.dev-clean: no stack traces or internal noise on the happy path; failures name the
  missing prerequisite and the fixing command.

**Acceptance:** fresh-scaffold dry run prints a legible flight plan with the explicit
empty-backlog line; a populated roadmap yields the real next item; a **no-mutation test**
asserts the ritual invocation (`run --dry-run --cycles 1`, without `--parallel` or
`--verbose`) leaves the working tree and `.dev/` byte-identical — the verbose/parallel
cycle-log write is outside the ritual's path, and guarding it too is optional hardening;
no behavior change to real runs; no README edits.

## T1-3 — Cost receipts in default output + embeddable stats (scope M; deps: T1-2; no README edits)

T1-3 follows T1-2 by dependency, not convention: both items edit the same default-output
rendering region of `pipeline.ts` (cycle banner, threshold warning, cycle-cost lines),
and T1-3's labeling inherits T1-2's threshold vocabulary.

The telemetry exists (`pelaggio stats`, per-step cost in the cycle log); surface it:

- Default (non-verbose) cycle output shows a per-step dollar line and an end-of-cycle
  total against the configured budget threshold (same accurate labeling as T1-2: a
  threshold that warns, not an enforced ceiling).
- **Estimated-cost integrity:** provider-estimated subscription costs already carry a
  `costEstimated` flag and render with a `~` prefix so they never read as billed USD.
  Both the new default output lines and the snapshot below must preserve that
  distinction; an estimate rendering as a plain dollar amount is an acceptance failure.
- A stats snapshot command with stable, embeddable output (e.g. `pelaggio stats
  --markdown`) producing the block T1-5 will embed in the README, with the regeneration
  command included in the block itself.

**Acceptance:** a default run's transcript shows cost per step and cycle total; `~`
prefixes survive in both surfaces; snapshot output is deterministic given a fixed log;
no README edits.

## T1-4 — Web UI adopts the brand palette (scope M; independent)

Recolor `packages/web` onto `docs/brand/palette.md`. Corrected premise: the UI today is
Tailwind slate **plus** blue-700 links, zinc neutrals, and ~30 red/green/amber status
utilities — the recolor is wider than three files. Full inventory (all carry slate or
status colors): `global.css`, `Base.astro`, `RepoNav.tsx`, `TokenPrompt.tsx`,
`RunList.tsx`, `RunDetail.tsx`, `RunDetailFromQuery.tsx`, `LogStream.tsx`,
`StartForm.tsx`, `StatsView.tsx`, `lib/format.ts`, `manifest.webmanifest`
(`background_color`) — plus the **gitignored raster icons** (`icon-192.png`,
`icon-512.png`, `apple-touch-icon.png`): regenerate via `gen-icons` as part of this item
so deployed rasters match the Notes→Wing `icon.svg` (stale letter-A rasters can persist
on disk from before Tier 0).

- Global tokens for Foam / Signal Teal / deep / abyss in `global.css`; all components
  restyled through the tokens; light and dark per palette.md's contrast-tested pairings.
- **Semantic state tokens are part of this item:** palette.md's "Semantic (state)
  colors" section defines policy only (no hexes, no tested pairs). Mint success /
  warning / danger tokens per that policy, contrast-test them against both grounds, and
  record them in palette.md as part of the change.
- **Two ambers, both legitimate:** Joe's Beak Amber (`#E7862A`) stays mascot-reserved
  per the brand rule; the *functional* warning amber role palette.md permits is a
  distinct token and may serve status chrome. Existing amber status utilities migrate to
  the functional token, not to Beak Amber, and not to deletion.
- No new components, no layout changes — recolor and typography only.

**Acceptance:** no `slate-*`, `zinc-*`, or ad-hoc `blue-*`/status-color utilities remain
in the files inventoried above; every pair **this item introduces or changes** matches a
contrast-tested entry in the updated palette.md (auditing palette.md's pre-existing
untested entries, e.g. the dark-mode `--surface`/`--text-soft` pair, is out of scope);
rasters regenerated; icon, theme-color, manifest, and page chrome read as one system.

## T1-5 — Hero demo GIF via VHS (scope M; deps: T1-1, T1-2, T1-3)

The README's hero: a 30–60s terminal GIF of one cycle — pick → plan → review verdicts →
PR opened — with the cost meter visible in frame.

- Built with Charm VHS from a `.tape` file checked into the repo.
- Deterministic source: the tape replays a captured transcript (the T1-2 flight plan
  plus a recorded real-cycle segment). Regenerating the GIF (`vhs <tape>`) must not
  require a paid live run.
- **Drift control:** the capture command that produced the transcript is documented next
  to the tape; the tape header records the CLI version it was captured against; the item
  adds a checklist note (release process or CI) to refresh the transcript when
  flight-plan or cost-line formats change. Canned output with no provenance is how demos
  rot.
- Fills the hero slot T1-1 reserved — no reordering of T1-1's hierarchy — and embeds
  the T1-3 stats snapshot in the Stats section placeholder.

**Acceptance:** `.tape` + GIF + capture provenance in-repo; GIF shows the cost meter
(with `~` where estimated); `vhs <tape>` regenerates offline; hero slot and stats
placeholder filled without structural README changes.

---

## Sequencing

| Order | Item | Depends on | README writes |
|---|---|---|---|
| 1 | T1-1 README inversion + npm sync | — | yes (sole restructurer, both front doors) |
| 1 | T1-2 dry-run ritual | — | none |
| 1 | T1-4 web palette | — | none |
| 2 | T1-3 cost receipts | T1-2 | none |
| 3 | T1-5 hero GIF + embeds | T1-1, T1-2, T1-3 | yes (fills reserved slots only) |

T1-1, T1-2, and T1-4 are parallel-safe: they touch disjoint files (READMEs / pipeline
dry-run path / web UI). T1-3 follows T1-2 by dependency (shared default-output region of
`pipeline.ts`). T1-5 is last. The edges order the work; their *resolution* runs through
the operator mark-done relay described under the ownership rule above.

## Risks

- **Naming (operator action, not an item dependency).** Main's brand system
  (`docs/brand/README.md`, self-declared source of truth) treats **Pelaggio** as the
  name; the unmerged `docs/naming-decision` branch (head `d9e2218`) records a contrary
  "Pelagic Autopilot — DECIDED". This plan proceeds on main's record. The operator
  should merge-or-close that branch to kill the contradiction; until then it is a
  documentation inconsistency, not a gate — an unenforceable "reconcile before merge"
  precondition under auto-merge would be theater.
- **VHS determinism.** A GIF that needs a live paid cycle to regenerate will rot;
  "regenerates offline" is a blocking acceptance criterion of T1-5, and the drift-control
  provenance is what keeps the canned transcript honest.
- **Comparison prose ages.** Competitor rows must stay falsifiable and dated; schedule a
  revisit when the launch arc (Tier 2) starts.
- **Badges.** `pelaggio@0.0.1` is published, so the npm badge resolves today; the CI
  badge is the one that 404s while the repo is private. T1-1 chooses the degrading-set
  accordingly.

## Destination

GitHub issues (`autopilot` label) via `npx pelaggio roadmap create-item`, scope M each so
every item receives a plan step. T1-5 carries `--deps` on the created issue numbers of
T1-1, T1-2, and T1-3.
