#!/usr/bin/env python3
"""Domain checker for the successor corpus.

Every check here exists because a review finding got past a hand-maintained encoding.
Failures are fatal; the renderer refuses to run on an invalid corpus.
"""
import json, sys, collections

C = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "corpus.json"))
N = {n["id"]: n for n in C["nodes"]}
RK = C["relationKinds"]
errs, warns = [], []

# --- identity ---------------------------------------------------------------
ids = [n["id"] for n in C["nodes"]]
for i, c in collections.Counter(ids).items():
    if c > 1:
        errs.append(f"duplicate node id {i} ({c}×)")

# --- node shape -------------------------------------------------------------
for n in C["nodes"]:
    if n["kind"] not in C["kernel"]:
        errs.append(f"{n['id']}: kind {n['kind']!r} not in kernel {C['kernel']}")
    if n["kind"] == "proposition":
        if n.get("role") not in C["propositionRoles"]:
            errs.append(f"{n['id']}: role {n.get('role')!r} not in {C['propositionRoles']}")
        if n.get("role") == "assumption" and not n.get("wrongIf"):
            errs.append(f"{n['id']}: assumption without a wrongIf — unfalsifiable")
    elif "role" in n:
        errs.append(f"{n['id']}: kind {n['kind']} must not carry a role")
    if not n.get("statement", "").strip():
        errs.append(f"{n['id']}: empty statement")

# --- edge domains (finding 3 / 18 / 20) -------------------------------------
for e in C["edges"]:
    r, f, t = e["relation"], e["from"], e["to"]
    if r not in RK:
        errs.append(f"{f} -{r}-> {t}: unknown relation kind"); continue
    spec = RK[r]
    if f not in N:
        errs.append(f"{f} -{r}-> {t}: source not a corpus node (external refs belong in `sources`)"); continue
    if t not in N:
        errs.append(f"{f} -{r}-> {t}: target not a corpus node (external refs belong in `sources`)"); continue
    if N[f]["kind"] not in spec["from"]:
        errs.append(f"{f} -{r}-> {t}: source kind {N[f]['kind']} not permitted (allowed: {spec['from']})")
    if N[t]["kind"] not in spec["to"]:
        errs.append(f"{f} -{r}-> {t}: target kind {N[t]['kind']} not permitted (allowed: {spec['to']})")
    if "toRole" in spec and N[t].get("role") not in spec["toRole"]:
        errs.append(f"{f} -{r}-> {t}: target role {N[t].get('role')!r} not in {spec['toRole']}")
    if spec.get("sameRole") and N[f].get("role") != N[t].get("role"):
        errs.append(f"{f} -{r}-> {t}: {r} requires matching roles")

# --- duplicate edges --------------------------------------------------------
seen = collections.Counter((e["from"], e["relation"], e["to"]) for e in C["edges"])
for k, c in seen.items():
    if c > 1:
        errs.append(f"duplicate edge {k[0]} -{k[1]}-> {k[2]} ({c}×)")

# --- coverage (warnings, not errors: a gap may be honest) -------------------
impl = {e["to"] for e in C["edges"] if e["relation"] == "implements"}
cons = {e["to"] for e in C["edges"] if e["relation"] == "constrains"}
assumed = {e["to"] for e in C["edges"] if e["relation"] == "assumes"}
refd = {e["from"] for e in C["edges"]} | {e["to"] for e in C["edges"]}

for n in C["nodes"]:
    if n["kind"] == "proposition" and n.get("role") == "invariant":
        if n["id"] not in impl:
            warns.append(f"{n['id']}: invariant with no decision implementing it")
        if n["id"] not in cons:
            warns.append(f"{n['id']}: invariant with no constraint bounding it")
    if n["kind"] == "proposition" and n.get("role") == "assumption" and n["id"] not in assumed:
        warns.append(f"{n['id']}: assumption nothing depends on — candidate for deletion (finding 4/5)")
    if n["id"] not in refd:
        warns.append(f"{n['id']}: orphan — participates in no relation")

# --- thesis smuggling (finding 6 / 8) ---------------------------------------
CAUSAL = ("raises", "reduces", "improves", "lowers", "increases", "decreases",
          "faster", "cheaper", "fewer", "more often", "less often", "drives", "causes")
for n in C["nodes"]:
    s = n["statement"].lower()
    hits = [w for w in CAUSAL if w in s]
    if hits and n.get("role") != "assumption":
        errs.append(f"{n['id']}: causal-outcome language {hits} outside an assumption — the corpus has no node kind for a thesis")
    elif hits:
        warns.append(f"{n['id']}: causal language {hits}; confirm the wrongIf tests the causal claim, not just the outcome")


# --- falsifier adequacy (pass-1 class A) -------------------------------------
CONJ = (" and ", " both ", "; ")
for n in C["nodes"]:
    if n.get("role") != "assumption":
        continue
    st, wi = n["statement"], n.get("wrongIf", "")
    if any(k in st.lower() for k in CONJ) and not any(k in wi.lower() for k in (" or ", ", or", "either")):
        warns.append(f"{n['id']}: statement has multiple clauses but wrongIf offers a single disjunct — "
                     f"a real failure of one clause may not falsify it")
    if len(wi.split()) < 8:
        warns.append(f"{n['id']}: wrongIf is terse; confirm it negates the claim rather than naming a symptom")

# --- specializes is entailment, not association (pass-1 class B) -------------
for e in C["edges"]:
    if e["relation"] == "specializes" and e["from"] in N and e["to"] in N:
        if not RK["specializes"].get("note"):
            warns.append("specializes has no stated semantics — entailment cannot be checked")

# --- report -----------------------------------------------------------------
k = collections.Counter(n["kind"] for n in C["nodes"])
r = collections.Counter(n.get("role") for n in C["nodes"] if n["kind"] == "proposition")
print(f"nodes {len(C['nodes'])}  {dict(k)}  roles {dict(r)}   edges {len(C['edges'])}")
print(f"relations {dict(collections.Counter(e['relation'] for e in C['edges']))}")
for w in warns: print(f"  warn  {w}")
for e in errs: print(f"  ERROR {e}")
print(f"\n{len(errs)} error(s), {len(warns)} warning(s)")
sys.exit(1 if errs else 0)
