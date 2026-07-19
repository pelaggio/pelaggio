# Contained execution (design)

(design) Confine every pelaggio step that runs agent-authored, injection-reachable code. The
boundary is **two cooperating primitives**, not one container:

1. **A host-side auth-terminating egress broker** — the agent never holds a reusable credential;
   the only network the container can reach is a fail-closed local proxy that injects auth
   outside the container and enforces a destination policy. This is the load-bearing piece and the
   concrete realization of #176.
2. **An FS/exec confinement container** (rootless Podman) — worktree-only filesystem, minimal
   explicit mounts, hardened (dropped caps / seccomp / read-only rootfs / resource limits).

**The container alone does not stop credential exfil** — a readable token plus an egress allowlist
that includes the token's own provider endpoint provides zero protection. The broker is what makes
the boundary real. This doc was rewritten after a three-driver adversarial review (Claude/Codex/
Grok) that converged on that flaw; the review notes live in the PR thread. Target-state; the tag
drops when it ships.

## Threat model — what the boundary does and does not do

- **Does:** bound host filesystem and environment reach; prevent provider-account compromise via a
  *readable, reusable* subscription token (there is none in the container); force all agent egress
  through a policy proxy; make the host the sole committer / effects owner via capability denial.
- **Does NOT (residual, must be stated, not hidden):** it is not a hard kernel boundary — a
  rootless-Podman/userns/kernel escape yields the *runner user* (not root, not other users). It
  does not stop same-host exfil purely by hostname filtering (a legitimate provider request body
  can carry data) — that is bounded by the broker terminating creds + response/prompt redaction +
  spend caps, not by the allowlist. "Can never reach" is replaced everywhere by precise, testable
  claims.

## Decouple the two goals #214 conflated

Getting a native branch-protection `review` status and using subscription (non-metered) auth are
**orthogonal**:

- **(A) Native `review` status** is *already solved*: `pr-review.yml` runs on `ubuntu-latest` and
  posts `review` as GitHub Actions (`app_id 15368`). It is merely **gated off** by
  `AUTOPILOT_REVIEW_RUNNER=local`. Flipping that back on gives native, non-`--admin` merges today —
  at the cost of a **metered API key**. Containers and self-hosted runners are not required for (A).
- **(B) Subscription-cost review with a native status** is the actually-hard problem, and it is
  **not** where containment should debut. Putting review — which executes PR-influenced code — on a
  self-hosted host that also holds `MAIN`, `gh` auth, and live subscription profiles *regresses*
  today's model (`pr-review.yml`: "GitHub-hosted, deliberately NOT self-hosted … never on a dev
  machine"). **Review stays on ephemeral GHA with a spend-capped key.** Containment debuts on
  **authoring**, which starts from the trusted harness + issue text and is the larger exposure.

## The contract

### Credentials — the agent never reads a reusable credential

| Path | Mechanism |
|---|---|
| **CI / review** | Spend-capped, scoped **API key** (metered), exactly as `pr-review.yml` uses `ANTHROPIC_API_KEY` today. No subscription token on a runner. |
| **Local authoring (subscription pool)** | The host **broker** holds the refresh token and mints short-lived access tokens; the container reaches providers only through the broker, which injects auth. If a provider CLI insists on reading an on-disk token, mount a **filtered, minimal, short-TTL copy** into tmpfs (never a rw bind of the live `~/.claude` profile — OAuth refresh writes would fail against a ro mount or vanish with `--rm`), and the broker re-mints/restarts on `401`. |

Never mount a home directory wholesale — `~/.claude|.codex|.grok` also hold MCP configs, cached
transcripts, and other tools' tokens. Mount only the specific auth file(s), by explicit allowlist.
Confirm each provider CLI's auth-file format and refresh path in the spike. ToS: use per-environment
accounts, not the human's primary; get legal sign-off before any CI-on-subscription; drop the
"same activity relocated" framing.

### Network — one fail-closed host proxy, not a hostname allowlist

