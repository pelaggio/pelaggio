# Plan — Team Adoption & Packaging

**Status:** draft, pending adversarial review
**Goal:** make Pelaggio installable and maintainable by a small team on a polyglot
monorepo (Rails + React frontend, plus Python and Node apps), with strong defaults that
produce higher-quality, lower-variance output that is easy to review and steer from the PR,
ticket, and task sides.

## Target consumer

One monorepo containing:

- a Rails app (Ruby, `Gemfile`, RSpec/Minitest, RuboCop)
- a React frontend (Node, likely pnpm/npm workspaces, Vitest/Jest, ESLint or Biome)
- one or more Python services (`pyproject.toml`, pytest, ruff)
- one or more additional Node apps

A 3–6 person team. Not every developer is a Node developer. Nobody wants to learn
Pelaggio's internals to get a first PR.

This shapes every decision below: **the harness must not assume its own stack is the
consumer's stack**, and Ruby/Python developers must never have to reason about pnpm.

## Current state (verified)

- Skills hardcode `pnpm check`, `pnpm -r test`, `pnpm install --frozen-lockfile`.
- `worktree-deps` shares dependencies by symlinking `node_modules`; there is no
  equivalent for `bundle`, `venv`/`uv`, or a mixed tree.
- There is no `verify:` key in `.pelaggio.yml`; verification commands are not configurable.
- `tsx` is a runtime dependency and `main`/`exports` point at `.ts` — every CLI
  invocation pays a TypeScript loader boot.
- No preflight/doctor command; no config schema or validation, despite `ajv` being present.
- `.claude-templates/README.md` and `_rubric.md` still carry Fathom/Expo/Jest/Zustand
  content that does not apply to a consumer.
- Review posture is now high-assurance in this repo (3-driver fan-out, `require`
  diversity, 2 passes) but there is no way for a consumer to ask for that by name.

## Non-goals

- Multi-tenant SaaS, hosted control plane, or any telemetry.
- Replacing the provider CLIs' own auth.
- Full flow/landing-queue concurrency work (tracked separately; this plan assumes
  teams partition by area until it lands).

---

## Phase 1 — Polyglot portability

The blocking prerequisite. Nothing else matters if a Rails developer cannot run a cycle.

### 1.1 `verify:` configuration block

Replace hardcoded pnpm commands with a declared, ordered verification contract:

```yaml
verify:
  # Per-ecosystem, not a single shell string — see "Reconciling verify.install" below.
  install:
    node:          pnpm install --frozen-lockfile
    ruby:          bundle install
    python-uv:     uv sync
    python-poetry: poetry install   # distinct ecosystem, not interchangeable with uv
  stages:
    lint:      { run: bin/lint,      required: true }
    typecheck: { run: bin/typecheck, required: true }
    test:      { run: bin/test,      required: true }
```

`required` **defaults to `true`**. A declared stage blocks on a non-zero exit unless it is
explicitly marked `required: false`. Defaulting to advisory would make it possible to ship
a stage that silently never blocks, which is the failure mode this whole seam exists to
prevent. Every example in this plan and in the generated config states `required`
explicitly anyway, so the default is a backstop rather than something readers must infer.

- Skills call `npx pelaggio verify --stage lint`, never a package manager directly.
- Each stage reports typed pass/fail with captured output, so the gate reads a
  deterministic result rather than scraping agent prose.
- Default when `verify:` is absent: today's pnpm behavior, so this repo is unaffected.

**The gate is harness-side, not skill-side.** A skill *invoking* `pelaggio verify` is a
convenience, not the gate — an agent that never runs it, or runs only the cheap stage,
must not be able to pass. Per the mechanism/policy spine (ADR-0014), the pipeline itself
runs every `required: true` stage after `implement`/`shakedown-code` and fails closed on
a non-zero exit, a missing stage result, or a stage it could not execute. Stage results
are recorded as effect-confirmed outcomes, so "the step said it verified" is never the
evidence. The skill-side invocation exists so agents can iterate mid-step; the blocking
decision belongs to the harness.

