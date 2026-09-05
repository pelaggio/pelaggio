# PR review contents and operator clarification

The local PR-review runner can retain an inspectable assessment and carry an operator's
answer through findings-driven revision and cold reassessment. This implements #782's
PR path; CI-only checkout transport and local-autopilot continuation are not implemented.
An answer changes task context. It does not grant permission to proceed, waive policy,
clear a retained blocker, post a status, adjudicate, or merge.

## Read and answer

Run the existing authorized local review with `npx pelaggio pr-review --pr <pr>`.
That command still posts the review comment and required status. With a resolvable
roadmap item, its assessment records the original request, current requirements,
reviewed SHA, actual reviewer identities, qualified findings, verification rationales,
material questions and applicable answers. The local sweep uses the same path.

Records live at `MAIN_REPO/.dev/pr-review-assessments/`, through the existing protected
register and atomic-writer machinery. Every assessment/answer/check gets a separate
file; superseded generations remain. Worktree cleanup does not delete this directory.
This is local durability, not backup or hosted custody. #703/#491 still own broader
lifetimes, attempt joins, metrics and retention; this item does not migrate their stores.

Inspect a captured record without running a provider or changing a PR:

```bash
npx pelaggio review-assessment show --file <assessment-record.json>
npx pelaggio review-assessment sarif --file <assessment-record.json>
```

Supply the exact assessment ID, question ID and full reviewed SHA shown in that record:

```bash
npx pelaggio review-assessment answer --pr <pr> --item <item> --sha <full-sha> --assessment <assessment-id> --question <question-id> --by <actor> --response "<work-item clarification>"
```

Replace an answer with the same command plus `--supersedes <answer-id>`. To resolve
concurrent conflicting answers, name every active answer as a comma-separated list.
Unknown questions, mismatched task/revision bindings and incomplete supersession are
refused without changing existing records. The original response and request remain.
`--by` is operator-supplied attribution, not authenticated or cryptographic identity.
The command is for the attended host operator; CI and single-shot pipeline invocation
are refused. Claude's existing Bash/register hook also refuses ordinary spellings of
these operator mutation commands, including direct bin/module entry points. This is
not a shell-program proof: dynamically constructed commands, arbitrary scripts and
uncontained host processes remain the documented #419 residual. Ordinary PR comments
are never admitted as answers.

Run the existing authorized `npx pelaggio revise --pr <pr>` path. The findings-driven
implement step loads applicable clarification once before its worker/retries. The next
local review supplies original/current requirements and admitted answers to independent
discovery and verification seats. Discovery gets no prior verdicts or Judge brief.
Prior review prose quoted in the revision findings is explicitly historical; it cannot
become a new operator answer. The usual revision lease, checks, parking and review gate
remain responsible for their existing effects.

## Applicability and authority limits

Answers bind the PR, item, task digest, stable question, source assessment, revision and
git objects at the question's declared relevant paths. Unchanged paths retain context
across unrelated edits. Changed requirements or relevant objects make an answer stale;
review the new revision and explicitly rebind with a replacement answer. Pathless
questions expire on any revision change. Unavailable git objects are distinct from an
absent path. This checks declared context, not semantic completeness of the path list.

Unanswered questions remain in subsequent records even when a reviewer omits them.
Superseded, stale, conflicting and unavailable answers remain inspectable, but do not
enter the admitted answer list. An empty residual set is not evidence of full coverage.
If an item has assessments for multiple PRs, findings-driven implementation withholds
clarification rather than selecting an ambiguous PR. A missing original task is reported
as unavailable; legacy review policy still runs.

The existing provider store-trust boundary governs admission. Claude/Codex review pools
have the register protection used by the existing carry machinery. Grok/OpenCode pools
do not currently establish that protection, so stored clarification/check evidence is
withheld with an explicit diagnostic. The repository's current Codex+Grok configuration
therefore does not admit persisted answers. No configuration or policy is silently
weakened here. Host processes and uncontained execution remain outside this boundary;
#419 owns the broader authority-hardening work. These records are not a new attestation.

## Basis and captured checks

PR schema-v1 reports remain supported. Optional `qualification` separates a code,
contract or judgment reference from the reviewer's conclusion, limitation and
recommendation. Optional `questions` are independent of severity. Invalid optional
detail is unavailable; it cannot change the existing gate or finding fingerprint.
Authoring-v3 findings and the Judge's synthesis/grouping remain #702's separate scope.

A model cannot author a captured check result. An attended operator can capture a
configured package script against a clean, exact local revision:

```bash
npx pelaggio review-assessment check --pr <pr> --item <item> --sha <full-sha> --script <package-script> --scope "<narrow behavior exercised>"
```

This executes the named script using pnpm, retains command/output/exit/revision and
prints a check ID. A changed tree or unavailable process result is recorded as
unavailable. The check result does not alter a gate. A subsequent reviewer can reference
its ID; missing and stale references never render as passed. The scope description is
operator-supplied, and a passing command establishes only what that check exercised.
Cold seats receive status, command and scope, not historical stdout or verdict prose.

## SARIF and site handoff

The SARIF 2.1.0 projection exports only findings with compatible relative code locations.
It maps must-fix/nice/note to error/warning/note, preserves the harness fingerprint,
location and seat attribution, and links richer semantics through namespaced assessment
IDs. The canonical assessment retains questions, answers, limitations and verification
dispositions. No confidence/rank mapping or suppression-as-fixed encoding is used.
No exported result means no projected code finding, not approval. #517/#518 had no
compatible landed emitter at implementation time; this projection introduces no detector
registry. The [OASIS schema](https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json)
is vendored unchanged in the test fixture. Ajv uses non-Unicode regular expressions for
the standard schema's legacy pattern syntax.

Generate the small production-seam example from the repository root:

```bash
mkdir -p docs/examples/pr-review-clarification
PELAGGIO_ASSESSMENT_EXAMPLE_DIR="$PWD/docs/examples/pr-review-clarification" pnpm_config_verify_deps_before_run=false npx tsx --test --test-reporter=dot packages/pelaggio/scripts/pelaggio/__tests__/review-assessment.test.ts
```

The [captured assessment](../examples/pr-review-clarification/assessment.json),
[rendered review](../examples/pr-review-clarification/assessment.md),
[SARIF projection](../examples/pr-review-clarification/assessment.sarif.json), and
[handoff evidence](../examples/pr-review-clarification/handoff.json) are the site consumer
contract. Reviewer/verifier/worker/operator inputs are explicitly simulated. The actual
parser, record writer, answer command, revision worker handoff, git changes and configured
blank-input check run. This proves deterministic plumbing, not autonomous model behavior.

For presentation changes, re-render the captured JSON using `review-assessment show` or
`sarif`. For workflow changes, regenerate the scenario and review the evidence diff.
The site may consume these artifacts but must retain simulation and check-scope labels.
This item does not edit or deploy the site. Attended provider evidence, when available,
is reported separately. The [attended Codex smoke](../examples/pr-review-clarification/provider-smoke.json)
ran through `runPrReviewGate`/`runStep` on an isolated tiny diff and produced a valid clean
assessment. It did not exercise a live-provider answer/revision cycle. No autonomous
behavior claim follows from either example; future missing provider runs stay unverified.

Assurance graph impact: none. This is construction and operator documentation, not a
new invariant, trust claim, ontology or promotion of the shadow graph.
