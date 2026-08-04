# Coordination Spine Context

**Status: design record / target-state.** Like `flow.md`, this describes an
architecture being chartered, not one that ships today. Sections tagged
**(planned)** are not implemented. This is the *enabling cut before flow*: the
`FlowPolicy`, scheduler, write-set contract, and landing queue in `flow.md` all
want to be typed calls, so the seam this doc defines should exist before those
land, or they get built on prose-scrape and inherit its non-determinism.

This doc is the durable home for the *why*. The one-line invariants at the
bottom mirror to `AGENTS.md` when the implementing item ships.

**Update (2026-07, amended by ADR-0025 2026-08):** the substrate question is
decided — pelaggio adopts Beads (`bd`) as the work store (see *Landscape and the
chosen substrate* below). The LANDING primitive is the harness's git ref
compare-and-swap (ADR-0025); `bd merge-slot` is only an optional ordering layer
above that fence. Chartered as #181 (adapter) with the flow items re-pointed onto
it: #171 (FlowPolicy over `bd ready`), #174 (landing discipline above the CAS fence, optionally ordered by `bd merge-slot`/
`gate`), #173 (write-sets — the one layer with no Beads analog, stays pelaggio's).

## The question this answers

*Is the skills/CLI boundary at the right latitude?* The suspicion that started
this: skills are "not deterministic enough" for where the roadmap is going. The
finding: the prose is not sloppy — it is at the wrong **altitude**. The
coordination *decision* runs inside a natural-language interpreter and is
reconstructed in TypeScript by regex. That is fine at depth-1 serial cycles and
becomes load-bearing the moment concurrency needs a sound gate.

## Three latitudes, not two

The skill/CLI split today is drawn at *mechanism vs. everything else*. The right
line has three bands:

| Band | Example | Nature | Belongs |
|---|---|---|---|
| **Mechanism** | claim branch+worktree, `mark-done`, `archive-plan`, worktree-deps | Deterministic | typed CLI call ✅ (already there) |
| **Coordination** | rank the pick queue, recoverable-vs-halt routing, deliverability gate, ship sequence, write-set disjointness | Deterministic *by requirement* | typed call ❌ (in prose today) |
| **Judgment** | write the plan, review vs. rubric, resolve a *semantic* merge | Irreducibly LLM | prose ✅ (leave it) |

