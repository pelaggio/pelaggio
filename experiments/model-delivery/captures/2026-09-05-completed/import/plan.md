# ITEM-1: Resume interrupted imports

Implement the complete M-sized charter in `docs/charter.md`: restarting `node src/import.mjs <file>` against the same store completes the import without duplicates, preserves existing records, and reports conflicts. Validation, persistence, and restart verification form one coherent slice; nothing is deferred.

The supplied roadmap context identifies ITEM-1 and declares no dependencies. `.pelaggio.yml` selects markdown. This file uses the documented `docs/plans/{branch-slug}.md` convention for `feat/item-1`; adapter resolution is unverified because the harness explicitly prohibits roadmap CLI calls. All work stays in this worktree; the harness owns commits and publication.

## Verified baseline and scope

- `src/import.mjs` parses the source, then calls `readItems(path)`, appends one row, and calls `writeItems(path, items)` on every iteration. It logs `committed <id>` after writing and applies `DEMO_IMPORT_DELAY_MS`. There is no validation or duplicate detection.
- `src/store.mjs` exports `readItems(path)` (JSON data, or a cloned 30-row fixture on ENOENT), `writeItems(path, items)` (create parent directory, write `${path}.tmp`, rename over the destination), `matchingItems(items, status = '')`, and `pageOf(items, page = 1)`. Reuse these signatures; retain the on-disk JSON array and current replacement operation.
- `src/server.mjs` uses those shared filtering/pagination helpers, serves `/api/items`, and binds to loopback with `PORT=0` and `listening <port>` support. `public/index.html` renders records through `textContent`. Neither needs production changes.
- `test/store.test.mjs` uses `node:test` and strict assertions, but only checks fixture filtering and pagination. There is no existing import or process-test implementation to reuse.
- `package.json` already discovers `test/*.test.mjs`; its check script covers all three production modules. No dependency or script changes are needed. No related design/plan documents are referenced; the optional project-context file is absent.

## Decisions and implementation

DECISION: restart identity and progress | chose: persisted records indexed by stable id, with complete record equality | alternatives: source hash and separate checkpoint journal

The store itself is the progress ledger. Source path, whitespace, and object key ordering are not identity. Equal records already present count as completed work. Preserve additional JSON fields and compare complete records structurally, including those fields, so changed content cannot disappear silently. Do not introduce trimming, coercion, nonempty-string requirements, or a closed schema absent from the charter.

DECISION: conflict timing | chose: preflight all source and store conflicts before writing | alternatives: stop at the first conflict during incremental commits

A conflict therefore commits no new rows in that invocation, including non-conflicting rows earlier in the source. Earlier invocations' progress remains. This is stronger than the charter requires and cheap because the current source and store already fit in memory.

DECISION: pre-existing duplicate ids | chose: fail visibly before writes and preserve the store for manual repair | alternatives: collapse equal duplicates or migrate existing data

Do not silently repair data produced by the old importer. Identical repeated ids within a new source are accepted once; different records sharing an id are conflicts.

1. In `src/import.mjs`, add small local helpers for validating arrays/records and building the pending rows. Document the record shape with JSDoc, including `status: 'open' | 'done'`; treat parsed JSON as untrusted until validated. Require non-null, non-array objects with string `id`, string `title`, and an allowed status. Accept empty arrays.
2. Parse and validate the entire source before mutation. Read and validate the store through `readItems(path)`, retaining the missing-store fixture behavior. Reject malformed stores and duplicate stored ids without overwriting them.
3. Build a `Map` keyed by id from the store, then scan the source in order. Use Node's built-in structural comparison (`isDeepStrictEqual` from `node:util`) rather than serialized-text equality. Skip equal records; report unequal records with the conflicting id and source position. Add unseen records to the map and a pending list, detecting conflicts inside the source before any writes.
4. Append pending rows in source order to the in-memory store. Call `writeItems(path, items)` separately for each row. Only after it succeeds, print exactly `committed <id>` and apply the existing pacing hook. Equal rows and empty imports perform no writes or pacing and emit no commit acknowledgements. Retain CLI arguments, default store path, and environment controls.
5. Exit nonzero with a useful stderr message for usage, parse, validation, conflict, read, and write failures. Never print a commit acknowledgement for a failed write. Errors identify source/store and row or id where relevant without dumping record content.

