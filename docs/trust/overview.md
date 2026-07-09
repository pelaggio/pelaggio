---
title: Trust overview
description: What Pelaggio can touch, what leaves your machine, and how to verify every word of it.
status: draft            # mirrors trust-claims.yml; every `planned` claim must be `guarantee` before this ships
diataxis: explanation
sidebar:
  order: 1
last_reviewed: 2026-07-08
threat_model_ref: ./threat-model.md
---

# Trust, in one page

Pelaggio writes code and opens pull requests in your repositories — largely unattended. That only works if you can see exactly what it's allowed to do. So here's the whole story, and at the bottom, the commands to check that we're telling the truth.

Everything on this page is generated from a [claim registry](./trust-claims.yml) where each promise carries the test that proves it. If the code stops matching a claim, CI fails. We can't quietly drift.

## Five questions, five answers

**1. Can it push to my main branch?**
No — not unless you explicitly turn that on. Out of the box Pelaggio opens a pull request and stops there. Direct-push is an opt-in you have to reach for. *(→ `TC-012`, [permission model](./permission-model.md))*

**2. What can it write, and where?**
Only inside a throwaway worktree for the item it's working on. It can't reach back into your main checkout — a write outside its lane fails the step rather than slipping through. *(→ `TC-011`, [write boundary](./write-boundary.md))*

**3. What leaves my machine, and to whom?**
Your code goes to the model provider you configure, and to the roadmap/notify integrations you switch on — nowhere else. There's no telemetry: nothing phones home, because there's nothing to phone home with. Self-hosted, it all stays on your infra. *(→ `TC-002`, `TC-006`, [data & egress](./data-egress.md))*

**4. What if it goes wrong — how do I stop and undo it?**
Every run is a branch, and risky work parks itself as a `wip:` commit rather than vanishing. Nothing merges without passing the review gate, which fails *closed* — silence or an error blocks, it never green-lights on a shrug. *(→ `TC-003`, [uninstall & rollback](../guides/uninstall-and-rollback.md))*

**5. Can I trust the binary itself?**
Releases ship from a signed tag with npm provenance, so you can verify a build came from our source, untampered — and the published package runs no install scripts, so `npm install` never executes our code on your machine. *(→ `TC-004`, `TC-005`, [supply chain](../security/supply-chain.md))*

## What we haven't proven yet

We'd rather tell you than let you find out. The honest weak point is the one every autonomous code tool shares and few name: Pelaggio is *designed* to read and act on your repo files, issues, and PR text — which means the instructions it follows can come from places an attacker can reach. Today that blast radius is bounded by the worktree and the gates above, not by a purpose-built injection defense. That work is the roadmap headline. *(→ `TC-015`, [threat model](./threat-model.md))*

You'll also find claims marked **`planned`** in the registry. Those are guarantees we're building, not ones we're claiming. We won't move a claim to `guarantee` — or ship this page — until its test passes.

## Don't take our word for it

Every claim ships with a command that proves it:

```sh
pelaggio trust verify        # runs each guarantee's evidence check, fails on regression
cat pelaggio.trust.json      # the machine-readable version, for your own tooling
```

The trust surface is machine-readable too: [`/.well-known/pelaggio.trust.json`](./pelaggio.trust.json) declares Pelaggio's capabilities, egress, and hard *nevers* in a form another agent or orchestrator can read before it ever runs us.
