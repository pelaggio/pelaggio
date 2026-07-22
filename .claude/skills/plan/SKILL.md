---
name: plan
description: Generate an implementation plan for the current work item, self-review it, and revise until solid
argument-hint: "[item-id]"
allowed-tools: Read Glob Grep Write Bash(git:*) Bash(ls:*) Bash(npx:*)
---

# /plan — Plan and Self-Review

Generate an implementation plan for the current work item. Then review it yourself — is the outcome well-factored, well-tested, well-typed, correct, concise and idiomatic? Do we meet or exceed best practices, standards and patterns in the industry? Revise the plan until it's solid. Output only the final version.

## Context

Run `git rev-parse --path-format=absolute --git-common-dir` — the output ends with `/.git`. Strip that suffix to get MAIN_REPO.

Roadmap lookups go through `npx pelaggio roadmap ...`; the CLI dispatches to the configured adapter (markdown / github-issues / linear).

**Target item: `$ARGUMENTS`** — if an ID appears in your Arguments, use it. Otherwise get the branch from `git branch --show-current` (must not be `main`) and extract the item ID from the branch name.

1. **Understand the item.** If a `## Roadmap item context` block appears in your Arguments (pelaggio mode — the harness provides the item's requirements because a sandboxed provider can't fetch them itself), use THAT block as the spec and do **not** run `roadmap get` or `gh issue view`. If it names a `sourceRef` local file and you need more, read that file. Otherwise (inline / human `/plan`): run `npx pelaggio roadmap get <ID> --json` to fetch `title`, `deps`, `sourceRef` and, for github-issues, `body`; markdown's `sourceRef` is the roadmap file path and linear's is the issue identifier — read the roadmap file / view the issue for the full spec.
2. Read related `{MAIN_REPO}/docs/plan-*.md` and `{MAIN_REPO}/docs/design-*.md` files if referenced.
3. Read any source files named as deliverables — confirm they exist and note their current shape.
4. Find reference implementations for similar features already in the codebase.
5. **Verify APIs you plan to call or extend**: for every function, type, or module the plan will touch, read the actual source and confirm the signature. Don't assume names — check them. If something doesn't exist or has the wrong shape, note it in the plan and propose either extending it or an alternative approach.

## Quality rubric

!`cat .claude/skills/_rubric.md`

!`cat .claude/skills/_project-context.md 2>/dev/null`

## Write the plan

Resolve the target path via the adapter (so markdown lands in `docs/plans/` while gh/linear land in `.dev/plans/`):

```bash
npx pelaggio roadmap plan-path --id <ID> --worktree "$PWD"
```

This prints one line — the absolute path where the plan should live. Exit code 0 if it already exists, 2 if not.

**You MUST write the plan to that path** using the Write tool. Create parent directories if needed. Do not just output the plan as text — the file is read by `/shakedown` in a separate session.

**If your Arguments include `pelaggio`:** STOP after writing the file — do **not** run `git commit`
or `publish-plan`. The harness commits and publishes the plan for you (it runs those effects
in-process, so this step works on providers whose sandbox can't write git metadata or reach the
network). Just write the file and finish.

**Otherwise (inline / human `/plan`):** commit and publish it yourself:
```bash
git add "<resolved-path>"
git commit -m "docs: add implementation plan for <ID>"
# publish via the adapter (markdown: no-op; github-issues / linear: upserts the `<!-- pelaggio-plan -->` comment):
npx pelaggio roadmap publish-plan --id <ID> --file "<resolved-path>"
```

Cover in the plan: scope (what it does and doesn't touch), approach (why this over alternatives), files to change, test strategy, and a rubric self-check.

## Decompose large items (prefer this over a monolith)

One cycle implements one coherent, shippable slice. If delivering this item fully would sprawl — many independent files/subsystems, or several separable capabilities — **decompose it** rather than plan a monolith that risks running out of implement turns:

- Scope THIS plan to the **first coherent, independently-shippable slice** (a vertical slice that lands real value + tests on its own).
- List each remaining slice as a `deferred-item: {"title": "...", "scope": "S|M|L", "deps": ["<this-id>"]}` marker line on its own line. The harness creates them as follow-up roadmap items (do **not** run `roadmap create-item`). Keep titles specific and self-contained.
- State in the plan's scope section what this cycle delivers and what was deferred, so the shipped PR is honestly scoped to the slice.

Decomposition is the default for genuinely large work. Only carry a large item whole when it does not separate cleanly (a single tightly-coupled change) — the implement step has headroom for that case, but a monolith that could have been sliced is a planning smell.

## Self-review

This is the **in-context pass** — the same session wrote the plan, so you see the reasoning trail. That makes you strong at catching project invariants (the Correct dimension: step exhaustiveness, frontmatter stripping, worktree isolation, rate-limit parking, phantom ship guard, etc.) and weak at catching Idioms drift (out-of-context `/shakedown` owns that — fresh eyes are the right tool for convention enforcement).

Re-read the plan as a critical reviewer:

Flag reviewer-vetoable forks affecting invariants, security, cost, public API surface, or scope beyond M with `DECISION: <fork> | chose: <default> | alternatives: <other options>` and proceed with the default. The sentinel is non-halting, may appear multiple times, and is not for routine choices. Include any such forks in the self-review output.
- Score each rubric dimension. Are there blockers or concerns on Correct, Well-typed, Well-factored, Well-tested, or Concise?
- Skip Idioms — defer to `/shakedown`.
- If you find issues, **revise the plan inline** and note what changed.

## Output

Show the final plan. If you revised anything during self-review, briefly note what changed and why.

Then: "Run `/shakedown` for an independent review, or say **go** to start building. When done, run `/shakedown` again to review the code."
