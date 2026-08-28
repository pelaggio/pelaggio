---
title: Threat model
description: Prompt injection first, then STRIDE/LINDDUN over Pelaggio's trust and egress boundaries.
status: draft
diataxis: explanation
sidebar:
  order: 2
last_reviewed: 2026-08-19
---

# Threat Model

Pelaggio's defining threat is prompt injection through untrusted input (`TC-015`). The product is built to read repository files, issue bodies, PR text, dependency metadata, logs, and tool output, then act. Those strings may be attacker-controlled, so the main question is not whether the agent is trusted; it is what damage an injected instruction can cause after it reaches the agent (`TC-015`, [`ADR-0002`](../decisions/0002-untrusted-input-and-tool-scope.md)).

This maps directly to OWASP LLM01 Prompt Injection, OWASP LLM06 Excessive Agency, and the OWASP Top-10 for Agentic Applications 2025 through `TC-015`. Current controls bound blast radius; they are not yet a designed injection defense (`TC-015`).

## Trust Boundaries

| Boundary | Trust level | Current control | Claim(s) |
|---|---|---|---|
| Repo files, issues, PRs, dependency metadata, tool output | Untrusted input | Treat as attacker-reachable; bound actions with worktree conventions, budgets, and gates. | `TC-015`, `TC-011`, `TC-003`, `TC-012` |
| Pelaggio pipeline and skills | Trusted orchestrator code, but model-visible prompts can include untrusted text | Step budgets/turn limits, fail-closed review parser, configured provider/profile. | `TC-003`, `TC-015` |
| Item worktree | Mutating workspace | Hooks, dependency guard, and a default audit of main plus siblings; dirty-main mode retains siblings and uses provider-specific main protection. Not an OS sandbox. | `TC-011`, `TC-015` |
| PR/default branch | Shared remote state | PR default; direct push and auto-merge are explicit opt-ins. | `TC-012`, `TC-013` |
| Model provider | External sub-processor | Configured model endpoint receives prompts/source context/diffs/issue text. | `TC-006`, `TC-014` |
| Roadmap adapter | User-controlled integration | GitHub/Linear only when configured as the roadmap source. | `TC-006` |
| Git remote | User-controlled endpoint | Branch/commit push during ship modes; default branch push denied by default. | `TC-006`, `TC-012` |
| Notify webhook | User-controlled endpoint | Disabled until `notify.url` is set; sends outcome metadata. | `TC-002`, `TC-006` |
| Control-plane HTTP API | Operator surface | Every bind requires `CONTROL_PLANE_TOKEN`; bearer auth guards all operator routes. | `TC-010` |

## STRIDE

| Category | Threat | Current posture | Claim(s) |
|---|---|---|---|
| Spoofing | A reachable peer starts or controls runs through the daemon. | Startup fails without `CONTROL_PLANE_TOKEN`; bearer auth guards every authority-bearing API route. Health, the trust manifest, and the static UI shell carry no run authority. | `TC-010` |
| Tampering | Injected instructions write outside the item worktree or corrupt the main checkout. | Hooks and the install guard reduce exposure. By default the audit catches main and sibling changes; dirty-main mode uses Claude tool-window deltas or Codex workspace exclusion for main and retains siblings. The Claude seat starts a new terminal session so it cannot inject input through the harness controlling terminal (`TC-018`). Other paths remain outside this non-OS boundary. | `TC-011`, `TC-015`, `TC-018` |
| Repudiation | Operators cannot tell what ran, what shipped, or why a gate blocked. | `.dev/pelaggio-log.jsonl`, branches, PR comments, review metrics, and server state/logs preserve operational evidence; verbose raw logs have scrubbing limits. | `TC-001`, `TC-003`, `TC-014`, `TC-015` |
| Information disclosure | Secrets or private source leave through prompts, child env, logs, provider calls, or webhooks. | Known secret env vars are not interpolated into prompts/structured run logs; no telemetry exists; configured provider/integration egress is documented. Driver children receive a deny-by-default env and credential-scrubbed logs (`TC-014`). A Claude seat cannot read host `/proc/<harness-pid>/environ`, connect to configured harness-only socket directories, or (for forge-denied roles) use GitHub token env vars or existing GitHub CLI config directories (`TC-018`). The seat still has the host network, a bound host root outside those masks, leftover host credential files, and Anthropic/CLI auth names. | `TC-001`, `TC-002`, `TC-006`, `TC-014`, `TC-018` |
| Denial of service | Injection burns model budget/turns or leaves work half-finished. | Step budgets, turn caps, abort handling, rate-limit parking, and retry bounds limit unattended cost and preserve work at park paths. | `TC-015`, `TC-014` |
| Elevation of privilege | Injected text causes autonomous merge or direct default-branch mutation. | PR mode is default and the review gate fails closed; direct push/auto-merge require explicit `ship.target`. Auto-merge branch-protection verification is planned, not current. | `TC-003`, `TC-012`, `TC-013`, `TC-015` |

## LINDDUN Over Egress

| Category | Egress/privacy risk | Current posture | Claim(s) |
|---|---|---|---|
| Linkability | Provider/adapter data can link issue, diff, branch, and repo context. | Egress destinations and data classes are explicit in the manifest and [egress matrix](./egress.md). | `TC-006` |
| Identifiability | Source, diffs, PR text, logs, and comments may contain names, emails, tokens, or customer data. | No telemetry channel exists; provider/adapter retention is owned by the configured endpoint. Child env allowlisting and log scrubbing are shipped; leftover host credential files and Claude CLI auth names remain. | `TC-002`, `TC-006`, `TC-014` |
| Non-repudiation | PR comments, git branches, and server state can identify operator activity. | These artifacts are intentionally retained as audit/recovery surfaces; cleanup is operator-run. | `TC-003`, `TC-012`, `TC-015` |
| Detectability | External providers learn that a repo/run exists when configured calls happen. | Self-hosting keeps the controller local, but model/adapter/git/notify egress still occurs when configured or required. | `TC-006`, `TC-010` |
| Disclosure | Prompt/source/diff data leaves to the model provider and roadmap data leaves to GitHub/Linear when enabled. | The manifest names each destination, opt-out, and role; no hidden analytics path is present. | `TC-002`, `TC-006` |
| Unawareness | Operators may not know which destinations process run data. | The trust manifest, this doc set, and public `/.well-known/pelaggio.trust.json` endpoint expose the posture. | `TC-006`, `TC-010` |
| Non-compliance | Provider or integration retention may conflict with local policy. | Pelaggio does not override external retention; choose endpoints/adapters/providers that match policy. | `TC-006`, `TC-014` |

## Residual Risk

Pelaggio currently bounds prompt-injection blast radius but does not neutralize injection (`TC-015`). The default audit gates main and sibling worktrees; dirty-main mode gates siblings plus provider-specific main protection (`TC-011`). Neither is an OS sandbox or process-lifetime provenance. A Claude seat cannot see host procfs, configured private socket directories, or (for denied roles) existing GitHub CLI config stores, but still has the host network, broad host filesystem visibility outside those masks, leftover host credential files, and Anthropic/CLI auth names (`TC-014`, `TC-018`). A compromised provider remains in the trust base (`TC-006`), and auto-merge relies on external branch protection (`TC-013`).

The intended end state is stronger least-privilege tool scoping, provenance-aware prompt handling, a capability/credential broker, and branch-protection verification. Until those claims move out of `planned`, the docs keep naming them as residual risk (`TC-013`, `TC-015`).
