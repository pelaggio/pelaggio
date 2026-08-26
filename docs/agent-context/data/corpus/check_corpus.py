#!/usr/bin/env python3
"""Domain checker for the successor corpus.

Every check here exists because a review finding got past a hand-maintained encoding.
Failures are fatal; the renderer refuses to run on an invalid corpus.
"""
import json, os, re, sys, collections

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
        if n.get("role") == "assumption":
            # Two grammars, and the difference is honest rather than decorative: `wrongIf` is a
            # counterexample that settles the claim, `revisitIf` a trigger to look again. Most
            # things worth assuming only ever get the second. Requiring exactly one stops a bet
            # being dressed as a refutation, which is what grading falsifier prose was papering over.
            has = [k for k in ("wrongIf", "revisitIf") if n.get(k)]
            if not has:
                errs.append(f"{n['id']}: assumption carries neither a wrongIf nor a revisitIf")
            elif len(has) > 1:
                errs.append(f"{n['id']}: assumption carries both wrongIf and revisitIf — "
                            f"a claim is settled by a counterexample or it is not")
    elif "role" in n:
        errs.append(f"{n['id']}: kind {n['kind']} must not carry a role")
    if not n.get("statement", "").strip():
        errs.append(f"{n['id']}: empty statement")

# --- binds: a constraint is a predicate on the harness, or it is not a constraint ---
# This is the retired surface-area constraint as mechanism rather than as a node. Every other value is
# admitted so the author must classify honestly; each one names where the node belongs.
BINDS_DEST = {
    "callee": "surplus — the callee holds only tools (DEC-12), so either the tool is absent and this "
              "is already impossible, or it is present and the predicate is on the harness that granted it",
    "corpus": "not about the modelled system — this is a rule over the corpus, and belongs in this checker",
    "method": "not a predicate — this is a design choice, and belongs in a decision or in the RFC guardrails",
}
for n in C["nodes"]:
    if n.get("role") == "constraint":
        b = n.get("binds")
        if b is None:
            errs.append(f"{n['id']}: constraint without `binds` — name the party whose behaviour it bounds")
        elif b != "harness":
            errs.append(f"{n['id']}: binds {b!r} — {BINDS_DEST.get(b, 'unknown binds value')}")
    elif "binds" in n:
        errs.append(f"{n['id']}: only a constraint carries `binds`")

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

# --- duplicate edges --------------------------------------------------------
seen = collections.Counter((e["from"], e["relation"], e["to"]) for e in C["edges"])
for k, c in seen.items():
    if c > 1:
        errs.append(f"duplicate edge {k[0]} -{k[1]}-> {k[2]} ({c}×)")

# --- coverage (warnings, not errors: a gap may be honest) -------------------
impl = {e["to"] for e in C["edges"] if e["relation"] == "implements"}
assumed = {e["to"] for e in C["edges"] if e["relation"] == "assumes"}
refd = {e["from"] for e in C["edges"]} | {e["to"] for e in C["edges"]}

for n in C["nodes"]:
    if n["kind"] == "proposition" and n.get("role") == "invariant":
        if n["id"] not in impl:
            warns.append(f"{n['id']}: invariant with no decision implementing it — unbounded, since a "
                         f"bound is established by construction or by a predicate, and this has neither")
    if n["kind"] == "proposition" and n.get("role") == "assumption" and n["id"] not in assumed:
        warns.append(f"{n['id']}: assumption nothing depends on — candidate for deletion (finding 4/5)")
    if n["id"] not in refd:
        warns.append(f"{n['id']}: orphan — participates in no relation")

# --- thesis smuggling (finding 6 / 8) ---------------------------------------
CAUSAL = ("raises", "reduces", "improves", "lowers", "increases", "decreases",
          "faster", "cheaper", "fewer", "more often", "less often", "drives", "causes")
for n in C["nodes"]:
    s = n.get("statement", "").lower()
    hits = [w for w in CAUSAL if w in s]
    if hits and n.get("role") != "assumption":
        errs.append(f"{n['id']}: causal-outcome language {hits} outside an assumption — the corpus has no node kind for a thesis")
    elif hits:
        warns.append(f"{n['id']}: causal language {hits}; confirm its condition tests the causal claim, not just the outcome")


# --- prose must not name a node that does not exist --------------------------
# Hand-authored prose cites node ids, so retiring a node strands every sentence naming
# it. This is a completeness surface, so it is walked rather than listed: naming two
# renderers left this file and the corpus's own text unchecked, and this file was in
# fact citing a node it had retired.
HERE = os.path.dirname(os.path.abspath(__file__))
# One or two digits only. The antecedent repo numbers its nodes to four (`CON-0003`), and
# `sources` is precisely where such external references are supposed to live — matching them
# here would make the field that exists to carry them the field that cannot.
ID = re.compile(r"\b(?:INV|CON|ASM|DEC)-\d{1,2}\b")

def cite(where, text):
    for tok in sorted(set(ID.findall(text))):
        if tok not in N:
            errs.append(f"{where}: prose names {tok}, which is not a corpus node")

for fn in sorted(os.listdir(HERE)):
    if fn.endswith((".py", ".md")):
        cite(fn, open(os.path.join(HERE, fn)).read())
def walk(path, value):
    """Every string in the corpus, wherever it lives.

    Enumerating the prose-bearing fields is what this guard did first, and it was
    fail-open by construction: `authority`, the top-level `note` and each relation's
    `note` are prose too, so a retired id cited in any of them passed. A field list
    has to be extended for every field added; a walk does not.
    """
    if isinstance(value, str):
        cite(path or "corpus", value)
    elif isinstance(value, dict):
        for key, item in value.items():
            walk(f"{path}.{key}" if path else key, item)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            walk(f"{path}[{index}]", item)

walk("", C)

# --- report -----------------------------------------------------------------
k = collections.Counter(n["kind"] for n in C["nodes"])
r = collections.Counter(n.get("role") for n in C["nodes"] if n["kind"] == "proposition")
print(f"nodes {len(C['nodes'])}  {dict(k)}  roles {dict(r)}   edges {len(C['edges'])}")
print(f"relations {dict(collections.Counter(e['relation'] for e in C['edges']))}")
for w in warns: print(f"  warn  {w}")
for e in errs: print(f"  ERROR {e}")
print(f"\n{len(errs)} error(s), {len(warns)} warning(s)")
sys.exit(1 if errs else 0)
