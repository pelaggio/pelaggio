# Resume an interrupted import

## Raw request — authored demonstration prompt
“Let me resume an interrupted import without starting over or duplicating the work.”
This is the contrasting scenario proposed in the marketing-site conversation. It is not a verbatim customer request.

## Existing repository context
The CLI already imports a JSON array, saves after each row, and prints committed ids. Restarting the existing importer appends duplicate rows. Records have stable ids. A test-selected store and deliberate pacing hook already exist. See AGENTS.md and src/import.mjs.

## Scenario-author decisions added at chartering
- Running the same CLI with the same source and store resumes the operation after process termination.
- Existing records survive; an identical previously imported record is not duplicated.
- Reusing an id with different content is an explicit conflict, not permission to overwrite it silently.
- Source JSON/record validity is checked before new rows are written. Single-writer local use remains the bound.
- Scope is M: persistent progress/identity, restart behavior, conflict handling, and process-level verification warrant a plan.
These are explicit demonstration design choices, not hidden model inferences from the short request.

## Outcome and acceptance
- AC-1: Kill a paced import after some durable progress, then restart the same command: all source records end up in the store exactly once and pre-existing records remain unchanged.
- AC-2: Repeating a completed import leaves the same stored content.
- AC-3: A reused id with different content fails visibly without overwriting the existing record. Report whether earlier non-conflicting rows can have been committed before the conflict.
- AC-4: Malformed source JSON or invalid record shapes fail before new records are written.
- AC-5: Existing browser listing, filtering, pagination, and tests remain functional.

## Left to the plan
Whether persisted records suffice as progress evidence or a separate checkpoint is needed; how source identity/conflicts work; the smallest restart-safe persistence approach; process-level tests. Explain the choices from actual code and add verify bindings to the criteria.

## Bounds and residuals
One writer, local files, process termination. Power-loss durability, concurrent writers, changed input ordering, and remote retries are unassessed unless independently exercised. No particular review finding or successful outcome is prescribed.