**The gate's configuration is pinned at cycle start and read from the main repo.** A
worktree's `.pelaggio.yml` is agent-writable, so a gate that resolved `verify.stages` by
walking up from the worktree cwd could be defeated by rewriting every stage to `exit 0` —
the agent would be authoring its own passing criteria. Therefore:

- The blocking gate loads `verify:` **once, at cycle start, from `MAIN_REPO/.pelaggio.yml`**,
  and records its digest in the cycle record.
- A worktree-side `pelaggio verify` invocation is advisory-only and clearly labelled as
  such; it never produces the effect-confirmed result the gate consumes.
- If the worktree's `.pelaggio.yml` differs from the pinned one, the harness reports it as
  a finding rather than silently honoring either version. Legitimate config changes ship
  as a reviewed diff on the PR, which is the correct place to change the bar.

This is the same reasoning as the plan-documents-are-read-only-during-implement rule: the
worker may not edit the standard it is being measured against.

**Path-scoped stages** matter for a monorepo — running the full Rails suite for a
frontend-only diff is the difference between a usable and unusable cycle:

```yaml
verify:
  stages:
    rails-test: { run: bin/rails test,  when: "app/**,lib/**,test/**", required: true }
    web-test:   { run: pnpm -C web test, when: "web/**",               required: true }
    lint:       { run: bin/lint,         required: true }   # unconditional safety net
```

`when` is matched against the **cumulative branch diff** — three-dot
`origin/main...HEAD` for the item's branch — not against the last step's delta and not
against the declared write-set.

The distinction is load-bearing, and getting it wrong fails the gate open. The gate runs **once per
verifying step** (after `implement` and after `shakedown-code`), and each run selects
stages from the whole branch's changes. If selection used only the most recent step's
delta, a `shakedown-code` pass that touched only `web/**` would deselect the Rails stages
covering the `app/**` changes `implement` made earlier; the unconditional lint stage would
still pass and the gate would go green having never run the tests for the code under
review. Cumulative selection means a path, once touched anywhere on the branch, keeps its
stages selected for every subsequent gate run.

Declared write-sets are excluded as a selection input for a related reason: they are still
design-only and unenforced (`(flow, planned)` in `AGENTS.md`), so
preferring them would let an under-declared write-set skip required stages and fail the
gate open — precisely the outcome this seam exists to prevent. Once write-set enforcement
lands, the write-set may be used as an *additional* selector that can only widen the
selected set, never narrow what the diff selected.

Match semantics are fail-closed and must be specified before implementation:

- A stage whose `when` **misses** is *skipped*, and a skipped stage cannot block. This is
  the only way path scoping saves any time.
- `required: true` therefore means "must pass **when selected**", not "must always run".
- **Zero stages matched fails closed**, not open. An empty selection means the diff
  touched paths no stage claims — that is a configuration gap, not a clean run, and it
  blocks with a message naming the unmatched paths.
- Stages with no `when` always run and are the safety net that makes the zero-match case
  rare; `config check` warns when no unconditional required stage exists.

### 1.2 Language-aware worktree dependency sharing

Generalize `worktree-deps` from "symlink `node_modules`" to a per-ecosystem strategy,
each with the same lockfile-match → link, drift → install fallback:

Sharing is **content-addressed by lockfile digest**, never a single mutable shared prefix.
Each ecosystem's install prefix lives at a path keyed by the digest of its lockfile, so
worktrees with identical lockfiles read the same prefix and a worktree with drift resolves
to a *different* prefix rather than mutating the one its siblings are using:

| Ecosystem | Detect | Prefix (keyed by lockfile digest) | On drift |
|---|---|---|---|
| Node | `pnpm-lock.yaml` | share external deps for that digest, **materialize workspace packages worktree-local** | frozen install into the new digest's prefix |
| Ruby | `Gemfile.lock` | `BUNDLE_PATH` → `.dev/deps/ruby/<digest>` | `bundle install` into the new digest's prefix |
| Python | `uv.lock` | `UV_PROJECT_ENVIRONMENT` → `.dev/deps/python/<digest>` | `uv sync` into the new digest's prefix |
| Python | `poetry.lock` | `POETRY_VIRTUALENVS_PATH` → `.dev/deps/python-poetry/<digest>` | `poetry install` into the new digest's prefix |

