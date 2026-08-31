# Intent lineage audit

Status: **experimental / non-authoritative migration work**. Companion to the
[corpus accountability audit](./corpus-accountability-audit.md), for the #624 reconciliation campaign.

The accountability pass established that every developer-front-door record is grounded in the
ADR/trust corpus. This pass asks the different question that grounding cannot answer: **did that
corpus preserve the project intent that preceded it?** It traces the 21 decision records and four
assumptions through ADR birth commits, architecture discovery and reconciliation plans, the frozen
roadmap snapshot, and tracked decision logs. It does not make issue, PR, plan, or decision-log rows
graph nodes.

## Finding

The semantic kernel survives the archaeology. The source hierarchy does not.

The graph's proposition / decision / realization split continues to distinguish durable obligations,
replaceable choices, and present machinery. The misleading part was presentation: all decisions
appeared as one flat epistemic tier even though the repository's own reconciliation work explicitly
separates policy, current construction, unbuilt direction, and history. The explorer now groups those
choice statuses and says that current construction is replaceable.

The ADR ledger is a retrospective consolidation, not a contemporaneous record of all project intent:

- ADR-0001–0003 and ADR-0008 arrived in PR #141 from vetted but previously untracked trust drafts.
- ADR-0011–0019 arrived together in the docs-only PR #289 after a design-review session.
- ADR-0020–0022 arrived together in PR #341 from issue discussion, four triad rounds, and operator memory.
- PR #342 promoted two design documents and extracted five README-only ADR summaries into files.
- ADR-0025 onward has stronger failure, probe, review, and supersession lineage in its merge history.

That history does not invalidate the ADRs. It means exact textual grounding proves extraction fidelity,
not source completeness or contemporaneous authority.

## What the deeper sources add

`docs/plans/adr-reconciliation.md` supplies a useful constitutional test:

> If the mechanism changed tomorrow, would this sentence still be required to avoid reintroducing a known failure?

Its durable concerns already map substantially onto the graph:

| Reconciliation concern | Existing semantic home |
| --- | --- |
| Agents judge; independent authority resolves consequential advancement | `CLM-0006`, `CLM-0017`, `CLM-0019` |
| Consequential execution has a harness-owned authority boundary | `CLM-0002`, `CLM-0015`, `CON-0010`, `CON-0013` |
| Recovery follows lineage and reconciliation, not deterministic replay | `CLM-0012`, `CON-0014`, `DEC-0009` |
| Provenance survives the lifecycle and remains independently verifiable | `CLM-0008` and the ADR-0028 delivery constraints |
| Stateful transitions are fenced or reconciled; absence is not success | `CLM-0007`, `CLM-0009`–`CLM-0011`, `CON-0003`–`CON-0009` |
| Independent evaluation protects information isolation | `CLM-0016` |
| Review diversity is a paid, falsifiable premise rather than a permanent primitive | `ASM-0002`, `DEC-0014` |

One clear candidate is not yet independently represented: **the lifecycle is ordered and has explicit,
typed transition boundaries even when the current six-step / two-orchestrator topology is replaced**.
Today that durable idea is bundled into `DEC-0012`, while the more general wording exists only in a
pre-decision reconciliation proposal. It must be settled in an authoritative ADR before becoming a new
invariant; this audit does not promote it from proposal by inference.

The same proposal also names write-at-emission evidence durability, one lifecycle closer across ship
targets, and a metrics/projection commitment. Existing invariants cover their safety outcomes. Their exact
construction remains proposal or implementation territory until a competency question demonstrates a
missing semantic answer.

## Decision-log disposition

The 64 tracked decision-log files contain 162 active rows: 150 unique decision/choice pairs, of which
17 are cross-model escalation records, leaving 135 substantive unique pairs. Of 143 issue-sourced rows,
only 19 rows from seven issues cite an issue that any ADR explicitly cites.

That is a provenance gap, not evidence that the graph needs 135 more decision nodes. The logs intentionally
capture local choices such as a CLI flag name, temporary-file cleanup, retry placement, and renderer-specific
redaction. Several entries repeat as a plan is reviewed and implemented. These remain valuable implementation
lineage but fail the enduring-intent admission bar.

A logged choice enters the corpus only when at least one of these is demonstrated:

1. replacing its mechanism must preserve the choice to avoid a known failure;
2. rejecting it changes an existing consequential competency answer; or
3. it settles an open architectural alternative that an authoritative source adopts.

Otherwise the choice remains in the decision log, becomes realization evidence where appropriate, or is
summarized as ADR rationale. PR discussion is a tie-breaker when the issue, plan, and resulting code disagree;
it is not another corpus to ingest wholesale.

## Front-door dispositions

| Records | Lineage disposition |
| --- | --- |
| `DEC-0001`, `DEC-0005`–`DEC-0007`, `DEC-0017`, `DEC-0018`, `DEC-0021` | Keep as operating policy, not constitutional truth. Their linked invariants define the floor a policy change cannot cross. |
| `DEC-0003`, `DEC-0004`, `DEC-0009`–`DEC-0014`, `DEC-0016` | Keep as current construction choices. Architecture reconciliation explicitly treats their exact topology, algorithm, vocabulary, or substrate as replaceable. |
| `DEC-0008`, `DEC-0015` | Keep as selected target construction; neither is claimed built. |
| `DEC-0019`, `DEC-0020` | Keep as proposed construction. Their source ADRs remain proposed and their own promotion gates remain visible. |
| `DEC-0002` | Keep as historical construction because its supersession explains the surviving landing obligation. |
| `ASM-0001`–`ASM-0003`, `CON-0024` | Keep as assumptions, not facts. Each carries a counterexample or revisit trigger; archaeology adds rationale but does not strengthen it into truth. |

No record is promoted, removed, or retyped by this pass. That is a substantive result: the deeper sources
change how the front door frames decisions, but they do not justify silently granting a proposal authority
or copying implementation detail into the graph.

## Remaining closure work

Before ADR-0027 can promote the graph from shadow authority:

1. settle the ordered typed-lifecycle candidate, or explicitly reject it as an enduring invariant;
2. give every retained decision an authoritative adoption state at clause granularity rather than trusting
   stale document-level `status` frontmatter;
3. reconcile the handful of high-signal decision-log choices whose failure class is not already represented;
4. preserve issue/PR lineage in ADR rationale or generated provenance without making mutable tracker state
   graph authority; and
5. rerun the competency fixtures after each resulting semantic edit.

This is a bounded reconciliation queue. Completing or importing every historical issue and PR is neither a
promotion prerequisite nor a useful definition of corpus completeness.
