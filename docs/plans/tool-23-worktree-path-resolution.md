# TOOL-23 — Fix implement-step path resolution for worktree-relative deliverables

## Problem

Observed across 5 autopilot attempts on TOOL-7 / TOOL-21 (2026-04-18): the `implement` step edits the plan file instead of the deliverables. Root cause:

- `planRef` hands the agent an **absolute** path for the plan file.
- The plan body references deliverables with **project-relative** paths (e.g. `.claude/skills/_rubric.md`).
- The worktree-isolation system-prompt append warns: "NEVER use absolute paths starting with `${REPO}/`".
- The agent reads `.claude/skills/_rubric.md` as ambiguous (could be main repo or worktree) and, to be safe, edits only the one path it has a known-good worktree-absolute form for — the plan itself.

Fix belongs in the prompt-construction layer, not in the system-prompt append (which is correct, just under-specified on the resolution side).

## Scope

**In scope**

- Modify the `implement`-step prompt in `pipeline.ts` so the agent gets explicit instructions for resolving project-relative paths in the plan to worktree-absolute paths.
- Same fix for the `continuePrompt` (retry after `error_max_turns`) and the `quick` profile's direct-implement prompt — all three feed into `implement` and all three can hit the same ambiguity.
- Regression test via the mock SDK harness asserting the prompt carries the worktree hint.

**Out of scope**

- Editing the system-prompt append in `step-runner.ts` (already correct).
- Parsing the plan's "Files to change" table and appending resolved paths — noted as a later cheap extension if the prompt hint proves insufficient. Regex parsing of markdown tables is fiddle-prone; skip for first pass.
- Retro-fitting existing plans to use absolute paths (plans stay portable).
- Applying the same hint to `shakedown-code` / `ship` — neither edits plan-named deliverables by relative path; their failures look different.

## Approach

Compute a single `worktreeHint` string inside the `shouldRun("implement")` block in `pipeline.ts` and prepend it to each of the three implement-flavored prompts.

```
**Your working directory is**: `${worktree}`.
Any path the plan writes as `foo/bar` (project-relative) means `${worktree}/foo/bar` — use that absolute form when calling Edit/Write/Bash, so the worktree-isolation hook does not mistake it for a main-repo reference.
```

Why this phrasing:

- Names the cwd explicitly. The system prompt already says this; duplicating it here puts it *in the same prompt as the plan reference* so the agent reads them together.
- Gives the **resolution rule** (`foo/bar` → `${worktree}/foo/bar`), which is what the current system prompt lacks.
- Ties the rule to tool names (Edit/Write/Bash), matching the hook's surface and anchoring behavior to a concrete action.
- Mentions the hook by effect ("will not mistake it") rather than by name — keeps the prompt portable if the hook changes.

### Why not extend the system prompt

The system-prompt append in `step-runner.ts` fires for every step. Most steps (`plan`, `shakedown-*`, `ship`) don't reference plan-relative deliverables; adding resolution rules there adds noise and risks drift between the general rule and step-specific needs. Keeping the hint local to the implement prompt is the narrowest fix.

### Why not parse the plan's "Files to change" table

The roadmap entry lists this as "alternatively/additionally… out-of-scope for first pass if regex parsing gets ugly." Plans vary in how they list files (table rows, bullets, inline code spans). Parsing would pull in either a markdown AST dep or brittle regex. The prompt hint alone should be sufficient; revisit only if diagnostics show it isn't.

## Files to change

| File | Change |
|---|---|
| `scripts/autopilot/pipeline.ts` | Add `worktreeHint` string inside `shouldRun("implement")` block; inject at the top of `implementPrompt` (both `quick` and full-profile branches) and `continuePrompt`. |
| `scripts/autopilot/__tests__/pipeline.test.ts` | New prompt-content assertion on the happy-path test; one added assertion on the turn-limit retry test asserting the `continuePrompt` also carries the hint. |