Two rows deserve emphasis because a literal reading of "share the prefix" would regress
existing behavior:

- **Node is not a plain shared symlink.** `worktree-deps` today materializes workspace
  subpackages so every workspace entry resolves *inside the worktree*, while external
  dependencies may be shared. That materialize/rematerialize semantics is load-bearing for
  monorepo worktrees and must be preserved when generalizing — a worktree whose workspace
  packages resolve into the main checkout is the isolation bug this whole mechanism exists
  to prevent.
- **Poetry and uv are separate ecosystems**, not one "Python" row. They use different
  environment variables, different prefix layouts, and different install commands; driving
  a Poetry project with `uv sync` fails or corrupts the environment. If only one is
  implemented first, the other must be detected and reported as unsupported rather than
  silently handled by the wrong toolchain.

A drift install is therefore always a write to a prefix no other worktree is reading. This
is what makes sharing safe; a plain shared `vendor/bundle` or shared venv would recreate
exactly the shared-state corruption `INSTALL_PATTERN` exists to prevent.

Fail soft: an unknown ecosystem reports that it could not share and falls back to a
harness-run install.

**Reconciling `verify.install` with worktree isolation.** These two are in direct tension
and the plan must not paper over it. Today `INSTALL_PATTERN` in `step-runner.ts` blocks
agent-initiated `pnpm`/`npm` installs so a worktree cannot corrupt the main checkout's
`node_modules`; only `worktree-deps` may install. Introducing a `verify.install` key that
runs `bundle install && uv sync` would either bypass that guard or be blocked by it.

Resolution:

- `verify.install` is **keyed by ecosystem, not a free-form shell string.** A single
  `a && b && c` line cannot be reconciled with per-ecosystem lockfile share/drift logic,
  because the harness cannot tell which fragment corresponds to which lockfile. Each key
  maps to exactly one ecosystem's drift decision.
- **Precedence is explicit:** for each detected ecosystem, `worktree-deps` first attempts
  the share strategy in the table above. The configured `install` command runs **only** on
  lockfile drift, a missing share source, or an ecosystem with no share strategy. It is
  never both. When a configured command exists it replaces the built-in fallback for that
  ecosystem; when absent, the built-in fallback runs.
- `verify.install` is **executed by the harness through `worktree-deps`**, never by an
  agent, and never as a skill-issued shell command. It is a declaration of how to install,
  not a command an agent runs. It executes with the worktree as cwd and with the
  ecosystem's prefix variables (`BUNDLE_PATH`, `UV_PROJECT_ENVIRONMENT`) already pointed
  at the digest-keyed prefix, so a drift install cannot write to a prefix another worktree
  is reading.
- The install guard is extended beyond npm/pnpm to **every ecosystem in the table above**.
  `INSTALL_PATTERN` currently matches only `pnpm`/`npm`, so on a polyglot repo
  `bundle install`, `uv sync`, and `poetry install`/`poetry add` would sail past the guard
  entirely and mutate shared state — a pre-existing hole that this phase must close, not
  widen. The guard entry and the share strategy for an ecosystem **land in the same
  change**: adding `poetry` to the ecosystem table without a matching guard entry
  reintroduces exactly the corruption the guard exists to prevent. An ecosystem with no
  guard entry is not supported, and `doctor` says so.
- Ecosystem sharing is per-worktree and content-addressed by lockfile digest, so a
  worktree with drifted dependencies installs into its own prefix rather than mutating
  a shared one.

### 1.3 Detection-driven `init`

`init` inspects the repo and generates a `verify:` block and rubric skeleton rather than
emitting a stub the user must fill in blind. `Gemfile` → Rails stages; `pyproject.toml` →
pytest/ruff; workspace globs → per-package stages. Print the detected plan and write it
only on confirmation (or `--yes`). This is the single largest "delightful setup" lever:
it turns a 30-minute config-doc read into a 30-second review of a generated file.

