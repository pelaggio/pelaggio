# Adversarial review loop (design)

(design) Move review **upstream, into the authoring cycle**: an internal multi-driver adversarial
loop that **resolves** findings as it goes, converges, and ships a PR that is **already reviewed and
clean**, with the converged review record attached as **provenance**. The human audits an
evidence-backed result instead of triaging a raw first draft. This is what this very repo's design
work was dogfooded through.

## What is (and isn't) novel

The mechanism — *N implementers/authors + independent reviewers + a bounded review-fix loop* — is
**precedented, not novel.** Sakana's **Fugu** productizes multi-LLM orchestration-as-a-model with
Thinker/Worker/Verifier roles (code review a headline use). **FuguNano** (OSS) is nearly this exact
shape: fan-out implementers + an *independent* reviewer + a *bounded, reviewer-gated* repair loop,
with disagreement routing (`TRUST` / `TRUST_SPOT_CHECK` / `ESCALATE`) and confidence smoothing. The
academic base is deep: multi-agent **debate-to-convergence**, **agent-as-judge** / **multi-agent-as-
judge**, **Mixture-of-Agents** (a model's win-rate rises when shown others' answers).

So pelaggio's differentiation is **not** the loop. It is the **integration**: the loop lives inside an
autonomous **dev-cycle** (git/PR/effects), runs on the user's **own flat-rate subscription pool**
(economics neither Fugu nor FuguNano centers), and ships the converged review as **auditable PR
provenance** — a trust artifact the others don't emit. Same lesson as contained execution: borrow the
mechanism, differentiate on integration + provenance + economics.

## Borrowed methods (don't reinvent)

- **Three-phase shape:** individual review → in-group debate → judge aggregation. (multi-agent-as-judge)
- **Critic / Defender / Judge triad:** a **Defender** that *challenges* findings before the Judge
  rules — a cleaner adversarial-verify than folding it into the judge; kills false positives.
- **Convergence via stability detection** (KS-statistic / adaptive stability): stop when the
  finding/verdict distribution stabilizes across rounds — a real rule, not "no new findings" (which
  nits never satisfy).
- **Judge-synthesis > majority vote:** the literature is explicit that aggregation beats vote-tally.
- **FuguNano borrows:** reviewer *independence*, promote **only non-regressing** changes,
  **confidence smoothing** (a 5/5 fleet ≠ certainty), **escalate ordered by disagreement**,
  "deterministic evidence, not model prose" drives decisions.

## Honest cautions (prior art *against* over-doing it)

- **Single-agent can win at equal token budget** — a fleet is not a free lunch; a strong model
  thinking longer sometimes beats N reviewers. → **Benchmark the loop against a single-strong-agent
  baseline**; only pay for the fleet where diversity demonstrably helps.
- **The aggregator/judge is the selection bottleneck.** → Invest in the Judge; it's the
  highest-leverage component.

## Roles

- **Reviewers (N):** default **1 per available driver** (claude + codex + grok). Optionally
  lens-assigned (correctness / security / perf / ergonomics). Fresh (no authoring context).
- **Judge (1, config-set at the shakedown caller):** runs **each pass** — adversarially *verify*
  findings (real / reproducible / material), *consolidate* (dedupe across reviewers into one
  severity-tagged set), and *rule* on the terminal outcome. The Judge is the bottleneck → prefer a
  strong model.
- **Defender (optional):** challenges reviewer findings pre-Judge (the triad).
- **Separation:** `author ≠ reviewer ≠ judge`. The judge must not also hold a reviewer seat in the
  same pass; the judge identity may **rotate per pass** (a lever) to dilute single-model judge bias.
- **"Material" is judge-defined:** a finding blocks convergence only if the Judge, on verification,
  rates it **≥ the blocking bar**. Minors/nits accumulate as notes; they never spin the loop.

## The loop

Per pass: reviewers evaluate the current diff → (optional) defender challenges → judge verifies +
consolidates → author **revises** to resolve ≥-bar findings → re-review. **Convergence** = *all ≥-bar
findings resolved-and-confirmed* **and** *no new ≥-bar findings this pass* (distribution stable) — or
the ceiling, or genuine dissent. Only **non-regressing** revisions are promoted.

## Outcome levers

