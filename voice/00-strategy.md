# 00 · Strategy

## Product posture

Pelaggio leads with **Let the work run.** The supporting category is **a control
plane for coding agents**. Describe the work a user can delegate and what comes
back for them to inspect. Use the category to orient technical evaluators and
readers comparing Pelaggio with adjacent tooling.

The public story follows a charter through delivery: the intended outcome, the
change, the checks and review, and the decision to land. Review contributes evidence
to that journey. Keep concrete operating behavior beside its limits; “guarantees”
must name the property and conditions. Use real deliveries with attributed records
and visible gaps. Richer handoffs that are still being built belong in the roadmap.

Public behavior and trust claims lead to
[`../docs/trust/limitations.md`](../docs/trust/limitations.md), where defaults,
partial safeguards, and unavailable evidence are explained in context.

Observability is a **core capability and trust mechanism**, not the whole product
category. Pelaggio scopes work, launches it, supervises it, isolates it, reviews
it, recovers it, and moves it toward a delivery outcome.

## Core promise

Pelaggio extends a developer's reach **without requiring them to surrender
control**. Reach is the amount of consequential work a person can responsibly set
in motion beyond their immediate attention. Autonomy without trustworthy bounds is
exposure, not reach; observability without delegated execution is monitoring, not
reach. Pelaggio combines delegated execution with the evidence and controls needed
to trust it.

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
