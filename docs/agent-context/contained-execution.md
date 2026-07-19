# Contained execution (design)

(design) A single, provider-agnostic **containerized execution boundary** for every pelaggio
step that runs agent-authored, injection-reachable code — both **authoring** cycles and the
**review** gate. The container is the blast-radius boundary: agent code runs inside it with
scoped credentials, a worktree-only filesystem, and an egress allowlist; it can never reach the
host's other secrets, files, or network. This is target-state; the tag drops when it ships.

## Why

Today an agent step executes on the bare host with the operator's full environment and
subscription credentials:

- **Authoring is the larger exposure.** During `implement`, the agent both *writes*
  injection-reachable code (from untrusted issue/PR text — TC-015) *and executes its own
  test/build/verify commands* directly on the host. A prompt-injected step can run arbitrary
  code with the operator's `~/.claude|.codex|.grok` creds and full filesystem.
- **Review is the smaller-but-real half.** `pelaggio pr-review` runs the CLI *from the checked-out
  PR tree*, and pelaggio's PRs modify pelaggio's own code — so a malicious PR can execute during
  its own review. `pr-review.yml` keeps this on an ephemeral GitHub VM precisely for that reason;
  `review.runner: local` gives that up, which is why the local `review` status can't natively
  clear branch protection (#214).

Current isolation is a patchwork: per-provider flags (`codex -s workspace-write`, grok
`--sandbox` #240), Claude in-process worktree hooks, and prompt appends ("the harness owns git and
network"). It is inconsistent across providers and isolates neither credentials, host filesystem,
nor network egress. One container boundary replaces the patchwork uniformly.

## Decision

Run each agent step (and the review) inside an **ephemeral rootless container** with a fixed
contract. The harness stays on the host and owns everything the agent must not: git mutations,
roadmap/forge effects, worktree lifecycle, cost/park accounting. The container runs only the
agent turn.

### The contract

| Axis | Policy |
|---|---|
| **Filesystem** | The active worktree mounted `rw` at a fixed path; `MAIN_REPO` mounted `ro` (so the shared `node_modules` symlink resolves — see the worktree-deps sharing model). Nothing else. Writes are confined to the worktree (subsumes TC-011). |
| **Network** | Default-deny egress; allowlist only provider endpoints (`api.anthropic.com`, `cli-chat-proxy.grok.com`, the codex backend) and — for the harness, not the agent — `api.github.com`. Subsumes #240's net-allowlist; relates TC-006. |
| **Credentials** | `~/.claude`, `~/.codex`, `~/.grok` mounted **read-only into the container only**. The agent reads its own auth but cannot reach any other host secret. Advances #176 (credentials scoped to the execution boundary, not the bare process). |
| **Environment** | Deny-by-default minimal env — the same allowlist contract as `buildAgentEnv` (#237 / TC-014), enforced at the container boundary. |
| **Lifecycle** | Ephemeral (`--rm`), SIGTERM→SIGKILL on abort/timeout, wall-clock cap — mirrors `codex-provider.ts` / `grok-provider.ts`. |

### Runtime

Rootless **Podman** (`podman run`), not Docker: no root daemon, no Docker-socket=root exposure;
the runner user launches the container directly. A bare self-hosted Actions runner (or the local
sweep) invokes `podman run`; agent/PR code executes only inside the container. Linux operators
first; document the macOS path later.

## Consumers (how the chartered items fold in)

- **#214 (review → native merges):** the `pr-review.yml` job runs `run-contained pelaggio
  pr-review` on a self-hosted `pelaggio` runner. Because it is a genuine Actions job, the `review`
  status posts as `app_id 15368` and natively satisfies branch protection — no `--admin`, real
  author/reviewer separation. Review is read-mostly, so it is the easiest first consumer to
  validate the cred + network mechanics.
- **Authoring (contained autopilot):** each agent step in a cycle runs inside the primitive. The
  step-provider seam is the natural injection point — a provider (or a wrapper around the existing
  ones) runs its CLI via `run-contained` instead of a bare `spawn`. The harness's pick/ship/git
  and roadmap effects stay on the host, matching the existing "harness owns git and network"
  model.
- **#240 (grok sandbox):** folded in — the container *is* the sandbox, provider-agnostic. Grok
  runs plain inside it; per-provider `--sandbox` / `-s workspace-write` become redundant where the
  container covers them (keep them as defense-in-depth or retire per provider).
- **#176 (creds outside the agent process):** advanced — creds live in the container, mounted
  read-only, never in the bare agent env.
- **#237 (env allowlist):** the same deny-by-default contract, now at the container boundary.

## Open questions (spike-first)

1. **Credential mechanics + ToS.** Confirm injecting `~/.claude|.codex|.grok` (read-only) into the
   container authenticates the official CLIs, and that OAuth-token refresh survives a long step.
   Sanity-check the Feb-2026 ToS posture — the container runs the *official* CLIs, so this is the
   same activity as today's local runs, relocated; confirm it's no worse (this is the #214 note).
2. **Network enforcement.** The mechanism for the egress allowlist under rootless Podman
   (`slirp4netns`/`pasta` + firewall, an egress proxy, or a restricted network) — and how the
   harness's `gh` effects reach GitHub while the agent cannot.
3. **node_modules sharing.** The worktree shares `MAIN_REPO`'s `node_modules` via symlink; the
   mount set must include `MAIN_REPO` (ro) so the symlink resolves inside the container without a
   per-step `pnpm install`.
4. **Overhead.** Per-step container start cost (target: sub-second) and image caching across steps
   in a cycle.
5. **Effects boundary.** Precisely which operations stay host-side (git commit, `gh`, roadmap
   mutations, worktree create/remove) vs. in-container (the agent turn only), reusing the existing
   provider "no stateful git / no network CLI" append as the in-container instruction.

## Staging

1. Build the primitive: the `pelaggio-runner` image + a `run-contained` wrapper implementing the
   contract. Spike the cred + network mechanics.
2. Apply to **review (#214)** first — validate a native, non-`--admin` merge end-to-end.
3. Extend to **authoring** — wire the step-provider seam to `run-contained`; validate a full cycle
   with the implement step contained.
4. Fold in **#240**; retire redundant per-provider sandbox flags where the container supersedes
   them.

## Invariants (target-state)

- The container is the blast-radius boundary: agent code never runs on the bare host with host
  credentials or filesystem. The harness owns git + roadmap/forge effects host-side; the container
  runs only the agent turn.
- One provider-agnostic contract (FS / network / creds / env / lifecycle) — not per-provider
  sandbox flags. Providers see a uniform contained execution.
- Credentials are mounted read-only into the execution boundary, never inherited by the bare agent
  process (advances #176; composes with #237).