No changes to `step-runner.ts`, `config.ts`, `helpers.ts`, `types.ts`, skills, or templates.

### Exact edit shape in `pipeline.ts`

Inside `if (shouldRun("implement"))`, after `const planRef = …`:

```ts
const worktreeHint = [
    `**Your working directory is**: \`${worktree}\`.`,
    `Any path the plan writes as \`foo/bar\` (project-relative) means \`${worktree}/foo/bar\` — use that absolute form when calling Edit/Write/Bash, so the worktree-isolation hook does not mistake it for a main-repo reference.`,
].join("\n");
```

Then:

- `implementPrompt` quick-profile branch: prepend `worktreeHint` plus a blank line to the existing template literal.
- `implementPrompt` full-profile branch: add `worktreeHint` and `""` as the first two array entries.
- `continuePrompt`: same — first two array entries.

All three variants remain `string`-typed. No type surface changes. `worktree!` is already in scope (non-null asserted at pipeline step boundaries).

## Test strategy

Add one assertion in the existing `runPipeline — happy path` test in `pipeline.test.ts`:

1. After the pipeline runs, read `calls.find(c => c.step === "implement")?.prompt`.
2. Assert the prompt contains the literal `worktree` path (returned by `makeTempGitRepo()`).
3. Assert the prompt contains the resolution phrase — match a short, distinctive substring of what we ship (e.g. `"project-relative"` and `"use that absolute form"`), not the full sentence, so minor wording tweaks don't break the test.

Second assertion in the existing `implement turn-limit retry` test: the attempt-2 call's prompt (`continuePrompt`) also contains the hint. One line added, not a new test.

This leverages the prompt-recording capability already present in `mocks.ts` (`calls.push({ step, attempt, prompt })`) — no harness changes.

No dedicated `quick`-profile test: there isn't an existing one to extend and adding one is out-of-scope churn. Same codepath emits the hint; a future `quick`-path pipeline test can include the same assertion.

### Verification commands

```bash
npx tsx --test scripts/autopilot/__tests__/pipeline.test.ts
npx tsx --test scripts/autopilot/__tests__/helpers.test.ts
npx tsx -e "import('./scripts/autopilot/pipeline.ts')"
pnpm check
```

All four must succeed before ship.

### End-to-end validation (post-merge)

Per roadmap: once the fix lands, retry TOOL-7 and TOOL-21 via autopilot. If they now ship cleanly, close TOOL-23. This happens **after** this cycle ships — not part of this plan's own shippable unit.

## Rubric self-check

- **Correct** — No changes to step exhaustiveness, frontmatter stripping, worktree isolation mechanics, rate-limit parking paths, verdict parsing, or the phantom-ship guard. The fix is additive text in an existing prompt block; all existing exit paths and `parkExit()` call sites are untouched.
- **Well-typed** — No `any`, no new types, no `as` casts. All three call sites remain `string`-typed.
- **Well-factored** — Change stays in `pipeline.ts` (orchestration layer). No new module, no cross-layer leak. Hint is built from `worktree` (already in scope) — no new imports.
- **Well-tested** — One new prompt-content assertion on the happy-path test and one additional assertion on the retry test. Uses the existing mock harness; no new harness surface.
- **Concise** — ~6 lines added in `pipeline.ts`, ~4 added lines of test. No dead code, no abstractions, no config knob.
- **Idioms** — Deferred to `/shakedown`'s forked review.

## Risks and mitigations

- **Prompt wording for `quick` profile**: the hint says "any path the plan writes" but quick-profile has no plan — the roadmap entry is the source. The resolution rule is still load-bearing and the agent interprets "the plan or roadmap entry" charitably. Accepted; revisit if autopilot logs show quick-profile confusion.
- **Duplicate guidance between system prompt and implement prompt**: acceptable. The system prompt says "use relative or $PWD-relative"; the implement prompt specializes that to the plan-reference scenario. Redundancy is cheap; drift is the risk to watch — if the system prompt ever changes its wording, revisit this hint.