---

## Phase 2 — Strong defaults and presets

### 2.1 Named presets

```bash
npx pelaggio init --preset team
```

| Preset | Ship target | Review | Intended use |
|---|---|---|---|
| `solo` | `pull-request` | 1 pass, diversity `off` | one operator; matches today's shipped defaults |
| `team` | `pull-request` | 2 passes, 3-driver fan-out, diversity `require` | **recommended for a team** |
| `strict` | `pull-request` | 3 passes, diversity `require`, red-team forced on | regulated / high-stakes |

**No preset sets an autonomous merge target.** `DEFAULT_SHIP_TARGET` is `pull-request`
and stays that way in every preset: `direct-push` and `auto-merge-pr` remove the human
merge gate and must remain an explicit, individually-opted-in choice with its startup
banner (ADR-0003). A preset is a convenience bundle; it is never a path by which a team
loses a review gate it did not ask to lose. This repo's own `auto-merge-pr` setting is a
deliberate dogfooding posture, not the product default, and must not be mistaken for one
when the preset table is implemented.

A preset is a named bundle of existing keys, rendered into `.pelaggio.yml` **as commented
YAML the team can read and edit** — not hidden defaults in code. `team` deliberately keeps
a human merge gate: for a team, "who reviewed this" is a social contract, not just a check.

Two presets require new keys rather than existing ones, and this is a scope cost, not a
bundling exercise:

- `strict`'s "red-team forced on" **does not exist today**. Red-team is triggered solely
  by the diff security signal (`readSecuritySignal`); there is no configuration key that
  forces the label on. `strict` therefore depends on a new `review.red-team: auto | always`
  key, which must land before the preset can claim it.
- The preset table above is otherwise expressible in existing keys.

Presets need a matching `review.budget-cap`. `init` computes it as
`labels × drivers × (pr-review budget + pr-verify budget) × max-passes` — the per-iteration
reservation is what preflight checks, but `budget-cap` is the **aggregate across passes**,
so the multiplier is required. `init` writes the arithmetic as a comment, so a preset can
never preflight-block on the cap it shipped with. Worked example for `team`: red-team
trigger gives 2 labels × 3 drivers × $10 × 2 passes = $120.

### 2.2 Diversity on by default, scoped to available harnesses

`review.provider-diversity` currently defaults to `off`, and the review pool is a
hand-written list of provider names. Both should change: **diversity is the single
cheapest lever on output quality and review independence, so it should be the default** —
but a default that assumes three installed, authenticated CLIs would break every
single-harness install on day one.

Resolution, in two parts that must not be conflated:

1. **The default flips from `off` to `prefer`.** The existing
   `off | prefer | require` enum is kept exactly as-is — no new value, no migration, no
   alias. `prefer` already means "use diversity when available, don't block for its
   absence", which is precisely the requested behavior. Introducing an `auto` value would
   also break `review.authoring.provider-diversity`, which is hard-validated to *must* be
   `prefer`; there is no reason to pay that cost for a synonym.
2. **When no pool is explicitly configured, the pool is derived from detected
   capability** rather than defaulting to a single provider.

```yaml
review:
  provider-diversity: prefer   # new default (was: off)
```

- **`prefer` (new default)** — fan out across every driver that is installed,
  authenticated, and configured; draw the verifier from a different provider than the
  pool's first entry when one is available. With three harnesses this gives today's
  high-assurance posture with no configuration at all. With one harness it degrades to a
  single-driver review and says so in the gate comment. It never blocks *for lack of*
  diversity.
- **`require`** — unchanged: block at preflight unless at least one review driver differs
  from the verifier. For teams that want diversity to be a hard gate.
- **`off`** — unchanged: explicit opt-out, for cost-constrained runs.

**Precedence when the explicit pool, the capability probe, and the budget disagree** — the
plan is otherwise ambiguous here, and presets do still write explicit pools:

