---
title: "ADR-0028: The unit of delivery is the claim, carried as an intent-only packet that joins — never copies — its evaluative record"
status: proposed
date: 2026-08-22
claims: []
construction: none
---

# ADR-0028 — Claim-scoped delivery packets: carry intent, join verdicts

## Context

A delivery's evidence is inverted: every rigorous record (gate records, execution
receipts, adjudication sources, cycle provenance) is gitignored, per-machine, and
partly destroyed by the delivery completing (worktree-rooted records die with the
worktree), while the one artifact a reader sees — the PR body — is free-form model
prose with nothing binding its claims to the records. Direct-push deliveries emit no
structured artifact at all. No single artifact spans a delivery: records bind to
`(pr, headSha)`, `itemId`, `(runId, step, attempt)`, or one cycle, under four identity
schemes. Fifteen provider-diverse review passes over the design
(`delivery-packet.md`) established one structural fact the hard way: an artifact
carried by a delivery cannot honestly contain facts determined by or after its own
carrier, and no bolt-on gives an agent-landed, review-excluded file real integrity.

## Decision

1. **The unit of delivery is the claim.** Delivery identity is the claim identity
   (`claimId`), minted durably at claim time; a cycle is an attempt within a
   delivery, an item may span deliveries, and item identity is never substituted for
   delivery identity.
2. **Two artifacts, two jobs.** The machine record of an *attempt* is the
   attestation layer ADR-0018 already governs — cycle-scoped, cluster-owned, **fed**
   by the packet work (preserved evidence, delivery keys) and **joined** at render
   time; the carried packet neither duplicates it, dilutes its failure semantics,
   nor references it (statements post-date the carried half's freeze, so the join
   runs from statement to delivery keys, never the reverse). The carried packet is
   a human dossier plus a manifest asserting identity and reference only.
3. **The carried half is intent-only and freezes at compose.** Frame, references, and
   identity are carried; every evaluative or carrier-determined fact — findings,
   verdicts, statuses, outcomes, the landing, the carrying commit's own identity —
   is joined at render time from the record that owns it, never copied into the
   packet.
4. **Carriage is bookkeeping, never a gate.** Packet composition or carriage failure
   degrades to omission with a recorded warning; it never fails a ship effect,
   blocks a merge, or triggers a post-landing repair write.
5. **Campaigns and releases are folds over delivery packets, never stored objects** —
   the same rule as "an initiative is a projected swimlane."
6. **Per-delivery assurance is capped below "verified."** Pelaggio renders claim at
   most bound (digest/SHA reference) and attributable (identity trailers); raising
   the tier (signing, countersigning, anchoring) belongs to consumers behind the
   packet contract, and no render conflates per-delivery assurance with
   release-level signed provenance.
7. **Compose, don't author.** Packet composition is deterministic harness work over
   records that already exist — zero model turns, zero new review passes, on the
   ship path or anywhere else. The packet authors nothing; a model-authored dossier
   would reintroduce the unstructured-prose failure this decision exists to close.

## Constraints on any implementation

- **Must not embed carrier-determined or later facts in a carried artifact.** A
  statement carried inside a candidate cannot contain that candidate's digest, and a
  compose-time record cannot carry a terminal outcome without fabricating it
  (delivery-packet review passes 4–5).
- **Must not write to the default branch after landing.** No post-merge packet
  commit, no second push, no automated repair commit — the unverified-write class
  ADR-0025 Decision 8 forbids, and the unpushed-local-commit leak class already
  observed in autopilot runs.
- **Must not break the reviewed-artifact binding, and intent-only content alone
  does not preserve it.** A packet commit after review moves the landed candidate
  past the SHA the review record vouches for regardless of the packet's content
  (ADR-0024). A post-review compose is legal only where it is invisible to the
  reviewed-artifact binding by the same mechanism-class the repo's bookkeeping
  commits already use — and on an agent-landed target even that is insufficient
  without a fence-verified candidate, which is why in-candidate carriage waits for
  the ADR-0025 executor. Evaluative content is barred from carriage independently:
  a carried verdict is a copy competing with the gate's record.
- **In-candidate carriage on an agent-landed target requires a harness-built,
  fence-verified candidate.** Until the ADR-0025 landing executor exists, the
  direct-push carried file does not — path-name denial and local digest stores were
  each shown insufficient (passes 7–12); the store half alone serves that target
  meanwhile.
- **Identity ambiguity must split, never merge.** Recovery adopts a delivery
  identity only on positive corroboration between independent records; every
  ambiguous state mints a fresh identity marked degraded, because a wrongly-split
  delivery is mergeable later and a wrongly-merged one cannot be unfused.
- **Keys are stamped at emission or lost.** Delivery identity and grouping
  (lineage, initiative, supersede links) must be recorded while the claim is live —
  never re-derived by joining mutable git/provider state (the flow-catalog rule).

## Alternatives not taken

- **A bespoke per-delivery attestation schema** — ADR-0018 decided the envelope;
  a second format would fork the trust story.
- **Stored campaign/release objects** — recreates the claims-registry mistake one
  level up.
- **Embedding verdicts for reader convenience** — a copy competes with the gate's
  authoritative record and goes stale the moment an adjudication moves.
- **Gating merges on packet presence** — inverts the packet's purpose; the
  attestation layer owns any future deterministic gate (ADR-0018).

## Consequences

- (+) One artifact, many renders: stakeholder, developer, agent, and archeologist
  read the same delivery through joins, and downstream consumers get a stable seam
  with no visibility into any particular consumer required.
- (+) The direct-push evidence hole closes in stages (store now, carried file with
  the landing executor), and evidence stops dying with the worktree.
- (−) The direct-push carried file waits on the ADR-0025 executor.
- (−) Delivery-identity continuity is per-machine best-effort until durable
  write-back exists (#172).
- (−) The design carries five open mechanics findings (`delivery-packet.md` §12),
  owned by the slices that build the mechanisms they name.

## Construction

`docs/agent-context/delivery-packet.md` — the full design: unit ladder, audience
contract, store/carrier mechanics, sequencing, counter-case, and the §12 open-findings
ledger.
