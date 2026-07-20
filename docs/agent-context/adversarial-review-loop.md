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
autonomous **dev-cycle** (git/PR/effects) and ships the converged review as an **auditable PR
provenance record** — a trust artifact the others don't emit. Subscription-pool economics are a
*local-mode* advantage (§Auth posture), **not** the differentiator — the differentiator is
integration + provenance. Same lesson as contained execution: borrow the mechanism, differentiate on
integration + provenance.

## Borrowed methods (don't reinvent)

- **Three-phase shape:** individual review → in-group debate → judge aggregation. (multi-agent-as-judge)
- **Critic / Defender / Judge triad:** a **Defender** that *challenges* findings before the Judge
  rules — a cleaner adversarial-verify than folding it into the judge; kills false positives.
- **Convergence via stability detection** (KS-statistic / adaptive stability) exists in the
  literature — but for the *blocking* set we use pelaggio's stronger existing deterministic rule
  (fingerprint-survival, refutation-required; see §The loop). Stability metrics are a *later optional*
  lever for the below-bar note distribution, not v1.
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
- **Separation:** `author ≠ reviewer ≠ judge` — but note this is *role* separation. v1 = a **fixed
  configured (strong) judge**, with rotation as an optional audit lever (a full multi-judge is overkill
  for v1). The judge must not also hold a reviewer seat in the same pass.
- **Degraded mode (first-class, not a footnote):** when `provider-diversity` softens to a single
  authed provider, author/reviewer/judge can all be the *same model* — role separation with **zero
  model separation**, and the blind-spot guarantee the loop sells is **void**. This must emit a
  **visibly weaker attestation** (see Provenance), never the same badge. Never claim independence
  stronger than "one configured judge + optional rotation + recorded diversity status."
- **"Material" is judge-defined:** a finding blocks convergence only if the Judge, on verification,
  rates it **≥ the blocking bar**. Minors/nits accumulate as notes; they never spin the loop.

## The loop

Per pass: reviewers evaluate the current diff → (optional) defender challenges → judge verifies +
consolidates → author **revises** to resolve ≥-bar findings → re-review.

