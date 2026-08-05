---
name: decompose
description: Propose and apply a human-approved decomposition of an L/XL roadmap item into S/M children
argument-hint: "<item-id>"
disable-model-invocation: true
allowed-tools: Read Glob Grep Bash(npx:*)
---

# /decompose — Mindful L/XL Decomposition

Turn one oversized (L/XL) roadmap item into an explicitly reviewed set of independently shippable S/M children. This is a **human curation workflow**, not a pipeline step. It complements the automatic-pick scope gate (`pick.max-scope`) by giving an operator a deliberate way to make oversized work eligible — it does not let unattended cycles invent and publish a decomposition.

All roadmap reads and writes go through `npx pelaggio roadmap ...`. Never read tracker storage, `gh`, Linear, or `bd` directly. Never create branches, claim items, or run a pelaggio cycle.

## Phase 1 — Inspect

Require a non-empty `$ARGUMENTS` item ID. If missing, print usage and stop:

```
Usage: /decompose <item-id>
```

Fetch once:

```bash
npx pelaggio roadmap get <ID> --json
```

Validate the returned `RoadmapItemStatus` before proposing:

| Condition | Action |
|-----------|--------|
| `status === "unknown"` or fetch failed | Report which source was queried; stop. Zero mutation. |
| `status === "done"` | Report already done; stop. Zero mutation. |
| `status === "blocked"` | Warn that the item is blocked (`blockedReason` / deps), then continue — decomposition is often how blocked L work becomes shippable. |
| `status` is `open` or `in-progress` | Continue (operator may intentionally re-slice a claimed L). |
| Empty/missing `body` after a successful get | Stop: parent has no inspectable body. Do not invent scope from the title alone. |
| Not large scope (see below) | Stop: only L/XL parents may be decomposed. Recommend re-scoping or leaving as-is. |

### Large-scope detection

Match the same conventions as `FifoPolicy.isQuickScope` / flow-policy scope markers:

