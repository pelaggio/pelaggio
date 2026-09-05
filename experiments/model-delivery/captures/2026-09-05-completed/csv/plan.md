# ITEM-1: Export the filtered work list

## Scope and provenance

Deliver the complete M-sized vertical slice: CSV encoding, `GET /api/items.csv`, a visible browser download control, and verification of AC-1 through AC-4 in `docs/charter.md`. No decomposition is needed for this small, coupled feature.

The charter is the operative specification, including its scenario-author decisions: export all matching pages, preserve source order and text, use columns `id,title,status`, and retain the header for empty results. The request is an authored demonstration, not a verbatim customer request.

Keep persistence, importer behavior (including the known uniqueness-validation gap), list filtering, pagination, safe DOM rendering, and CLI startup contracts unchanged. No dependencies, authentication, concurrent writers, giant-dataset support, or spreadsheet formula policy. UTF-8 interchange is the target; application-specific spreadsheet behavior remains unassessed.

Work only in this worktree. `.pelaggio.yml` selects markdown; the sandbox prohibits the adapter CLI, so use the documented branch-slug convention, `docs/plans/item-1.md` for `feat/item-1`. Adapter resolution was not executed. The harness owns commits and publication.

## Verified source contracts

- `src/store.mjs`: `readItems(path)` reads JSON or returns a cloned fixture for a missing file; `matchingItems(items, status = '')` preserves order and matches exact status, with empty status selecting everything; `pageOf(items, page = 1)` slices ten rows. `writeItems(path, items)` is the persistence writer and is unnecessary for export.
- `src/server.mjs`: the `/api/items` branch filters before pagination, returning `{items, total, page, pageSize: 10}`. It reads `DEMO_STORE`, binds to loopback, and supports `PORT=0` with `listening <port>`. Reuse its query normalization, `url.searchParams.get('status') || ''`.
- `public/index.html`: inline module `render()` fetches the current status and page; status changes reset page to one, and Previous/Next invoke `render()`. Records render through `li.textContent`.
- `test/store.test.mjs`: built-in `node:test` and strict assertions cover fixture filtering and pagination. No CSV, HTTP, or browser test infrastructure exists.
- `package.json`: `npm test` discovers `test/*.test.mjs`; `npm run check` explicitly checks the three existing source modules. No application dependencies exist. No related design or implementation plans were found; optional `_project-context.md` is absent.

## Implementation

1. **Add `src/csv.mjs`.** Export the new pure function `itemsToCsv(items)` with JSDoc for an array of records `{id: string, title: string, status: 'open' | 'done'}` and a string return value. Emit the literal header `id,title,status`, followed by ordered records and CRLF record separators, including a final separator. Quote every data field and double embedded double quotes; retain embedded CR, LF, commas, empty strings, and Unicode verbatim. Emit UTF-8 without a BOM. Fixed columns avoid leaking extra stored properties. This small encoder is easier to inspect and test than adding a library; buffering fits the explicitly small local dataset.
2. **Extend `src/server.mjs`.** Add the exact `/api/items.csv` route. Read the store once, call the existing `matchingItems` with the same normalization as `/api/items`, encode its complete result, and return `Content-Type: text/csv; charset=utf-8` plus `Content-Disposition: attachment; filename="items.csv"`. Do not call `pageOf` or any writer. Ignore `page` parameters for this route. Leave the JSON endpoint and server startup contract intact.
3. **Update `public/index.html`.** Add an accessible, visible anchor labeled `Export CSV`, with a download URL and optional `download="items.csv"` hint. At the start of `render()`, before its first await, set its `href` to `/api/items.csv?status=${encodeURIComponent(status.value)}`. Thus initial rendering, status changes, and page navigation keep the URL current without including a page. Use the native link and attachment response for downloading; no fetched blob or duplicate list state is needed. Preserve text-only record rendering.
4. **Add the tests below and extend `package.json`'s check command** to include `src/csv.mjs`. Add verification bindings beside the existing acceptance criteria in `docs/charter.md` during implementation without rewriting their meaning or provenance. Leave the roadmap row untouched.

