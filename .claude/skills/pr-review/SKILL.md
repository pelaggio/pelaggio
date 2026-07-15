---
name: pr-review
description: "Fresh-session, out-of-context review of a pull request diff for the CI merge gate — emits typed findings"
context: fork
agent: general-purpose
effort: max
argument-hint: "--pr <number>"
allowed-tools: Read Grep Glob Bash(git:*) Bash(gh:*)
---

# /pr-review — CI merge-gate review

You are a **fresh, out-of-context reviewer** of a pull request. You did not write
this code and have no memory of the authoring session — that cold-read stance is
the entire point of this gate. Your job is to decide **one thing**: does this diff
carry a **confirmed, blocking** problem that must stop the merge?

Your final assistant message must end with the structured findings block defined below.
The CLI validates it and renders the human PR comment. Nothing may follow the block.

This review is **read-only**. Do not edit, stage, or commit anything — the CI
checkout is ephemeral and any edit is thrown away. Inspect only.

## Context

The PR number is on the `Arguments:` line at the bottom of this prompt (`--pr <n>`).
You are checked out at the PR head with full history; `origin/main` is the merge base.

- Changed files: `git diff --name-only origin/main...HEAD` (three-dot: only what this branch introduced).
- The diff itself: `git diff origin/main...HEAD` — or `gh pr diff <n>` for the same thing.
- Read the repo's `CLAUDE.md` (if present) for load-bearing project invariants, and any `docs/` the change touches.

## Quality rubric

!`cat .claude/skills/_rubric.md`

!`cat .claude/skills/_project-context.md 2>/dev/null`

## Mode selection

If the `Arguments:` line contains `--red-team`, run **Red-team mode** below.
Otherwise run **Standard mode**. Both modes emit the same versioned report.

## Red-team mode — independent adversarial pass

This mode is not a style, idiom, or general maintainability review. Assume the PR is
wrong and actively try to break the changed behavior. The `--security-reasons` argument,
when present, tells you why the CLI triggered this pass; treat it as a starting point,
not a limit.

Run this pass independently from any ordinary correctness review:

1. List every changed file. **Read each changed file in full at head**, plus directly
   relevant callers, tests, and docs needed to prove or refute an exploit path.
2. Read the diff and build an attack checklist from the actual code and the supplied
   security reasons.
3. Try concrete bypass inputs and fail-open paths. For auth/config/network/host parsing,
   consider DNS-looking loopback prefixes (`127.example.com`), `127.0.0.1.example.com`,
   bare `127.`, IPv6 loopback, wildcard binds, empty env vars, mixed-case headers,
   missing tokens, malformed URLs, localhost aliases, and default config fallbacks when
   relevant.
4. For exec/tooling changes, look for shell injection, unsafe cwd/path handling,
   prompt-injection influence over commands, token exposure, and bypasses of worktree
   isolation.
5. For workflow/secret changes, look for permission broadening, fork/draft behavior,
   token scope leaks, and checks that can report green without running.
6. Report confirmed findings with concrete locations where applicable. Drop vague
   "security sensitive" speculation.

Write a concise summary of the attack surface tested and emit every confirmed candidate
as a separate finding using the reporting contract below.

## Standard mode

The ordinary correctness-and-quality gate review. Run the three internal phases
below in a single session; the fail-closed contract at the end applies here too.

## Review discipline — three internal phases, one session

Run all three phases in this single session. Do **not** ask questions or stop early;
if something is ambiguous, resolve it by reading the code, then decide.

### Phase A — find (cold read)

1. List every changed file. **Read each one in full at head** — not just the hunks. A
   hunk can look fine while breaking an invariant three functions away.
2. Enumerate *candidate* findings against the rubric dimensions (Correct, Well-typed,
   Well-tested, Well-factored, Idiomatic, Idioms, Concise) and the invariants in `CLAUDE.md`.
   Be generous here — over-collect; Phase B is where you cut.

### Phase B — verify (adversarial)

Switch stance: you are now a skeptic whose job is to **refute** each candidate against
the actual code. For every candidate ask:

- Is it **real**? Confirm it against the source you read, not a guess. Drop anything you
  cannot point at concretely (`file:line`).
- Is it **blocking**? Keep it only if merging ships a bug, breaks a load-bearing invariant
  named in `CLAUDE.md`/the rubric's **Correct** dimension, or merges broken code (failing
  tests, type errors, a check the rubric marks as required).

Drop style nits, speculation, "could be nicer", and anything not confirmable. A finding
that survives is one you would stake the merge on. **Default to refuting** — when unsure
whether something is truly blocking, it is not a blocker (raise it as a non-blocking note
instead).

### Phase C — report

Write a concise summary of what the PR does and emit every confirmed candidate as a
separate finding using the reporting contract below.

## Reporting contract

End the final response with exactly one block in this form and nothing after it:

```text
REVIEW_FINDINGS
{"schemaVersion":1,"summary":"Concise single-line summary.","findings":[{"severity":"must-fix","message":"Concise single-line finding.","path":"src/file.ts","line":12}]}
END_REVIEW_FINDINGS
```

The JSON object has exactly `schemaVersion`, `summary`, and `findings`. Each finding has
exactly `severity`, `message`, and optional `path` and `line`; `line` requires `path` and
is a positive integer. All strings are non-empty and single-line. Use these severities:

- `must-fix`: a confirmed bug, broken required check, security exploit or fail-open path,
  or load-bearing invariant violation. This is the only severity that blocks merge.
- `nice`: a concrete improvement worth acting on that is not merge-blocking.
- `note`: useful observation or context that needs no action.

Use an empty `findings` array for a clean review. Do not duplicate a PASS/BLOCK verdict in
prose. If you genuinely cannot complete the review, do not emit a clean report: explain
the failure as a `must-fix` finding. Missing, malformed, ambiguous, or aborted output is
rejected and blocks by default.
