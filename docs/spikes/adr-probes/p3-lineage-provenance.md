# P3 — Run/attempt lineage, cold isolation, provenance

**Targets:** F (durable recovery follows lineage, not replay), G (self-contained source provenance),
I/J (review in authoring; independence as a property).

**Subject:** item **#481**, chartered specifically as the probe subject and run through the real
pipeline — not a toy.

**Method.** `npx pelaggio run --item 481`, then
`npx tsx docs/spikes/adr-probes/p3-dossier.ts --item 481`. The assembler classifies each provenance
question G requires as `durable` / `mutable-join` / `unanswerable`. That classification **is** the
probe: G's falsification signal is "answering basic provenance questions requires mutable joins".

## Coverage — partial, and why

| Lifecycle state P3 wanted | Exercised |
|---|---|
| in-progress attempt | ✅ |
| accepted step outputs | ✅ `plan` (codex, $2.40), `shakedown-plan` (grok, $3.17) |
| failed / superseded attempt | ✅ attempt 1 died on confinement; attempt 2 ran — both in `.dev/attempts/481/` |
| implementation checkpoint | ✅ "no changes to commit (implementation checkpoint)" |
| non-success terminal state | ✅ quarantined |
| durable WIP interruption + resume | ❌ no rate-limit park occurred |
| authoring review | ❌ never reached `shakedown-code` |
| cold / independent evaluation | ❌ never reached `pr-review` |
| final candidate | ❌ |

**The blocker was a chartering error of mine, not a harness defect.** #481 asks to *extend*
`ci/verify-adr-shape.ts`, which exists only on the unmerged `agent/adr-reconciliation-plan` branch;
the claim worktree branches from `main`, where it does not exist. The implement step detected the
missing prerequisite and **quarantined rather than recreating the file**, which is the correct
plan-respecting behavior. #481 should have been chartered with a dependency on #480, or scoped to
something self-contained on `main`. I/J therefore remain unexercised here.

## Dossier result

Run against the fresh #481 lineage, and against #435 (which predates the #467 attempt-identity
work) as a comparison:

> **Instrument correction (added after P5).** The assembler these figures come from had three
> defects, found by the cold gate reviewing this branch: it resolved worktree-relative receipt paths
> (`types.ts:67`) under the main repo, derived steps/provenance/cost from the last cycle record only
> (dropping the failed and superseded attempts this probe exists to distinguish), and classified
> reviewer history as durable from an unfiltered count of every gate record in the store. Corrected,
> #481 scores **6 durable / 2 mutable-join / 5 unanswerable**, not 5/2/5, and #483 scores 6/3/4. The
> shape of the finding is unchanged — the charter and landing authorization remain mutable-joins,
> the same four answers remain unanswerable, and the reviewer-findings answer joins them (its
> durable reading was the unfiltered-count defect) — but treat the individual numbers as this
> instrument's output rather than as measurements.

| | durable | mutable-join | unanswerable |
|---|---|---|---|
| **#481** (post-#457, post-#467) | **6** | 2 | 5 |
| #435 (pre-#467) | 5 | 2 | 6 |

Both rows are the *corrected* assembler's output over thirteen answers (the #481 row read 7/2/4
before the three instrument defects above were fixed); #435's lineage predates the run and is read
as it stands on disk.

The same assembler shows provenance completeness **measurably improving** as those items landed —
attempt lineage moved from unanswerable to durable (park cause reads durable on both rows: #435's
cycle records already carry the #457 `parked` field).

### What cannot be answered durably today

| Question | State | Why |
|---|---|---|
| why did this work exist / what was chartered? | **mutable-join** | the charter is a GitHub issue body — editable after the fact, never copied into the lineage at claim time |
| why was the final candidate authorized to land? | **mutable-join** | branch-protection status checks live on GitHub, not mirrored into the record |
| what context and skill were supplied? | **unanswerable** | skill bodies are expanded into the prompt; no prompt or skill digest is recorded per step |
| under what authority / sandbox profile? | **unanswerable** | no authority profile is declared or recorded per step — consistent with P2 |
| what deterministic checks ran? | **unanswerable** | check invocations happen inside step execution; no typed record of which gates ran |
| what did reviewers find, and how were findings fixed/refuted? | **unanswerable** on #481, **mutable-join** on #483 | the gate record carries only the disposition; findings and their resolution live in the rendered PR comment — and #481 never reached `pr-review`, so it has no record at all |
| what semantic surfaces were reconciled? | **unanswerable** | K is unimplemented |

## Verdicts

**F — supported.** Attempt lineage cleanly separated a failed attempt from its successor: the
confinement-aborted run is attempt 1, the real run attempt 2, both durable in `.dev/attempts/481/`.
The implement checkpoint did **not** masquerade as an accepted output — quarantine is a distinct
terminal state, and no resume pretended an LLM execution could be replayed. The plan's own worry
that "failed WIP becomes indistinguishable from accepted output" did not materialize.

**G — falsified as written.** G requires the dossier to be "sufficient to answer, **without mutable
external joins**", the provenance questions it lists — thirteen answers as the assembler splits them
(park cause and attempt lineage/supersession are classified separately, because one verdict for both
would be wrong in one direction). Seven of the thirteen cannot be answered durably today — two
mutable-joins and five unanswerable — and the very first item on G's own list — what was chartered —
is among them. A charter that lives in an editable issue body is precisely the mutable external
state G forbids relying on.

**G's other signal did not fire.** Nothing degenerated into transcript storage: the six durable
answers come from structured records (`pelaggio-log.jsonl`, execution receipts, the attempt
registry). Telemetry and provenance stayed distinct. **G is achievable — it is just
not achieved**, and the gap is specific and small rather than architectural.

**I/J — untested.** See coverage above, and standing caveat 4: with `sessionResume` false on every
provider there is no inheritance mechanism to defeat, so J would have been weak evidence regardless.

## Architectural consequences

1. **G needs a capture obligation, not just a schema.** The fix for both mutable joins is to copy
   the charter into the lineage at claim time and mirror the landing authorization into the record at
   ship time. Without an explicit *capture-at-the-boundary* requirement, G describes a record that
   can only be assembled by joining the mutable sources it forbids.
2. **Three unanswerables are cheap to close** — skill/prompt digest, declared authority profile, and
   a typed record of which checks ran are all emit-at-execution facts. None requires transcripts.
3. **Do not weaken G to match the implementation.** The honest move is to record G as unmet and
   charter the capture work, not to redefine "self-contained" to mean "self-contained apart from the
   charter".