Mechanism is at the right latitude. Judgment is at the right latitude — forcing
it deterministic is the opposite error. The whole problem is the middle band:
coordination is expressed as skill prose the harness executes and then
regex-scrapes back into an enum (`parsePickResult`, `parseShipMerged`,
`parseBlockedReason` in `helpers.ts`). The defensive comments on those parsers
(*"first-match-wins is a fail-open hole"*, *"prose 'the task is blocked' never
matches"*) are the seam telling you the value is in the wrong place: a
control-flow decision is being transported as English, calibrated to one model's
prose habits.

## The seam: a typed coordination spine, agent-as-caller

Draw the line so **coordination is a typed tool surface the agent calls**, and
the agent reads a structured result to decide its next call — rather than the
agent *being* the executor of prose the harness scrapes. The agent's loop
becomes: call a typed command → read a classed exit code + machine-readable
output → decide the next call. Judgment stays as the agent's own reasoning
*between* those calls; it never emits scrape-bait.

This is a **hybrid**, not a flip. pelaggio is not a stateless CRUD surface — it
has genuine judgment steps and a flow scheduler to come. The spine carries
mechanism and coordination; judgment prose *calls into* the spine. The agent
still reasons in prose to write a plan; it just *acquires* the item, *reads* the
ranked queue, *declares* its write-set, and *reports* the ship verdict through
typed calls with structured returns.

### Reference exemplar: `cdhorne/zonot`

zonot draws exactly this line for its whole surface (it can, being stateless
capture/read CRUD — it has no judgment band and no flow, so it is a reference for
the *seam shape*, not a template to copy wholesale):

- **One isomorphic core holds the guts;** *"one handler set, two transports"* —
  the logic is written once and the CLI / MCP / HTTP surfaces are thin adapters
  over it.
- **One schema, defined once (TS → JSON Schema),** reused for tool I/O,
  validation, and the conformance test. The contract and the validator are the
  same artifact.
- **Structured returns as discipline** (`apps/cli/src/output.ts`): NDJSON when
  piped or `--json`, human only on a TTY; **exit codes carry a class**
  (`ok / user / upstream / config / interrupted / internal`); errors are
  RFC-9457-style problems with a machine `slug` + actionable `hint` + `trace_id`
  (the `ERROR_MAP`).

The payoff is the phrase that motivated this: *an agent outside the harness
steers more accurately*. A typed loop degrades gracefully across models; a
prose-scrape loop is tuned to the model whose output the regexes were calibrated
against. It also dissolves the bilingual tax — provider-neutrality stops being a
*discipline* ("keep the prose neutral", `skills.md`) and becomes *structural*
(there is no prose to neutralize), which is the same instinct as the `#80`
constraint that the Codex provider must not depend on a 28 KiB startup document.

## Landscape and the chosen substrate: Beads

Research into the state of the art (cited synthesis, 2026-07) returned two
load-bearing facts. First, **there is no named standard for an agent-driven
work/backlog/orchestration surface** — MCP (tool invocation), ACP (editor↔agent),
A2A (agent↔agent), and AGENTS.md (docs) are each scoped elsewhere. The
coordination layer has no protocol to conform to; the pragmatic move is to expose
the *driver/tool seam* via MCP if useful while keeping the *policy* a deterministic
typed CLI.

Second, the nearest neighbor is Steve Yegge's **Beads (`bd`)** — a purpose-built,
agent-native issue tracker with a deterministic `--json`-everywhere CLI and a
code-based ready-set (`bd ready` = dependency-graph filtering, not LLM prose). A
spike (bd 1.1.0, findings in the #181 charter) confirmed Beads already ships the
machine-first work store this doc set out to build, **and more**: `bd merge-slot`
provides atomic exclusive-access ordering (proven under an 8-way race — though per
ADR-0025 pelaggio uses it only as an optional ordering layer, never as the landing
fence), and `bd gate` (`gh:pr`/`gh:run`/`timer`/`human`) maps onto the
`ship.target` seam.

**Correction to an earlier claim in this doc:** a first pass here said Beads had
"crossed its orchestration boundary." It has not. Beads ships richer
*primitives* than pure issue-tracking (merge-slot, gate, swarm-molecule), but the
orchestration *policy* — scheduler, dispatch, landing processor — lives in a
**separate binary, Gastown (`gt`)**, which depends on `bd`. The
primitives-vs-policy boundary holds: `bd` = substrate + primitives, `gt` = the
orchestrator. That makes pelaggio a **sibling orchestrator to Gastown on the
shared `bd` substrate** — see *Gastown: the sibling orchestrator* below.

**Decision (adopt Beads as substrate).** Rather than build the store, pelaggio
adopts Beads as a first-class `RoadmapSource` (#181) and `bd ready` as the pick
candidate set. This is the "best foundation, not novel" call for the *store*.

**Amended by [ADR-0025](../decisions/0025-landing-serialization-cas-fence-optional-ordering.md):
the landing half is demoted from *adopt* to *optional optimization*.** `bd
merge-slot` cannot be the fence — it orders pelaggio's own workers without fencing
an external pusher, its binary ships via `postinstall` and is absent in practice,
and making landing *safety* depend on that fetch imports the vector ADR-0006
closes. The `direct-push` primitive is therefore **git ref compare-and-swap** built
in the harness, with `merge-slot` available as an optional ordering layer above it
(#174). The store half of this decision is untouched.

**The differentiator narrows — and sharpens — accordingly.** Beads owns the store
and the ready-set (and, optionally, landing *ordering*). What stays distinctly
pelaggio's is
exactly what flow.md calls policy:

- the **provider-neutral pick→plan→implement→review→ship cycle** and the
  Claude/Codex driver seam (Beads has primitives and a `formula` concept, not the
  dev-cycle);
- **worktree isolation** + declared **write-set** enforcement (#173 — Beads has no
  analog; its merge-slot is landing-time exclusion, not pre-implementation
  disjointness);
- **flow policy** — ranked ordering / WIP / class-of-service *over* `bd ready`
  (#171), and the landing *discipline* (fair ordering, waiter hygiene, dead-holder
  reconcile) *over* the harness's own landing fence (#174).

The ready-set primitive is Beads'; the **landing primitive is the harness's git ref
compare-and-swap** (ADR-0025) — `bd merge-slot` is at most an optional ordering layer
above that fence, never the exclusion mechanism itself. The *policy and safety* remain
pelaggio's — the storage-vs-policy line, drawn one layer higher than before this
spike and re-drawn at landing by ADR-0025.

## Gastown: prior-art sibling orchestrator

A hands-on spike of Gastown (`gt` v1.2.1) — the orchestration-policy layer Steve
Yegge builds on `bd` — informed several design choices here. Architecturally it is
a *sibling* to pelaggio: a different orchestrator on the same substrate, already
deterministic in the mechanics that matter (DAG ready-set, atomic `--claim`, a
capacity-governed scheduler, typed gates, and a **Refinery** — a Bors-style
batch-then-bisect verified merge queue). The only LLM-prose seam is its Mayor
decomposing goals into beads. So pelaggio is not "more deterministic" than
Gastown; it makes **different architectural bets** on the same substrate:

| | Gastown (`gt`) | pelaggio |
|---|---|---|
| Stance | push — daemon slings work onto hooks | pull — ranked Kanban pull over the ready-set |
| Conflicts | recover — Refinery re-implements on conflict | prevent — declared write-sets refuse to co-schedule (#173) |
| Weight | service fleet — HQ + daemon + Dolt server + persistent agents | lean single-orchestrator CLI, no daemon |
| Runtime | Claude-Code-native control plane | provider-neutral driver seam (#176) |
| Cycle | author-your-own formula colony | fixed, reviewed `pick→plan→implement→review→ship` + rubric |

Two concrete reference designs pelaggio borrows — the *design*, not the binary
(`gt` is an all-or-nothing town: every command errors outside a provisioned HQ +
daemon + Dolt):

- **Landing queue (#174):** the Refinery + `gt done` (submit → notify → sync) +
  `gt mq` (ordered queue, `next` = highest priority). pelaggio builds its own on
  `bd merge-slot`. Divergence worth keeping: Gastown resolves conflicts
  *reactively* (re-implement); pelaggio *prevents* via declared write-sets (#173).
- **Provider seam (#176):** Gastown wraps harnesses as a registry of command
  templates (`gt config agent set <name> <cmd>`) — spawn-generic, but its
  *orchestration* rides Claude Code's Stop hook + account rotation, so non-Claude
  harnesses are second-class. The architectures are inverted: Gastown injects work
  *into* a running harness via that harness's hooks; pelaggio drives the harness
  *from outside* (SDK per step — harness-as-callee). pelaggio's inversion is what
  lets Codex/Gemini/OpenCode be true peers of Claude, not degraded workers.

*(Competitive and commercial positioning — how these architectural differences
translate into product strategy — is out of scope for this architecture doc.)*

## What already exists (the half-built spine)

pelaggio has the *outbound* half of this pattern and part of the inbound half:

- **Outbound is already typed.** The effects manifest (`effects.ts`) is
  structured intent-out: steps declare `Effect[]` (e.g. `ship.ShipDecision`,
  `plan.publish`) written to a provenance-checked manifest — `schemaVersion`,
  `runId`, `itemId`, `step`, `attempt`, `cwd`, `preSha` all validated before any
  side effect, with typed `EffectsManifestError` kinds
  (`provenance_mismatch`, `unknown_effect_kind`). This is the pattern; it just
  is not applied to inbound decisions.
- **Inbound is half-typed.** `roadmap-cli.ts` has structured subcommands and
  load-bearing exit codes (`claim` → exit 3 on a lost race). But its returns are
  `branch=` / `worktree=` line-parsing, and the *decisions* (which item to pick,
  whether a ship is deliverable, how to route) are not in the CLI — they live in
  skill prose and come back as scraped markers.

The gap is narrow and specific: give the inbound side the same typed discipline
the outbound side already has.

## The cut (planned)

1. **Own the decisions.** Add `roadmap next [--topic] --json` returning the
   ranked candidate deterministically — the ranking now living only as a prose
   bullet in `pick/SKILL.md`. This is the seed of `flow.md`'s `FlowPolicy` (a
   pure `snapshot → verdict` function), cashed early. `pick` shrinks to: call it,
   narrate, claim.
2. **Adopt zonot's output discipline in the roadmap/flow CLI.** NDJSON returns,
   `EXIT`-class codes, RFC-9457-ish error slugs. Then `pick`'s "did it claim?"
   is an exit-code read, not `parsePickResult` over prose.
3. **Move inbound control-flow onto the typed channel.** As decisions move into
   the CLI, the prose-marker parsers (`parsePickResult`, `parseShipMerged`,
   `parseBlockedReason`) retire, and the `ship` sequence's pipeline-mode
   detection (`if Arguments contains "pelaggio"`) becomes a caller distinction,
   not a prose branch.
4. **Keep judgment with the model.** Plan authoring, shakedown, PR-review reasoning, and
   semantic merge resolution stay model-owned; PR-review transports its judgment as a
   validated severity-tagged report rather than a prose verdict. The spine is glue between
   judgments, not a replacement for them.

### MCP is deferred, not designed-in (planned, low priority)

MCP is **not part of this cut and not necessary yet.** The spine earns its keep
without any network transport: the value is the typed decision surface + the
structured return channel, consumed by the callers that exist today — the
pipeline, a human at the CLI, and Codex via the same CLI. Adding an MCP transport
now is surface with no consumer.

The reason it can wait cheaply is the zonot lesson itself: *"one handler set, N
transports."* Once the coordination logic lives behind a typed spine, a transport
is a thin adapter, not a rewrite — so there is no lock-in cost to deferring it.
The trigger to pick it up is a concrete external-agent consumer (a BYO desktop
agent, or a second orchestrator that is not the pipeline). Until such a consumer
exists, MCP stays an asterisk: the spine is designed so MCP *could* be added, and
is not built until something asks to call it.

The token economics back the deferral rather than merely permitting it. Beads
itself treats its MCP server as a *fallback* for shell-less harnesses (its CLI +
hooks cost ≈1–2k tokens vs an MCP schema surface of ≈10–50k); one practitioner
survey predicts schema-carrying CLIs overtaking MCP servers as the default
agent-access mechanism within ~18 months; and RFC-9457-style classed errors — the
error half of this spine — measured a ~98% token reduction vs prose/HTML errors
(Cloudflare). Typed-CLI-first with MCP as an optional adapter is the
token-efficient default, not the cautious one.

## Relationship to flow

This is the enabling cut. Every coordination primitive in `flow.md` is a typed
call in disguise:

- **`FlowPolicy`** is `roadmap next`/rank promoted to a strategy — a pure
  function over a snapshot, which is a typed input and a typed verdict, not
  prose.
- **The write-set contract** is a declared, machine-checkable set the scheduler
  reads; a scheduler whose disjointness check is an LLM reading two plans is the
  *predicted-and-hoped* the flow doc rejects.
- **The landing queue** is a state machine over structured candidates.

Build these on the prose-scrape seam and they inherit its non-determinism at
exactly the layer — concurrency correctness — that has no tolerance for it. The
spine is the floor they stand on.

## Non-goals / rejected alternatives

- **Typing the judgment band.** "Write the plan" / "review vs. rubric" / resolve
  a semantic merge cannot be typed calls — they *are* the reasoning. Do not try.
- **A wholesale flip to CLI-only, zonot-style.** zonot can because it is
  stateless CRUD with no judgment band. pelaggio is a hybrid; the flip would
  destroy the steps that must stay prose.
- **MCP-first.** No consumer today; the transport is a thin adapter over the
  spine and is deferred until an external-agent caller exists (see above).
- **A new marker vocabulary.** The point is to *remove* prose markers by moving
  the decision, not to invent more structured strings to scrape.

## Invariants (mirror to AGENTS.md when this ships)

- Coordination decisions (pick ranking, routing, deliverability, ship sequence,
  write-set disjointness) are typed CLI calls with classed exit codes and
  structured returns — never prose the harness regex-scrapes.
- Judgment steps (plan, shakedown, PR review, semantic merge) stay model-owned; typed
  judgment outputs such as PR review findings prevent control flow from scraping prose.
  Convergence and arbitration remain planned rather than part of this seam.
- The CLI is one caller among several (pipeline, human, Codex); coordination
  logic never assumes the Claude Code harness.
- MCP is a deferred thin transport over the spine, added only when a concrete
  external-agent consumer exists — not designed-in.
- Beads (`bd`) is the chosen **work-store** substrate: adopt it as a
  `RoadmapSource`. The `feat/<id>` git branch stays the authoritative claim token
  (bd status is write-back, never the claims registry). For **landing**, ADR-0025
  demotes Beads from mechanism to optional optimization: the `direct-push` fence is
  git ref compare-and-swap in the harness, with `bd merge-slot` available as an
  ordering layer above it (gated on a positive typed-output probe; when used the slot
  lives in one shared `MAIN_REPO/.beads`, and ordering/waiter-hygiene/dead-holder
  reconcile stay pelaggio's).
