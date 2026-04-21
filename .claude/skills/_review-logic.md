# Review Logic

Shared dispatch, categorization, and stopping rules for `/shakedown` (both plan review and code review paths).

## Target detection

Detect what to review, in order:

1. **Explicit argument** — if `Arguments:` below names a `.md` file, review it as a plan; if it names a commit range or file list, review it as code.
2. **Autopilot directive** — if `Arguments:` contains `autopilot plan-review` or `autopilot code-review`, dispatch to that mode regardless of git state.
3. **Plan-only state** — extract the item ID from the current branch name and resolve the plan path via `npx @cdhorne/claude-autopilot roadmap plan-path --id <ID> --worktree "$PWD"` (exit 0 means it exists). If the plan exists AND `git diff --name-only main...HEAD` lists only that plan path (or other paths under the same `docs/plans/` or `.dev/plans/` directory), it's plan review mode — target is the resolved plan path.
4. **Code state** — otherwise, review the diff. Target is the union of:
   - Unstaged changes (`git diff`)
   - Staged changes (`git diff --cached`)
   - Committed changes (`git diff main...HEAD --name-only`)

If neither a plan nor a diff exists, report "nothing to review" and stop.

## Finding categorization

Sort every issue into exactly one bucket:

- **Fix now** — type errors, test failures, lint errors, bugs, convention violations, security issues, correctness gaps, rubric violations that will produce broken output. Must be fixed in this session before the verdict.
- **Near-term** — missing tests, factoring improvements, incomplete error handling, reuse opportunities, documentation gaps. Fix in this session when within scope; otherwise defer.
- **Deferred** — feature extensions beyond scope, performance optimizations without evidence, refactors to untouched code, logical future extensions. Add to the roadmap (autopilot mode) or list in the output (inline mode).

## Stopping rule

Iterative review caps at **2 passes**. Subsequent passes surface progressively smaller editorial findings (naming nits, missing references, unspecified edge cases) that are cheaper to address during implementation than in another paper review.

After pass 2, if issues remain:
- **Correctness-critical findings** (will produce broken code or plans): fix them, then stop.
- **Editorial / clarifications**: leave as inline TODOs in the target, then stop.

Reviews have diminishing returns; actual code surfaces real edge cases faster than another paper review. Within a single invocation, however, make as many internal edit passes as needed to produce a clean result — the 2-pass cap is about user-triggered iteration, not internal thoroughness.

## Output format

End the review with a single verdict line that the pipeline's verdict parser can match:

```
Verdict: APPROVE
```

Use one of:

- **APPROVE** — no blocking issues, or all fix-now items have been addressed in this session. Safe to proceed.
- **REVISE** — fix-now items remain but the target is fixable without redesign. Rare in practice, since the skill usually fixes in place and emits APPROVE.
- **RETHINK** — fundamental design issue that editing cannot fix. In plan review, this aborts the autopilot cycle. In code review, it signals the implementation should go back to `/plan`.

Above the verdict, summarize:

1. **Target** — what was reviewed (plan file path or file list)
2. **Fix-now** — items addressed this session
3. **Near-term** — items addressed or deferred
4. **Deferred** — items added to roadmap (autopilot) or listed (inline)
5. **Verification** — results of the rubric's Verification commands (code review only)