The existing same-directory temporary-file rename is sufficient for the specified single-writer process-termination model. A kill before rename leaves the prior store; a kill after rename leaves the committed row, even if its acknowledgement was never printed. Restart reads the authoritative store and ignores any stale `.tmp`; the next write replaces that scratch file. No checkpoint can drift from the records. Retain `writeItems` unchanged unless implementation exposes a concrete defect within this bound.

## Files and verification bindings

Change `src/import.mjs`; add `test/import.test.mjs` and `test/server.test.mjs`. Preserve existing tests and production store/server/UI behavior. Use built-in modules, real temporary directories, and child processes launched with `process.execPath`. Each test controls `DEMO_STORE`; teardown terminates and reaps children and removes its directory. Read readiness/commit lines with buffered stdout handling and bounded deadlines, not fixed sleeps.

| Criterion | Observable verification |
| --- | --- |
| AC-1 | Seed unrelated records, launch a sufficiently long paced import, wait for several `committed` lines, send SIGKILL, and await exit. Read the store and assert a valid partial result and unchanged seed. Restart the same source/store command in a fresh process; assert every source id exactly once, preserved seed/order/content, and commit output only for records missing at restart. Do not assume the last observed line is the last persisted row. Repeat with a planted stale `.tmp` file. |
| AC-2 | Run the completed import again; assert success, byte-for-byte unchanged store, and no commit lines. Cover identical source duplicates, equal pre-existing records, reordered object keys, additional JSON fields, empty source with existing store, and empty source with missing store (no store created). Exercise a nonempty import into a missing nested store and verify fixture preservation. |
| AC-3 | Test same id with changed title, status, or additional field; include a new row before the conflict. Assert nonzero exit, identifiable conflict, no commit lines, and unchanged store bytes. Cover conflicts within the source and pre-existing duplicate store ids. |
| AC-4 | Test malformed JSON, non-array roots, null/array rows, missing or incorrectly typed fields, and invalid status, including a valid prefix before an invalid row. Assert no mutation or newly created store. Test malformed existing store data and a deterministic filesystem write failure; preserve the prior store and report no failed-row commit. |
| AC-5 | Start the real server with `PORT=0` against imported data and consume `listening <port>`. Request `/`, then `/api/items` with all/open/done filters and first/later/out-of-range pages. Assert exact items, totals, page size, ordering, and unchanged fixture entries. Retain the existing helper test and inspect that browser rendering still uses `textContent`. |

Run `npm test` and `npm run check` after implementation. The current baseline passes both (one existing test); the new acceptance tests have not yet been written or executed. HTTP tests plus unchanged browser source do not establish an automated interactive-browser result; report that limit honestly.

## Self-review

Scores assess plan readiness on a 1–5 scale, not completed implementation: Correct 5; Well-typed 5; Well-factored 5; Well-tested 5; Concise 5. No remaining plan blockers. Idioms is deferred to independent `/shakedown` review.

The review tightened full-source conflict preflight, equality for additional fields, refusal to repair legacy duplicates, and the kill-test assertion so it does not mistake stdout for authoritative progress. It also made missing-store/empty-source behavior and stale temporary-file handling explicit. The decision markers above capture the reviewer-vetoable choices.

Coverage remains local, single writer, JSON files, and process termination. Power-loss durability (no fsync guarantee), concurrent writers/importers, changed source ordering, remote retries, cloud storage, authentication, and spreadsheet formula policy are unassessed or out of scope. No UI redesign, store migration, checkpoint infrastructure, or performance rewrite is included.