- **Body marker:** `/\bscope:\s*(l|xl)\b/i` (covers create-item's `Scope: L` prose)
- **Label:** any label matching `/^scope[\s:/-]*(l|xl)$/i`

If neither matches (missing scope, or only S/XS/M), refuse before proposing.

Use the returned `body` and `labels` as the authoritative spec.

### External dependency seeds

Parse `parent.deps` as external dependency seeds:

1. Split on commas
2. Trim each token
3. Drop empty, `—`, and `-` tokens

These are **real provider IDs**, not proposal keys. Preserve them on the earliest children that need them — do not attach every parent dep to every slice.

## Phase 2 — Propose

Draft **at least two** S/M vertical slices from the full item body. Prefer an existing Deliver / deliverables list when present.

If the honest decomposition is a single M (or one slice), **refuse** and recommend re-scoping the parent (or `/charter` for a replacement) instead of creating one child and closing the parent.

### Proposal keys

Identify each slice by a temporary proposal key: `A`, `B`, `C`, … — **uppercase letters only**. Never use provider-looking IDs for proposal keys (no issue numbers, no `ENG-…`). Sibling dependencies reference these keys until create returns real IDs.

### Required row fields

Every proposal row must state:

| Field | Constraint |
|-------|------------|
| **Key** | `A`, `B`, … (uppercase letter) |
| **Title** | Concise imperative title for `create-item` |
| **Scope** | `S` or `M` only — reject L/XL children |
| **Outcome** | Independently testable / valuable result |
| **Retained parent requirements** | Which parent requirements this slice covers |
| **External deps** | Real provider IDs (from parent seeds or other existing work) |
| **Sibling-key deps** | Other proposal keys this slice depends on |

### Validation (before preview)

- ≥2 rows
- Every child scope is S or M
- No cycles among sibling-key deps
- No unknown proposal keys in sibling deps
- Coverage summary accounts for the full parent outcome — "clean slices" must not silently drop parent work
- Each slice is independently valuable/testable

### Worked patterns (compact)

Use these as shape references only — do not claim unavailable issue details:

- **#191 → #198 / #199 / #200** — one L item split into three shippable S/M children with explicit dependency edges
- **#170–#178** — larger pattern: shippable slices, explicit dependency edges, no catch-all implementation item

### Proposal table shape

Present a table like:

```
| Key | Title | Scope | Outcome | External deps | Sibling deps |
|-----|-------|-------|---------|---------------|--------------|
| A   | …     | M     | …       | 42            | —            |
| B   | …     | S     | …       | —             | A            |
| C   | …     | M     | …       | 42            | A, B         |
```

Plus:

1. **Coverage summary** — how the union of rows covers the parent outcome (and any intentional deferrals, if any, called out explicitly — not silent drops).
2. **Dependency graph** — textual DAG of keys + external IDs.
3. **Topological creation order** as the exact `create-item` command lines that would run (proposal keys not yet substituted in deps until apply; show how substitution will work).

## Phase 3 — Approve

Print the complete proposal from Phase 2, then:

1. The **topological creation order** as exact shell lines:

   ```bash
   npx pelaggio roadmap create-item --title "..." --description "<slice outcome and acceptance details>" --scope <S|M> [--deps "<csv of real IDs>"] --json
   # … one line per child, in topo order; later deps will use IDs returned by earlier creates
   ```

2. The **parent-close** command that will run only after every child succeeds:

   ```bash
   npx pelaggio roadmap mark-done <parent-id> --note "Decomposed into: <ids>"
   ```

3. **Partial-failure / retry protocol** (state this before asking):

   - On any create failure: stop immediately; parent stays open; already-created children are kept.
   - Report created key→ID mappings, the failed key, and remaining uncreated keys.
   - **Retry is not auto-resumed.** A later `/decompose` on the same parent is a fresh proposal and would risk duplicate children. After partial failure the operator finishes remaining slices with `/charter` (deps wired to the already-created IDs from the reconciliation report) and closes the parent with `npx pelaggio roadmap mark-done <parent> --note "Decomposed into: …"` manually.

### Consent gate — conspicuous

**Stop and wait for the operator.**

- **Only the exact token `approve`** (case-insensitive, optionally surrounded by whitespace) starts mutations.
- Edits to the proposal → re-validate and re-preview (return to Phase 2/3). No mutations.
- `cancel` / anything else that is not exact `approve` → **zero mutation**.
- Silence and vague acknowledgments (`lgtm`, `looks good`, `yes`, `ok`, `ship it`) are **not** consent.

Do not run `create-item` or `mark-done` until this gate passes.

## Phase 4 — Apply / Report

Only after exact `approve`:

### Create children

Create in topological order:

```bash
npx pelaggio roadmap create-item \
  --title "..." \
  --scope <S|M> \
  [--deps "<csv of real provider IDs>"] \
  --json
```

Persist each child's slice outcome and acceptance details with `--description`; the concise title, scope, and dependencies alone are not a complete charter.

After each successful create:

1. Capture the JSON `id` immediately.
2. Record key→ID (e.g. `A → 198`).
3. Substitute returned IDs for proposal keys in later `--deps` lists before the next call.
4. Never recreate an already-created child during the same invocation.

### On create failure (fail closed)

Stop immediately. Do **not** attempt remaining creates. Do **not** close the parent. Report:

```
RECONCILIATION (partial failure — parent left OPEN)
  Created:  A → <id>, …
  Failed:   <key> — <error summary>
  Remaining (not attempted): <keys>

Manual retry protocol:
  1. Finish remaining slices with /charter, wiring --deps to the already-created IDs above.
  2. Close the parent manually:
     npx pelaggio roadmap mark-done <parent-id> --note "Decomposed into: <all child ids>"
  Do NOT re-run /decompose on this parent to "resume" — that would risk duplicate children.
```

### Close parent (only after all children exist)

```bash
npx pelaggio roadmap mark-done <parent-id> --note "Decomposed into: <id1>, <id2>, …"
```

Quote the note for the shell. This uses the existing adapter's close/completion representation as the portable "epic decomposed" state.

### On closure failure

Report separately without hiding successfully created children:

```
Children created successfully: A → <id>, B → <id>, …
Parent close FAILED — parent remains open.
Manual close:
  npx pelaggio roadmap mark-done <parent-id> --note "Decomposed into: <ids>"
```

### On full success

Print the final key→ID mapping and suggest:

```
/pick <first-ready-child>
```

where first-ready is the first child with no unmet sibling deps in the original proposal, else the first created.

## Hard rules

- Roadmap access only via `npx pelaggio roadmap ...` (never `pnpm pelaggio <subcommand>`, never raw `gh` / Linear / `bd`).
- No `Edit` of roadmap files or tracker state.
- No branches, claims, worktrees, or pipeline cycles.
- No L/XL children; no single-child "decomposition."
- No mutations before exact `approve`.
- No parent close before every planned child exists.
- Partial failure: fail closed, report reconciliation, operator finishes via `/charter` + manual `mark-done`.
