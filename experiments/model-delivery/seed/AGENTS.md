# Workbench demo

A deliberately small, local-only work-list app. Read `docs/charter.md` for the current task and context provenance before planning. It is the full operative specification; the markdown roadmap row links to it because the adapter does not preserve descriptions.

- Node ESM, built-in modules, no application dependencies. Start with `npm start`; verify with `npm test` and `npm run check`.
- `src/store.mjs`: JSON-file persistence, fixtures, shared status filtering and ten-row pagination. Missing store starts with the fixture. `DEMO_STORE` selects a test store.
- `src/server.mjs`: loopback HTTP server. `PORT=0` allocates a free port, printed as `listening <port>`. Keep this startup contract for independent tests.
- `src/import.mjs <file>`: imports a JSON array into the store. Prints `committed <id>` after each durable row. `DEMO_IMPORT_DELAY_MS` is explicit demonstration pacing, used to reproduce interruptions. Keep this CLI contract.
- `public/index.html`: vanilla browser UI. Preserve safe DOM text rendering.
- Each record has unique string `id`, string `title`, and status `open` or `done`. The existing importer does not yet enforce uniqueness: that is a known baseline gap, not permission to change it in the CSV scenario.
- Local demonstration, one writer per store; no cloud storage, authentication, concurrent importers, or spreadsheet formula policy is specified. Report those bounds rather than imply coverage.
- Acceptance criteria in the charter are public. An operator runs additional black-box checks against the delivered commit from outside this repo.
- Retain genuine problems, decisions, and limitations in the delivery summary. Do not fabricate review disagreement or claim checks you did not execute.
