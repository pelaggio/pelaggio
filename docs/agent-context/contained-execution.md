# Contained execution

The execution jail and optional constrained egress broker are implemented for raw `run-contained`.
The reviewed production policy is Codex key mode: `POST /v1/responses`, model
`gpt-5.2-codex`, through `https://api.openai.com`. Provider step runners are not yet wired to this
transport; until an official Unix/base-URL or host-stdio seam is verified, egress remains opt-in.

Select it with `--egress codex --egress-model gpt-5.2-codex --egress-auth key --key-env NAME`.
The named variable must exist in the host environment; its value is never accepted in argv or passed
to the jail. `--egress-conformance codex` accepts key or transparent auth for transport testing.
Transparent auth is deliberately unavailable in command mode.

Defaults are 1 MiB request bodies, 8 MiB responses, 60 requests/minute, 500 requests/run,
10 million conservatively reserved input tokens, 1 million output tokens, and 100 USD in integer
micro-USD accounting. A hard cap, response overflow, or unaccountable successful response seals the
broker and kills the systemd scope. Decisions retain method, path without query, rule/outcome,
status, byte/token/cost counters, and timestamps only. Policy or request-shape changes require an
intentional update to the versioned fixture under `__tests__/fixtures/egress/`.

(design) Confine agent-authored, injection-reachable code that pelaggio runs autonomously. This doc
was re-scoped after three rounds of adversarial multi-driver review (Claude/Codex/Grok) that
converged on a hard truth:

> **Containment is orthogonal to permission.** A contained agent that "uses no API key" *feels* like
> it resolves the risk, but it laundered a **commercial-terms** question as a **security** one. The
> token being unexfiltratable says nothing about whether you are *allowed* to make the calls, or who
> owns the liability when you do.

So the posture is deliberately **scoped and light**, not a bespoke security product. Remaining
provider-runner integration is target-state.

## Posture (what we build, and the defaults)