1. An **explicitly configured pool wins** over derivation. Deriving a pool is what happens
   in the *absence* of configuration, never an override of it. A team that wrote
   `pr-review: [claude, codex]` gets exactly that.
2. Each pool member — configured or derived — is then **filtered by the capability probe**.
   A configured driver that is not installed or not authenticated is dropped with a named
   reason rather than failing mid-run.
3. If filtering empties the pool, the gate **fails closed**: no reviewers is never a pass.
4. `require` is evaluated against the post-filter pool, so a configured-but-unavailable
   second provider cannot satisfy the diversity requirement on paper.
5. Budget is applied last and **never silently drops a driver** — see below.

The detection is the same capability probe `doctor` performs (binary present,
authenticated, version pinned), so this reuses Phase 2.4 rather than adding a mechanism.

**Detection must not make the gate nondeterministic.** A gate whose driver set is
re-probed at arbitrary times could pass a PR with three reviewers and fail an identical
one with two, which would violate the determinism-in-the-harness spine. Therefore:

- Capability is probed **once at cycle start**, and the resolved driver set is pinned into
  the cycle record alongside the config digest.
- The gate consumes the pinned set, never a live probe.
- The resolved set and the reason each unavailable driver was excluded (not installed /
  not authenticated / version mismatch) are rendered in the gate comment and the PR
  provenance block, so "why did only two models review this?" is always answerable after
  the fact.
- A driver that was available at cycle start but fails mid-run is an infrastructure
  failure (`agreement: invalid`), not a silent narrowing of the pool.

Capability-derived pools also remove the most common footgun in the current design: a
hand-listed pool naming a provider the operator never installed, which today surfaces as a
confusing mid-run failure rather than a clear "grok is configured but not logged in."

**The default `budget-cap` must be auto-sized, or this change bricks the gate.** This is
the sharpest edge in the proposal and it is easy to miss: `review.budget-cap` defaults to
`$20`, which covers at most two single-label drivers at `$5 + $5`. Flipping the default to
`prefer` on a machine with three installed CLIs produces a reservation of
`1 × 3 × $10 = $30`, which exceeds the cap — so **every three-harness install would
preflight-block on every PR, permanently**, with no configuration error to point at. The
presets size their own caps; the un-preset default currently would not.

Therefore, when `budget-cap` is not explicitly set, it is **computed** from the pinned
driver set at cycle start rather than taken from a fixed default:

```
default budget-cap = labels × |pinned pool| × (pr-review budget + pr-verify budget) × max-passes
```

with red-team's second label included so a security-triggered PR does not block. An
**explicitly configured** `budget-cap` is always honored as a hard ceiling — a team that
sets $20 means $20. In that case, if the cap cannot cover the pinned pool, the run fails
preflight with the arithmetic and both remedies shown (raise the cap, or narrow the pool);
it never silently drops drivers to fit, because silently reviewing with fewer models than
configured is the failure mode the whole diversity feature exists to prevent.

### 2.3 Config schema, validation, and `explain`

- Publish a JSON Schema; `init` writes the `# yaml-language-server: $schema=` line so
  editors autocomplete and validate inline.
- `pelaggio config check` validates types **and in-file cross-field consistency** — for
  example, that a required unconditional verify stage exists, or that `budget-cap` covers
  the configured pool and pass count.
- The `review.runner` / `AUTOPILOT_REVIEW_RUNNER` / CI-gate trio is **not** a `config
  check` rule: two of the three live outside the YAML file (a GitHub repo variable and a
  workflow gate). Static file validation cannot see them. It belongs in `doctor`, which
  can query live state: read `review.runner` from config, fetch the repo variable via
  `gh api repos/{owner}/{repo}/actions/variables/AUTOPILOT_REVIEW_RUNNER`, and confirm the
  workflow's gating condition agrees. A mismatch is reported as a single finding naming
  all three values, because that trio disagreeing means every PR blocks forever with no
  local signal.
- `pelaggio config explain [--step implement]` prints the fully resolved configuration
  with the provenance of each value (default / preset / file / flag). Teams cannot reason
  about a 1000-line config reference; they can read a resolved table.

