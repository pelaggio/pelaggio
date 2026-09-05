# Export the filtered work list

## Raw request — authored demonstration prompt
“Let me export the filtered work list as CSV.”
This is a scenario proposed in the marketing-site conversation and selected for a real execution. It is not a verbatim customer request.

## Existing repository context
The app already filters by status, paginates at ten rows, and stores id/title/status records. The fixture has 23 open and seven done items. One title includes quotes, a comma, and a newline. See AGENTS.md and src/store.mjs.

## Scenario-author decisions added at chartering
- “Filtered list” means all matching records, including later pages. The visible page is not the export boundary.
- Include columns id,title,status, in that order. Preserve source order and text, including punctuation and Unicode.
- Empty matches produce a header-only CSV.
- Scope is M: a server export path, browser download interaction, and cross-layer verification warrant a plan.
These are explicit demonstration design choices, not choices attributed to the model or silently inferred from the short request.

## Outcome and acceptance
- AC-1: GET /api/items.csv?status=open downloads all 23 matching fixture rows once, without done rows; selecting another page has no effect on the export. Verify: `node --test test/export.test.mjs`
- AC-2: CSV text round-trips commas, quotes, line breaks, and Unicode. Response declares CSV and a download filename. Empty matches retain the header. Verify: `node --test test/csv.test.mjs test/export.test.mjs`
- AC-3: A visible “Export CSV” control downloads using the currently selected status from the browser, including after changing pages. Verify: `node --test test/ui.test.mjs`
- AC-4: Existing filtering, pagination, and tests remain functional; export does not mutate the store. Verify: `node --test test/store.test.mjs test/export.test.mjs test/ui.test.mjs`

## Left to the plan
How to share filtering between endpoints, structure CSV encoding, wire the browser action, and organize tests. Explain the choices with actual source references. Add verify bindings to the acceptance criteria using the resulting test commands.

## Bounds and residuals
No authentication, multi-user permissions, giant datasets, or spreadsheet formula-execution guarantee. UTF-8 CSV interchange is the target; application-specific spreadsheet treatment is unassessed. No particular review finding or successful outcome is prescribed.