**Convergence reuses pelaggio's existing `pr-review` contract — do not invent a weaker one.** That
rule is deterministic and fail-closed (`roadmap-and-ship.md`): *validated ≥-bar (blocker) fingerprints
survive across passes until a complete verifier explicitly **refutes** them — **omission is never
refutation***; PASS requires a complete valid pass with an **empty carried-survivor set** and no new
≥-bar findings. Only **non-regressing** revisions are promoted ("non-regressing" = required checks/
tests green + the judge's re-check of the prior ≥-bar set). Statistical stability detection
(KS/adaptive) is a **deferred, optional lever for the below-bar *note* distribution only** — never the
gate on the blocking set. Non-convergent exits (ceiling / dissent / hard-block) are terminal
*outcomes*, not convergence.

## Outcome levers

**Terminal outcomes** (biased toward shipping-with-provenance — the loop optimizes for
*high-confidence, resolved-where-resolvable, honestly-flagged-where-not*, **not** unanimity):

| Outcome | When | Result |
|---|---|---|
| **Converged-clean** | all ≥-bar findings resolved, no new blockers | ship + full provenance *(preferred)* |
| **Converged-with-notes** | blockers resolved; residual minors/nits recorded | ship, notes in provenance |
| **Ceiling-reached** | hit M passes, remaining items below the bar | ship, open items flagged |
| **Dissent** *(judgment-band only)* | a genuine **non-safety** disagreement revision can't close, below the safety floor | ship depends on `ship.target` (below) + record dissent + notify |
| **Hard-block** | any **unrefuted** finding in the safety-critical class, or a verified blocker revision can't fix | `parkExit()` for human — never ships |
| **Budget/rate-limit** | cost/turn cap or a sub's limit hit mid-loop | checkpoint + park |

**Two teeth make "ship-not-unanimity" safe rather than merely efficient:**

1. **Safety floor (never ships on dissent).** Any finding in the **security / data-loss /
   correctness-regression** class that a reviewer raised is **Hard-block → park**, *not* Dissent, until
   fixed — a single Judge's `refuted` decision does not clear it (omission ≠ refutation — the
   `pr-review` invariant — **and neither is a lone Judge's say-so**, #272). Once raised it is retained
   every pass (carried blockers are re-seeded, so reviewer omission cannot drop it either) and the run
   **parks for human adjudication** — the loop never self-clears a safety must-fix, even after the
   author's revision addresses it. Ship-on-dissent is permitted for judgment-band findings
   **only**. A single-model judge must not be able to reclassify a real safety finding as "dissent" and
   ship it.
2. **Condition Dissent on `ship.target`.** For **`direct-push`**, dissent defaults to **park/block**
   (post-hoc human adjudication after a merge is not a control). For **`pull-request` / `auto-merge-pr`**,
   dissent may push the branch + record + notify — GitHub's required checks and the human merge still
   gate. Dissent must record: the minority finding, the judge's ruling, attempts made, and the notify
   target.

**Parse tolerance vs. genuine fail-closed (#280).** The teeth above must fire on *real* disagreement,
not on output-format flakes that would fail-close good code. Two redundancies are tolerated: a reviewer
emitting more than one `AUTHORING_REVIEW_FINDINGS` block (all blocks are parsed and their findings
unioned — codex reliably emits several), and a Judge decision omitting the redundant `class` (it is
inherited from the candidate the Judge is already adjudicating by ID). The load-bearing fail-closed
guards are unchanged: duplicate / unknown / missing decisions still invalidate the pass (#259), and a
Judge may not **downgrade** a reviewer's safety class to a non-safety one (only restate or elevate),
so reclassification cannot route a safety finding around the floor (#272).

**Steering knobs** (all nested config — see below): `reviewers` (N + lenses), `passes` (M ceiling,
generous, converge-early), `judge` (identity, rotation), `blocking-bar` (which severities must resolve
to ship — the primary cost/rigor dial), `convergence` (stability definition), `resolve` (auto-revise
+ max attempts/finding), `escalation` (dissent → ship-and-record *(default)* vs block),
`provider-diversity` (below).

## Auth posture (inherited) & cost

**The loop inherits `contained-execution.md`'s local/unattended auth boundary — verbatim, per
execution context.** This is load-bearing and non-negotiable:

- **Local-authoring loop** (operator machine, operator's own seats, operator-supervised,
  single-tenant): reviewers may run on the **subscription pool** *or* keys, under transparent
  isolation. Here — and *only* here — each reviewer rides a different flat-rate seat, so the marginal
  cost of a pass is ~0 within sub limits, funding generous ceilings. This is a **local-mode cost
  property**, not the product default or a differentiator.
- **Unattended / CI / shared / at-scale loop**: **metered/org keys**, exactly like `#214`. The loop
  must run correctly key-metered with **tight ceilings** — the fleet is optional, never a free lunch.

The differentiator is **integration + provenance**, not the pool. Never build an OAuth vault so N
reviewers can share subscription seats — that is the unattended-subscription-automation
`contained-execution.md` rules out.

Cost is **capped like any step** regardless of mode — this is "just another set" in the existing
per-step `budget` / `turn-limits` / `effort` config (generous, but bounded). In local-pool mode,
spread reviewers across seats (pool-aware scheduling #246); a mid-loop rate-limit → `parkExit()` +
optionally rotate to another seat's reviewer.

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

## Provenance — a structured evidence *record*, not an attestation (yet)

The loop emits a **structured review record**: which drivers reviewed, each pass's verdicts, the
convergence delta, which driver caught what, the blocking-bar, the **diversity-guarantee status
(met | softened)**, the terminal outcome, and any recorded dissent. It becomes an **attestation** only
when a separate layer binds it to the reviewed **commit SHA + config + tool results + trusted harness
identity** — that binding is #188's job (#186 predicate / #187 emit / #189 assisted-by): the loop is a
**producer/consumer of those charters, not a reinvention of them** — it must not invent its own
crypto/predicate binding.

**Residual honesty (the doc-1 discipline, applied here).** The headline "reviewed by K models" must
**not** imply "K independent chances to catch the bug":
- **Process, not coverage.** K models ≠ K independent judgments — shared training lineage produces
  *correlated* errors (the MoA/debate literature this doc cites documents exactly this). Provenance
  attests *what was run*, not *what was covered*.
- **Conditional on realized diversity.** A same-provider run (degraded mode) must emit a **visibly
  weaker** record, not the same badge — the softening *is* the point of recording it.
- **Gaming.** Author and reviewers run the same orchestrator on the same pool; integrity rests on the
  judge's adversarial verification + reviewer independence, both of which **degrade toward zero** under
  same-provider. State this; don't let provenance become the very "laundering" doc 1 warns against.

## Composition with existing charters

Mostly composition, not net-new: `shakedown-code` evolves into the loop controller; **Judge = the
shakedown lead**; **N = the fan-out (#243)**; **M/resolve = the revise loop (#60 / #244)**;
**author≠reviewer≠judge (#245)**; **pool-spread (#246)**; **caps = existing budget/turn config**;
**provenance = the attestation charters (#186–189)**. The genuinely new parts are the **Judge role**
and the **convergence-loop controller + terminal-outcome taxonomy**.

## Invariants (target-state)

- **Auth posture is inherited per execution context** from `contained-execution.md`: local-authoring
  loop = subscription-or-keys (transparent isolation); unattended/CI/shared = keys (`#214`). No OAuth
  vault, no multi-seat unattended subscription automation. Subscription-pool economics are a local-mode
  property, never the differentiator.
- Review is **pre-commit and resolving**, not a post-hoc comment gate; the PR arrives converged + a
  structured review **record** (an attestation only once #188 binds it to SHA/config/identity).
- `author ≠ reviewer ≠ judge` (role separation); diversity **preferred, gracefully degraded, always
  recorded** — a same-provider run emits a visibly weaker record.
- **No model, especially the Judge, may launder unresolved material uncertainty into a landed change**
  by labeling it "dissent" or "convergence." Convergence reuses the deterministic `pr-review`
  fingerprint-survival rule (omission ≠ refutation). The **safety-critical class never ships on
  dissent**; Dissent is conditioned on `ship.target` (direct-push → park).
- The loop optimizes for **confidence + honest audit trail, not unanimity** — but only *judgment-band*
  disagreement ships-with-notes.
- Bounded by the same per-step cost caps regardless of mode. A single-strong-agent baseline is a
  **stated caution** (single-agent can win at equal budget): measure before assuming the fleet pays —
  not a hard gate on shipping the loop.

## Relation to #214

Two `review` realizations, one posture: **`#214` (CI merge-gate / unattended) is delivered by the
GHA-key path** — re-enable the ephemeral GitHub-hosted review job on a metered key (no self-hosted
runner, no subscription). **This local pre-commit loop is the *authoring-time* realization** (operator
machine, operator seats). They share the convergence + provenance contracts; they differ only in
funding (key vs local-pool) per the inherited auth posture.
