# Quality Rubric

Six dimensions — apply when planning, reviewing, or fixing code. These drive `/shakedown` and every review pass.

## Dimensions

**Well-typed** — Strong types at every boundary; no escape hatches (`any`, untyped dicts, blind casts). Types derived from the schema or source of truth rather than duplicated by hand. Branded/nominal types for values that need semantic identity (e.g., `Cents`, `UserId`, `{{YOUR-DOMAIN-BRAND}}`). Explicit return types on exported functions. Discriminated unions (or your language's equivalent) over boolean flags where state matters. {{ADD YOUR TYPE-SYSTEM RULES}}

**Well-tested** — Unit tests for pure logic. Integration tests against real infrastructure (a real database file, not mocks) where practical. Edge cases: empty state, boundaries, error paths. {{ADD STACK-SPECIFIC TEST RULES — e.g., fixture conventions, i18n key parity, snapshot policy}}

**Well-factored** — Single responsibility. Business logic lives in domain modules (`{{e.g., src/ingestion/, src/pricing/}}`), not in UI glue, route handlers, or hooks. Reuse the shared components and helpers you already have ({{LIST YOUR SHARED COMPONENTS/HELPERS}}). Thin adapters at the edges.

**Idiomatic** — Clean under the project linter/formatter ({{YOUR LINTER}}). {{LIST YOUR PROJECT IDIOMS — the "this codebase does X, never Y" rules a new contributor would trip on. Examples of the right shape: "ULIDs over auto-increment IDs", "ISO-8601 UTC timestamps via nowISO()", "soft deletes with deleted_at", "display labels via get*Label(), never hardcoded maps"}}

**Correct** — *This is the project-specific invariants section — fill this in yourself; it's the single most important part of the rubric.* {{REPLACE BELOW WITH YOUR DOMAIN INVARIANTS}}

*Starter prompts to help you author this section:*

- What are the 3–5 invariants that, if violated, corrupt the data model?
- What currency/unit/range rules must hold at every boundary?
- What references must never be broken (foreign keys, evidence chains, source attributions)?
- What operations must be atomic (multi-table writes, cross-entity mutations)?
- What can the system infer automatically, and what requires explicit user confirmation?

*Example invariants of the right shape (replace with yours):*
- ~~*All money amounts stored as integer cents behind a branded `Cents` type — float arithmetic on currency is a bug*~~
- ~~*Every derived record traces to its source row (evidence chain)*~~
- ~~*Multi-table writes always inside a transaction*~~
- ~~*Automated mutations go through the propose-then-confirm path, never direct writes*~~

**Concise** — YAGNI. No dead code. Early returns. No premature abstractions. No backwards-compat shims. Three similar lines is better than a premature helper.

## Verification

```bash
{{TYPECHECK COMMAND}}   # e.g. pnpm typecheck / tsc --noEmit / mypy .
{{LINT COMMAND}}        # e.g. pnpm check / ruff check / rubocop
{{TEST COMMAND}}        # e.g. pnpm test / pytest / bin/rails test
```

All must exit 0. **Warnings are acceptable** — only errors block. Do not fix warnings in files outside your diff.
