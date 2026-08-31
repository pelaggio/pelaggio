# Compressed handoff — PR #325 (experiment #752)

Only what the accountable maintainer still needs to decide. Everything else is closed in
the shadow artifact (`shadow-artifact.md`); each item traces to its question records.

## Bottom line

The merge itself needs no reversal. The code is sound: the fail-closed confinement gate
is preserved by inspection and by independently re-executed tests (246/246 at the merged
SHA) [Q4, Q5], and the shipped docs match the shipped behavior [Q8]. But the PR's
headline is false — it did not fix #308's failure, which was grok's own sandbox opt-in
missing from config and was remediated separately — and that separate remediation landed
a security-posture default without review. Three decisions remain.

## Decisions required

1. **Security default (the only substantive decision).** The real #308 fix —
   `providers.grok.allow-unsandboxed-fallback: true` + `bin` — is now committed repo
   config, having entered as an unannounced rider in the unrelated #324 PR (base commit
   `477b757`), reversing commit `38ce26f`'s explicit "stays uncommitted — local
   supervised-dogfooding config, not a repo default" posture. The flag's own guidance
   says it belongs only to supervised runs with an external containment boundary. Decide:
   keep it as a tracked repo default, or revert it to local-only config. [Q2]

2. **Correct the record.** PR #325 claims "Fixes #308" and restates the causal theory
   (#308's snapshot-audit misfire under grok) that the issue's own root-cause comment had
   already refuted with direct evidence ($0.00/0 turns, zero audit events). The change's
   honest rationale is the one in the close comment: correct classification of
   snapshot-execution failure vs proven mutation, durable `errorDetail` diagnostics
   (delivering the #303-linked follow-on), plus prophylactic retry — no
   snapshot-execution failure was ever observed in the case. Annotate PR/issue so the
   refuted cause isn't relearned. [Q1, Q3, Q7]

3. **Two policy questions (flag, not per-PR).** (a) "Diversity: met" reflects
   *configured* seats by documented policy, but this run's realized review was
   Claude-only on a Claude-authored, author-merged change (codex seat dead, disclosed;
   no human review) — decide whether diversity accounting should reflect realized seats.
   (b) An issue whose resolution comment said "no code change" stayed open and was
   autopilot-re-picked 26 h later into this PR — decide whether pickability should
   require reconciling the newest issue comments. Per #752's framework gate, neither
   authorizes implementation from this experiment. [Q6, Q7]

## Explicitly closed (no decision remains)

- Gate integrity: retries touch only execution throws; a successful observation is never
  re-polled; exhaustion still fails closed; effects stay suppressed; no new masking
  window [Q4].
- Automated PASS: corroborated by independent local re-execution, not trusted [Q5].
- Claims-vs-behavior: PR body and doc amendments are accurate; retry genuinely shared
  with the main-checkout observer [Q8].
- `Atomics.wait` sync sleep: bounded, deliberate, not material [Q9].
- Closing #308: outcome-correct (symptom remediated via config; recurrence class removed
  by tracking it) even though attribution was wrong [Q10, Q1].
