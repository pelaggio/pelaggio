#!/usr/bin/env python3
"""Markdown projection of the corpus, for review. Same source as the HTML."""
import json, os, sys, subprocess, collections

HERE = os.path.dirname(os.path.abspath(__file__))

CORPUS = sys.argv[1] if len(sys.argv) > 1 else "corpus.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "corpus-review.md"
PASS = sys.argv[3] if len(sys.argv) > 3 else None

if subprocess.run([sys.executable, os.path.join(HERE, "check_corpus.py"), CORPUS],
                  stdout=subprocess.DEVNULL).returncode:
    sys.exit("corpus invalid — refusing to render")

C = json.load(open(CORPUS))
N = {n["id"]: n for n in C["nodes"]}
E = C["edges"]
inc = collections.defaultdict(list)
outg = collections.defaultdict(list)
for e in E:
    inc[e["to"]].append(e); outg[e["from"]].append(e)

def sect(title, nodes):
    L = [f"\n## {title}\n"]
    for n in nodes:
        L.append(f"- **{n['id']}** — {n['statement']}")
        if n.get("wrongIf"):
            L.append(f"  - wrong-if: {n['wrongIf']}")
        if n.get("revisitIf"):
            L.append(f"  - revisit-if: {n['revisitIf']}")
        if n.get("binds"):
            L.append(f"  - binds: {n['binds']}")
        if n.get("sources"):
            L.append(f"  - sources: {', '.join(n['sources'])}")
    return "\n".join(L)

def by(k, r=None):
    return [n for n in C["nodes"] if n["kind"] == k and (r is None or n.get("role") == r)]

L = ["# Successor project corpus" + (f" (pass {PASS} review target)" if PASS else ""),
     "",
     f"Kernel: {' / '.join(C['kernel'])}. Roles: {' / '.join(C['propositionRoles'])}. "
     f"Authority: none.",
     "",
     "This document is **generated** from `corpus.json` by a renderer that refuses to emit unless a "
     "domain checker passes. The checker enforces: edge source/target kinds against a declared relation "
     "contract; `assumes` targets must be assumptions; every constraint binds the harness; every edge "
     "endpoint must resolve to a corpus node (external references live in a `sources` field, never as an "
     "edge target); every assumption carries either a counterexample that would settle it or a trigger to "
     "revisit it, never both; and causal-outcome language is rejected outside "
     "an assumption, because the corpus admits no node kind for a thesis.",
     "",
     "Relation contract:",
     ""]
for k, v in C["relationKinds"].items():
    extra = ""
    if v.get("toRole"): extra += f", target role {v['toRole']}"
    L.append(f"- `{k}`: {v['from']} → {v['to']}{extra}")

L.append(sect("Invariants", by("proposition", "invariant")))
L.append(sect("Constraints", by("proposition", "constraint")))
L.append(sect("Assumptions", by("proposition", "assumption")))
L.append(sect("Decisions", by("decision")))

L.append("\n## Coverage (derived)\n")
L.append("| Invariant | Constrained by | Implemented by | Assumes |")
L.append("|---|---|---|---|")
for n in by("proposition", "invariant"):
    i = n["id"]
    c = ", ".join(e["from"] for e in inc[i] if e["relation"] == "constrains") or "—"
    d = [e["from"] for e in inc[i] if e["relation"] == "implements"]
    a = ", ".join(x["to"] for x in E if x["relation"] == "assumes" and x["from"] in d) or "—"
    L.append(f"| {i} | {c} | {', '.join(d) or '—'} | {a} |")

L.append("\n## Edges\n")
L.append("| From | Relation | To |")
L.append("|---|---|---|")
for e in sorted(E, key=lambda x: (x["relation"], x["from"])):
    L.append(f"| {e['from']} | {e['relation']} | {e['to']} |")

L.append("""
## Review charge — class-level, not instance-level

This corpus is authored once as data; the page, the coverage table and the edge list are all
projections of it. A defect fixed in one projection is fixed in all, so **do not report projection
inconsistencies** — they are structurally impossible here, and the checker rejects the classes that
produced them previously.

Report findings **grouped by class**. For each class:

1. Name the class of defect, not only its instances.
2. Name the **single invariant or constraint** whose addition or restatement would eliminate the
   whole class — or state plainly that the class needs case-by-case repair and why.
3. List the instances the class covers.

Assess in particular:

- **Minimality.** Which invariants are entailed by others and could be deleted without loss? The
  target is the smallest set that still answers every question the corpus must answer.
- **Independence.** Do any two invariants overlap such that one is a special case of the other? The
  corpus carries no relation for entailment — it was declared, tried, and removed — so the answer is
  a deletion, not an edge.
- **Mechanism leakage.** Does any invariant or constraint name the mechanism its decision was
  supposed to choose? (An invariant that must be rewritten when the implementation is replaced is
  construction, not intent.)
- **Condition grammar.** Is each assumption carrying the right one? A `wrong-if` claims a single
  counterexample settles the matter; a `revisit-if` concedes it does not. An assumption written as
  refutable when it is really a bet is the defect to look for, and the reverse where a closure claim
  has been softened.
- **Ungoverned behaviour.** Name a consequential question this corpus cannot answer. Answer by
  naming the question, not by proposing a mechanism.
- **Threshold soundness.** INV-2 sets required authority from what an effect can do, the harm class
  it carries, and what the run has realized; CON-12 makes that computation monotonic and bars the
  acting party from influencing it. Does that boundary hold, or does it license something it should
  not?
""")
open(OUT, "w").write("\n".join(L) + "\n")
print(f"rendered {OUT}")
