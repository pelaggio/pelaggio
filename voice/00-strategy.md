# 00 · Strategy

## Product posture

Pelaggio leads with **Let the work run.** The supporting category is **a control
plane for coding agents**. Describe the work a user can delegate and what comes
back for them to inspect. Use the category to orient technical evaluators and
readers comparing Pelaggio with adjacent tooling.

The [brand campaign brief](../docs/brand/README.md#campaign-brief) owns the audience,
problem, offer, and evidence boundaries. The supporting line is **Your process,
across pull requests.** Lead with the developer's repeated coordination work and
explain how their instructions and criteria become reusable. Show what they supply,
what returns, and where they still need to intervene.

Use “codify your judgment” only with a concrete explanation: write the working
instructions, review criteria, and check commands into the repository. Workers
exercise judgment; the harness runs the process and enforces deterministic gates.
Avoid suggesting that it learns the developer's preferences automatically from past
pull requests, enforces arbitrary prose, or eliminates supervision.

When describing orchestration, draw the work and its review/revision paths. Name
the agents assigned to steps separately from the process. Use concrete recorded
measurements; avoid “graph-powered,” automatic optimization, or unsupported model
rankings. The [brand brief](../docs/brand/README.md#show-the-process) defines the scope.

Checks support a specific result. Keep the full evidence accessible without making
the number of passing checks the campaign's central benefit. Use real deliveries
with attributed records and visible gaps. Richer handoffs still being built belong
in the roadmap. “Guarantees” must name the property and conditions.

Public behavior and trust claims lead to
[`../docs/trust/limitations.md`](../docs/trust/limitations.md), where defaults,
partial safeguards, and unavailable evidence are explained in context.

Observability is a **core capability and trust mechanism**, not the whole product
category. Pelaggio scopes work, launches it, supervises it, isolates it, reviews
it, recovers it, and moves it toward a delivery outcome.

## Core promise

Let a developer reuse their way of working across delegated changes. Explain the
setup honestly: someone has to articulate the criteria, choose the checks, and
update the process when it falls short. More available attention is the desired
benefit; claims about time saved or fewer interventions require measured evidence.

## Trust model

Every major interaction exposes the relevant subset of four properties. Trust is
communicated through **inspectable state, not emotional reassurance.**

1. **Bounds** — what the work may affect, consume, or change.
2. **Attribution** — who or what produced each action, claim, or decision.
3. **Evidence** — where a user can verify a reported result.
4. **Control** — where the user may inspect, intervene, stop, redirect, or resume.

When these principles conflict with convenience, **trust takes precedence.**

> Use: *The implementation is preserved in three commits on `feat/item-184`.*
> Not: *Don't worry. Your work is safe.*

## Guiding principles

- Work goes offshore. Control does not.
- Trust is built through evidence, not reassurance.
- The closer something is to a system fact, the less personality it should contain.
- Every autonomous action should be more understandable after Pelaggio touches it.
- Silence is better than filler.
- Clear boundaries create confident autonomy.
