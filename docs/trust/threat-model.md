---
title: Threat model
description: The one threat that defines this product — and how the boundaries answer it.
status: draft
diataxis: explanation
sidebar:
  order: 2
last_reviewed: 2026-07-08
---

# Threat model

Most tools model a trusted operator using a tool against the outside world. An autonomous code orchestrator inverts that: **the instructions it acts on arrive from surfaces an attacker can reach** — repository files, issue bodies, PR descriptions, dependency metadata, tool output. So we lead with that, not with a generic checklist.

## The defining threat: prompt injection via untrusted input

Pelaggio is *built* to read your repo, issues, and PRs and take action on them. That is the feature and the risk. A malicious `README`, a poisoned issue, or a crafted test output can try to steer the agent into running a command or writing a file it shouldn't.

The wrong mental model is "keep the trusted agent contained." The right one is: **treat every repo/issue/PR string as attacker-controllable, and bound what the agent can do regardless of what it's told.**

Maps to **OWASP LLM01 (Prompt Injection)**, **LLM06 (Excessive Agency — functionality / permissions / autonomy)**, and the **OWASP Top-10 for Agentic Applications (2025)**. Governed by [`ADR-0002`](../decisions/0002-untrusted-input-and-tool-scope.md); tracked as claim `TC-015`.

### How the boundaries answer it

| Attack | Bound | Claim / ADR |
|---|---|---|
| "Edit files in the real repo / another branch" | Writes confined to the item's worktree; violations fail the step | `TC-011` / `ADR-0001` |
| "Push straight to main" | Denied by default; direct-push is explicit opt-in | `TC-012` / `ADR-0003` |
| "Get this merged" | Review gate fails closed — only an explicit PASS merges | `TC-003` / `ADR-0004` |
| "Exfiltrate a secret" | Secrets never enter prompts/logs; egress is an allowlist | `TC-001`, `TC-006` |
| "Run forever / rack up cost" | Per-step budget + turn caps; rate-limit parking | `TC-015` |

**Honest residual:** within its worktree the agent still runs allow-all tools, so injection *inside the sandbox* is bounded by the sandbox, not detected. Least-privilege tool scoping and human gates on risky file classes are the roadmap (`ADR-0002`).

## Trust boundaries

```
  untrusted input                 Pelaggio                    your world
 ┌──────────────┐        ┌───────────────────────┐        ┌──────────────┐
 │ repo files   │──────► │  agent (allow-all      │──────► │ item worktree│  (write-confined, TC-011)
 │ issues / PRs │        │  tools, budget-capped) │        ├──────────────┤
 │ tool output  │        │  ─ worktree hooks      │──────► │ PR (gated)   │  (fail-closed, TC-003)
 │ deps         │        │  ─ egress allowlist    │──────► │ main branch  │  (opt-in only, TC-012)
 └──────────────┘        └───────────┬───────────┘        └──────────────┘
                                     │ egress (sub-processor: model provider)
                                     ▼  prompts, source, diffs, issue text  (TC-006)
```

## STRIDE (security)

| | Threat | Control | Claim/ADR |
|---|---|---|---|
| **S**poofing | Unauth control-plane peer spawns a run | Fail-closed auth / loopback-only | `TC-010` / `ADR-0008` |
| **T**ampering | Agent corrupts main or a sibling worktree | Worktree write confinement | `TC-011` / `ADR-0001` |
| **R**epudiation | "What did it do?" | Git-native trail + audit log; provenance | `TC-005` |
| **I**nfo disclosure | Secret leaks via prompt/log | No secrets in prompts/logs; child-env allowlist | `TC-001`, `TC-014` |
| **D**enial | Runaway cost/loops | Budget + turn caps; parking | `TC-015` |
| **E**levation | Injected instruction gains autonomy | PR-gated default; no direct-push | `TC-012` / `ADR-0003` |

## LINDDUN (privacy)

The one privacy question that matters for an LLM tool is *what leaves the machine*. We frame the egress list as a **sub-processor list** (see `pelaggio.trust.json`): self-hosted, the operator is the controller and Pelaggio ships **no** processor relationship of its own. **L**inkability / **I**dentifiability: source and diffs sent to the model provider may contain author identities — documented, provider-retained, opt-out by choosing a different provider (`TC-006`). **U**nawareness: countered by this page + the machine manifest. **N**on-compliance: no telemetry by default (`TC-002`).

## What we do not defend against (yet)

- A compromised **model provider** (you trust whoever you configure).
- A malicious **operator** (Pelaggio runs with your credentials, by design).
- Injection *within* the worktree sandbox beyond the blast-radius bounds above.
