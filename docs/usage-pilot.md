# Local usage pilot

The pilot reports provider usage separately from the UTF-8 size of the text supplied by the
harness. It does not estimate tokens from bytes, attribute cached tokens to documents, export
telemetry, or change execution budgets, quota strategy, gates, permissions, or recovery.

## Read a report

```sh
# Dogfood pipeline step observations
npx pelaggio stats --usage
npx pelaggio stats --usage --json

# Consumer local-autopilot run, including resumed execution
npx pelaggio show <runId> --usage
npx pelaggio show <runId> --usage --json
```

These are read-only, on-demand projections. Normal `stats`, `show`, and snapshot JSON retain
their existing shapes. Usage JSON has its own `schemaVersion: 1` and `kind: pelaggio.usage-report`. The #777 snapshot schema is unchanged. Its optional `metrics.usage`
input/output totals are populated only when all recorded adapter observations report that
field; partial totals belong in the diagnostic report, which carries coverage.

Each numeric total has `value`, `observed`, and `total`: `null` means unavailable, while a
reported zero remains zero. A non-null value with incomplete coverage is a measured subtotal,
not the complete run cost. Coverage counts persisted harness observations, not hidden model
calls. Reports retain attempt rows and group by provider/model/step. Consumer `attempt` follows
start/resume boundaries; dogfood attempt numbers are step-local. Legacy cycle logs without a
run ID use a cycle-local display identity rather than pretending to identify a whole run.

Cache-read fraction uses only observations with both input and cached-read counts. Its own
coverage can therefore differ from input coverage. Cache reads/writes are subsets of total
input, and reasoning is a subset of total output: do not add them to totals. Prompt bytes
measure supplied text once per invocation. `promptBoundary: dispatcher-input` identifies
pipeline text before adapters append harness system/sandbox instructions; `adapter-assembled`
identifies the consumer Grok/Codex prompt including its harness instructions. Reports split bytes
by boundary: compare growth within the same boundary, not between these two surfaces. Old
measurements without a boundary are `unrecorded`, never inferred. Neither boundary includes
provider-managed context, tool definitions, retained history, or subsequent tool results.
These byte counts are not billed tokens.

## Accounting evidence and limits

| Source | Diagnostic interpretation |
| --- | --- |
| Claude SDK terminal usage | Input is the sum of uncached input, cache reads, and cache writes, only when all three are present. Output is the reported output count. |
| Codex CLI single terminal usage | Input includes cached input; output includes reasoning. Neither subset is added again. Multiple terminal events in one collected execution are unverified until their cumulative/delta semantics are established. |
| Grok / OpenCode | Numeric raw counters are retained with `basis: unverified`; no overlap semantics are guessed. |
| Consumer Grok/Codex preview adapters | Supplied prompt bytes are measured. The current text-only adapters do not expose native usage, so tokens remain unavailable. No prose scraping or additional provider call is added. |
| Legacy step logs | Coverage is unavailable in this report; old zero-defaulted counters are not retroactively claimed to be verified measurements. The ordinary stats view remains available. |

Sources for normalization: [Claude cache accounting](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[Codex non-interactive usage](https://learn.chatgpt.com/docs/non-interactive-mode), and the
captured `codex-events-success.jsonl` fixture. The report's inclusive totals align with
[OpenTelemetry GenAI usage semantics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md).
There is no OTel dependency or exporter. Unknown/future versions are unavailable, not zero.

The existing adapter `tokens` and `cost` fields remain unchanged because execution budgets
consume them. This report does not validate those historical cost estimates or silently repair
them. In particular, legacy Codex cached/reasoning addition and the legacy stats cache denominator
remain accounting audit targets. Changing those operational inputs requires a separately tested
budget-impact change. This diagnostic report uses the corrected, separately versioned meanings.

Review-loop leaf attempt records also carry the diagnostic measurement when available. Their
parent/pass cost rollups are not additional usage. `stats --usage` currently reads pipeline cycle
steps only; it does not silently combine review records or account-wide provider history.

## Storage and trust

Only an allowlist of finite nonnegative integer counters, a basis tag, and an observation ID is
retained. No prompts, tool bodies, task text, file hashes, or credentials are added to diagnostics.
Measurements ride existing step records, review attempt records, and consumer call acknowledgements;
there is no per-token event, extra journal append, background process, or network export.
Consumer recovery ignores diagnostic fields. Malformed diagnostic values become unavailable.
Duplicate observations are excluded from totals; conflicting records lose their measurement.
Regenerating a report does not write or re-emit records.

## Run the bounded pilot

Use a small named cohort of ordinary dogfood and consumer runs. Keep existing outcomes,
verification/repair counts, and work scope alongside usage. Compare within provider/model and
execution path; do not generalize dogfood documentation exposure to consumer repositories.

First establish reporting coverage. Use ccusage JSON as an independent reconciliation of a pinned,
supported session sample, never as an extra total to add or a production dependency. Investigate
counter differences before claiming savings. No live provider runs are required by the tests.

If usage and repeat attempts identify a useful optimization, stop instrumenting and test that
change. If a specific source remains unresolved, add a targeted measurement at an already-visible
boundary. Do not create automatic alerts, percentage thresholds, or follow-up items. An acceptable
pilot result is that no further attribution is justified.