### 2.4 `pelaggio doctor`

One command, ✓/✗ per requirement, each failure carrying its fix:

- git version; repo is a git repo; worktree support
- `gh` present, authenticated, scopes sufficient to write commit statuses and PR comments
- roadmap label exists on the configured repo
- each configured provider CLI: present, authenticated, **and at the pinned version**
- Node ≥ 20.6; WSL detected on Windows
- branch protection matches the configured ship target
- resolved `verify:` stages are **resolvable and executable**, which is not the same as
  running them

On that last point: `doctor` must not run a full monorepo test suite. A Rails suite alone
can take many minutes, and a preflight that costs more than the cycle it precedes will be
disabled by the team on day two. The check is tiered:

- **default (`doctor`)** — resolve each stage, verify the entrypoint exists and is
  executable, and confirm the interpreter/toolchain is present. Seconds, not minutes.
- **`doctor --smoke`** — run each stage with its configured `smoke` variant if one is
  declared (`bin/test --smoke`, a single fast spec), otherwise skip and say so.
- **`doctor --full`** — actually execute every stage. Opt-in, for CI or initial setup.

`doctor` (default tier) runs automatically before the first cycle and on `init`
completion. Most first-hour pain today is a prerequisite failing deep inside a cycle
instead of up front.

---

## Phase 3 — Packaging and weight

### 3.1 Compile on publish; drop the runtime TypeScript loader

`prepack` already exists. Emit JavaScript there, keep `tsx` for in-repo development only,
and point `main`/`exports` at the built output. Removes a runtime dependency, removes
loader boot from every `npx pelaggio roadmap …` call inside skill bodies, and makes the
package importable without a TypeScript loader.

### 3.2 Dependency reduction

Audit toward a near-zero-dependency CLI: `yaml`, `ulid`, and `diff` are each replaceable
by a standard-library equivalent or a small vendored routine. For a tool with write access
to a team's repository, the dependency count *is* part of the security posture — and it is
one of the few claims in `docs/trust/` that a reader can verify in seconds.

### 3.3 Distribution beyond npm

A Rails or Python team should not need a Node toolchain to run the harness. In priority
order: (a) keep `npx` working with zero peer dependencies; (b) ship a Node SEA or
Bun-compiled single binary per platform; (c) a Homebrew tap. (b) is what most modern AI
CLIs now ship and is what makes "install it" a one-liner for a non-Node team.

---

## Phase 4 — Reviewability and steering

This is the part that makes agent output reviewable *holistically* rather than
line-by-line, and it is where the team-facing value concentrates.

### 4.1 PR provenance block

Every pelaggio PR body carries a generated, deterministic block:

- the driving item and a link to the plan
- per step: provider, model, effort, tokens, cost, duration
- review findings raised, and for each: upheld or refuted, by which driver, with rationale
- verification stages run and their results
- resolved config digest and pinned provider CLI versions

