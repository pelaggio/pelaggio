#!/usr/bin/env python3
"""Render the successor corpus to a single HTML page.

Every relation shown is read from `edges`. Nothing is hand-written twice — which is
the whole point: findings 2, 17 and 19 of the last review were three encodings of the
same 35 edges disagreeing inside one document.
"""
import json, subprocess, sys, html, collections

CORPUS = sys.argv[1] if len(sys.argv) > 1 else "corpus.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "minimal-viable-bones.html"

if subprocess.run([sys.executable, "check_corpus.py", CORPUS]).returncode:
    sys.exit("corpus invalid — refusing to render")

C = json.load(open(CORPUS))
N = {n["id"]: n for n in C["nodes"]}
E = C["edges"]
esc = lambda s: html.escape(str(s))

out_e = collections.defaultdict(list)
in_e = collections.defaultdict(list)
for e in E:
    out_e[e["from"]].append(e)
    in_e[e["to"]].append(e)

def by(kind, role=None):
    return [n for n in C["nodes"] if n["kind"] == kind and (role is None or n.get("role") == role)]

def rel_line(nid):
    """Node annotation — derived from edges, never authored."""
    bits = []
    for e in out_e[nid]:
        bits.append(f'<span><b>{esc(e["relation"])}</b> {esc(e["to"])}</span>')
    inc = [e for e in in_e[nid] if e["relation"] == "constrains"]
    if inc:
        bits.append(f'<span><b>constrained by</b> {esc(", ".join(e["from"] for e in inc))}</span>')
    imp = [e for e in in_e[nid] if e["relation"] == "implements"]
    if imp:
        bits.append(f'<span><b>implemented by</b> {esc(", ".join(e["from"] for e in imp))}</span>')
    asm = [e for e in in_e[nid] if e["relation"] == "assumes"]
    if asm:
        bits.append(f'<span><b>assumed by</b> {esc(", ".join(e["from"] for e in asm))}</span>')
    src = N[nid].get("sources") or []
    if src:
        bits.append(f'<span><b>sources</b> {esc(" · ".join(src))}</span>')
    return f'<span class="nm">{"".join(bits)}</span>' if bits else ""

def node_html(n):
    extra = ""
    if n.get("wrongIf"):
        extra = f'<span class="wi"><b>wrong-if</b> {esc(n["wrongIf"])}</span>'
    return (f'<div class="node"><span class="nid">{esc(n["id"])}</span><div class="nb">'
            f'<span class="nt">{esc(n["statement"])}</span>{extra}{rel_line(n["id"])}</div></div>')

def set_html(cls, label, nodes):
    body = "".join(node_html(n) for n in nodes)
    return (f'<div class="set {cls}"><div class="set-h"><span>{esc(label)}</span>'
            f'<span>{len(nodes)}</span></div>{body}</div>')

# coverage — derived
cov_rows = []
for n in by("proposition", "invariant"):
    i = n["id"]
    c = ", ".join(e["from"] for e in in_e[i] if e["relation"] == "constrains") or "—"
    d = ", ".join(e["from"] for e in in_e[i] if e["relation"] == "implements") or "—"
    a = ", ".join(e["to"] for f in [i] for e in
                 [x for x in E if x["relation"] == "assumes" and
                  x["from"] in [y["from"] for y in in_e[i] if y["relation"] == "implements"]]) or "—"
    cov_rows.append(f'<tr><td class="k">{esc(i)}</td><td>{esc(c)}</td><td>{esc(d)}</td><td>{esc(a)}</td></tr>')

edge_rows = "".join(
    f'<tr><td class="k">{esc(e["from"])}</td><td>{esc(e["relation"])}</td><td class="k">{esc(e["to"])}</td></tr>'
    for e in sorted(E, key=lambda x: (x["relation"], x["from"])))

counts = collections.Counter(n["kind"] for n in C["nodes"])
roles = collections.Counter(n.get("role") for n in C["nodes"] if n["kind"] == "proposition")
unused = [k for k in C["relationKinds"] if k not in {e["relation"] for e in E}]

