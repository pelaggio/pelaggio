# Model delivery experiment

Two authored medium scenarios on the same Workbench application baseline: filtered
CSV export and resumable import. The marketing page presents both completed runs in the same format, with a scenario
toggle and links to the captured artifacts. Both final revisions passed all six
independent checks; see [the comparison](COMPARISON.md) for evidence and limits.

## Context provenance

1. **Conversation:** CSV export and interrupted import were proposed as demonstrations;
   the user selected running both. The short prompts in `scenarios/` are authored
   demonstration requests, not verbatim customer quotations.
2. **Repository context:** `seed/` establishes the app, data shape, filters, pagination,
   importer, and known gaps. Both executions receive identical application files.
3. **Chartering:** the supervising assistant applies Pelaggio's charter skill. Each
   scenario distinguishes repository facts from explicit scenario-author decisions,
   acceptance criteria, planning choices, and unassessed behavior. The pipeline starts
   at pick; it does not perform this chartering step itself.
4. **Planning and execution:** real pipeline sessions read the charter and source,
   produce a plan, review it with a different provider, implement, review code, and
   attempt local delivery. Their outputs are observations, not prescribed outcomes.
5. **Evaluation:** the operator runs `evaluate.mjs` from outside the candidate repository.
   It evaluates behavior independently of tests written by the implementation agent.
   Criteria are public; the evaluator implementation is not installed in the candidate.

Markdown roadmap descriptions are not persisted by the adapter. The full operative
charter therefore lives at `docs/charter.md`, referenced by both AGENTS.md and the
adapter-created roadmap title. Keep that limitation visible when discussing intake.

## Reproduce

Prerequisites: installed workspace dependencies, Node, pnpm, Python 3 (standard-library
CSV reader), Chrome, authenticated Codex and Grok CLIs, and the supervised execution setting described below. Model runs consume provider capacity. Model versions follow local driver
configuration; they are not pinned by this experiment and output is not deterministic.

From the Pelaggio checkout:

```sh
node experiments/model-delivery/prepare.mjs > /tmp/workbench-execution.json
```

The output names independent repositories, their local bare remotes, medium item IDs,
and a harness checkout pinned to this checkout's HEAD. The normal dependency install
uses the local pnpm cache. It does not clone uncommitted harness changes. The baseline
application and charter documents are committed before item creation. Initial config
uses Grok coordination, Codex authoring, and Grok plan/code review, with the ordinary shakedown flow.
There is no PR review gate or multi-reviewer authoring panel in these local runs.

For each named repository, first establish the negative control from the original app:

```sh
node experiments/model-delivery/evaluate.mjs csv <csv-repo> <output-directory>/csv-baseline.json
node experiments/model-delivery/evaluate.mjs import <import-repo> <output-directory>/import-baseline.json
```

These should exit 1: the baseline lacks CSV export and duplicates interrupted imports.
The results distinguish the already-working behavior from the missing behavior.

Then, from each repository, run the pinned CLI given in the preparation output:

```sh
node <harness>/packages/pelaggio/bin/pelaggio.js run --item ITEM-1 --cycles 1 --profile standard
```

Capture stdout/stderr in a new log for each attempt outside the repo. Direct-push is
explicitly configured, with origin pointing only at a local bare repository. No GitHub
issue, PR, status, or hosted deployment is part of this experiment. The default cycle
budget and per-step limits apply; subscription-provider accounting may be incomplete.
Rate limits park with auto-resume disabled. Follow the harness's printed resume command
instead of retrying blindly. Do not hand-edit a live claimed worktree.

After the process exits, run the same independent evaluator against the delivered
repository, or the preserved claim worktree if delivery failed. Keep the candidate SHA
and clean/dirty disclosure with the results. Use a new output filename. For a preserved
worktree, this measures the candidate's behavior and does not establish delivery.