This converts "review 900 lines of agent-written code" into "review the decisions, then
spot-check the code" — the single highest-leverage change for review quality. The flow
event catalog (#170) is the eventual source; a v0 rendered from the existing cycle log
delivers most of the value without waiting for it.

### 4.2 Ticket-side steering

The rubric is the variance control, so make authoring it a guided step rather than a
fill-in-the-blank file:

- `pelaggio rubric init` interviews the team using the prompts already in the template,
  reads the repo to propose stack-specific bullets, and emits a rubric with the Fathom
  examples removed.
- Support **path-scoped rubric sections** (`app/**` vs `web/**`) so backend and frontend
  can hold different bars without arguing inside one file.
- Item-level rubric overrides via a ticket field, so a spike and a payment-path change do
  not get the same bar.

### 4.3 Operator identity

Stamp an operator identity into every cycle-log record and PR body, and move the daemon
from a single shared bearer token to per-user tokens. Without this a team cannot answer
"who ran this" or revoke one person's access. This is deliberately scoped *below* the full
concurrency work: it is attribution, not co-scheduling.

---

## Phase 5 — Practices expected of a modern AI tool

These are the items that a security-conscious team will ask about, and that a tool with
commit access to their repository should be able to answer.

### 5.1 Reproducibility and provenance

- **Pin provider CLI versions** in config, verify in `doctor`, and record the *resolved*
  versions in every cycle record. An agent CLI that silently self-upgrades changes the
  behavior of the harness underneath a pinned config — this has already happened here.
- **Version the skills/prompts** and surface a changelog, so a `sync` diff is reviewable
  as a behavior change rather than an opaque text edit.
- **npm publish provenance** (`--provenance`), a signed release, and an SBOM. For a tool
  that writes to your repo, this is table stakes, and it is cheap given the existing trust
  manifest.

### 5.2 An eval harness for the harness

The claim "higher quality, lower variance" is currently unmeasured. A golden-task suite —
a set of fixed items with known-good outcomes, run N times, reporting pass rate,
variance, cost, and review-finding counts per configuration — turns preset selection into
evidence and makes prompt/rubric changes safe to land. This is the difference between
asserting the review loop helps and knowing by how much.

It also directly answers the team's question "is 3-driver diversity worth the cost?" with
a number instead of an opinion.

### 5.3 Least-privilege and enterprise fit

- A scoped GitHub App installation as an alternative to a personal `gh` login, so team
  automation is not tied to one person's account.
- Document and enforce the spawned-agent environment allowlist in `doctor`; surface
  exactly which variables cross into an agent session.
- HTTPS proxy and offline/air-gapped support, and a documented egress list.

### 5.4 Reversibility

`pelaggio uninstall`, a documented "abandon a run cleanly" path, and a guarantee that
removing the tool leaves the repository in a valid state. Teams adopt tools they believe
they can back out of.

---

## Sequencing

| # | Item | Phase | Unblocks |
|---|---|---|---|
| 1 | `verify:` block + stage runner | 1.1 | everything non-Node |
| 2 | Language-aware worktree deps **+ extend the install guard to `bundle`/`uv`/`poetry`** | 1.2 | Rails/Python cycles |
| 3 | Detection-driven `init` | 1.3 | first-run experience |
| 4 | `doctor` | 2.4 | support burden |
| 5 | Config schema + `check` + `explain` | 2.3 | config confidence |
| 6 | Presets (+ `review.red-team` key for `strict`) | 2.1 | strong defaults |
| 6b | Diversity default `off`→`prefer` + capability-derived pool + auto-sized cap | 2.2 | quality by default |
| 7 | Template cleanup (Fathom residue) | 2.x | credibility; trivial |
| 8 | Compile on publish + dep reduction | 3.1–3.2 | weight, portability |
| 9 | PR provenance block | 4.1 | review quality |
| 10 | Rubric init + path scoping | 4.2 | variance |
| 11 | Operator identity | 4.3 | team attribution |
| 12 | Eval harness | 5.2 | evidence for all of the above |

Items 1–3 are the minimum viable "a Rails team can use this." Item 7 is an hour and
should not wait for a phase. Item 12 should start early enough to measure 6 and 10.

## Risks

- **`verify:` is a breaking seam.** Skills must migrate together with the config key, or
  a consumer on an older config gets a half-migrated pipeline. Mitigate with an explicit
  default-to-current-behavior path and a `config check` migration warning.
- **Detection-driven `init` guesses wrong** on unusual monorepos. Mitigate by always
  showing the plan and requiring confirmation; never silently write.
- **Preset proliferation.** Three presets, no more, and each must be expressible as plain
  config a team can read and diff. No preset may set an autonomous merge target.
- **The install guard is currently npm-only.** Landing polyglot support without extending
  `INSTALL_PATTERN` would let `bundle install` / `uv sync` mutate shared state from inside
  a worktree. The guard extension must land in the same change as the ecosystem support,
  not after it.
- **Compile-on-publish changes the debugging story** for consumers reading package source.
  Ship source maps and keep the repo runnable via `tsx`.
- **Eval harness cost.** Golden-task runs consume budget; scope to a small suite run on
  demand and before preset changes, not per-PR.