The container gets **no direct egress**. Its only route is the host broker/proxy (e.g. container
`--network=none` plus a mounted UNIX socket, or a dedicated netns whose sole gateway is the proxy).
The proxy is protocol-aware (HTTPS to known provider API hosts only; block `CONNECT` tunnels to
arbitrary hosts; block arbitrary DNS/DoH/IPv6), **fails closed** if it dies, and is enforced
*outside* the container's user namespace (rootless `pasta`/`slirp4netns` give no hostname allowlist
on their own — an IP allowlist leaks on CDN churn/rebinding). **`api.github.com` is host-side only
and is NOT in the container's reachable set** — the harness's `gh` effects run on the host. The exact
provider domain set (incl. token-refresh, telemetry, model-download hosts each CLI may hit) is
enumerated empirically in the spike; an incomplete list must fail closed, never auto-open.

### Filesystem — minimal explicit mounts; the host is the sole committer

- **Mounts are the real TCB — minimal and explicit.** The active **worktree** rw; the specific
  **pnpm store** paths the deps resolve to, ro (see below); nothing else. Do **not** bind whole
  `MAIN_REPO` — it exposes `.git`, `.env*`, `.dev/`, credentials, and other tokens.
- **Git stays host-side.** A linked worktree's `.git` is a *file* → `MAIN_REPO/.git/worktrees/<name>/`;
  commits write there and to `MAIN_REPO/.git/objects/`. The container gets **no `git` remote creds,
  no `gh`, and ideally no writable `.git`** (agent writes working-tree files only). The **host is the
  sole committer**, post-container-exit, over a **declared write-set** that respects `.gitignore`
  (so in-container build/test caches are never blindly `git add -A`ed). "Harness owns git" is enforced
  by capability denial, not by a prompt append.
- **node_modules sharing is a spike risk, not a footnote.** `worktree-deps.ts` materializes
  **absolute** symlinks into `MAIN_REPO/node_modules` (and possibly `~/.local/share/pnpm/store`).
  Inside the container those targets dangle unless the worktree and store are mounted at their
  **identical host paths** (`-v /same:/same`) — which constrains "a fixed path" — or the materialized
  links are made **relative**. `readlink -f` on `.pnpm`/`.bin` must be audited; native modules are
  host-ABI-sensitive. Resolve this concretely before depending on shared deps.
- Worktrees must be **siblings outside `MAIN`** (never nested) so a rw worktree mount can't reach MAIN.
- **`--ignore-scripts` everywhere.** Any in-tree `pnpm install` fallback must use it (today only the
  repair path does; the worktree-deps install fallback does not — fix that regardless).

### Execution profiles — split the LLM turn from command execution

The "agent turn" and "the commands the agent runs" have different needs:

- **LLM API turn:** reaches the broker (auth), no repo command execution.
- **Test/build/verify:** runs untrusted, injection-reachable code — needs **no credential and no
  network at all**. Run these in a stricter, network-`none`, credential-free profile.

### Trusted boundary code — the PR tree is data, never the executor

The wrapper, the container **image (pinned by digest)**, the review entrypoint, and the provider CLI
come from a **trusted source — installed `pelaggio` / `main`**, never the checked-out PR tree. A PR
must not be able to rewrite its own container invocation (drop mounts, add `--privileged`, change the
proxy). For the review gate specifically: **never `npx pelaggio` from the PR's `node_modules`**; run
the pinned harness with a **sanitized `PATH`** and project-local hooks/config/`core.hooksPath`
disabled; the PR tree is mounted ro as data. The review *workflow itself* must be un-modifiable by the
PR (run from the base ref, pin actions by SHA).

### Container hardening & lifecycle

`--userns`, **drop all caps**, `no-new-privileges`, pinned seccomp/AppArmor, **read-only rootfs** +
tmpfs scratch, `--pids-limit` + memory/CPU/disk/log-size caps (a hostile test can fork-bomb / fill
disk), **no Podman socket**, no host `HOME`, explicit `--env` list (never `--env-host`). Ephemeral
(`--rm`); SIGTERM→SIGKILL on abort/timeout; a **framed stdout protocol + host watchdog** so cost/park
accounting and `parkExit()` still fire when a turn is killed mid-stream.

