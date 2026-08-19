---
title: "ADR-0023: Contained-execution boundary — execution jail + constrained egress broker"
status: proposed
date: 2026-07-22
claims: []
---

# ADR-0023 — Contained-execution boundary

## Context
Pelaggio runs agent-authored, injection-reachable code autonomously (most sharply `implement`'s test/build/verify). That code needs confining, and any network it reaches needs constraining — but three rounds of adversarial multi-driver review converged on a reframe: **containment is orthogonal to permission.** A contained agent that "holds no API key" *feels* safe but launders a **commercial-terms** question as a **security** one — the token being unexfiltratable says nothing about whether the calls are *allowed*. So the posture is deliberately scoped and light, not a bespoke security product. Shipped today: the raw `run-contained` execution jail + the constrained key-mode egress broker, gated by a 12/12 hostile-probe conformance suite. Chartered-not-built (#254): wiring provider step runners to this transport. Detail lives in `docs/agent-context/contained-execution.md`.

## Decision
Confine autonomous agent execution with **two composable boundaries**, chosen per step:
1. **Execution boundary** — agent code + its shell run in a `--network=none` FS/exec jail (bubblewrap / systemd-run first; rootless Podman where an image is needed). Filesystem is the active worktree (rw) plus the exact ro pnpm-store paths, and **never** the whole `MAIN_REPO`. Git stays host-side: the container gets no remote creds, no `gh`, no writable `.git`; the **host is the sole committer**, over a **host-computed write-set** (worktree diffed against a pre-run snapshot), enforced by capability denial — never an agent-declared set.
2. **Credential/egress boundary** — the container's only network is a **host-side fail-closed broker**: a provider path/method/model allowlist + rate/token/body/spend caps with a kill, injecting auth **outside** the container and stripping response auth headers. `--network=none` is the load-bearing backstop — any unanticipated CLI change fails toward **blocked-and-visible, never leaky**, and everything fails closed to `parkExit()`.

**Auth posture is set by execution context:** unattended / CI / shared / at-scale → **metered/org keys** (ToS-clean, liability-clean); local single-developer → **subscription is a defensible opt-in** under transparent isolation (the official CLI owns its own OAuth; no dummy `auth.json`, no header injection). A versioned conformance suite gates every CLI/image bump and only the supported surface.

## Constraints on any implementation

*Added 2026-08-18, after #557 made the Claude seat's confinement unconditional. The Claude seat is a **narrower, separate** mechanism from this ADR's jail — it keeps the host network and host filesystem — but both are confinement boundaries and both are Linux-only, so the platform constraint is recorded once, here, as a property of any confinement mechanism rather than of either one.*

- **Confinement must refuse, never degrade, on a host it cannot confine.** A boundary that quietly falls back leaves the operator holding the guarantee's language without the guarantee, which is worse than having none. Both mechanisms refuse today (`contained-execution.ts` throws; the Claude seat's preflight returns `error_confinement` before `query()`), and a replacement must refuse too.
- **The vector sets the scope, not the platform.** PID + mount namespaces were chosen to answer a *Linux-specific* exposure: same-UID `/proc/<pid>/environ` reads and unrestricted unix-socket reachability. This is **not** a finding that confinement is a Linux-shaped problem. A host without procfs has a materially different exposure and needs a differently-shaped mechanism — not this one ported. Do not read the current construction as a platform stance.
- **Platform parity is required; today's Linux-only construction is tracked debt (#564), not the target state.** macOS support is a medium-term requirement. Any macOS mechanism must deliver the same three properties this one does — a worker cannot read another process's environment, cannot reach a harness-only socket, and cannot inject into the operator's controlling terminal — and must carry **its own** conformance evidence rather than inheriting the Linux suite's, since a trust claim cannot silently span two platforms with one probe.

## Alternatives not taken
- **Subscription credential-*termination* as the productized "no reusable credential" answer** — lab-proven for grok, but makes pelaggio an OAuth vault + unofficial OIDC client + perpetual reverse-engineer of undocumented internals, absorbing token-liability + ToS heat for a security delta `network=none` + broker + spend-caps already mostly deliver. Keys earn that liability; kept as a lab spike behind an experimental flag at most.
- **A heavy bespoke security product / whole-`MAIN_REPO` mount** — the heavier we go the more credential-handler liability + ToS exposure we own; light-and-key is safer on every axis, and mounting `MAIN_REPO` leaks `.git`/`.env`/`.dev` tokens.
- **Agent-declared write-sets / agent-held git creds** — the host computes the write-set and is the sole committer; enforced by capability denial, not a prompt.
- **Treating containment as permission** ("no API key ⇒ allowed") — the reframe this ADR rejects.

## Consequences
- (+) Protects the operator's own machine from their own autonomous agents, cheaply; a real ToS-neutral execution win independent of the credential question.
- (+) `network=none` + fail-closed broker means provider-CLI churn fails toward broken-and-visible, not leaky.
- (−) Fail-closed protects **safety, not availability** — a wedged pin parks every cycle (an outage cost); the bounded remedy is falling back to the last *verified* pin (recorded, `ship.target`-gated) per ADR-0017, never to an uncontained run.
- (−) **Contained ≠ confidential-from-provider**: prompt/body exfil to the provider (an allowed sink) is unclosable by any layer; stated plainly, never implied away.
- (−) Every confinement mechanism shipped today is Linux-only, and #557 widened the blast radius: because the Claude seat is unconditional and Claude is the default driver for every step, a default install on macOS now fails at `pick`, not merely at review. Disclosed and fail-closed rather than silent, but it is **debt against a required platform (#564)** — the medium-term answer is a macOS mechanism meeting the constraints above, not a narrowed platform scope.
- (−) Pelaggio becomes a credential-and-egress handler on the user's box — hence light-and-key as the default and local single-dev as the only place subscription is defensible (no cross-user credential custody).

Specializes ADR-0014; FS confinement per ADR-0001, env allowlist per ADR-0010, degrade-on-rigor / last-verified-pin per ADR-0017. Capability *placement* (host-owned effects, deterministic handlers) is ADR-0021's, not restated here.
