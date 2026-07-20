# Decisions

Status values are `default-taken`, `resolved`, or `resolved→ADR-nnnn`. Source is an item, pull request, or review-note reference.

## Active

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
| configuration surface for pooled assignment | default-taken | allow models.profiles.<name>.providers.<authoring-or-review-step> to be either the existing provider scalar or an ordered, non-empty provider list | add a separate top-level assignment block; replace scalar provider settings outright | https://github.com/pelaggio/pelaggio/issues/245 | 2026-07-20 |
<!-- decision:af49a5313053cb76 -->
| meaning of availability within this item | default-taken | cycle-local eligibility from an injected availability predicate evaluated before assignment, plus configured candidates minus the output author and already-selected review seats; the production predicate initially reflects provider configuration/driver readiness and tests can supply changing availability | fail over after a provider has begun an artifact; persist quota/cooldown state across cycles as #246 | https://github.com/pelaggio/pelaggio/issues/245 | 2026-07-20 |
<!-- decision:9df96e1088a51025 -->

## Resolved

| Decision | Status | Chosen/leaning | Alternatives | Source | Date |
| --- | --- | --- | --- | --- | --- |