## Provider specifics

- **Claude is in-process today** — `step-runner.ts` runs the Agent SDK in-process with `PreToolUse`/
  plan-polish hooks, *not* a CLI spawn. Containerizing it forces a CLI/ACP shape and moves those
  hooks. **Containerize the CLI providers (codex, grok) first**; Claude either stays host-side
  initially or its hooks re-home to host-observed FS policy. Do not assume `spawn(cli)` covers Claude.
- **Keep per-provider sandboxes (`codex -s workspace-write`, grok `--sandbox`) as defense-in-depth**
  until the container contract is proven under adversarial tests — do not retire them early.

## Runner posture

- **Review: ephemeral GitHub-hosted (or an explicitly disposable VM) + metered key.** Not a
  self-hosted box with real creds.
- **Authoring / self-hosted:** if used, require **ephemeral runners** (or per-job VM reset), image
  **digest pinning** + build-in-CI + cosign/attest (never `:latest` on the runner), cache separation,
  and cleanup verification — a persistent runner can be poisoned (images/caches/volumes/systemd-user).

## Consumers

- **#214:** decoupled. Native status is available now by re-enabling the GHA review job (metered);
  the subscription-cost contained review is a later, separate step gated on the trusted-binary split
  and the broker.
- **#176 (creds outside the process):** the broker **is** this — elevated from open question to the
  primitive.
- **#240 (grok sandbox):** folds in eventually, but grok's `--sandbox` stays as defense-in-depth.
- **#237 (env allowlist):** enforced as the explicit `--env` list at the boundary.

## Open questions → spike order (reordered: hardest/riskiest first)

1. **Broker + egress proxy + cred mechanics** on a throwaway/disposable env with an **API key** — the
   load-bearing spike. Prove: container reaches *only* the proxy; hostile in-container binaries cannot
   exfil via raw TCP/UDP/DNS/CONNECT; the agent never reads a reusable token; the proxy fails closed.
2. **Authoring `implement`** with **file-only mounts** + the **trusted-binary** launch; resolve the
   worktree-`.git` write path and the absolute-symlink/path-remap node_modules reality; host-side
   commit of a declared write-set; framed protocol + park-on-SIGKILL.
3. **Review contained** — only after the trusted-binary split and broker are proven; and only if the
   subscription-cost benefit justifies leaving ephemeral GHA.
4. Performance: measure p50/p95 cold/warm start with the real mount set; decide **per-cycle** container
   (`podman exec` per turn, with proven state reset) vs per-step `run`. Drop "sub-second" as a gate.
5. Ergonomics: support matrix (**Linux native | macOS `podman machine` VM — different mount/net/UID,
   design explicitly | unsupported**); `run-contained --self-test` (fail closed on a failed contract
   probe) and `--debug` (retain container, print the exact `podman run` line); **no silent host
   fallback** in production modes.

## Invariants (target-state — precise and testable)

- The agent **never holds a reusable credential**: the broker injects ephemeral tokens; CI uses
  spend-capped API keys. (advances #176)
- The only network the container can reach is the **fail-closed host proxy**; `gh`/GitHub egress is
  host-side only.
- The **boundary code + image are trusted** (installed `pelaggio`/`main` + pinned digest), never the
  PR tree; the review workflow is un-modifiable by the PR.
- The **host is the sole committer and effects owner**, enforced by capability denial (no git-remote
  creds / no `gh` / declared write-set), not by a prompt.
- **Mounts are the TCB:** minimal, explicit, host secrets excluded; worktrees are siblings outside MAIN.
- The container bounds **host FS/env and account-via-readable-token**, **not** container escape
  (residual: escape → runner user, paired with spend caps so an escape yields little).