Do not publish raw execution logs automatically. Inspect them for local paths and other
incidental data. Public receipts should select attributable artifacts and retain failures,
operator interventions, missing evidence, and the actual shipping mode.

## Evaluation bounds

CSV checks exercise the actual HTTP response with Python's CSV reader and the browser
download after pagination/filter changes. Import checks kill a paced process midway,
restart it, repeat a completed import, and exercise conflicts and malformed inputs.
The pacing hook is declared demonstration infrastructure. SIGKILL is a process-restart
probe, not a power-loss durability proof. Both run candidate tests and syntax checks.

The evaluator's SHA-256, candidate revision, tracked/untracked status, case results,
and time are recorded. Digests identify bytes; they do not attest authorship or establish
that the cases are sufficient. A successful run is not a reliability percentage.

This is a rerunnable demonstration scaffold. It is not yet a scheduled benchmark or
production delivery-envelope producer. The richer handoff format remains #782's work.

## Initial experiment, 2026-09-05

Runtime records live under `/tmp/pelaggio-model-execution-OWQfIs`; preparation metadata
is `execution.json`. All failed attempts are retained there. Setup observations:

- Linking the harness package's entire node_modules directory was rejected by the
  dependency guard. Preparation now uses a normal frozen offline dependency install.
- A single-provider configuration failed preflight because review needs a non-author
  driver. Preparation now assigns Grok review separately from Codex authoring.
- Codex pick sessions refused prohibited coordination mutations. Coordination was then
  attempted with Claude, matching the main repository's arrangement at the time.
- Claude subscription access was disabled by the account's organization. Both attempts
  exited before implementation. The operator then claimed each item with the normal
  `npx pelaggio roadmap claim ITEM-1` command and resumed from `plan`. This intervention
  is part of the run history, not an unattended intake success.
- Preflight dry runs emit synthetic `RETHINK` outcomes; they are not model judgments.
  Distinguish these entries from the numbered real attempt logs.

The baseline acceptance records each have four failing feature checks and two passing
checks for already-working behavior. In particular, the restart probe reproduces
actual duplicates after killing the baseline importer. These are negative controls,
not agent implementation results.

Both initial model plans were committed; Grok plan review then refused to start because
kernel Landlock is unavailable. No implementation or shipping had occurred at that point. See
[the comparison](COMPARISON.md) and `captures/2026-09-05/manifest.json` for those initial
outcomes. Bubblewrap availability alone was checked, but no custom containment path or
unsandboxed fallback was introduced.

Preparation initializes `execution.json` with `operatorInterventions: []`. Record any
operator changes, manual claims, or resumes in that execution's list as they occur.
Capture requires this field and copies only those entries. For older runtime metadata,
reconstruct the list from that run's records before capturing; use `[]` only when no
interventions occurred. Existing frozen captures retain their original history.

Once an execution has exited, capture selected evidence into a fresh destination:

```sh
node experiments/model-delivery/capture.mjs <runtime-root>/execution.json <new-capture-directory>
```

The initial capture helper expects the two medium plans and harness decision logs to
exist. It intentionally refuses overwriting artifact files. It is scoped to these two
scenarios, not a general delivery-packet implementation.

## Authorized continuation

The user subsequently authorized Codex/Grok-only execution and abstaining from
environmental constraints for this supervised demonstration. Preparation now sets
`providers.grok.allow-unsandboxed-fallback: true`, with Grok coordination and review,
and Codex plan/implementation. This is an explicit demo setting, not a product default
or a claim of containment. Both preserved runs resumed at `shakedown-plan`; the earlier
failure capture remains intact. Both runs subsequently completed plan review, implementation, code review, and local
delivery. The final independent evaluations passed all six cases for each scenario.
`captures/2026-09-05-completed/` preserves those revisions, checks, original charters,
updated charters, plans, changes, and the attempt history. The local bare remotes were
checked against the delivered revisions; no hosted deployment was performed.
