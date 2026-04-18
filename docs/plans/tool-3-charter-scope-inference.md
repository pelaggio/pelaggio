# TOOL-3 — Scope inference in `/charter` from description

**Branch:** `feat/tool-3-charter-scope-inference`
**Depends on:** none

## Goal

When `/charter` is invoked without `--scope`, infer one of `XS | S | M | L | XL`
from the description text using keyword heuristics, and report the inferred
scope alongside a one-line rationale (the trigger phrase that matched).
Existing `--scope` and `--bug` overrides keep working unchanged.

Today the skill body says scope is "inferred from description (bug fix = S,
new screen = M, new system = L)" — which is (a) incomplete (no XS, no XL),
(b) inconsistent with the repo's published taxonomy (`docs/roadmap-core.md`
scope legend is XS/S/M/L/XL), and (c) contradicted by the `argument-hint`
frontmatter which advertises only `S|M|L`. TOOL-3 closes all three gaps.

## Scope

**In scope**
- Edit `.claude/skills/charter/SKILL.md`:
  - Fix `argument-hint` frontmatter: `[--scope XS|S|M|L|XL]`.
  - Add a new "Scope inference" section between "Select target" and
    "Generate item" with the heuristic table + tie-break rule + default.
  - Update the "Generate item" step 4 to point at the new section and keep
    the `--bug` / `--scope` override precedence explicit.
  - Update the "Report" section to include the inferred-scope line when
    inference was used (skipped when `--scope` was explicit, to avoid
    redundant noise).
  - Keep the checkbox/table output formats as-is; only the `Scope:` token
    widens to the five-value set. `Scope: XS` and `Scope: S` continue to
    satisfy the existing pipeline regex (`/scope:\s*x?s\b/i` in
    `markdown.ts:26`), so quick-scope routing stays intact.

**Out of scope (explicitly)**
- Any TypeScript change. Scope inference lives entirely inside the skill body
  — the pipeline consumes the `Scope: X` token that the skill writes into the
  roadmap entry, and that contract is already stable. Adding logic to
  `scripts/autopilot/` would be scope creep.
- Changing the XS/S/M/L/XL taxonomy or renaming the legend.
- Rewiring `isQuickScope()` in `roadmap/markdown.ts` or `roadmap/github-issues.ts`.
  Those regexes stay untouched; the emitted `Scope:` value still flows
  through them as it does today.
- ML-based scope estimation — keyword heuristics are fine (stated in the
  roadmap "Out of scope").
- Extending inference to the `/pick` skill's "Report scope" step (pickup is
  already reading the roadmap entry; it will see whatever `/charter` wrote).
- Updating downstream skill bodies (`/pick`, `/pickup`, `/plan`) to display
  the rationale — the rationale is an artifact of the charter moment, not a
  persistent field. We emit it once, in `/charter`'s own report, and move on.

## Approach

### Why heuristics in the skill body (not in TypeScript)

`/charter` is invoked by a human-driven `/charter <description>` command or
by another skill. Its entire job is markdown editing — there is no autopilot
loop here, no SDK orchestration, no shared helper module. Adding a TS helper
to infer scope would force the skill to shell out to `tsx` mid-execution and
marshal the description through argv, which buys nothing. The LLM running the
skill already reads natural language; codifying heuristics as an in-skill
rules table is the minimal, honest implementation.

### Heuristics table

Matched against the user's description text (after flag extraction), using
case-insensitive word-boundary matches. Priority from broadest to narrowest
so "migrate and rename" correctly infers XL, not XS.

| Rank | Scope | Trigger keywords (any match) | Rationale phrase reported |
|------|-------|------------------------------|---------------------------|
| 1 | XL | `migration`, `migrate`, `rewrite`, `schema change`, `re-architect` | "migration / rewrite / schema change" |
| 2 | L | `new system`, `new engine`, `new pipeline`, `new framework` | "new system / engine" |
| 3 | M | `new screen`, `new page`, `new component`, `new hook`, `new adapter`, `new command` | "new screen / component / adapter" |
| 4 | S | `add `, `one file`, `small`, `extract`, `wire up` | "add X / single-file change" |
| 5 | XS | `fix `, `typo`, `rename`, `tweak`, `bump` | "fix / typo / rename" |
| — | M | (no match) | "default — no keyword matched" |

Tie-break: first-to-match from rank 1 downward. Default when nothing matches
is **M** (not S) — a safer default for an LLM-authored charter, since
under-scoping would skip planning entirely and land straight in `/implement`
via `isQuickScope`. Over-scoping merely adds a plan step, which is cheaper
than shipping an unplanned L-sized change.

**Word boundaries matter**: `\bfix\b` (not bare `fix`) avoids triggering XS
on "prefix", "fixture", etc. Same for `\btype\b` vs "typography", `\brename\b`
vs "renamed". The skill body calls this out so the LLM applies it consistently.

### Precedence

1. `--scope X` → use X verbatim. Skip inference. Skip the inferred-scope
   line in the final report.
2. `--bug` → scope S (existing behavior, preserved). Skip inference. The
   `--bug` flag is semantically "this is a bug-fix, the taxonomy has
   already priced it at S" — we do not re-run the XS heuristic even though
   `fix` would match, because `--bug` is an explicit claim about scope.
3. Otherwise → run inference, write the chosen value, report it.

### Report line

When inference ran, append after the existing "Confirm:" output:

```
Inferred scope: M (new screen / component / adapter)
Override with `/charter ... --scope <XS|S|M|L|XL>` if wrong.
```

