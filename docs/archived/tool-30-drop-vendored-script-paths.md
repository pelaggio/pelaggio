# TOOL-30 — Drop vendored script paths from skill prose

## Scope

Two cosmetic string replacements in consumer-facing skill files. Remove the `scripts/autopilot/helpers.ts:parseVerdict` path references — after a consumer `npm install`, those paths resolve under `node_modules/@cdhorne/claude-autopilot/...`, so the in-prose path is stale for any human reading the skill. The pipeline consumes only the verdict string itself; the path was always incidental.

**In scope**:
- `.claude/skills/_review-logic.md` line 39
- `.claude/skills/shakedown/SKILL.md` line 78

**Out of scope**:
- `.claude/skills/_rubric.md` — autopilot-internal rubric, not a consumer-facing skill; roadmap explicitly leaves it alone.
- `parseVerdict` the function — name, grammar, and behavior all unchanged.
- Auditing other skills for vendored paths — opportunistic only, per roadmap.

## Approach

Replace the path token with a path-free phrase that still tells the reader *what* parses the verdict. Use **"the pipeline's verdict parser"** — matches the roadmap's own suggested wording and reads naturally in both sentences.

Alternatives considered:
- *"the autopilot pipeline"* — loses the "parser" specificity; reader might wonder what shape the pipeline expects.
- *Delete the "parsed by X" clause entirely* — strips useful context (explains *why* the exact format matters). Rejected.
- *Keep the path but qualify with "(in this package)"* — still rots under `node_modules/` and adds noise. Rejected.

## Files to change

### `.claude/skills/_review-logic.md`
Line 39 currently:
```
End the review with a single verdict line that `scripts/autopilot/helpers.ts:parseVerdict` can match:
```
Becomes:
```
End the review with a single verdict line that the pipeline's verdict parser can match:
```

### `.claude/skills/shakedown/SKILL.md`
Line 78 currently:
```
- The `Verdict:` line is parsed by `scripts/autopilot/helpers.ts:parseVerdict` — emit it with the exact format `Verdict: APPROVE` / `REVISE` / `RETHINK`.
```
Becomes:
```
- The `Verdict:` line is parsed by the pipeline's verdict parser — emit it with the exact format `Verdict: APPROVE` / `REVISE` / `RETHINK`.
```

Both edits are single-line string replacements — unambiguous, no surrounding context shifts.

## Test strategy

- `pnpm check:skills` — validates skill frontmatter and `!cat` include targets. Neither edit touches frontmatter or includes, so this should remain green.
- `pnpm check` — Biome scope is `scripts/**/*.ts`; markdown is out of scope. Still run it to confirm no incidental drift.
- Grep `.claude/skills/` for `scripts/autopilot/helpers.ts:parseVerdict` post-edit — expect zero hits in `_review-logic.md` and `shakedown/SKILL.md`; `_rubric.md` hits remain (intentional, per scope).
- No unit tests warranted — the change is prose-only and doesn't touch `parseVerdict()` behavior.

## Rubric self-check

- **Correct**: No load-bearing invariant touched. Verdict grammar unchanged; `parseVerdict()` still matches the emitted `Verdict: APPROVE/REVISE/RETHINK` lines verbatim. No change to step exhaustiveness, frontmatter stripping, worktree isolation, rate-limit parking, or phantom-ship guard.
- **Well-typed**: N/A — no TypeScript touched.
- **Well-factored**: Keeps the consumer-facing / internal split honest — `_rubric.md` can keep its internal references; the two files read by downstream consumers shed them.
- **Well-tested**: `pnpm check:skills` covers the skill lint path. The edits are too trivial and too cosmetic to warrant new tests.
- **Concise**: Minimal surgical replacement. No new files, no new abstractions, no drive-by cleanups elsewhere.
- **Idioms**: Deferred to `/shakedown`.

## Self-review notes

Re-read before writing: the plan is small enough that elaboration risks overselling a 2-line change. Kept it surgical. One concern flagged during review — whether dropping the specific symbol name (`parseVerdict`) loses debuggability for someone grep-hunting — resolved in favor of the replacement because (a) the exact verdict format is still spelled out one clause later, and (b) consumers don't have direct access to `parseVerdict` in their install tree anyway, so the symbol name is just as stale as the path.