**Terminal outcomes** (biased toward shipping-with-provenance — the loop optimizes for
*high-confidence, resolved-where-resolvable, honestly-flagged-where-not*, **not** unanimity):

| Outcome | When | Result |
|---|---|---|
| **Converged-clean** | all ≥-bar findings resolved, no new blockers | ship + full provenance *(preferred)* |
| **Converged-with-notes** | blockers resolved; residual minors/nits recorded | ship, notes in provenance |
| **Ceiling-reached** | hit M passes, remaining items below the bar | ship, open items flagged |
| **Dissent** | a *genuine* material disagreement revision can't close | **ship completed work + record dissent + notify**; human adjudicates post-hoc |
| **Hard-block** | a verified blocker revision cannot fix, reviewers agree is real | `parkExit()` for human |
| **Budget/rate-limit** | cost/turn cap or a sub's limit hit mid-loop | checkpoint + park |

**Steering knobs** (all nested config — see below): `reviewers` (N + lenses), `passes` (M ceiling,
generous, converge-early), `judge` (identity, rotation), `blocking-bar` (which severities must resolve
to ship — the primary cost/rigor dial), `convergence` (stability definition), `resolve` (auto-revise
+ max attempts/finding), `escalation` (dissent → ship-and-record *(default)* vs block),
`provider-diversity` (below).

## Cost

The **subscription pool** makes this affordable in a way a metered shop can't: each reviewer rides a
**different flat-rate seat**, so the marginal cost of a pass is ~0 within sub limits → generous
ceilings for "extended confidence and reach." But it is **still capped like any step** — this is "just
another set" in the existing per-step `budget` / `turn-limits` / `effort` config (generous, but
bounded). Spread reviewers across seats so one loop doesn't drain one sub (pool-aware scheduling
#246); a mid-loop rate-limit → `parkExit()` + optionally rotate to another seat's reviewer.

## Nested config + provider diversity

Slots onto pelaggio's existing hierarchical config (`resolveStepSettings`: `profile[step] ??
profile[inheritedStep] ?? default`). A `review:` block lives at **global default → per-profile →
per-step** (shakedown-code / pr-review), with the **shakedown caller config carrying the judge + loop
levers**; the rest inherits.

**Provider diversity is encouraged, not required** — this is the existing `review.provider-diversity:
off | prefer | require` lever, defaulted to **`prefer`**: the loop *tries* a different provider for
reviewer/judge than the author, but **degrades gracefully to same-provider when only one is authed**
and **records the softened guarantee in provenance**. The blind-spot result (a model's blind spots
become the agent's) is the *why* it defaults to `prefer` not `off`; availability-over-rigor is why
`prefer` not `require`.

## Provenance

The converged review record is the PR's **attestation** (ties to #186 ai-delivery predicate / #187
emit / #188 evidence-binding / #189 assisted-by): which drivers reviewed, each pass's verdicts, the
convergence delta, which driver caught what, the blocking-bar, the diversity guarantee (met/softened),
and any recorded dissent. This is the trust artifact — *"reviewed by K independent models across P
passes to convergence, here's the record"* — and the differentiator vs. comment-only reviewers.

## Composition with existing charters

Mostly composition, not net-new: `shakedown-code` evolves into the loop controller; **Judge = the
shakedown lead**; **N = the fan-out (#243)**; **M/resolve = the revise loop (#60 / #244)**;
**author≠reviewer≠judge (#245)**; **pool-spread (#246)**; **caps = existing budget/turn config**;
**provenance = the attestation charters (#186–189)**. The genuinely new parts are the **Judge role**
and the **convergence-loop controller + terminal-outcome taxonomy**.

## Invariants (target-state)

- Review is **pre-commit and resolving**, not a post-hoc comment gate; the PR arrives converged +
  provenance-attached.
- `author ≠ reviewer ≠ judge`; provider diversity **preferred, gracefully degraded**, always recorded.
- The loop **optimizes for confidence + honest audit trail, not unanimity**; only a verified
  hard-blocker blocks — dissent ships with the disagreement recorded.
- Bounded by the same cost caps as any step; the flat-rate pool funds generosity, the caps bound
  pathology; benchmark against a single-strong-agent baseline before assuming the fleet pays.