DECISION: CSV status-query semantics | chose: preserve the list endpoint's exact-match semantics: missing or empty selects all, unknown values match nothing and produce a header-only 200 response | alternatives: reject unknown statuses with 400, which would introduce a different filtering contract

## Test strategy and acceptance bindings

Use Node built-ins and real temporary stores. New child-process HTTP tests must spawn `src/server.mjs` with `DEMO_STORE` and `PORT=0`, wait for its actual startup line rather than sleep, report premature exit, bound waits, and always terminate children and remove temporary files.

| Acceptance | Planned verification |
| --- | --- |
| AC-1: all filtered rows regardless of page | `node --test test/export.test.mjs`: request open exports with absent page and pages 1, 2, and 3; assert identical CSV and exactly the ordered 23 open fixture IDs once. Check done gives seven rows and absent/empty status gives all 30. |
| AC-2: CSV interchange and download metadata | `node --test test/csv.test.mjs test/export.test.mjs`: exact wire assertions for header and escaping; independent test-only CSV decoding for full record equality, including quotes, commas, LF, CRLF, lone CR, Unicode, and empty strings. Exercise special characters in IDs as well as titles. Check response status, CSV charset, attachment filename, empty-store header, and unknown/malformed-as-status values such as `OPEN` and `open,done`. |
| AC-3: current browser selection | `node --test test/ui.test.mjs`: execute the actual served inline script with `node:vm` and a minimal DOM/fetch test double; assert the visible export link's label and URL initially, after selecting open/done/all, and after Next/Previous. Check the URL changes synchronously even while a list fetch is pending. Fetch the generated URL against the real server and verify the expected rows and attachment headers. |
| AC-4: regressions and read-only export | `node --test test/store.test.mjs test/export.test.mjs test/ui.test.mjs`: assert JSON list totals and page contents remain 10/10/3 for open; done remains seven. Compare populated store bytes before/after repeated exports, including after restarting the server against the same store. Verify exporting a missing store returns fixtures without creating the store file. Retain existing store tests and safe `textContent` UI assertions. |

Keep the CSV decoder confined to tests and independent of the encoder; never split CSV on newlines to count records. Use exact expected serialized samples alongside round-trip checks so a shared formatting assumption cannot hide mistakes.

The DOM double exercises actual UI logic but does not prove browser download-manager behavior. Supplement with a real browser smoke check where available: start with `npm start`, select open, navigate to page 2 or 3, activate Export CSV, and inspect the downloaded file for 23 open records; repeat for done and all. Record whether this was executed and any environment limitation; do not claim a real browser check from simulated DOM tests.

Final implementation checks: `npm test` and `npm run check`. Baseline execution during planning passed the existing one-test suite and syntax checks; feature tests have not yet been implemented or run.

## Self-review

Scores use 1–5, with 5 meaning no identified planning concern:

| Dimension | Score | Assessment |
| --- | --- | --- |
| Correct | 5 | Full filtered collection, stable order/text, empty header, current UI selection, and read-only persistence have explicit implementation and checks. Status-query fork is recorded above. |
| Well-tested | 4 | Unit, real HTTP/file, restart, and actual-script UI tests cover acceptance; native browser download verification remains conditional on browser availability. |
| Well-factored | 5 | One pure encoder, existing shared filter, thin HTTP and native browser adapters; no store refactor. |
| Well-typed | 5 | Explicit JSDoc record/string contract and existing URL normalization; unknown query values remain safe exact-match filters. No new import boundary or out-of-scope importer validation. |
| Concise | 5 | Single M slice, no dependencies or generic export framework; test scaffolding serves observable cross-layer behavior. |
| Idioms | Deferred | Independent `/shakedown` review owns this assessment. |

Self-review revisions: require the download URL update before awaiting list fetches, explicitly preserve unknown-status behavior, add missing-store non-creation verification, and distinguish DOM simulation from native download verification. These address stale selection, contract drift, accidental writes, and overstated coverage. No blocking planning concerns remain.

Run `/shakedown` for an independent review, or say **go** to start building. When done, run `/shakedown` again to review the code.