One rationale line plus one hint. Keeps the skill's report concise.

### Why `M` default instead of `S`

The pipeline's `isQuickScope()` routes XS and S straight to `/implement`,
skipping `/plan` and `/shakedown-plan`. Defaulting to S when nothing matched
means every ambiguous charter lands in the fast path — including ones that
should have had a plan. Defaulting to M preserves the planning step for
unclear cases, which is the cautious choice. The user can always drop scope
manually on the next `/pick`, but recovering a skipped plan is more work.

## Files to change

| Path | Change |
|------|--------|
| `.claude/skills/charter/SKILL.md` | Fix `argument-hint`; add "Scope inference" section; update "Generate item" step 4 + "Report" section; preserve `--scope` / `--bug` precedence. No other section touched. |

Zero TypeScript files. Zero new files. Zero test changes.

## Test strategy

There is no unit-test surface for skill body text — skills are prose +
frontmatter consumed by `expandSkill()`, and the rubric already treats skill
markdown as unlinted beyond `pnpm check:skills` (frontmatter validity +
include resolution).

Verification:
1. `pnpm check:skills` — confirms frontmatter + includes still parse after
   the edits.
2. `pnpm check:roadmap` — unrelated to this change but cheap sanity run.
3. Manual smoke (the honest test for a skill):
   - `/charter "fix off-by-one in parseResetTime"` → expect `Scope: XS` +
     rationale line mentioning "fix / typo / rename".
   - `/charter "add new Linear roadmap adapter"` → expect `Scope: M`
     (matches "new ... adapter" before "add" — rank 3 beats rank 4).
   - `/charter "migrate .dev logs to SQLite"` → expect `Scope: XL`
     (rank 1 wins).
   - `/charter "small tweak to TUI colors" --scope S` → inference skipped;
     no rationale line.
   - `/charter "fix crash on startup" --bug` → scope S (from `--bug`), no
     rationale line, title prefixed "Fix:".
   - `/charter "investigate silent Edit failures"` → no keyword match,
     default `Scope: M`, rationale "default — no keyword matched".

Not wiring these into an automated smoke suite; the skills layer has no
precedent for that (TOOL-5's `check-skills.ts` validates structure, not
semantics). If a future TOOL wants to snapshot-test skill output, that's a
separate charter.

## Rubric self-check

- **Correct** — no pipeline invariant touched. No new step (step-exhaustiveness
  tables in `config.ts` unchanged), no hooks changed, no phantom-ship guard
  altered, no parkExit paths touched. The emitted `Scope: XS` / `Scope: S`
  tokens continue to match `isQuickScope`'s `/scope:\s*x?s\b/i` regex
  byte-for-byte, so quick-scope routing is preserved. Default-to-M is the
  conservative failure mode (over-plans rather than under-plans).
- **Well-typed** — N/A (markdown-only change, no runtime types affected).
- **Well-factored** — single-file edit, entirely within `/charter`'s existing
  section structure. Heuristics live as a table co-located with their usage.
  No new helper module, no cross-skill coupling. The `--scope` override path
  stays the single source of truth for explicit scope.
- **Well-tested** — relies on `pnpm check:skills` structural lint plus manual
  smoke. No automated coverage for inference semantics; acceptable given
  skills layer has no precedent and adding it here would widen scope past
  what TOOL-3 claims.
- **Concise** — ~25 added lines (one section + a table). No new config, no
  new flag, no new helper. `--scope` / `--bug` precedence is stated once and
  reused. YAGNI: no configurable keyword lists, no per-project heuristic
  overrides, no rationale cache.
- **Idioms** — (defer to `/shakedown`). Spot-checks: keeps the existing
  skill's table-heavy writing style; `argument-hint` taxonomy aligned with
  `docs/roadmap-core.md`'s scope legend; report line imperative + one
  follow-up instruction, matching the rest of the skill.

## Revision notes (self-review)

Re-read once after drafting; the changes below landed in-place.

1. **Default was originally S.** Revised to **M**. Reasoning: S gets routed
   to `/implement` directly via `isQuickScope`, skipping planning. A "no
   keyword matched" case is exactly the situation where the description is
   ambiguous, which is exactly when a plan *is* valuable. Erring toward a
   plan step is cheaper than erring toward unplanned shipment.
2. **First draft let `--bug` run through inference** to "confirm" S via the
   `fix` keyword. Revised: `--bug` short-circuits, matching the existing
   behavior verbatim. Treating an explicit flag as a hint that still needs
   re-deriving is exactly the kind of cleverness the rubric warns against.
3. **Considered scanning narrowest-to-broadest** (XS first). Revised to
   broadest-first — "migration + rename" must infer XL, not XS. The rubric's
   "Correct" dimension explicitly flags fail-safe defaults; priority-from-top
   is the safer direction here.
4. **First draft added a report field `rationale: <phrase>` to the roadmap
   row itself.** Revised: rationale lives in `/charter`'s stdout only, not
   in the roadmap entry. The roadmap row stores decisions, not their
   provenance; if a reviewer wants to know why scope is M, they re-run
   `/charter` (or read the plan). Persisting rationale would be spec churn.
5. **Considered widening inference to the `--bug` short-circuit output
   format** (also reporting "Scope: S (bug override)"). Revised: skip the
   line entirely when inference didn't run. Absence of the line is the
   signal that the user supplied the scope.

---

Run `/shakedown` for an independent review, or say **go** to start building.
When done, run `/shakedown` again to review the code.