- **Execution containment is the real, ToS-neutral win — build it light.** Every step that runs
  untrusted code (esp. `implement`'s test/build/verify) runs in a `--network=none` FS/exec jail
  (**bubblewrap / systemd-run** first; rootless Podman where an image is needed; **gVisor** only for a
  future escape-worried runner). No creds, no net for pure execution. This protects the operator's own
  machine from their own autonomous agents and is cheap.
- **Auth default = metered/org API key** for anything **unattended / CI / shared**. Keys are the
  ToS-clean, liability-clean, ergonomically-clean path to "the agent holds no reusable credential"
  (key injected at the broker, never in the container; rotate/revoke is normal; ToS *expects*
  automation). This is also the native-`review`-status answer (§Consumers).
- **Local single-developer subscription is a defensible opt-in** — running the *official* CLI on your
  *own* machine and *own* account is ordinary use, just orchestrated by pelaggio. Use **transparent
  isolation**: the CLI owns its OAuth end-to-end (via the official base-URL override), and we only
  `--network=none`-confine + path/spend-cap. **No** dummy `auth.json`, **no** header injection.
- **Subscription credential-*termination* is lab-proven but NON-PRODUCT** (see §Termination). The
  ToS-clean way to get "no reusable credential in the agent" is a **key**, not a subscription OAuth
  token we hold and refresh.

## The two composable boundaries

Not one stack — two separable boundaries you compose per step:

1. **Execution boundary** — where agent code + its shell run. FS = active worktree only (see FS
   contract); `--network=none`; hardened. This is where light suffices almost everywhere.
2. **Credential/egress boundary** — the **host-side broker**: the *only* reachable network, a
   fail-closed proxy enforcing a path/method/model allowlist + rate/token/body/spend caps, injecting
   auth **outside** the container. For unattended, it injects a **key**; for local-sub, the CLI keeps
   its own auth and the broker is a transparent policy gateway.

`--network=none` is the load-bearing backstop: any unanticipated CLI change fails toward **broken
(blocked, visible)**, never leaky. (Caveat: fail-closed protects *safety, not availability* — a
wedged pin parks *every* cycle, an outage cost, not an edge case.)

## The contract (for what we do build)

- **Filesystem:** active worktree mounted rw; the exact pnpm-store paths deps resolve to, ro; nothing
  else. **Never** whole `MAIN_REPO` (leaks `.git`/`.env`/`.dev`/other tokens). Worktrees are siblings
  *outside* MAIN. `worktree-deps` uses **absolute** symlinks, so mount at **identical host paths** or
  relativize. Force `--ignore-scripts` on any in-tree install.
- **Git stays host-side.** A linked worktree's `.git` is a file → `MAIN_REPO/.git/worktrees/<name>/`.
  The container gets **no `git` remote creds, no `gh`, no writable `.git`**; the **host is the sole
  committer** post-exit, over a write-set the **host computes** by diffing the worktree against a
  pre-run snapshot (symlinks/hardlinks rejected, `.gitignore` respected) — **never** an agent-declared
  set. Enforced by capability denial, not a prompt.
- **Broker = constrained gateway, not a transparent forwarder:** provider path/method/model allowlist;
  hard rate/token/body-size/spend caps with a kill; response-side header stripping (`Authorization`/
  `Set-Cookie`), no cross-origin redirects; logs never record auth or query strings. Borrow the policy
  plane where it fits (LiteLLM/Envoy) for **key-based** budgets/model-allowlists — but expect to own
  the unix-socket ingress + provider-path policy yourself.
- **Hardening (asserted, not assumed):** `--cap-drop=ALL`, `no-new-privileges`, seccomp/AppArmor,
  read-only rootfs + tmpfs, `--pids-limit` + mem/cpu/disk/log caps, no Podman socket, no host `HOME`,
  explicit `--env` (never `--env-host`). The conformance probe must *assert* these, not just
  containment.
- **Ingress:** grok's `--cli-chat-proxy-base-url` is an official flag → transparent re-origination is
  a supported seam. `socat`-in-container reopens a loopback listener under `network=none`; prefer a
  unix-socket base-URL or a host-side stdio shim, and never let the bridge be agent-killable.
- **Env/creds:** deny-by-default env (#237); secrets via `podman --secret` / tmpfs / short-TTL, never
  a long-lived agent-writable auth volume.

## Auth posture — the local/unattended boundary

The dividing line is **execution context**, and it is load-bearing (the review loop
(`adversarial-review-loop.md`) inherits this exact posture, so it lives here as the single source):

- **Local single-developer (subscription allowed, opt-in):** operator's own machine, operator's own
  seats, **operator-initiated or operator-supervised**, **single-tenant**. This is ordinary use
  orchestrated by pelaggio. Transparent isolation only (CLI owns its OAuth; no dummy `auth.json`, no
  header injection). "Local" does **not** stretch to a packaged, always-on, multi-seat daemon.
- **Keys required (no subscription):** CI, multi-user or shared runners, headless/at-scale
  unattended, and anything packaged to "run unattended against consumer subs." This is the
  `#214`-style path — metered/org keys, spend-capped.

Subscription economics are therefore a **local-mode cost property, not a product-default** — do not
build defaults, cost models, or a differentiator on multi-seat unattended subscription automation.

The three-way tension is unavoidable: **subscription economics · strongest security (termination) ·
ToS-clean — pick two.** Classify per provider before implementing:

| Provider | Unattended / CI / shared | Local single-dev authoring |
|---|---|---|
| **Anthropic (Claude)** | **API key / Bedrock / Vertex / Team / Enterprise** (contractually clean). **No token termination** — Claude Code OAuth is for ordinary native-app use; keep Claude on its sanctioned SDK/`-p` path. | Sanctioned SDK/`-p`, network-isolated. |
| **xAI (grok)** | Org/enterprise key or the official external-auth hook; enterprise terms bless headless. | Transparent isolation via the official base-URL override; CLI owns its OAuth. |
| **OpenAI (codex)** | Org/service API key. | Official CLI headless, network-isolated. |

## Termination — lab-proven, deliberately non-product

Empirically, credential-termination *works* for grok (a fully-dummy container `auth.json` — invalid
access JWT *and* refresh token — + a broker that injects a host-held token → a real model call
succeeds; and host-side OIDC refresh works via `auth.x.ai/.well-known/openid-configuration` →
`/oauth2/token`). But **do not productionize it for subscription OAuth**: it makes pelaggio an OAuth
vault + an unofficial OIDC client + a perpetual reverse-engineer of undocumented internals
(`auth.json` shape, header forms), absorbing **token-liability + ToS heat + churn** for a security
delta that `network=none` + a constrained broker + spend caps *already* mostly deliver. Termination
"earns its liability" only with **keys**. Keep the spike as lab proof, behind an experimental flag at
most.

## The unfixable residual

**Prompt/body exfil to the provider is unclosable by any layer** — the provider is an allowed sink, so
an agent can put worktree secrets into a legitimate prompt. "Contained" ≠ "confidential from the
provider." Mitigate (cap prompt bytes/turn, host-side pre-prompt secret redaction, keep high-value
secrets *off* the worktree mount) but state it plainly; do not let "contained" imply confidentiality.

## Change management vs provider churn

We depend on a third-party binary that can change under us. You can't stop change — make it **detected
in test** and **safe at runtime**:

- **A versioned security-conformance suite gates every CLI/image bump:** containment (12/12 hostile
  probe), hardening-flag assertions, request-shape **snapshot diff** (a new endpoint → human review),
  override-completeness, response non-leakage, fail-closed-on-broker-death, and (key path) key-inject
  works. It gates **only the supported surface** (official override + key/CLI auth + containment) —
  **not** a pretend-stable API for reverse-engineered internals.
- **Rolling verified pin, not a frozen fork:** auto-verify each upstream release in CI, advance the pin
  when green, **default-but-overridable** (opt into latest behind an "unverified" banner). Fast
  re-verification is what keeps pinning from becoming friction users route around.
- **Fail-closed to `parkExit()`** on any break — never a silent fallback to uncontained/leaky.

## Where it lives — and the liability of wrapping

Everything runs on the operator's **own infra** (host broker + Podman + pelaggio; container = the
untrusted zone). No new external trust. But the flip side: **we become a credential-and-egress handler
on the user's box** — our bugs are credential leaks, spend blowouts and account flags land on us, and
we own perpetual coupling to undocumented CLI internals. **The heavier we go, the more liability +
ToS exposure we own** — which is why light-and-key is the safer default on *every* axis, and why local
single-dev is the only place subscription is defensible (no cross-user credential custody).

