# `.pelaggio.yml` — configuration schema

Place an `.pelaggio.yml` at the repo root to override pipeline defaults. All
keys are optional — omit anything you don't want to change and the default
applies. If the file is absent or empty, behavior is identical to today.

The file is read once at startup by `loadConfig()` in
`packages/pelaggio/scripts/pelaggio/config.ts`. Parse errors fail loudly with the file path in
the message — delete the file to fall back to defaults.

## Precedence

For the worktree prefix (the one key with an env-var escape hatch):

```
PELAGGIO_WORKTREE_PREFIX  >  worktree.prefix (yml)  >  basename(REPO) + "-"
```

All other values use: `yml value` > default.

`budgets`, `turn-limits`, and `effort` also support a per-profile layer that
overrides the global step value for one profile only (see
[Per-profile step overrides](#per-profile-step-overrides)):

```
models.profiles.<name>.<section>.<step>  >  <section>.<step> (global yml)  >  default
```

## Annotated example

```yaml
# .pelaggio.yml — every key is optional

worktree:
  prefix: "myproj-"            # default: `${basename(REPO)}-`

confinement:
  allow-dirty-main: false       # default: false. true uses provider-specific main protection
                                # for worktree steps; sibling worktrees remain hard-gated.

ship:
  target: pull-request          # default: pull-request
                                # values: direct-push | pull-request | auto-merge-pr
  required-checks: [ci]         # default: [ci] — checks that must be PRESENT and green for
                                # the `pelaggio land --admin` red-merge guard (issue #292).
                                # `--admin` bypasses branch protection, so this is pelaggio's
                                # own gate: a required check that has not reported (e.g. Actions
                                # hasn't created `ci` yet) refuses the merge, not just a red one.
                                # An explicit `[]` is the escape hatch for a repo with no gating CI.

park:                           # overnight park-and-resume on rate-limit
  auto-resume: true             # default: true (wait out the window and resume)
                                # false = hand the prompt back at the first park
  max-wait: 6h                  # default: 6h — skip resuming if the reset is farther out
                                # ("6h", "90m", "1h30m", or a bare number = minutes)
  unknown-reset-wait: 60m       # default: 60m — conservative wait when the rate-limit
                                # event reports no reset time (same format as max-wait)

watch:                          # continuous watch defaults (issue #83)
  daily-budget: 25              # optional USD day cap; omit = unlimited
                                # CLI --day-budget overrides; server StartForm prefills this

revise:                         # local revise sweep — auto-fix red-review PRs (issue #76)
  local: true                   # default: true (opt-out). No-op unless roadmap.source is
                                # github-issues AND ship.target is a PR mode AND auto-pick mode.

review:                         # PR review poster (issue #84)
  runner: ci                    # default: ci. values: ci | local
  statusless-after: 2h          # local-mode diagnostic threshold
  authoring:                    # opt-in pre-ship adversarial loop
    enabled: false              # concurrent reviewer/Judge seats use detached
                                # checkouts under .dev/authoring-review-seats/ (#269)
    provider-diversity: prefer
    blocking-bar: must-fix
    max-passes: 5              # iterate to convergence (integer 1..5) before raising to a human
    max-revisions: 4           # author revisions (integer 0..max-passes-1); 0 = review but never auto-revise
    budget-cap: 180            # aggregate $ cap; sized for a full 5-pass convergence
    reviewers:
      - { id: claude, provider: claude }
      - { id: codex, provider: codex, codex-model: gpt-5-codex }
      - { id: grok, provider: grok }
    judge: { provider: claude, model: claude-opus-4-8 }
  taxonomy:                     # ADR-0016 safety floor; omit for the built-in owner table
    owner: operator             # forensic label only; not a cryptographic identity
    judgment-default: permissive # permissive | park; seeded for the #297 tolerance dial
    classes:                    # overlay: omitted baseline entries remain in force
      my-new-risk: safety       # extension/elevation is signature-free
    # contract:                 # required for any contraction
    #   signature-b64: "<Ed25519 signature>"

notify:                         # outbound run-outcome webhook (default: disabled)
  url: ""                       # default: "" (disabled). Set a webhook/topic URL to enable.
  format: json                  # default: json | ntfy
  events:                       # default: all events below
    - parked
    - failed
    - shipped
    - pr-opened
    - shipwrecked
    - review-stranded
    - decision

roadmap:
  source: markdown              # default: markdown
                                # values: markdown | github-issues | linear | beads
  # github:                     # only consulted when source is github-issues
  #   repo: acme/widgets        # required when source=github-issues (owner/repo)
  #   label: autopilot          # default: autopilot
  #   plan-location: issue-comment  # default: issue-comment | pr-description
  # linear:                     # only consulted when source is linear
  #   team: <team-uuid>         # required when source=linear (Linear team UUID)
  #   label: pelaggio          # default: "" (no label filter)
  #   plan-location: issue-comment  # default: issue-comment (pr-description reserved)
  # beads needs no extra keys — `bd` discovers MAIN_REPO/.beads

budgets:                        # dollars per step (safety-net caps)
  pick: 2
  plan: 8
  shakedown-plan: 5
  implement: 25
  shakedown-code: 25
  ship: 3
  shipwreck: 3
  pr-review: 5                  # CI merge-gate review (non-pipeline step; see docs/pr-review.md)
  pr-verify: 5                  # isolated candidate-blocker verification (non-pipeline)

turn-limits:                    # SDK turn cap per step
  pick: 30
  plan: 80
  shakedown-plan: 60
  implement: 200
  shakedown-code: 150
  ship: 60
  shipwreck: 40
  pr-review: 60
  pr-verify: 60

effort:                         # "low" | "medium" | "high" | "xhigh" | "max"
  pick: medium                  # xhigh needs Opus 4.7/4.8 or Sonnet 5; falls back to high on models without it.
  plan: xhigh                   # Opus 4.8 defaults to `high` when effort is omitted; max needs Opus 4.6/4.7/4.8 or Sonnet 5.
  shakedown-plan: xhigh
  implement: xhigh
  shakedown-code: xhigh
  ship: medium
  shipwreck: medium
  pr-review: xhigh
  pr-verify: xhigh

models:
  profiles:
    standard:
      pick: claude-sonnet-5
      plan: claude-opus-4-8
      shakedown-plan: claude-opus-4-8
      implement: claude-opus-4-8
      shakedown-code: claude-opus-4-8
      ship: claude-opus-4-8
      shipwreck: claude-sonnet-5
      pr-review: claude-opus-4-8
    quick:
      pick: claude-sonnet-5
      plan: claude-sonnet-5
      shakedown-plan: claude-sonnet-5
      implement: claude-sonnet-5
      shakedown-code: claude-sonnet-5
      ship: claude-sonnet-5
      shipwreck: claude-sonnet-5
      pr-review: claude-sonnet-5
    # Additional named profiles (e.g. `thrifty`) can be added here.
    # A profile may also carry its own budgets / effort / turn-limits, which
    # override the global step values above for that profile only (sparse —
    # list only the steps you want to bump):
    # deep:
    #   plan: claude-opus-4-8
    #   budgets:
    #     plan: 16                # this profile's plan cap; other steps stay global
    #   effort:
    #     plan: max
    #   turn-limits:
    #     plan: 120
```

`confinement.allow-dirty-main: true` tolerates main-checkout dirtiness that is unchanged across provider tool windows. Claude snapshots main immediately before and after every mutating tool and fails closed on a delta or attribution error; Codex excludes main through its workspace-write boundary. Sibling worktrees remain whole-step audited. A simultaneous operator edit inside a Claude tool window is conservatively attributed to that tool, while detached writes after the post hook and paths outside audited Git roots remain out of scope. Future providers that can reach main must use the same observer before this mode can claim attribution coverage.

## Merge semantics

- Partial overrides are allowed. `budgets: { implement: 40 }` sets that one
  step and leaves every other step at its default. The same applies inside
  `turn-limits`, `effort`, and each profile under `models.profiles`.
- Adding a new profile (e.g. `thrifty`) leaves `standard` and `quick`
  untouched. Within a new profile, any step you omit inherits the slot from
  whatever was already defined under that profile name in defaults (for a
  brand-new profile, omitted steps stay unset — be explicit).
- Section keys use kebab-case (`turn-limits`), matching YAML convention. Step
  names (`pick`, `plan`, `shakedown-plan`, etc.) are literal keys whose
  internal hyphens are part of the step identifier.
- `shipwreck`, `pr-review`, and `pr-verify` are **non-pipeline** steps: they carry the same
  per-step config as pipeline stages but never run as part of a `/pick → … →
  /ship` cycle. `shipwreck` is ship-failure recovery; `pr-review` is the
  standalone CI merge gate; `pr-verify` is its isolated blocker-verification
  session (see [docs/pr-review.md](./pr-review.md)).

## Per-profile step overrides

The top-level `budgets`, `turn-limits`, and `effort` blocks set values that
apply to *every* profile. A profile that swaps a step onto a differently-priced
or differently-tuned model often needs matching cost/effort headroom — so each
`models.profiles.<name>` may also carry its own `budgets:`, `effort:`, and
`turn-limits:` sub-blocks:

```yaml
models:
  profiles:
    deep:
      plan: claude-opus-4-8       # step → model, as usual
      budgets:
        plan: 16                  # raise just this profile's plan budget
      effort:
        plan: max
      turn-limits:
        plan: 120
```

- **Sparse.** A per-profile block lists only the steps it changes. Any step you
  omit falls through to the global value for that section, then to the default.
  Precedence per step:
  `models.profiles.<name>.<section>.<step>` > `<section>.<step>` (global) > default.
- **Isolated.** An override on `deep` never affects `standard`, `quick`, or any
  other profile — and never affects `deep`'s *other* steps.
- **Same value rules as the global blocks.** `budgets`/`turn-limits` take
  numbers; `effort` takes one of `low | medium | high | xhigh | max`. A wrong
  type or a non-map block fails loudly at startup with the file path and the
  dotted key (e.g. `models.profiles.deep.budgets.plan`).
- **Unknown steps ignored.** A non-step key inside an override block (e.g.
  `budgets.bogus`) is silently dropped, same as the global sections.
- The built-in `standard` and `quick` profiles carry no override blocks, so out
  of the box every profile resolves to the global/default step values.

### Provider and Codex model overrides

`providers` is the sibling sub-block that selects the backend for a step. The
registered backends are `claude` (default), `codex`, `grok`, and `opencode`. Set
a step to another provider to route it there:

```yaml
models:
  profiles:
    deep:
      providers:
        implement: codex
        shakedown-code: grok

The authoring steps (`plan`, `implement`, `shakedown-plan`, and `shakedown-code`)
and the non-pipeline CI gate step `pr-review` also accept an ordered, non-empty
list. **Semantics differ by step:**

| Step(s) | Pool meaning |
|---------|----------------|
| `plan` / `implement` / `shakedown-*` | *Selection set* — the pipeline picks one eligible driver from the list. |
| `pr-review` | *Fan-out set* — every resolved candidate runs the same discovery prompt concurrently; the gate passes only when every required driver/label pass completes and passes (all-pass / veto). |

There is no second config key for this distinction; the step name selects the
behavior.

```yaml
models:
  profiles:
    standard:
      providers:
        plan: [claude, codex, grok]
        implement: [claude, codex, grok]
        shakedown-plan: [claude, codex, grok]
        shakedown-code: [claude, codex, grok]
        # CI merge-gate fan-out (not author rotation):
        pr-review: [claude, codex]
```

List order is significant. For authoring selection sets, Pelaggio rotates author
selection deterministically from the cycle number and authoring-step ordinal,
after filtering drivers that are not ready before execution. Review selection
excludes the realized author of the artifact and an N-seat request requires
distinct providers; insufficient eligible seats fails closed. For `pr-review`,
order is the deterministic render/aggregation order of driver passes (and the
order used when merging concurrent park metadata). Scalars and one-element lists
remain static pins (single-driver / no fan-out). Provider lists are rejected for
`pr-verify`, `ship`, coordination, recovery, and other unsupported steps —
verification stays one independently configurable scalar driver per discovery
result.

Readiness is a pre-execution capability check. Once a driver begins an artifact,
a launch, transport, or rate-limit failure parks and checkpoints the cycle; it
does not switch drivers mid-artifact. The policy has no persisted quota,
credential-seat, cooldown, or cross-worker fairness state; those scheduling
concerns are outside this cycle-local policy.
```

The `grok` provider drives `grok agent stdio` over ACP (issue #136). Follow the
[Grok operator guide](./grok.md) for the pinned install, authentication,
Landlock preflight, metering, and trust limits. Its off-PATH binary must be
pinned via `providers.grok.bin` (see [Provider binaries](#provider-binaries)).
Pin a `grok` model id in that profile's `grok` sub-block (see
[Per-provider model sub-blocks](#per-provider-model-sub-blocks) below); a
`claude-*` id is never forwarded, and absence means the grok CLI default applies.

The `opencode` provider drives `opencode run --format json` as a headless
subprocess (issue #137), fronting OpenCode's 75+ model backends on the same seam.
Follow the [OpenCode operator guide](./opencode.md) for install, authentication,
the autonomous-permission env, and trust limits. Its off-PATH binary can be
pinned via `providers.opencode.bin`. Address a backend model in that profile's
`opencode` sub-block using OpenCode's `provider/model` form (for example
`anthropic/claude-sonnet-4-5` or `openai/gpt-5`); a bare `claude-*` id is never
forwarded, so the OpenCode CLI default applies when only such an id is present.
OpenCode is not a default authoring reviewer; opt in per profile.

### Per-provider model sub-blocks

Each subprocess-backed provider has its own sparse model sub-block —
`codex`, `grok`, and `opencode` — parallel to the top-level `<step>` slot that
pins the Claude model. A provider receives **only its own** sub-block's model;
it never scavenges another provider's slot, so one profile can pin a distinct
model per provider for the same step:

```yaml
models:
  profiles:
    deep:
      implement: claude-opus-4-8   # Claude model (top-level <step> slot)
      providers:
        implement: [claude, codex, grok, opencode]
      codex:
        implement: gpt-5-codex
      grok:
        implement: grok-code-fast-1
      opencode:
        implement: openrouter/qwen3-coder   # provider/model form
```

Whichever provider the pipeline selects for `implement` receives only its own
model. Model selection order for a subprocess provider is:

1. the matching provider sub-block's exact step —
   `models.profiles.<name>.<codex|grok|opencode>.<step>`;
2. for `pr-verify`, that same provider sub-block's `pr-review` value when the
   sub-block has no exact `pr-verify` value (mirrors the Claude/`<step>`
   inheritance);
3. the provider CLI default.

Codex additionally retains a legacy fallback: when its `codex` sub-block has no
value for the step, Codex reads the top-level `<step>` slot, but only when that
value is not a `claude-*` id. Grok and OpenCode do **not** read the top-level
`<step>` slot — without their own sub-block entry they fall through to the CLI
default. A `claude-*` id is never forwarded to any subprocess provider.

No default Codex/Grok/OpenCode model ids ship in this config. Omitting a
provider sub-block preserves each CLI's default-model behavior exactly.

Each sub-block validates like the other sparse blocks: values must be strings, a
non-map block fails at startup, and wrong value types report the dotted key (for
example `models.profiles.deep.grok.implement`). Unknown step keys inside a block
are ignored.

#### Reasoning effort at provider boundaries

A step carries one scalar `effort` (`low | medium | high | xhigh | max`); there
is no per-provider effort override. Pelaggio translates that single value at each
provider's boundary into the vocabulary that CLI accepts:

- **Grok** and **Codex** accept `low | medium | high`. Pelaggio preserves `low`
  and `medium` and collapses `high`, `xhigh`, and `max` to `high`. Codex receives
  the mapped value as `-c model_reasoning_effort=<low|medium|high>` on every
  `exec` run, whether or not a Codex model is pinned.
- **Claude** consumes the full five-value scale directly.

## Provider binaries

The top-level `providers` block (distinct from the per-profile `providers`
sub-block above, which selects a step's backend) pins the **executable** a
subprocess-backed provider spawns. Without it, each provider resolves its
default binary through `PATH` (`codex` runs `codex`):

```yaml
providers:
  codex:
    bin: /opt/codex/bin/codex   # absolute path
  # A leading ~/ expands to the home directory — pins an off-PATH driver:
  # grok:
  #   bin: ~/.grok/bin/grok
  #   allow-unsandboxed-fallback: false
```

Keys are validated against the registered provider names, so an entry for a
provider that is not yet wired in fails loudly at startup rather than silently
doing nothing. `bin` must be a non-empty string. The `claude` provider runs
in-process (no subprocess), so a `bin` override for it has no effect.

### Grok sandbox

The end-to-end setup and supervised fallback procedure live in the
[Grok operator guide](./grok.md); this section is the configuration reference.

On Linux, Grok's custom sandbox requires both `bubblewrap` and kernel Landlock support (Landlock
must appear in `/sys/kernel/security/lsm`). Every Grok step normally installs and explicitly
selects the namespaced `pelaggio-worktree-v1` profile in `~/.grok/sandbox.toml`; unrelated user
profiles and file permissions are preserved. Missing Landlock or profile installation failure
refuses the step by default.

On a Landlock-less Linux host such as a default WSL2 kernel, operators may explicitly set
`providers.grok.allow-unsandboxed-fallback: true`. Pelaggio then starts Grok without `--sandbox`
and prints a loud warning. Until the Pelaggio host-side jail is wired, only environment-secret
denial and CWD guidance remain; this is acceptable for local supervised dogfooding, not unattended
operation. The option does not bypass malformed or unwritable profile configuration when Landlock
is available. Built-in web search remains disabled in either mode.

The profile extends Grok's `strict` policy, so project/source access is limited
to the invocation CWD. Grok still needs its executable, system libraries and
certificates, and its own authentication/session/sandbox-event state under
`~/.grok`. Linux read-deny needs `bubblewrap`; macOS uses Seatbelt. Grok
0.2.103 only enforces `restrict_network` for child commands on Linux.

Pelaggio also passes `--disable-web-search`, disabling Grok's built-in web
search/fetch. Grok 0.2.103 has no hostname-firewall setting for its in-process
model client: `cli-chat-proxy.grok.com` is the sole destination observed and
locked by release conformance, not an OS-enforced allowlist.

After a Grok upgrade, capture DNS names and/or TLS SNI for the same probe run
with a privileged tool such as `tcpdump`, normalized without paths, payloads,
queries, or authentication. Then run:

```bash
PELAGGIO_GROK_LIVE_CONFORMANCE=1 \
PELAGGIO_GROK_NETWORK_CAPTURE=/path/to/normalized-capture.txt \
npx tsx --test --test-name-pattern='live Grok' \
  packages/pelaggio/scripts/pelaggio/__tests__/grok-sandbox.test.ts
```

This release gate requires Linux, Grok 0.2.103, `bubblewrap`, valid Grok auth,
network access, and packet-capture privileges. A destination change requires a
security review; do not update the fixture as a routine snapshot refresh.

## Pinning a profile per run

`--profile <name>` pins the model/provider profile for the entire run, where
`<name>` is any profile under `models.profiles` (`standard`, `quick`, or a
custom one). A pinned profile **suppresses the automatic quick-mode downgrade**,
so the step set and backend stay identical across runs — useful for a
capability bake-off (e.g. `pelaggio run --parallel 1 --profile <driver>` per
driver in separate sessions). Invalid names fail fast at startup with the list
of valid profiles.

## Ship target

`ship.target` selects how `/ship` lands the branch. Three modes:

| Value            | Behavior                                                         |
|------------------|------------------------------------------------------------------|
| `direct-push`    | Squash, merge into local `main`, push, update docs, clean up.    |
| `pull-request`   | Squash, push branch, `gh pr create`. Stop. No docs, no merge.    |
| `auto-merge-pr`  | As `pull-request` + `gh pr merge --auto --squash`.               |

Default: `pull-request`. Precedence: `--target` CLI flag > `ship.target` yml > default.
Invalid values fail fast at startup with the list of valid names.

`pull-request` is the default because it keeps a human review gate in the loop.
`direct-push` and `auto-merge-pr` push to the remote autonomously with no review gate, so
they are **explicit opt-ins**: whenever either is configured, pelaggio emits a loud one-time
banner at startup naming the target and how to restore the gate (`ship: { target: pull-request }`).

**`direct-push` splits the work at the merge.** In pipeline runs the `ship`
step's job ends once the branch is squashed, merged into local `main`, and
post-merge verification passes — it then stops (`ship-merged: <ID>`). Everything
past the merge — recovering any stray `MAIN_REPO` changes as a commit (never
discarded), mark-done, archive-plan, the single `git push`, worktree cleanup,
and claim-branch delete — is run by the **pipeline itself** as deterministic,
zero-turn, idempotent code (`ship/bookkeeping.ts`), not by the budget-capped
agent. This guarantees bookkeeping can't be dropped when the ship step runs out
of turns after merging, and can't destroy a sibling cycle's uncommitted work.
The tail runs only on a **verified** merge (the ship step reported success,
i.e. it completed post-merge verification): a merge that lands but is unverified
(the step ran out of turns) or fails post-merge verification routes to
`/shipwreck` instead of a blind push. Mark-done and archive-plan are independent
best-effort mutations: either failure is reported as a shipped-bookkeeping
warning with a manual remediation command, but the verified feature push is
still attempted. Push/integration failure remains fatal and leaves the branch
intact (recoverable on local `main`). A successful push permits **worktree**
cleanup even when roadmap metadata is incomplete; **claim-branch delete is
gated on mark-done success** so a still-open tracker item cannot be re-picked
until the operator reconciles mark-done and releases the claim (#205). Inline
(human-typed) `/ship` still runs the full flow itself under the same gate.

In PR modes the worktree, local branch, and post-merge doc updates
(task-index, roadmap "Recently completed", plan archive) are intentionally
**not** touched in-session — those land after the PR merges externally.
Automating the post-merge side is planned for TOOL-10 / TOOL-15.

## Roadmap source

`roadmap.source` selects the backend that drives `/pick`, plan lookup, and
scope heuristics. Invalid values fail loudly at startup.

| Value           | Status | Reads                                              |
|-----------------|--------|----------------------------------------------------|
| `markdown`      | ready  | `docs/roadmap-*.md` + `docs/task-index.md`         |
| `github-issues` | ready  | GitHub Issues via the `gh` CLI                     |
| `linear`        | ready  | Linear via `@linear/sdk`                           |
| `beads`         | ready  | Beads issues via the `bd --json` CLI               |

Skill bodies (`/pick`, `/plan`, `/ship`, `/charter`, `/decompose`, `/status`,
`/pickup`, `/shakedown`, `/tidy`) are adapter-agnostic — all roadmap access flows
through `npx pelaggio roadmap ...`, which dispatches to the configured source.

### `pick.max-scope`

The automatic `roadmap next` readiness gate admits declared scopes up to
`pick.max-scope` (default `M`). Items declaring `L` or `XL` are therefore
excluded by default until decomposed. Explicit `--item <id>` and `/pick <id>`
runs bypass this gate as an operator override. Set the threshold to `XL` to
disable scope filtering; items without a declared scope are never gated.

### `github-issues`

### `roadmap.github.*`

Consumed only when `roadmap.source` is `github-issues`:

| Key                           | Default          | Meaning                                                                 |
|-------------------------------|------------------|-------------------------------------------------------------------------|
| `roadmap.github.repo`         | *(required)*     | `owner/name` passed to `gh --repo`. Missing value fails at startup.     |
| `roadmap.github.label`        | `autopilot`      | Label used to filter open issues for `listOpenItems`.                   |
| `roadmap.github.plan-location`| `issue-comment`  | Where plan bodies live. `pr-description` is reserved; not implemented.  |

`gh` availability is probed lazily on first adapter call. If `gh` is not
installed or not authenticated, the adapter throws a clear diagnostic
(`gh CLI required — install https://cli.github.com/` or `gh CLI not
authenticated — run 'gh auth login'`). No config-time probe — tests and
dry-runs can construct the adapter with a stub runner without `gh` on
`PATH`.

Item IDs are bare issue numbers (`"42"`). Branches follow
`feat/issue-<n>[-slug]` where `slug` is a kebab-cased, 40-char-capped
derivation of the issue title. Worktrees follow the same
`${WORKTREE_PREFIX}${id}` convention as the markdown adapter so `--resume`
lookups work identically.

Plan bodies are resolved in two stages: first a local-disk lookup mirroring
the markdown adapter (`docs/plans/issue-<n>-*.md`, then `.dev/plans/<n>.md`),
then the most recent issue comment whose body begins with the
`<!-- pelaggio-plan -->` marker. Comment-sourced plans are materialized to
`.dev/plans/<n>.md` (scratch, typically `.gitignore`'d), **not**
`docs/plans/` — that directory remains `/plan`'s canonical committed output.

#### Curation labels

Priority and deferred projection use **labels as the sole runtime source of
truth** (body text is not consulted for those fields at read time):

| Label             | Effect |
|-------------------|--------|
| `deferred`        | Item stays visible in `list` / `get` with `deferred: true`, but is ineligible for automatic `roadmap next`. Explicit `/pick <id>` / `--item <id>` still claim it. |
| `priority:high`   | Projects as numeric priority `1` (most urgent). |
| `priority:normal` | Projects as numeric priority `2`. If both high and normal are present, high wins. |

Every projected GitHub item materializes priority `1` or `2` (unlabeled → `2`).
`create-item --priority high|normal` adds the matching label (and keeps the
human-readable body marker). Omitted priority adds neither label.

**FIFO within the newest-200 window:** `gh issue list --limit 200` returns the
newest ≤200 matching issues; the adapter then sorts that window by ascending
issue number so equal-priority ties drain oldest-first. This does **not** fetch
the 200 oldest open issues — a backlog larger than 200 still starves issues
outside the newest window until the window slides. Pagination / oldest-window
search is out of scope.

**One-time migration:** older issues may carry only a body line `Priority: high`
without the label. After deploying this projection, run once against the
configured repo:

```bash
npx pelaggio roadmap backfill-priority-labels
```

(or `--json` for machine-readable counts). The command is fail-closed and
idempotent: body-high issues that already have `priority:normal` are reported
as conflicts with zero edits; a clean re-run after convergence labels nothing.

### `linear`

### `roadmap.linear.*`

Consumed only when `roadmap.source` is `linear`:

| Key                            | Default          | Meaning                                                                 |
|--------------------------------|------------------|-------------------------------------------------------------------------|
| `roadmap.linear.team`          | *(required)*     | Linear team UUID. Missing value fails at startup.                       |
| `roadmap.linear.label`         | `""`             | Label filter for `listOpenItems`. Empty string = no filter.             |
| `roadmap.linear.plan-location` | `issue-comment`  | Where plan bodies live. `pr-description` is reserved; not implemented.  |

`LINEAR_API_KEY` is read from the environment on first adapter call. Missing
or unauthorized keys surface a clear diagnostic — never logged, never stored
in config. Linear API keys are scoped to a single workspace, so there is no
`workspace-id` field.

Item IDs are Linear issue identifiers (`ENG-42`). Branches follow
`feat/<team>-<n>[-slug]` lower-cased (e.g. `feat/eng-42-fix-thing`).
Worktrees follow the same `${WORKTREE_PREFIX}${id.toLowerCase()}` convention
as the markdown and github adapters so `--resume ENG-42` lookups work
identically (dashes in directory names are filesystem-safe on every target
OS).

Plan bodies resolve in two stages: a local-disk lookup
(`docs/plans/<team>-<n>-*.md`, then `.dev/plans/<team>-<n>.md`) followed by
the most recent issue comment whose body begins with
`<!-- pelaggio-plan -->`. Comment-sourced plans materialize to
`.dev/plans/<team>-<n>.md` in the worktree — **not** `docs/plans/`, which
remains `/plan`'s canonical committed output.

### `beads`

```yaml
roadmap:
  source: beads
```

No Beads-specific config keys. Consumers must install a compatible `bd`
binary (Beads 1.1.x); Beads carries/uses embedded Dolt — pelaggio does not
install either component. Initialize Beads in the consumer repository so
its authoritative store is `MAIN_REPO/.beads/`.

The adapter always invokes `bd` with `cwd` = the git main worktree
(`dirname(git rev-parse --git-common-dir)`), so list/claim/close/create hit
one shared store even when the CLI runs from a feature worktree.
Per-worktree `.beads` copies may exist for Beads' own sync model; pelaggio
never targets them. Synchronization travels through `refs/dolt/data`, not
markdown-style plain Git JSONL.

`bd` availability is probed lazily on first adapter call. Missing binary
surfaces `bd CLI required — install Beads ...`. No config-time probe — tests
and dry-runs construct the adapter with a stub runner without `bd` on
`PATH`.

| Concern | Behavior |
|---------|----------|
| IDs | Source-assigned lowercase Beads IDs — `bd-<hash>` (e.g. `bd-a1b2`), optionally with a db prefix (`bd-main-a1b2c3`) and/or a hierarchical suffix for epics/sub-tasks (`bd-a3f8.1.1`) |
| Status / ready | Availability from Beads work-readiness (`bd ready` ∪ `in_progress`), never bd claim status; `closed`→done, deps-unmet→`blocked`. **Claimed/in-progress is derived from the live `feat/<id>` git branch only** — a bd `in_progress` item with no branch re-enters availability (dead-holder reconcile) |
| Priority | Beads numeric priority attached as a duck-typed field for flow ranking; pelaggio `high`→1, `normal`→2 on create |
| Dependencies | Structured Beads deps → comma-separated `deps` string |
| Claims | Git `feat/<id>` (slug-free — bd ids contain hyphens/dots) is authoritative. `bd update --claim` is best-effort write-back only. Availability + claimed-status overlay live `feat/*` branches via `claimedIds`, so a failed write-back or a released-branch dead-holder never lets bd status gate pickability |
| Plans | Committed under `docs/plans/<id>.md`; linked with `bd update --spec-id docs/plans/<id>.md` |

Future merge-slot/gate work (#174) must likewise contend against the one
shared `MAIN_REPO/.beads`; this adapter does not implement that landing
primitive.

## Park & auto-resume

When a run hits its rate-limit window the pipeline **parks**: it checkpoints
each in-flight item's uncommitted work and stops that cycle with
`error: "parked"`. In normal (`--cycles` / `--parallel`) mode the orchestrator
then decides whether to wait out the window and pick the parked items back up.

| Key                | Default | Meaning                                                                       |
|--------------------|---------|-------------------------------------------------------------------------------|
| `park.auto-resume` | `true`  | Wait for the limit to reset, then resume the parked items in-process.         |
| `park.max-wait`    | `6h`    | Cap on how long to wait. If the reset is farther out, exit parked instead.    |
| `park.unknown-reset-wait` | `60m` | Estimate to wait when the rate-limit event carries no reset time.        |

**`auto-resume` defaults to `true`.** The pipeline already waited by default
(the old `--max-wait` had a built-in 6h default), so this formalizes existing
behavior into a named, disableable knob rather than introducing a wait. Set
`auto-resume: false` for interactive use where you'd rather get your prompt back
immediately — the run prints the parked item IDs and a ready-to-paste
`pnpm pelaggio --resume <id>` command per parked item, then exits with code 1.

**Multi-window.** Resuming is looped: if the resumed work re-parks in a *later*
rate-limit window, the orchestrator waits again and resumes again, up to an
internal round cap (12). This is what makes a "leave it running overnight" batch
survive several consecutive 5h windows. Each round independently re-checks the
reset timestamp and `max-wait`, so a window whose reset is farther out than
`max-wait` still exits parked rather than spinning.

**Unknown reset time.** Some rate-limit events carry no reset timestamp — every
Codex 429 omits it, and some Claude events do too. Rather than end the run, the
park first tries to recover a concrete reset from the limit message text; failing
that it synthesizes `now + park.unknown-reset-wait` (default 60m, a safe
under-estimate for 5-hourly subscription windows) so auto-resume waits out a
window and retries. The synthesized wait is still bounded by `max-wait`, and the
limit type is suffixed `(estimated)` in the park banner, notify event, and
`.dev/pelaggio-log.jsonl` so the wait reads honestly as a guess. A manual pause
(SIGUSR2) still exits parked with a resume hint — it is never auto-estimated.

**`max-wait` precedence:** `--max-wait` CLI flag > `park.max-wait` (yml) > `6h`.
Because the CLI flag has no built-in default anymore, an unset flag lets
`park.max-wait` take effect; a supervising daemon can therefore set the wait
policy entirely from `.pelaggio.yml`. Accepts the same formats as the flag:
`6h`, `90m`, `1h30m`, or a bare number (minutes). An unparseable value falls
back to 6h.

## Continuous mode (issues #82 / #83)

Long-running **auto-pick** sessions use drain/watch presets so the operator can
leave a campaign running past a fixed `--cycles` count without burning paid
pick steps on an empty queue.

| Flag / config | Meaning |
|------|---------|
| `--continuous` | Enable continuous mode (default preset: `drain`). |
| `--preset drain\|watch` | Preset alone also enables continuous. **drain** exits when the free queue probe is empty; **watch** sleeps `--probe-interval` (default `5m`) and re-probes without a pick agent. |
| `--day-budget <usd>` | Day-spend cap (local timezone). Counts pick cycles, revise sweeps, and local review sweeps. |
| `watch.daily-budget` | Config default for the day-budget when CLI omits `--day-budget`. Absent = unlimited. |
| `--probe-interval <dur>` | Watch-mode free-probe sleep (`5m`, `1h`, bare minutes). |
| `--cycles N` | In continuous mode, default `1` means *no fixed cap*; `N > 1` is a safety ceiling. |
| `--parallel N` | Up to N concurrent paid cycles. Free probe, revise, and idle sleeps share one continuous gate. |

**Day-budget precedence:** CLI `--day-budget` > `watch.daily-budget` > unlimited.

**Budget exhaustion:** **drain** stops when the day budget is exceeded. **watch**
emits `pelaggio.budget-idle`, sleeps until local midnight, rolls the tracker,
emits `pelaggio.budget-wake`, and probes again. (This drain-stop vs. watch-idle
split is intentional and unchanged: drain finishes the queue or stops; only watch
idles to rollover.)

**Day-budget durability (issue #398):** the day-spend total is durable across
process restarts, with no new state file. Every continuous process start (fresh
launch, daemon pause→resume, crash restart) reconstructs today's spend by summing
the `total_cost` of cycle-log lines in `.dev/pelaggio-log.jsonl` whose timestamp
falls on the local calendar day, then seeds the tracker with it — so a same-day
restart resumes at the accumulated spend and a midnight-crossing restart starts
fresh. Pick cycles and revise sweeps already record their cost in the cycle log;
local-review charges additionally append a minimal `budgetCharge` receipt line so
review spend survives a restart too. Those receipts are excluded from `/stats`
cycle and cost tallies. A cycle that crashes before it logs is under-counted by at
most that one cycle's spend; budget is not pre-reserved for in-flight work.

Constraints: auto-pick only (no `--item` / `--resume` / `--no-worktree`).
Continuous mode re-runs the local revise sweep **before each pick iteration** so
newly-red PRs are revised between items, not only at campaign start.

Lifecycle liveness is written to `.dev/flow-events/<streamId>.jsonl` as
`pelaggio.watch-idle|watch-wake`, `pelaggio.budget-idle|budget-wake`, and catalog
`pelaggio.suspended|resumed` (rate-limit / operator-pause / sdk-outage). The
server tails that segment for UI activity; stdout remains an operator log only.

```bash
# Drain the ready queue once, free-probing emptiness
pnpm pelaggio --continuous --preset drain --verbose

# Watch overnight with a $25/day hard cap
pnpm pelaggio --preset watch --day-budget 25 --probe-interval 10m --verbose

# Parallel drain (gate serializes probe; paid cycles may overlap)
pnpm pelaggio --preset drain --parallel 2
```

Server/UI surface: Drain ×1 / Drain ×2 / Watch ×2 presets and advanced controls
in the web Start form (issue #83).

Auto-resume applies only to the normal `--cycles` / `--parallel` driver. A
single-item `--resume <id>` invocation that re-parks is itself re-runnable by
the same command, so it is intentionally not looped.

## PR review runner

`review.runner` selects who owns the required `review` context:

| Key | Default | Meaning |
|-----|---------|---------|
| `review.runner` | `ci` | `ci` runs `.github/workflows/pr-review.yml`; `local` runs the review sweep from the trusted local tree. |
| `review.statusless-after` | `2h` | In local mode, emit `review-stranded` and leave a PR diagnostic when a same-repo pelaggio PR has no `review` status this long. |
| `review.max-passes` | `1` | Independent review iterations, integer `1..3`. One preserves the safe rollout/current behavior. |
| `review.budget-cap` | `20` | Positive finite aggregate dollar cap. A full required iteration is reserved before it starts. |
| `review.provider-diversity` | `off` | `off`, `prefer`, or `require`; `require` blocks before agent work unless **at least one** review driver differs from the scalar verifier provider. |

Local mode is only active in normal auto-pick runs for github-issues roadmaps and PR
ship targets. Configure the model provider through the existing non-pipeline
`pr-review` step settings. By default, `pr-verify` inherits the resolved
`pr-review` model, Codex model, and provider (the pool's **first** entry when
`pr-review` is a list) while retaining its independently configurable global
budget, turn limit, and effort.

### Multi-driver `pr-review` fan-out

A provider pool on `pr-review` is a **fan-out set**: every candidate runs the
same standard (and, when triggered, red-team) discovery prompt concurrently.
`pr-verify` stays scalar — one isolated verification session per blocker-bearing
driver report. The gate is all-pass / fail-closed: every required
`(driver × label)` cell must complete with a valid effective PASS. A mix of
valid PASS and findings-BLOCK is recorded as typed `agreement: disagreement`
(still BLOCK; human escalation is #244). Infrastructure failure is
`agreement: invalid`, never mislabeled as model dissent.

**Budget-cap multiplication (operators size the cap; pelaggio does not auto-raise it):**

```
reservation = labels × drivers × (pr-review budget + pr-verify budget)
```

Defaults are `$5` + `$5` per cell and `review.budget-cap: 20`. A 2-driver pool
with only the standard label reserves `$20` (fits). The same pool with a
security-triggered red-team label reserves `$40` and fails preflight under
defaults. Enabling a multi-driver pool almost always requires raising
`review.budget-cap`; red-team multiplies again.

```yaml
review:
  runner: local
  statusless-after: 2h
  max-passes: 2
  budget-cap: 40   # size for labels × drivers × (review+verify)
  provider-diversity: require

models:
  profiles:
    standard:
      providers:
        pr-review: [claude, codex]   # fan-out; order is render/aggregation order
        pr-verify: codex             # scalar verifier (independent of the pool)
      codex:
        pr-review: gpt-5-codex
        pr-verify: gpt-5-codex
```

Scalar `pr-review: codex` remains a one-driver pool (current single-driver
behavior). `provider-diversity: require` accepts a pool when **at least one**
review driver differs from the verifier (rejects only when *every* review
driver equals the verifier). Metrics render the pairing as
`claude+codex/codex`, not a single `review/verify` string.

For a single-driver cross-provider setup without fan-out:

```yaml
models:
  profiles:
    standard:
      pr-review: claude-opus-4-8
      providers:
        pr-review: claude
        pr-verify: codex
      codex:
        pr-verify: gpt-5-codex
```

When using local mode, set the repo variable `AUTOPILOT_REVIEW_RUNNER=local` so the
CI workflow does not run review tooling from the PR branch. The local `gh` auth must
be able to write commit statuses and PR comments.

## Safety taxonomy

`review.taxonomy` overlays the ADR-0016 class-to-tier table. Class IDs are lowercase kebab-case
tokens with at most one slash; values are exactly `safety` or `judgment`. Unknown finding classes
default to `safety`. Adding a safety class, or elevating a baseline judgment class to safety, needs
no signature. Moving a baseline safety class to judgment or introducing a new judgment class is a
contraction and fails config loading unless its contract signature verifies.

The verification key is the operator's Ed25519 public-key PEM, supplied out-of-band through the
`PELAGGIO_TAXONOMY_PUBKEY` environment variable — never through YAML or repo source. This keeps the
trust anchor outside the agent's write surface: a worker cannot seat its own key and self-sign a
contraction, because the key it would have to overwrite does not live in any file it can edit. If the
variable is unset, contractions fail closed with a "no owner trust anchor is configured" error, while
safety extensions (which need no signature) continue to load. Keep the matching private key outside the
repository and pipeline, and set `PELAGGIO_TAXONOMY_PUBKEY` in the operator environment that runs
pelaggio.

Use the operator CLI to inspect and authorize a contraction:

```bash
npx pelaggio taxonomy canonical --config .pelaggio.yml
npx pelaggio taxonomy sign --private-key /secure/operator-ed25519.pem --config .pelaggio.yml
# Paste the emitted signature-b64 under review.taxonomy.contract, then:
npx pelaggio taxonomy verify --config .pelaggio.yml
```

The signed bytes are a domain-separated, versioned envelope over the canonical, code-unit-sorted
contraction set only (`{"domain":"pelaggio.taxonomy.contraction.v1","contractions":[...]}`). Safety
extensions are excluded, so adding one does not invalidate an existing authorized contraction. The
domain tag prevents a signature made with the same owner key for another protocol from being replayed
onto a contraction. The taxonomy parser rejects unknown keys and malformed values rather than silently
ignoring them.

**The ambiguity sink is non-contractible.** The class the emission classifier assigns to an *ambiguous*
finding (`correctness-regression`) cannot be contracted even with a valid owner signature — the
"ambiguous ⇒ safety" rule (ADR-0014) is load-bearing, so demoting the sink would silently gut the floor
for every unclassified finding. Attempting to contract it fails config loading before the signature is
even checked.

**Scope of the signed gate.** This gate closes the *config-only* floor shrink. It does **not** close the
*source-integrity* surface: the classifier, the verifier, the baseline table, and the blocking
predicates all live in the repo, so a code change to any of them could neutralize the gate. That is out
of scope by construction — the gate is deterministic only when pelaggio runs from a pinned/installed
package outside the candidate checkout (its actual execution model; hardened further by the confinement
work), never from the PR branch under review. Treat the taxonomy code path as a code-review +
confinement integrity surface.

**Replay residual (documented, intentional).** A signature authorizes that exact contraction set
indefinitely; there is no nonce or expiry, so an owner-signed demotion can be re-applied later without a
fresh ritual, and revocation is by key rotation or removing the `contract` block. If the same owner key
is reused across repositories, a signature valid in one repo verifies in another with the same contracted
class set — use a distinct anchor key per repo where cross-repo replay matters.

## Local revise sweep

When a PR-mode ship opens a pull request and the `review` merge gate comes back
red, the change stalls until a human intervenes — unless something reruns the
implement step against the review's findings. `revise.local` makes the **local
runner** do exactly that, in-process on your Claude subscription.

| Key            | Default | Meaning                                                                    |
|----------------|---------|----------------------------------------------------------------------------|
| `revise.local` | `true`  | At the start of an auto-pick run, sweep for red-review PRs and revise each. |

At the start of a normal `--cycles` run (before the pick worker pool), the
orchestrator lists open PRs, keeps the ones whose `review` check failed on a
`feat/issue-<n>` branch, and — **exactly once per PR** — re-runs the implement
step from the PR-review findings and re-pushes so the gate re-runs. It reuses
the same in-process resume the park/auto-resume loop uses (`startFrom:
implement` + a fetched `--review-findings` file), so parking, notifications, and
cost accounting all apply. Revisions do **not** consume `--cycles` (that sizes
new-work throughput) but **do** count toward `--budget` (they spend real money).

**Default-on is safe because the sweep is a hard no-op** unless the run is:

- `roadmap.source: github-issues`, **and**
- a PR ship target (`pull-request` or `auto-merge-pr`), **and**
- pure auto-pick mode (`--cycles`, no `--item` / `--resume` / `--no-worktree` /
  `--dry-run`).

For every markdown / direct-push consumer it does nothing. Set `revise.local:
false` to turn it off entirely — the documented off-switch, mirroring the CI
loop's repo-wide `AUTOPILOT_AUTO_REVISE=false` variable.

**One-pass bound.** Like the CI loop, a PR is revised at most once: the sweep
adds an `autopilot:revised` label **before** any work, filters labeled PRs out
of the candidate set, and posts a single human-handoff comment on a labeled PR
that is still red. Any `gh`/git error in the sweep logs and skips — it never
throws into the run. This is the **local** counterpart to the API-funded CI
workflow (`.github/workflows/pr-review-revise.yml`); see
[docs/pr-review.md](./pr-review.md) for which path is active.

## Spawned-agent env allowlist

Driver subprocesses (codex today, grok next) run work influenced by untrusted
repo/issue/PR text. To stop a prompt-injected step from reading credentials, they
are spawned with a **deny-by-default environment**: only a fixed allowlist
(`PATH`, `HOME`, locale/cert vars) plus any names you add here is forwarded — the
child never inherits the full parent environment (issue #237, TC-014).

Subscription auth keeps working out of the box because codex/grok read their
tokens from files under `HOME`. Add a var only when a driver needs it in the
environment — e.g. an API key for key-based auth:

```yaml
security:
  env-allowlist: [OPENAI_API_KEY, XAI_API_KEY]
```

`security.env-allowlist` must be an array of strings. Independently, captured
driver stderr and the verbose `.dev/*.log` transcript are **secret-scrubbed
before write**: credential-shaped strings (JWTs, provider keys, tokens) and the
values of secret-named env vars are replaced with `[REDACTED]`.

## Notifications

Unattended runs have no outbound signal by default — you learn a cycle parked,
failed, shipped, or opened a PR only by tailing `.dev/pelaggio-log.jsonl`. The
`notify` block turns that poll into a **push**: one best-effort webhook per
terminal cycle, sent from deterministic orchestrator code *after* the pipeline
returns, so a notification fires even when the agent step died mid-cycle.

`decision` is separate from terminal-event precedence: every assistant `DECISION:`
sentinel produces its own notification when the step ends. It is subscribed by
default. Its payload carries the decision, item, step, durable source, log path,
and timestamp; it does not synthesize cycle cost or completion fields.

The canonical durable authority is **per-item** under
`docs/decision-log/<owner>.md` (item ID, or `run-<runId>` for unclaimed
emissions), distinct from the `docs/decisions/` ADR directory.
`docs/decisions.md` is a **generated index only** — regenerate with
`npx pelaggio decisions rebuild-index`; the pipeline never writes it.

Active and Resolved tables share the columns
`Decision | Status | Chosen/leaning | Alternatives | Source | Date`. Sentinel
rows start as `default-taken`; lifecycle tooling changes them to `resolved` or
`resolved→ADR-nnnn`. Source is the best durable item, PR, or review-note
reference.

Lifecycle and projection commands:

| Command | Purpose |
|---------|---------|
| `npx pelaggio decisions resolve <id> …` | Move an Active row to Resolved in its owner file (or, from main, the unique sibling worktree that owns the ID) |
| `npx pelaggio decisions archive-resolved --older-than 30d` | Move eligible Resolved rows into `docs/decision-log/archive/<owner>.md` |
| `npx pelaggio decisions migrate` | One-time legacy migration from a shared `docs/decisions.md` register into per-owner authority |
| `npx pelaggio decisions rebuild-index` | Cold-path projection of all non-archive authority files into `docs/decisions.md` |

Ordinary emissions use an opaque UUID lifecycle ID plus a separate content
fingerprint; retries with the same run/step/occurrence/fingerprint are
idempotent (attempt is ignored). ID or fingerprint collisions with unequal
content fail closed. Review escalations keep evidence-bound
`reviewEscalationId` hashes.

**Parked items after migration ships:** worktrees that predate the merged
cutover must merge/rebase main (or re-run `decisions migrate` in that worktree)
so `docs/decision-log/<item>.md` exists before `--resume`; otherwise lookup
returns `missing` and review re-runs rather than honoring a prior resolution.

| Key             | Default        | Meaning                                                            |
|-----------------|----------------|--------------------------------------------------------------------|
| `notify.url`    | `""`           | Webhook / topic URL. Empty = **disabled** (a no-op; no network).   |
| `notify.format` | `json`         | Wire format: `json` \| `ntfy`.                                     |
| `notify.events` | *(all events)* | Which events page you: `parked`, `failed`, `shipped`, `pr-opened`, `shipwrecked`, `review-stranded`, `decision`. |

### Events

Each terminal cycle maps to **at most one** event, by precedence:

| Outcome                                            | Event         |
|----------------------------------------------------|---------------|
| Rate-limit parked                                  | `parked`      |
| Completed via a PR mode (`awaitingMerge`)          | `pr-opened`   |
| Completed (direct-push merge)                      | `shipped`     |
| Routed through `/shipwreck` without recovering     | `shipwrecked` |
| Recoverable / informational (queue-empty, rethink, already-done, aborted, …) | *(skipped — never pages)* |
| Any other non-completion                           | `failed`      |

A cycle that shipwrecked **and recovered** classifies as `shipped`/`pr-opened`
(it did land), but the payload always carries `shipwrecked: true`, so the signal
is never lost.

### Formats

| Format | Body                                   | Best for                                             |
|--------|----------------------------------------|------------------------------------------------------|
| `json` | Full payload as `application/json`.    | Slack incoming webhooks (read `text`) + any generic POST endpoint. |
| `ntfy` | The `text` summary as `text/plain`, with `Title`, `Tags` (per-event emoji), `Priority` (high for `failed`/`shipwrecked`), and `Click` (= `prUrl`) headers. | [ntfy.sh](https://ntfy.sh) phone pushes — renders a first-class notification, not raw JSON. |

### Payload

The `json` format POSTs this shape (fields present when applicable):

```jsonc
{
  "event": "shipped",                 // parked|failed|shipped|pr-opened|shipwrecked
  "itemId": "34",
  "title": "Run-outcome notifications for unattended cycles", // best-effort
  "completed": true,
  "cost": 1.23,
  "error": "ship blocked: dirty tree", // present when the result carried one
  "prUrl": "https://github.com/…/pull/5", // pr-opened / when known
  "shipwrecked": false,
  "logPath": "/repo/.dev/pelaggio-log.jsonl",
  "ts": "2026-07-06T12:34:56.000Z",
  "text": "pelaggio: shipped 34 \"Run-outcome notifications…\" — $1.23"
}
```

**Best-effort only.** Delivery is a single bounded (5s) POST — any failure
(network, DNS, timeout, non-2xx) is swallowed and never fails a cycle; a failed
delivery leaves one `⚠ notify: …` warning on stderr so a mistyped URL is
diagnosable. There is no retry, queue, or persistence. Title is best-effort
too: a failing roadmap lookup simply omits `title`. The lookup bound depends on
the adapter — async adapters (linear) are raced out at ~3s; the gh CLI adapter
runs synchronously and is bounded by its own 30s subprocess timeout instead.

## Unknown keys

Top-level keys not recognized by the current loader (`project`, `docs`,
`roadmap`, …) are silently ignored. This keeps forward-compatibility as
future tools extend the schema. Unknown step keys inside a recognized
section (e.g. `budgets.bogus: 5`) are also ignored.

## Not configurable (yet)

- `REPO` / `LOG_PATH` — derived from the module location.
- Runtime reload — load-once at startup.
- Schema validation beyond shape checks — add `zod` if/when warranted.
- Secret handling — store secrets in the environment, not here.
# Human resolution of cross-model review splits

When successfully parsed authoring reviewers disagree (at least one pass and one block), Pelaggio records the commit-bound evidence in `docs/decision-log/<itemId>.md`, sends the existing `decision` notification when subscribed, and parks for every ship target. Notification delivery is best-effort and never changes the gate.

Resolve the recorded decision explicitly, then resume the item:

```bash
npx pelaggio decisions resolve <decision-id> --disposition proceed --by <actor> --reason "<rationale>"
npx pelaggio --resume <item-id>
```

Run `resolve` from the item worktree, or from the main checkout when the ID is unique across sibling worktrees (0 or >1 matches fail closed). Flag syntax is unchanged. Use `--disposition block` to retain the block. A `proceed` resolution applies only to the unchanged reviewed commit and exact recorded evidence. Missing, malformed, ambiguous, stale, or safety-class evidence fails closed and parks; changing the code requires a fresh review.
