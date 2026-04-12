# Quality Rubric

Six dimensions — apply when planning, reviewing, or fixing code. These drive `/shakedown` and every review pass.

## Dimensions

**Well-typed** — No `any`. Schema-derived types (`$inferInsert`, `$inferSelect`, domain enums). Branded types for values that need semantic identity (e.g., `Cents`, `UserId`, `{{YOUR-DOMAIN-BRAND}}`). Explicit return types on exports. Discriminated unions over boolean flags where state matters.

**Well-tested** — Unit tests for pure logic. Integration tests for DB (real SQLite, not mocks). Edge cases: empty state, boundaries, error paths. i18n key parity passes *(if bilingual)*. {{ADD STACK-SPECIFIC TEST RULES}}

**Well-factored** — SRP. Business logic in domain engines (`src/{your-domain}/`, e.g., `src/ingestion/`, `src/matching/`, `src/pricing/`), not hooks. Reuse shared components ({{LIST YOUR SHARED UI COMPONENTS HERE, e.g., `Screen`, `ScreenHeader`, `Button`, `InfoRow`, `ItemTable`, `StatCard`}}). Hooks are thin wrappers.

**Idiomatic** — Biome-clean. ULIDs over auto-increment IDs. ISO-8601 UTC via `nowISO()`. Soft deletes with `deleted_at`. Zustand v5 named import. Explicit `created_at`/`updated_at` on inserts. `<Redirect href>` not `useEffect` + `router.replace()`. Schema types from `@db/schema`. Display labels from `get*Label()`. Press feedback on every interactive element. `MOTION.duration.*` tokens.

**Correct** — *This is the project-specific invariants section — fill this in yourself, it's the single most important part of the rubric.* {{REPLACE BELOW WITH YOUR DOMAIN INVARIANTS}}

*Starter prompts to help you author this section:*

- What are the 3–5 invariants that, if violated, corrupt the data model?
- What currency/unit/range rules must hold at every boundary?
- What references must never be broken (foreign keys, evidence chains, source attributions)?
- What operations must be atomic (multi-table writes, cross-entity mutations)?
- What can the system infer automatically, and what requires explicit user confirmation?

*Examples from Fathom (for reference — replace with yours):*
- ~~*Currency boundaries enforced — all amounts as integer cents with branded `Cents` type*~~
- ~~*Transfer exclusion on spend/income queries*~~
- ~~*Evidence chain to `source_documents`*~~
- ~~*Confidence-gated automation (3-tier: auto / review / flag)*~~
- ~~*Multi-table writes in `db.transaction()`*~~
- ~~*Agent writes via `proposeAction()` only*~~

**Concise** — YAGNI. No dead code. Early returns. Destructured props. No premature abstractions. No backwards-compat shims. Three similar lines is better than a premature helper.

## Verification

```bash
pnpm typecheck          # repo root
pnpm check              # apps/mobile — biome
npx jest --no-coverage  # apps/mobile
```

All three must exit 0. **Biome warnings are acceptable** — only errors block. Do not fix warnings in files outside your diff.