## Non-negotiables

- **Legal review of the actual provider ToS clauses before any unattended-subscription-at-scale.** Docs
  must state plainly: *consumer subscription = local authoring only; unattended/CI/shared = keys.*
- **Do not extract/publish this as a standalone product** — a productized "help people automate against
  subscription terms" is a liability magnet regardless of how airtight the socket is. Keep clean seams
  (`run-contained`, the gateway interface) so a later split is a package move if it's ever warranted.

## Consumers

- **#214 (native `review` status):** already available by re-enabling the GHA review job on a
  **metered key** — no self-hosted runner, no subscription. Review stays **ephemeral GHA + key**.
- **#240 (grok sandbox):** folds into the execution jail; keep grok `--sandbox` / `codex -s` as cheap
  defense-in-depth.
- **#176 (creds outside the process):** realized with a **key** at the broker, not a held subscription
  refresh token.
- **#237 (env allowlist):** the explicit `--env` list at the boundary.

## Invariants (re-scoped, precise)

- Execution containment is the default everywhere untrusted code runs; auth default is a **key** for
  unattended; subscription is **local-only, transparent-isolation, opt-in**.
- The container's only network is the fail-closed host broker; `gh`/GitHub egress is host-side only.
- The broker is a **constrained** provider-API gateway (path/method/model allowlist + caps + response
  non-leakage), not a transparent forwarder.
- The host is the **sole committer/effects owner** (capability denial + host-computed write-set).
- Boundary code + image are trusted (installed pelaggio/`main` + pinned digest), never the PR tree.
- Conformance gates only the **supported** surface; `network=none` is the runtime backstop
  (fail-broken-not-leaky); everything fails closed to `parkExit()`.
- **Contained ≠ confidential-from-provider**, and **contained ≠ ToS-permitted** — both are stated, not
  implied away.