CSS = open("corpus.css").read()
doc = f"""<title>Minimal Viable Bones</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>{CSS}</style>
<div class="page">
<header class="masthead">
  <p class="eyebrow">Successor architecture · project corpus · draft 5 · generated</p>
  <h1>Minimal Viable Bones</h1>
  <p class="standfirst">The governing knowledge of a successor harness, authored once as data and rendered from it. Every relation on this page is read from the corpus; none is written twice.</p>
  <div class="pins">
    <span><b>Kernel</b> {esc(" · ".join(C["kernel"]))}</span>
    <span><b>Nodes</b> {len(C["nodes"])}</span>
    <span><b>Edges</b> {len(E)}</span>
    <span><b>Authority</b> none</span>
  </div>
</header>

<section><div class="sec-head"><span class="sec-num">§0</span><h2>Why this is generated</h2></div>
<p>The previous draft hand-maintained node annotations, an edge table and a coverage table. A provider-diverse review found all three disagreeing — inside one document, authored in one sitting, arguing for author-once-derive-everything. Three of its twenty-one findings were that drift.</p>
<p>This page is emitted by a renderer that refuses to run on an invalid corpus. A domain checker enforces the relation contract — source and target kinds, assumption targets, matching roles for <code>specializes</code> — and rejects an edge whose endpoint is not a corpus node, which is how external references stopped being edge targets and became a <code>sources</code> field. It also fails on causal-outcome language outside an assumption, because the corpus has no node kind for a thesis.</p>
<p>Counts: {esc(dict(counts))}, roles {esc(dict(roles))}. Relation kinds declared but unused: {esc(", ".join(unused) or "none")}.</p>
</section>

<section><div class="sec-head"><span class="sec-num">§1</span><h2>Invariants</h2></div>
<p>What must always be true, stated without naming the mechanism that achieves it.</p>
{set_html("inv", "proposition · invariant", by("proposition", "invariant"))}
</section>

<section><div class="sec-head"><span class="sec-num">§2</span><h2>Constraints</h2></div>
<p>What any implementation may not do.</p>
{set_html("con", "proposition · constraint", by("proposition", "constraint"))}
</section>

<section><div class="sec-head"><span class="sec-num">§3</span><h2>Assumptions</h2></div>
<p>The only node kind that may carry a claim about consequences. Each is falsifiable and each is depended upon by something — an assumption nothing rests on is deleted.</p>
{set_html("asm", "proposition · assumption", by("proposition", "assumption"))}
</section>

<section><div class="sec-head"><span class="sec-num">§4</span><h2>Decisions</h2></div>
{set_html("dec", "decision", by("decision"))}
</section>

<section><div class="sec-head"><span class="sec-num">§5</span><h2>Coverage</h2></div>
<p>Derived from the edge set. A gap here is a real gap, not a transcription slip.</p>
<div class="tablewrap"><table>
<thead><tr><th>Invariant</th><th>Constrained by</th><th>Implemented by</th><th>Assumes</th></tr></thead>
<tbody>{"".join(cov_rows)}</tbody></table></div>
</section>

<section><div class="sec-head"><span class="sec-num">§6</span><h2>Edges</h2></div>
<p>The corpus's relations in full. §1–§5 are projections of this table.</p>
<div class="tablewrap"><table>
<thead><tr><th>From</th><th>Relation</th><th>To</th></tr></thead>
<tbody>{edge_rows}</tbody></table></div>
</section>

<div class="endnote">
<p><strong>Status.</strong> {esc(C["authority"])}. No evidence nodes exist yet: the kernel admits them, and nothing has been observed of a system that does not run.</p>
<p><strong>Generated</strong> from <code>corpus.json</code> by <code>render_corpus.py</code>, which refuses to emit on a corpus that fails <code>check_corpus.py</code>.</p>
</div>
</div>
"""
open(OUT, "w").write(doc)
print(f"rendered {OUT}: {len(C['nodes'])} nodes, {len(E)} edges")
