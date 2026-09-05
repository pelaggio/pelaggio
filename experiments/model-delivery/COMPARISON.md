# CSV export and interrupted import: execution comparison

Both Codex/Grok runs completed plan review, implementation, code review, and delivery
into their local bare remotes. Each delivered revision passed all six independent
acceptance checks. The baseline for each scenario failed four feature checks and
passed two checks for existing behavior.

## What context was added where

| Layer | CSV | Interrupted import |
| --- | --- | --- |
| Authored short request | Export the filtered list | Resume without starting over or duplicating work |
| Existing repo facts | Shared status filter; ten-row pages; 23 open fixture rows | Per-record persistence; stable ids; restart currently duplicates rows |
| Scenario author at chartering | All matching pages; fixed columns; preserve text and order | Restart the same command; preserve existing records; surface content conflicts |
| Model's actual plan | Reuse the exact filter semantics; use a native download anchor; update its URL before awaiting a list fetch | Use stored records as progress evidence; compare complete records; preflight conflicts before any new writes |
| Planned evidence | HTTP exports, CSV round-trip, UI behavior, store non-mutation | SIGKILL and restart, idempotence, conflicts, invalid input, preserved listing |
| Observed evidence | Four baseline feature failures; all six final checks pass, including real browser downloads | Four baseline feature failures; all six final checks pass, including SIGKILL and restart |

The extra context is not all autonomous discovery. Both full charters were authored by
the supervising assistant applying the charter skill, with demonstration choices labeled.
The planning sessions then read actual repository contracts and recorded their own
implementation decisions. No short-prompt-only control was run, so this experiment does
not measure how much chartering improves delivery success.

## What the page shows

CSV is the default example: the visible list has ten rows per page while the export
contains all 23 matches. Import uses the same presentation and shows a different
planning decision: reuse persisted records as progress evidence, with conflict checks
before new writes. The toggle keeps request, charter, plan, checks, and run result in
the same positions for both.

The original authored charter is preserved separately from the charter in the delivered
repository. This lets readers inspect changes made during execution. Plan self-scores
are not promoted into assurance; the page links full plans and independent check results.

## Evidence and limits

- Final capture: `captures/2026-09-05-completed/manifest.json`, with artifact digests,
  original and final charters, plans, decision logs, checks, code diffs, and attempt history.
- CSV delivered revision: `a48777f8ba7c599f83465c2e8af2bec4060105b8`.
- Import delivered revision: `b90f5d0f8420e819e6cda4be58ef0389659379bf`.
- Earlier stopped runs remain in `captures/2026-09-05/`; full runtime logs remain at
  `/tmp/pelaggio-model-execution-OWQfIs`.

Both final revisions were clean and matched their local origin's main branch. These
were local deliveries, not GitHub PRs or hosted deployments. The user authorized Grok's
unsandboxed fallback for this supervised demo after Landlock prevented review. Earlier
Codex coordination refusal and Claude account failure remain in the history. This was
not an unattended run from intake, a containment demonstration, or a reliability study.

The independent CSV evaluator exercises HTTP output and real browser downloads. The
import evaluator kills a paced process, restarts it, repeats an import, and checks
conflicting and invalid inputs. Its boundary is one writer and process interruption;
it does not establish power-loss durability. Passing these cases establishes the
observed behavior at the captured revisions, not completeness of the checks.
