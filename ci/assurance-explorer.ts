import type { ExplorerPayload } from "./assurance-views.js";

function embedJson(payload: unknown): string {
	return JSON.stringify(payload).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const ATLAS_CONCEPTS = [
	{ id: "authority", title: "Authority & self-authorization", summary: "Who may judge, approve, and cause consequential effects — and what Pelaggio may never decide for itself.", view: "why", node: "CLM-0006" },
	{ id: "execution", title: "Contained execution", summary: "How untrusted agent work is bounded so a mistake cannot quietly become ambient authority.", view: "why", node: "CLM-0002" },
	{ id: "review", title: "Review & judgment", summary: "Why model judgment remains distinct from deterministic enforcement, and how blockers survive disagreement.", view: "review" },
	{ id: "landing", title: "Safe landing", summary: "The intent that must remain true when verified work crosses into the target branch.", view: "landing" },
	{ id: "recovery", title: "State & recovery", summary: "How interrupted work resumes by reconciling durable state rather than replaying a model transcript.", view: "why", node: "CLM-0012" },
	{ id: "provenance", title: "Provenance & custody", summary: "What lets a reviewer trace a delivered change through the choices, evidence, and authority behind it.", view: "why", node: "CLM-0008" },
	{ id: "policy", title: "Mechanism & policy", summary: "The seam that keeps deterministic safety in the harness while allowing judgment to evolve.", view: "why", node: "CLM-0017" },
	{ id: "corpus", title: "Intent & corpus integrity", summary: "How Pelaggio keeps durable architectural intent singular, inspectable, and independent of its renderer.", view: "why", node: "CLM-0020" },
	{ id: "trust", title: "Public trust", summary: "The promises Pelaggio exposes publicly, their scope, and what internal intent they project.", view: "trust" },
] as const;

const STYLES = `
:root {
  --paper: #f4f1ea; --paper-deep: #ebe6dc; --ink: #18201d; --muted: #68716c;
  --line: #d8d3c8; --card: #fffdf8; --forest: #173f36; --forest-2: #285b4d;
  --mint: #d8eadf; --amber: #d88745; --violet: #7568a8; --blue: #467d97;
  --danger: #a44a3f; --shadow: 0 16px 45px rgba(37, 45, 40, 0.08);
}
* { box-sizing: border-box; }
html { background: var(--paper); }
html, body { margin: 0; color: var(--ink); font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { min-height: 100vh; background: radial-gradient(circle at 80% -10%, #dde7dd 0, transparent 36rem), var(--paper); }
button, select, input { font: inherit; }
button { color: inherit; }
[hidden] { display: none !important; }
.app-bar { height: 66px; padding: 0 30px; display: flex; align-items: center; gap: 22px; border-bottom: 1px solid rgba(24,32,29,.1); background: rgba(244,241,234,.9); backdrop-filter: blur(16px); position: sticky; top: 0; z-index: 20; }
.wordmark { border: 0; background: none; padding: 0; cursor: pointer; display: flex; gap: 11px; align-items: center; font: 650 17px/1 Georgia, serif; letter-spacing: -.02em; }
.mark { width: 28px; height: 28px; border-radius: 50%; background: var(--forest); color: #fff; display: grid; place-items: center; font: 600 16px Georgia, serif; }
.app-nav { display: flex; gap: 4px; }
.app-nav button, .quiet-button { border: 0; background: transparent; padding: 8px 10px; border-radius: 8px; cursor: pointer; color: var(--muted); }
.app-nav button:hover, .quiet-button:hover { background: rgba(23,63,54,.07); color: var(--forest); }
.status-pill { margin-left: auto; border: 1px solid #b7c9bc; color: var(--forest-2); background: rgba(255,255,255,.55); border-radius: 999px; padding: 5px 10px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.global-search { position: relative; width: min(320px, 28vw); }
.global-search input { width: 100%; border: 1px solid var(--line); background: rgba(255,255,255,.72); border-radius: 10px; padding: 9px 12px 9px 34px; outline: none; }
.global-search:before { content: "⌕"; position: absolute; left: 12px; top: 7px; color: var(--muted); font-size: 18px; }
#search-results { position: absolute; z-index: 30; left: 0; right: 0; top: calc(100% + 7px); margin: 0; padding: 6px; list-style: none; background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); max-height: 22rem; overflow: auto; }
#search-results:empty { display: none; }
#search-results button { display: block; width: 100%; text-align: left; border: 0; background: none; padding: 9px 10px; border-radius: 7px; cursor: pointer; }
#search-results button:hover { background: var(--paper-deep); }
.atlas { max-width: 1040px; margin: 0 auto; padding: 64px 34px 90px; }
.eyebrow { color: var(--forest-2); text-transform: uppercase; letter-spacing: .13em; font-size: 11px; font-weight: 700; }
.atlas h1 { font: 500 clamp(42px, 6vw, 68px)/1.02 Georgia, serif; letter-spacing: -.045em; max-width: 850px; margin: 17px 0 23px; }
.atlas-lede { max-width: 760px; color: #53605a; font-size: 18px; line-height: 1.65; margin: 0 0 42px; }
.section-heading { display: flex; justify-content: space-between; gap: 20px; align-items: end; margin-bottom: 20px; }
.section-heading h2 { font: 500 29px Georgia, serif; margin: 0; }
.section-heading p { margin: 0; color: var(--muted); max-width: 510px; }
.preview-note { margin: -6px 0 22px; padding: 10px 13px; border-left: 3px solid var(--amber); background: #fbf4e8; color: #735a38; font-size: 12px; }
.corpus-tabs { display: flex; gap: 6px; padding: 5px; border: 1px solid var(--line); border-radius: 13px; background: rgba(235,230,220,.7); margin-bottom: 18px; }
.corpus-tab { flex: 1; border: 0; border-radius: 9px; padding: 13px 16px; background: transparent; color: var(--muted); cursor: pointer; text-align: left; }
.corpus-tab strong { display: block; color: inherit; font-size: 14px; }
.corpus-tab span { font-size: 11px; }
.corpus-tab[aria-selected="true"] { background: var(--card); color: var(--forest); box-shadow: 0 2px 10px rgba(37,45,40,.08); }
.index-intro { display: flex; justify-content: space-between; gap: 24px; align-items: baseline; margin: 0 2px 15px; }
.index-intro h2 { margin: 0; font: 500 25px Georgia, serif; }
.index-intro p { color: var(--muted); margin: 0; font-size: 12px; }
.record-list { border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: rgba(255,253,248,.75); }
.record { border-bottom: 1px solid var(--line); }
.record:last-child { border-bottom: 0; }
.record summary { list-style: none; display: grid; grid-template-columns: 92px minmax(0,1fr) auto; gap: 18px; align-items: center; padding: 20px 22px; cursor: pointer; }
.record summary::-webkit-details-marker { display: none; }
.record summary:hover { background: rgba(216,234,223,.25); }
.record[open] summary { background: rgba(216,234,223,.36); }
.record-id { color: var(--forest-2); font: 700 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; }
.record-title { min-width: 0; }
.record-title strong { display: block; font: 500 20px/1.2 Georgia, serif; overflow-wrap: anywhere; }
.record-title span { display: block; color: var(--muted); margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.record-glance { display: block; color: var(--forest-2); margin-top: 7px; font-size: 11px; text-transform: lowercase; }
.record-toggle { width: 29px; height: 29px; border: 1px solid var(--line); border-radius: 50%; display: grid; place-items: center; color: var(--forest); font-size: 18px; transition: transform .16s ease; }
.record[open] .record-toggle { transform: rotate(45deg); }
.record-body { display: grid; grid-template-columns: minmax(0,1.5fr) minmax(220px,.7fr); gap: 38px; padding: 4px 64px 28px 132px; background: rgba(255,253,248,.55); }
.record-statement { margin: 0; font: 500 19px/1.55 Georgia, serif; }
.record-side h3 { display: block; margin: 0 0 4px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.brief-section { padding: 17px 0; border-top: 1px solid var(--line); }
.brief-section:first-of-type { border-top: 0; padding-top: 0; }
.brief-section h3 { margin: 0 0 9px; color: var(--forest-2); font-size: 10px; letter-spacing: .11em; text-transform: uppercase; }
.brief-section p { margin: 7px 0; }
.brief-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.brief-list li { color: #3e4944; }
.brief-link { border: 0; border-bottom: 1px solid #9eb9aa; padding: 0; background: transparent; color: var(--forest-2); cursor: pointer; font-weight: 700; text-align: left; }
.brief-link:hover { border-bottom-color: var(--forest); }
.brief-gap { color: #846443 !important; font-style: italic; }
.tripwire { margin-top: 3px; padding: 13px 15px; border: 1px solid #e6d3b5; border-radius: 9px; background: #fbf4e8; color: #735a38; }
.tripwire p:first-child { margin-top: 0; }
.tripwire p:last-child { margin-bottom: 0; }
.source-anchor { margin: 9px 0; padding-left: 13px; border-left: 2px solid var(--line); color: #59645f; }
.record-side { border-left: 1px solid var(--line); padding-left: 24px; margin-top: 15px; }
.record-side h3 { margin-top: 18px; }
.record-side h3:first-child { margin-top: 0; }
.record-side ul { margin: 6px 0 0; padding-left: 17px; }
.record-side a { color: var(--forest-2); }
.record-meta { display: flex; gap: 6px; flex-wrap: wrap; }
.record-meta span { background: var(--paper-deep); border-radius: 999px; padding: 3px 7px; font-size: 10px; color: var(--muted); }
.graph-link { margin-top: 20px; border: 0; border-bottom: 1px solid #9eb9aa; background: transparent; color: var(--forest-2); padding: 3px 0; cursor: pointer; }
.empty-index { padding: 34px; color: var(--muted); }
#explorer-shell { min-height: calc(100vh - 66px); }
#concept-hero { padding: 34px 34px 28px; background: rgba(255,253,248,.63); border-bottom: 1px solid var(--line); }
.concept-hero-inner { max-width: 1380px; margin: auto; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 34px; align-items: end; }
.concept-hero-inner h1 { font: 500 36px/1.1 Georgia, serif; letter-spacing: -.025em; margin: 8px 0 10px; }
.concept-hero-inner p { color: var(--muted); max-width: 720px; font-size: 16px; margin: 0; }
.hero-stats { display: flex; gap: 22px; }
.hero-stats strong { display: block; font: 500 22px Georgia,serif; }
.hero-stats span { color: var(--muted); font-size: 11px; }
#banner { padding: 8px 34px; background: #fbf4e8; border-bottom: 1px solid #e6d3b5; color: #7b5b2f; font-size: 11px; display: flex; gap: 18px; }
#banner h1 { display: none; }
#banner p { margin: 0; }
#banner-warning { margin-left: auto !important; }
#controls { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; padding: 12px 34px; border-bottom: 1px solid var(--line); background: rgba(255,253,248,.8); }
#controls label { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted); }
#controls select { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 6px 8px; max-width: 310px; }
#view-question { margin: 0; flex: 1 1 20rem; color: var(--muted); }
#depth-controls, #relation-controls { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 11px; }
#depth-controls button { border: 1px solid var(--line); background: #fff; border-radius: 6px; cursor: pointer; }
#depth-controls button[aria-pressed="true"] { background: var(--forest); color: #fff; }
#crumbs { display: flex; flex-wrap: wrap; gap: 6px; padding: 9px 34px; background: rgba(255,253,248,.72); }
#crumbs:empty { display: none; }
#crumbs button, .panel-actions button { border: 0; background: var(--paper-deep); padding: 6px 9px; border-radius: 7px; cursor: pointer; text-align: left; }
#workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 390px); min-height: 620px; max-height: calc(100vh - 220px); }
#canvas { position: relative; background-image: radial-gradient(#c9cec8 0.7px, transparent .7px); background-size: 18px 18px; background-color: #f7f7f3; min-height: 620px; }
#canvas:before { content: "INTENT                         CHOICES                         MACHINERY"; white-space: pre; position: absolute; z-index: 1; left: 9%; right: 9%; top: 16px; display: flex; justify-content: space-between; color: #9aa19d; font-size: 9px; letter-spacing: .12em; pointer-events: none; }
#graph { width: 100%; height: 100%; min-height: 620px; touch-action: none; }
#panel { border-left: 1px solid var(--line); background: var(--card); padding: 28px; overflow: auto; }
#panel h2 { margin: 0 0 6px; font: 500 27px Georgia, serif; }
#panel h3 { margin: 24px 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
#panel dl { margin: 0; }
#panel dt { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-top: 16px; }
#panel dd { margin: 4px 0 0; }
#panel .statement { white-space: pre-wrap; font: 500 17px/1.5 Georgia, serif; }
#panel a { color: var(--forest-2); }
#panel ul { padding-left: 18px; }
.badge { display: inline-block; margin: 3px 3px 0 0; padding: 3px 7px; border-radius: 999px; font-size: 10px; background: #f3dfdc; color: #7f342c; }
.badge.unrealized { background: #f8e3c9; color: #825019; }
.incident { margin: 6px 0; color: #4f5c56; }
.panel-actions { display: grid; gap: 7px; margin-top: 24px; }
.panel-actions button { width: 100%; padding: 9px 10px; }
#debt-list { max-width: 1100px; margin: 30px auto; padding: 28px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
#debt-list li { margin: 10px 0; }
#legend, #retired { padding: 12px 34px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; background: rgba(255,253,248,.75); }
#legend ul { display: flex; flex-wrap: wrap; gap: 9px 18px; margin: 7px 0 0; padding: 0; list-style: none; }
.swatch { display: inline-block; width: 9px; height: 9px; margin-right: 5px; vertical-align: 0; border-radius: 3px; }
.node-label { font-size: 10px; }
@media (max-width: 900px) {
  .record-body { grid-template-columns: 1fr; padding-left: 132px; }
  .record-side { border-left: 0; border-top: 1px solid var(--line); padding: 20px 0 0; }
  #workspace { grid-template-columns: 1fr; max-height: none; }
  #panel { border-left: 0; border-top: 1px solid var(--line); }
  .concept-hero-inner { grid-template-columns: 1fr; }
  .global-search { width: 220px; }
}
@media (max-width: 640px) {
  .app-bar { padding: 0 16px; }
  .app-nav { display: none; }
  .global-search { flex: 1; width: auto; }
  .status-pill { display: none; }
  .atlas { padding: 45px 18px; }
  .corpus-tabs { overflow-x: auto; }
  .corpus-tab { min-width: 130px; }
  .record summary { grid-template-columns: 70px minmax(0,1fr) auto; padding: 17px 15px; gap: 10px; }
  .record-title strong { font-size: 17px; }
  .record-body { padding: 2px 20px 25px; }
  #banner-warning { display: none; }
}
`.trim();

const CLIENT_SCRIPT = `
(function () {
  var payload = JSON.parse(document.getElementById("assurance-explorer-payload").textContent);
  var UNREALIZED = { "invariant-without-realization": 1, "constraint-without-enforcement": 1, "decision-without-realization": 1 };
  var PHRASES = {
    constrains: ["constrains", "constrained by"],
    implements: ["implements", "implemented by"],
    assumes: ["assumes", "assumed by"],
    specializes: ["specializes", "specialized by"],
    "derived-from": ["derived from", "has derivation"],
    projects: ["projects", "projected by"],
    supersedes: ["supersedes", "superseded by"]
  };
  var CONCEPTS = ${embedJson(ATLAS_CONCEPTS)};
  var INDEX_TABS = [
    { id: "choices", label: "Choices", title: "Decisions deliberately made", description: "Change or remove one only after checking the obligations and premises attached to it." },
    { id: "invariants", label: "Invariants", title: "Things that must stay true", description: "The acceptance bar for a replacement, regardless of which machinery implements it." },
    { id: "assumptions", label: "Assumptions", title: "Beliefs worth challenging", description: "Premises that make choices reasonable — and the earliest evidence that should reopen them." }
  ];
  var NS = "http://www.w3.org/2000/svg";
  var NODE_W = 168;
  var NODE_H = 46;
  var COL_X = { proposition: 140, decision: 420, realization: 700 };
  var crumbs = [];
  var state = defaultState();
  var atlasTab = new URLSearchParams(location.hash.replace(/^#/, "")).get("tab") || "choices";
  var vb = { x: 0, y: 0, w: 960, h: 640 };
  var pan = { on: false, x: 0, y: 0 };

  function viewMeta(id) {
    for (var i = 0; i < payload.views.length; i++) if (payload.views[i].id === id) return payload.views[i];
    return null;
  }
  function conceptMeta(id) {
    for (var i = 0; i < CONCEPTS.length; i++) if (CONCEPTS[i].id === id) return CONCEPTS[i];
    return null;
  }
  function currentView() { return viewMeta(state.view) || payload.views[0]; }
  function defaultDepth(view) {
    return view.defaultDepth;
  }
  function defaultMask(view) { return (1 << (view.relations ? view.relations.length : 0)) - 1; }
  function defaultState() {
    var view = payload.views[0];
    return { page: "atlas", concept: "", view: view.id, node: "", source: "", depth: defaultDepth(view), rel: defaultMask(view), sel: "", q: "" };
  }
	function sourceSeedKey(source) { return "source:" + source; }
	function stateSeedKey(view, node, source) {
		if (view.parameter === "node-or-source" && source) return sourceSeedKey(source);
		return node;
	}
  function nodeById(id) {
    for (var i = 0; i < payload.nodes.length; i++) if (payload.nodes[i].id === id) return payload.nodes[i];
    return null;
  }
  function debtView() {
    for (var i = 0; i < payload.views.length; i++) if (payload.views[i].kind === "debt") return payload.views[i];
    return null;
  }
  function debtDiagnostics() {
    var view = debtView();
    if (!view) return [];
    return payload.results[view.id].diagnostics || [];
  }
  function debtFor(id) {
    return debtDiagnostics().filter(function (d) { return d.node === id; });
  }
  function hasHit(view, node, source, depth, rel) {
    var bucket = payload.results[view.id];
    if (!bucket) return false;
    if (view.kind === "debt") return true;
    if (view.kind === "static") return !!bucket[String(rel)];
	var seed = stateSeedKey(view, node, source);
	return !!(bucket[seed] && bucket[seed][String(depth)] && bucket[seed][String(depth)][String(rel)]);
  }
  function restoreFromHash() {
    var raw = location.hash.replace(/^#/, "");
    if (!raw) return defaultState();
    var params = new URLSearchParams(raw);
    if (params.get("page") === "atlas") {
      var requestedTab = params.get("tab");
      if (requestedTab === "choices" || requestedTab === "invariants" || requestedTab === "assumptions") atlasTab = requestedTab;
      return defaultState();
    }
    var view = viewMeta(params.get("view") || "");
    if (!view) return defaultState();
    var node = params.get("node") || "";
	var source = params.get("source") || "";
    var depthParam = params.get("depth");
    var relParam = params.get("rel");
    var depth = depthParam == null || depthParam === "" ? defaultDepth(view) : Number(depthParam);
    var rel = relParam == null || relParam === "" ? defaultMask(view) : Number(relParam);
	if (node && source) return defaultState();
	if (!hasHit(view, node, source, depth, rel)) return defaultState();
	if (view.kind === "parameterized" && !node && !source) return defaultState();
    var sel = params.get("sel") || "";
    if (sel && !nodeById(sel)) sel = "";
	return { page: params.get("concept") ? "concept" : "explorer", concept: params.get("concept") || "", view: view.id, node: node, source: source, depth: depth, rel: rel, sel: sel, q: params.get("q") || "" };
  }
  function writeHash() {
    if (state.page === "atlas") {
      history.replaceState(null, "", "#page=atlas&tab=" + encodeURIComponent(atlasTab));
      return;
    }
    var view = currentView();
    var parts = ["view=" + encodeURIComponent(state.view)];
    if (state.page === "concept" && state.concept) parts.unshift("concept=" + encodeURIComponent(state.concept));
    if (view.kind === "parameterized") {
	  if (state.source) parts.push("source=" + encodeURIComponent(state.source));
	  else parts.push("node=" + encodeURIComponent(state.node));
      parts.push("depth=" + String(state.depth));
    }
    if (view.kind !== "debt" && view.relations.length) parts.push("rel=" + String(state.rel));
    if (state.sel) parts.push("sel=" + encodeURIComponent(state.sel));
    if (state.q) parts.push("q=" + encodeURIComponent(state.q));
    history.replaceState(null, "", "#" + parts.join("&"));
  }
  function hitFor(view, node, source) {
    var bucket = payload.results[view.id];
    if (view.kind === "debt") return { nodeIdxs: [], edgeIdxs: [], diagnostics: bucket.diagnostics || [] };
    if (view.kind === "parameterized") return bucket[stateSeedKey(view, node, source)][String(defaultDepth(view))][String(defaultMask(view))];
    return bucket[String(defaultMask(view))];
  }
  function hitForConcept(concept) {
    var view = viewMeta(concept.view);
    return hitFor(view, concept.node || "", "");
  }
  function openAtlas() {
    state.page = "atlas";
    state.concept = "";
    state.sel = "";
    writeHash();
    renderAll();
  }
  function indexNodes(tab) {
    if (tab === "choices") return payload.nodes.filter(function (node) { return node.kind === "decision"; });
    if (tab === "invariants") return payload.nodes.filter(function (node) { return node.role === "invariant" && node.visibility === "internal"; });
    if (tab === "assumptions") return payload.nodes.filter(function (node) { return node.role === "assumption"; });
    return [];
  }
  function tabMeta(id) {
    for (var i = 0; i < INDEX_TABS.length; i++) if (INDEX_TABS[i].id === id) return INDEX_TABS[i];
    return INDEX_TABS[0];
  }
  function relatedEntries(id, direction, relations, kind) {
    var found = [];
    payload.edges.forEach(function (edge) {
      if (direction === "out" && edge.from !== id) return false;
      if (direction === "in" && edge.to !== id) return false;
      if (relations.indexOf(edge.relation) < 0) return false;
      var other = nodeById(direction === "out" ? edge.to : edge.from);
      if (other && (!kind || other.kind === kind)) found.push({ edge: edge, node: other });
    });
    return found;
  }
  function consequenceLines(node) {
    var lines = [];
    var seen = {};
    function add(entries, text) {
      entries.forEach(function (entry) {
        var sentence = typeof text === "function" ? text(entry.node) : text;
        var key = entry.node.id + "|" + sentence;
        if (seen[key]) return;
        seen[key] = 1;
        lines.push({ node: entry.node, text: sentence });
      });
    }
    add(relatedEntries(node.id, "out", ["implements"], "proposition"), "remains an obligation this choice is intended to preserve.");
    add(relatedEntries(node.id, "out", ["assumes"]), "is a premise this choice relies on.");
    var dependentChoices = relatedEntries(node.id, "in", ["assumes"], "decision");
    add(dependentChoices, "depends on this premise and should be reopened if it weakens.");
    if (node.role === "assumption") {
      dependentChoices.forEach(function (choice) {
        add(relatedEntries(choice.node.id, "out", ["implements"], "proposition"), "remains an obligation even if this premise is rejected.");
      });
    }
    add(relatedEntries(node.id, "in", ["constrains"]), "binds any acceptable implementation of this property.");
    add(relatedEntries(node.id, "in", ["implements"], "decision"), function (choice) {
      if (choice.status === "historical-construction-choice") return "is a historical choice that previously carried this property.";
      if (choice.status === "target-construction-choice") return "is the target choice intended to preserve this property.";
      if (choice.status === "proposed-construction-choice") return "is a proposed choice intended to preserve this property.";
      return "is a current choice intended to preserve this property.";
    });
    add(relatedEntries(node.id, "out", ["derived-from"]), "is the earlier record this choice derives from.");
    add(relatedEntries(node.id, "out", ["supersedes"]), "is the earlier choice this record supersedes.");
    add(relatedEntries(node.id, "in", ["supersedes"]), "supersedes this record.");
    add(relatedEntries(node.id, "out", ["specializes"]), "is the broader intent this record specializes.");
    add(relatedEntries(node.id, "in", ["specializes"]), "is narrower intent that depends on this distinction.");
    add(relatedEntries(node.id, "in", ["projects"]), node.kind === "decision" ? "publishes a scoped projection of this choice." : "publishes a scoped projection of this internal property.");
    return lines;
  }
  function currentMachinery(node) {
    return relatedEntries(node.id, "in", ["implements", "derived-from"], "realization");
  }
  function actionableSignals(node) {
    return debtFor(node.id).filter(function (signal) {
      return UNREALIZED[signal.check] || signal.check === "assumption-without-falsifier" || signal.check === "projection-overreach";
    });
  }
  function openRecordGraph(id) {
    state.page = "explorer";
    state.concept = "";
    reseedNode("why", id);
  }
  function openConcept(id) {
    var concept = conceptMeta(id);
    if (!concept) return;
    var view = viewMeta(concept.view);
    state.page = "concept";
    state.concept = id;
    state.view = view.id;
    state.node = concept.node || "";
    state.source = "";
    state.depth = defaultDepth(view);
    state.rel = defaultMask(view);
    state.sel = concept.node || "";
    writeHash();
    renderAll();
  }
  function openAdvanced() {
    state.page = "explorer";
    state.concept = "";
    writeHash();
    renderAll();
  }
  function lookupHit() {
    var view = currentView();
    var bucket = payload.results[view.id];
    if (view.kind === "debt") return { nodeIdxs: [], edgeIdxs: [], diagnostics: bucket.diagnostics || [] };
	if (view.kind === "parameterized") return bucket[stateSeedKey(view, state.node, state.source)][String(state.depth)][String(state.rel)];
    return bucket[String(state.rel)];
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function el(tag, props) {
    var node = document.createElement(tag);
    if (!props) return node;
    Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value == null) return;
      if (key === "text") node.textContent = value;
      else if (key === "className") node.className = value;
      else if (key === "href") node.setAttribute("href", value);
      else node.setAttribute(key, String(value));
    });
    return node;
  }
  function svgEl(name) { return document.createElementNS(NS, name); }
  function fillFor(node) {
    if (node.kind === "proposition") {
      if (node.role === "constraint") return "#f59e0b";
      if (node.role === "assumption") return "#a78bfa";
      return "#60a5fa";
    }
    if (node.kind === "decision") {
      if (node.status === "current-policy-choice") return "#38bdf8";
      if (node.status === "target-construction-choice") return "#a3e635";
      if (node.status === "proposed-construction-choice") return "#fbbf24";
      if (node.status === "historical-construction-choice") return "#94a3b8";
      return "#2dd4bf";
    }
    return "#cbd5e1";
  }
  function isUnrealized(id) {
    return debtFor(id).some(function (d) { return UNREALIZED[d.check]; });
  }
  function layout(nodes) {
    var columns = { proposition: [], decision: [], realization: [] };
    nodes.forEach(function (node) {
      if (columns[node.kind]) columns[node.kind].push(node);
      else columns.realization.push(node);
    });
    Object.keys(columns).forEach(function (kind) {
      columns[kind].sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    });
    var max = Math.max(columns.proposition.length, columns.decision.length, columns.realization.length, 1);
    var height = 80 + max * (NODE_H + 18);
    var pos = {};
    function place(list, kind) {
      var span = height - 80;
      list.forEach(function (node, i) {
        var y = 40 + (list.length === 1 ? span / 2 : (i + 0.5) * (span / list.length));
        pos[node.id] = { x: COL_X[kind], y: y };
      });
    }
    place(columns.proposition, "proposition");
    place(columns.decision, "decision");
    place(columns.realization, "realization");
    return { pos: pos, width: 860, height: height };
  }
  function applyViewBox() {
    document.getElementById("graph").setAttribute("viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h);
  }
  function fitTo(width, height) {
    vb = { x: -40, y: 0, w: width + 80, h: Math.max(height, 320) };
    applyViewBox();
  }
  function renderBanner() {
    document.getElementById("banner-meta").textContent =
      "status: " + (payload.status || "unknown") +
      " · authority: " + (payload.authority || "unspecified") +
      " · schema: " + payload.graphSchemaVersion +
      " · catalog: " + payload.catalogSchemaVersion +
      " · commit: " + payload.commitSha;
    document.getElementById("status-pill").textContent = (payload.status || "unknown") + " corpus · " + payload.nodes.length + " records";
  }
  function renderAtlas() {
    var tabs = document.getElementById("corpus-tabs");
    clear(tabs);
    INDEX_TABS.forEach(function (tab) {
      var nodes = indexNodes(tab.id);
      var button = el("button", { type: "button", className: "corpus-tab", role: "tab", "aria-selected": String(atlasTab === tab.id), "aria-controls": "record-list" });
      button.appendChild(el("strong", { text: tab.label }));
      button.appendChild(el("span", { text: nodes.length + " records" }));
      button.addEventListener("click", function () {
        atlasTab = tab.id;
        writeHash();
        renderAtlas();
      });
      tabs.appendChild(button);
    });
    var meta = tabMeta(atlasTab);
    document.getElementById("index-title").textContent = meta.title;
    document.getElementById("index-description").textContent = meta.description;
    var host = document.getElementById("record-list");
    clear(host);
    var records = indexNodes(atlasTab).slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    if (!records.length) host.appendChild(el("p", { className: "empty-index", text: "No records in this category." }));
    records.forEach(function (node) {
      var signals = actionableSignals(node);
      var consequences = consequenceLines(node);
      var machinery = currentMachinery(node);
      var details = el("details", { className: "record" });
      var summary = el("summary");
      summary.appendChild(el("span", { className: "record-id", text: node.id }));
      var title = el("span", { className: "record-title" });
      title.appendChild(el("strong", { text: node.slug.replace(/-/g, " ") }));
      title.appendChild(el("span", { text: node.statement }));
      var glance = [node.status || node.role, signals.length ? "needs attention" : ""].filter(Boolean).join(" · ");
      if (glance) title.appendChild(el("small", { className: "record-glance", text: glance }));
      summary.appendChild(title);
      summary.appendChild(el("span", { className: "record-toggle", text: "+", "aria-hidden": "true" }));
      details.appendChild(summary);
      var body = el("div", { className: "record-body" });
      var main = el("div");
      var claim = el("section", { className: "brief-section" });
      claim.appendChild(el("h3", { text: "Claim" }));
      claim.appendChild(el("p", { className: "record-statement", text: node.statement }));
      main.appendChild(claim);
      var consequence = el("section", { className: "brief-section" });
      consequence.appendChild(el("h3", { text: "If this changes" }));
      var consequenceList = el("ul", { className: "brief-list" });
      consequences.forEach(function (line) {
        var item = el("li");
        var button = el("button", { type: "button", className: "brief-link", text: line.node.id + " · " + line.node.slug.replace(/-/g, " ") });
        button.addEventListener("click", function () { openRecordGraph(line.node.id); });
        item.appendChild(button);
        item.appendChild(document.createTextNode(" " + line.text));
        consequenceList.appendChild(item);
      });
      if (!consequences.length) consequenceList.appendChild(el("li", { className: "brief-gap", text: "No change consequence is encoded for this record." }));
      consequence.appendChild(consequenceList);
      main.appendChild(consequence);
      var escalation = el("section", { className: "brief-section" });
      escalation.appendChild(el("h3", { text: "Raise early" }));
      var tripwire = el("div", { className: "tripwire" });
      if (!node.wrongIf && !node.revisitIf && !signals.length) tripwire.appendChild(el("p", { className: "brief-gap", text: "No change-specific escalation condition is encoded for this record." }));
      if (node.wrongIf) tripwire.appendChild(el("p", { text: "Settling counterexample: " + node.wrongIf }));
      if (node.revisitIf) tripwire.appendChild(el("p", { text: "Revisit trigger: " + node.revisitIf }));
      signals.forEach(function (signal) { tripwire.appendChild(el("p", { text: signal.check + ": " + signal.message })); });
      escalation.appendChild(tripwire);
      main.appendChild(escalation);
      var evidence = el("section", { className: "brief-section" });
      evidence.appendChild(el("h3", { text: "Evidence & current state" }));
      var evidenceList = el("ul", { className: "brief-list" });
      machinery.forEach(function (entry) {
        var item = el("li");
        var button = el("button", { type: "button", className: "brief-link", text: entry.node.id + " · " + entry.node.slug.replace(/-/g, " ") });
        button.addEventListener("click", function () { openRecordGraph(entry.node.id); });
        item.appendChild(button);
        item.appendChild(document.createTextNode(" is named as current machinery for this record."));
        evidenceList.appendChild(item);
      });
      node.sources.forEach(function (source) {
        var item = el("li");
        item.appendChild(document.createTextNode("Authored in "));
        if (source.href) item.appendChild(el("a", { href: source.href, text: source.label }));
        else item.appendChild(document.createTextNode(source.label));
        evidenceList.appendChild(item);
      });
      evidence.appendChild(evidenceList);
      node.grounding.forEach(function (entry) {
        entry.anchors.forEach(function (anchor) { evidence.appendChild(el("p", { className: "source-anchor", text: "“" + anchor + "”" })); });
      });
      main.appendChild(evidence);
      body.appendChild(main);
      var side = el("aside", { className: "record-side" });
      var metaWrap = el("div", { className: "record-meta" });
      [node.status, node.visibility, node.role].filter(Boolean).forEach(function (value) { metaWrap.appendChild(el("span", { text: value })); });
      side.appendChild(metaWrap);
      side.appendChild(el("h3", { text: "Technical trace" }));
      side.appendChild(el("p", { text: "The graph is retained for inspecting exact typed edges, not as the primary explanation." }));
      var graphButton = el("button", { type: "button", className: "graph-link", text: "Open technical trace →" });
      graphButton.addEventListener("click", function () { openRecordGraph(node.id); });
      side.appendChild(graphButton);
      body.appendChild(side);
      details.appendChild(body);
      host.appendChild(details);
    });
  }
  function renderConceptHero() {
    var hero = document.getElementById("concept-hero");
    var concept = conceptMeta(state.concept);
    if (!concept || state.page !== "concept") {
      hero.hidden = true;
      return;
    }
    hero.hidden = false;
    var hit = lookupHit();
    var nodes = (hit.nodeIdxs || []).map(function (idx) { return payload.nodes[idx]; });
    var unresolved = nodes.filter(function (node) { return debtFor(node.id).length > 0; }).length;
    document.getElementById("concept-title").textContent = concept.title;
    document.getElementById("concept-summary").textContent = concept.summary;
    document.getElementById("concept-records").textContent = nodes.length;
    document.getElementById("concept-relations").textContent = (hit.edgeIdxs || []).length;
    document.getElementById("concept-debt").textContent = unresolved;
  }
  function renderControls() {
    var view = currentView();
    var picker = document.getElementById("view-picker");
    if (!picker.childNodes.length) {
      payload.views.forEach(function (candidate) {
        var opt = el("option", { value: candidate.id, text: candidate.id + " — " + candidate.question });
        picker.appendChild(opt);
      });
      picker.addEventListener("change", function () {
        var next = viewMeta(picker.value);
        state.view = next.id;
        state.depth = defaultDepth(next);
        state.rel = defaultMask(next);
        if (next.kind === "parameterized") {
		  var seed = state.sel || state.node;
		  var source = next.parameter === "node-or-source" ? state.source : "";
		  if (!hasHit(next, seed, source, state.depth, state.rel)) {
			seed = payload.nodes[0].id;
			source = "";
		  }
          state.node = seed;
		  state.source = source;
		} else {
		  state.source = "";
        }
        writeHash();
        renderAll();
      });
    }
    picker.value = view.id;
    document.getElementById("view-question").textContent = view.question;
    var depthBox = document.getElementById("depth-controls");
    depthBox.hidden = view.kind !== "parameterized";
	clear(depthBox);
    if (view.kind === "parameterized") {
	  depthBox.appendChild(el("span", { text: "Depth" }));
	  view.depths.forEach(function (depth) {
		var btn = el("button", { type: "button", "data-depth": depth, text: depth, "aria-pressed": String(depth === state.depth) });
		btn.addEventListener("click", function () {
		  state.depth = depth;
		  writeHash();
		  renderAll();
		});
		depthBox.appendChild(btn);
      });
    }
	var seedControl = document.getElementById("seed-control");
	var seedPicker = document.getElementById("seed-picker");
	seedControl.hidden = view.kind !== "parameterized";
	clear(seedPicker);
	if (view.kind === "parameterized") {
	  var nodeGroup = el("optgroup", { label: "Nodes" });
	  payload.nodes.forEach(function (node) { nodeGroup.appendChild(el("option", { value: node.id, text: node.id + " · " + node.slug })); });
	  seedPicker.appendChild(nodeGroup);
	  if (view.parameter === "node-or-source") {
		var sourceGroup = el("optgroup", { label: "Sources" });
		payload.sources.forEach(function (source) { sourceGroup.appendChild(el("option", { value: sourceSeedKey(source.label), text: source.label })); });
		seedPicker.appendChild(sourceGroup);
	  }
	  seedPicker.value = stateSeedKey(view, state.node, state.source);
	  seedPicker.onchange = function () {
		if (seedPicker.value.indexOf("source:") === 0) {
		  state.source = seedPicker.value.slice("source:".length);
		  state.node = "";
		  state.sel = "";
		} else {
		  state.node = seedPicker.value;
		  state.source = "";
		  state.sel = state.node;
		}
		writeHash();
		renderAll();
	  };
	}
    var relBox = document.getElementById("relation-controls");
    clear(relBox);
    relBox.hidden = !view.relations.length || view.kind === "debt";
    view.relations.forEach(function (name, bit) {
      var label = el("label");
      var box = el("input", { type: "checkbox" });
      box.checked = !!(state.rel & (1 << bit));
      box.addEventListener("change", function () {
        if (box.checked) state.rel |= 1 << bit;
        else state.rel &= ~(1 << bit);
        writeHash();
        renderAll();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(" " + name));
      relBox.appendChild(label);
    });
    document.getElementById("search").value = state.q;
    renderSearch();
    renderCrumbs();
  }
  function renderSearch() {
    var list = document.getElementById("search-results");
    clear(list);
    var q = state.q.trim().toLowerCase();
    if (!q) return;
    payload.nodes.forEach(function (node) {
      if (list.childNodes.length >= 20) return;
      var hay = (node.id + " " + node.slug + " " + node.statement).toLowerCase();
      if (hay.indexOf(q) < 0) return;
      var item = el("li");
      var btn = el("button", { type: "button", text: node.id + " · " + node.slug });
      btn.addEventListener("click", function () { focusOrOffer(node.id); });
      item.appendChild(btn);
      list.appendChild(item);
    });
	if (currentView().parameter === "node-or-source") {
	  payload.sources.forEach(function (source) {
		if (list.childNodes.length >= 20 || source.label.toLowerCase().indexOf(q) < 0) return;
		var item = el("li", { className: "source-result" });
		var seedLabel = source.label.indexOf("ADR-") === 0 ? "affected from this ADR" : "affected from this source";
		var btn = el("button", { type: "button", text: source.label + " · " + seedLabel });
		btn.addEventListener("click", function () { reseedSource(currentView().id, source.label); });
		item.appendChild(btn);
		if (source.href) item.appendChild(el("a", { href: source.href, text: "open" }));
		list.appendChild(item);
	  });
	}
  }
  function renderCrumbs() {
    var nav = document.getElementById("crumbs");
    clear(nav);
    crumbs.forEach(function (crumb, idx) {
      var btn = el("button", { type: "button", text: crumb.view + (crumb.source ? ":" + crumb.source : crumb.node ? ":" + crumb.node : "") });
      btn.addEventListener("click", function () {
        crumbs = crumbs.slice(0, idx);
		state = { page: crumb.page || "explorer", concept: crumb.concept || "", view: crumb.view, node: crumb.node, source: crumb.source, depth: crumb.depth, rel: crumb.rel, sel: crumb.sel, q: state.q };
        writeHash();
        renderAll();
      });
      nav.appendChild(btn);
    });
  }
  function currentIds(hit) {
    var ids = {};
    (hit.nodeIdxs || []).forEach(function (idx) { ids[payload.nodes[idx].id] = 1; });
    return ids;
  }
  function focusOrOffer(id) {
    if (state.page === "atlas") {
      state.page = "explorer";
      state.concept = "";
      reseedNode("why", id);
      return;
    }
    state.sel = id;
    writeHash();
    if (currentIds(lookupHit())[id]) renderGraph();
    renderPanel();
  }
  function rememberCrumb() {
	crumbs.push({ page: state.page, concept: state.concept, view: state.view, node: state.node, source: state.source, depth: state.depth, rel: state.rel, sel: state.sel });
	}
	function reseedNode(viewId, nodeId) {
	rememberCrumb();
    var view = viewMeta(viewId);
    state.view = viewId;
    state.node = nodeId;
	state.source = "";
    state.depth = defaultDepth(view);
    state.rel = defaultMask(view);
    state.sel = nodeId;
    writeHash();
    renderAll();
  }
	function reseedSource(viewId, source) {
	rememberCrumb();
	var view = viewMeta(viewId);
	state.view = viewId;
	state.node = "";
	state.source = source;
	state.depth = defaultDepth(view);
	state.rel = defaultMask(view);
	state.sel = "";
	writeHash();
	renderAll();
	}
  function renderGraph(keepViewport) {
    var root = document.getElementById("graph-root");
    clear(root);
    var view = currentView();
    var canvas = document.getElementById("canvas");
    var debtList = document.getElementById("debt-list");
    if (view.kind === "debt") {
      canvas.hidden = true;
      debtList.hidden = false;
      renderDebtList();
      return;
    }
    canvas.hidden = false;
    debtList.hidden = true;
    var hit = lookupHit();
    var nodes = hit.nodeIdxs.map(function (idx) { return payload.nodes[idx]; });
    var edges = hit.edgeIdxs.map(function (idx) { return payload.edges[idx]; });
    var laid = layout(nodes);
    nodes.forEach(function (node) {
      var at = laid.pos[node.id];
      var g = svgEl("g");
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.setAttribute("transform", "translate(" + at.x + " " + at.y + ")");
      var shape;
      if (node.kind === "decision") {
        shape = svgEl("polygon");
        shape.setAttribute("points", "0," + (-NODE_H / 2) + " " + (NODE_W / 2) + ",0 0," + (NODE_H / 2) + " " + (-NODE_W / 2) + ",0");
      } else {
        shape = svgEl("rect");
        shape.setAttribute("x", String(-NODE_W / 2));
        shape.setAttribute("y", String(-NODE_H / 2));
        shape.setAttribute("width", String(NODE_W));
        shape.setAttribute("height", String(NODE_H));
        shape.setAttribute("rx", node.kind === "proposition" ? "10" : "2");
      }
      shape.setAttribute("fill", fillFor(node));
      if (isUnrealized(node.id)) shape.setAttribute("data-unrealized", "true");
      shape.setAttribute("stroke", state.sel === node.id ? "#0f172a" : "#334155");
      shape.setAttribute("stroke-width", state.sel === node.id ? "3" : "1.25");
      if (node.visibility === "internal") shape.setAttribute("stroke-dasharray", "5 3");
      g.appendChild(shape);
      if (isUnrealized(node.id)) {
        var hatch = shape.cloneNode(false);
        hatch.setAttribute("fill", "url(#unrealized-hatch)");
        hatch.setAttribute("stroke", "none");
        g.appendChild(hatch);
      }
      var title = svgEl("title");
      title.textContent = node.id + " " + node.slug;
      var idText = svgEl("text");
      idText.setAttribute("text-anchor", "middle");
      idText.setAttribute("y", "-4");
      idText.setAttribute("class", "node-label");
      idText.setAttribute("pointer-events", "none");
      idText.textContent = node.id;
      var slugText = svgEl("text");
      slugText.setAttribute("text-anchor", "middle");
      slugText.setAttribute("y", "12");
      slugText.setAttribute("class", "node-label");
      slugText.setAttribute("pointer-events", "none");
      slugText.textContent = node.slug.length > 22 ? node.slug.slice(0, 21) + "…" : node.slug;
      g.appendChild(title);
      g.appendChild(idText);
      g.appendChild(slugText);
      g.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
      g.addEventListener("click", function () {
        state.sel = node.id;
        writeHash();
        renderGraph(true);
        renderPanel();
      });
      g.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          state.sel = node.id;
          writeHash();
          renderGraph(true);
          renderPanel();
        }
      });
      root.appendChild(g);
    });
    edges.forEach(function (edge) {
      var a = laid.pos[edge.from];
      var b = laid.pos[edge.to];
      if (!a || !b) return;
      var path = svgEl("path");
      var x1 = a.x + NODE_W / 4, y1 = a.y, x2 = b.x - NODE_W / 4, y2 = b.y, mx = (x1 + x2) / 2;
      path.setAttribute("d", "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#64748b");
      path.setAttribute("stroke-width", "1.25");
      path.setAttribute("marker-end", "url(#arrow)");
      path.setAttribute("pointer-events", "none");
      var label = svgEl("text");
      label.setAttribute("x", String(mx));
      label.setAttribute("y", String((y1 + y2) / 2 - 4));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "node-label");
      label.setAttribute("fill", "#475569");
      label.setAttribute("pointer-events", "none");
      label.textContent = edge.relation;
      root.insertBefore(label, root.firstChild);
      root.insertBefore(path, root.firstChild);
    });
    if (!keepViewport) fitTo(laid.width, laid.height);
  }
  function renderDebtList() {
    var host = document.getElementById("debt-list");
    clear(host);
    host.appendChild(el("h2", { text: "Debt diagnostics" }));
    var note = el("p", { text: "Empty graph is correct: the engine returns no neighbourhood for diagnostics. Receipts come from this checkout and PELAGGIO_ASSURANCE_OBSERVATION_RESULTS." });
    host.appendChild(note);
    var list = el("ul");
    (lookupHit().diagnostics || []).forEach(function (issue) {
      var item = el("li");
      var btn = el("button", { type: "button", text: issue.check + " · " + issue.node });
      btn.addEventListener("click", function () {
        var why = payload.views.filter(function (v) { return v.parameter === "node"; })[0];
		if (why) reseedNode(why.id, issue.node);
      });
      item.appendChild(btn);
      item.appendChild(el("div", { text: issue.message }));
      list.appendChild(item);
    });
    host.appendChild(list);
  }
  function addField(dl, label, value) {
    if (value == null || value === "") return;
    dl.appendChild(el("dt", { text: label }));
    var dd = el("dd");
    if (typeof value === "string") dd.textContent = value;
    else dd.appendChild(value);
    dl.appendChild(dd);
  }
  function verbalize(edge, id) {
    var pair = PHRASES[edge.relation] || [edge.relation, "← " + edge.relation];
    if (edge.from === id) return id + " " + pair[0] + " " + edge.to;
    return id + " " + pair[1] + " " + edge.from;
  }
  function renderPanel() {
    var panel = document.getElementById("panel");
    var node = nodeById(state.sel);
    if (!node) {
      panel.hidden = true;
      clear(panel);
      return;
    }
    panel.hidden = false;
    clear(panel);
    panel.appendChild(el("h2", { text: node.id }));
    var dl = el("dl");
    addField(dl, "slug", node.slug);
    addField(dl, "kind", node.kind);
    addField(dl, "role", node.role);
    addField(dl, "status", node.status);
    addField(dl, "visibility", node.visibility);
    addField(dl, "externalId", node.externalId);
    var statement = el("div");
    statement.className = "statement";
    statement.textContent = node.statement;
    addField(dl, "statement", statement);
    addField(dl, "wrongIf", node.wrongIf);
    addField(dl, "revisitIf", node.revisitIf);
    if (node.projection) addField(dl, "projection", [node.projection.status, node.projection.scope].filter(Boolean).join(" · "));
    panel.appendChild(dl);
	function addLinks(title, items, affectedView) {
      if (!items || !items.length) return;
      panel.appendChild(el("h3", { text: title }));
      var list = el("ul");
      items.forEach(function (item) {
        var li = el("li");
        if (item.href) {
          var a = el("a", { href: item.href, text: item.label || item.path });
          li.appendChild(a);
        } else {
          li.textContent = item.label || item.path;
		}
		if (affectedView) {
		  var affectedLabel = item.label.indexOf("ADR-") === 0 ? "affected from this ADR" : "affected from this source";
		  var affected = el("button", { type: "button", text: affectedLabel });
		  affected.addEventListener("click", function () { reseedSource(affectedView.id, item.label); });
		  li.appendChild(affected);
		}
        list.appendChild(li);
      });
      panel.appendChild(list);
    }
	var affectedView = payload.views.filter(function (view) { return view.parameter === "node-or-source"; })[0];
	addLinks("sources", node.sources, affectedView);
    addLinks("code evidence", node.codeEvidence);
    if (node.observations && node.observations.length) {
      panel.appendChild(el("h3", { text: "observations" }));
      var obs = el("ul");
      node.observations.forEach(function (observation) {
        obs.appendChild(el("li", { text: observation.kind + " · " + observation.id + " · " + observation.path }));
      });
      panel.appendChild(obs);
    }
    if (node.grounding && node.grounding.length) {
      panel.appendChild(el("h3", { text: "source grounding" }));
      node.grounding.forEach(function (entry) {
        var block = el("div");
        if (entry.href) block.appendChild(el("a", { href: entry.href, text: entry.path }));
        else block.textContent = entry.path;
        entry.anchors.forEach(function (anchor) {
          var quote = el("blockquote");
          quote.textContent = anchor;
          block.appendChild(quote);
        });
        panel.appendChild(block);
      });
    }
    var badges = debtFor(node.id);
    if (badges.length) {
      panel.appendChild(el("h3", { text: "diagnostics" }));
      var wrap = el("div");
      badges.forEach(function (issue) {
        var badge = el("span", { className: "badge" + (UNREALIZED[issue.check] ? " unrealized" : ""), text: issue.check });
        wrap.appendChild(badge);
      });
      panel.appendChild(wrap);
      badges.forEach(function (issue) { panel.appendChild(el("p", { text: issue.message })); });
    }
    var incidents = lookupHit().edgeIdxs.map(function (idx) { return payload.edges[idx]; }).filter(function (edge) { return edge.from === node.id || edge.to === node.id; });
    if (incidents.length) {
      panel.appendChild(el("h3", { text: "incident edges" }));
      incidents.forEach(function (edge) {
        panel.appendChild(el("p", { className: "incident", text: verbalize(edge, node.id) }));
      });
    }
    var actions = el("div", { className: "panel-actions" });
    payload.views.forEach(function (view) {
      if (view.parameter === "node" || view.parameter === "node-or-source") {
        var label = view.parameter === "node" ? "why from here" : "affected from here";
        var btn = el("button", { type: "button", text: label });
		btn.addEventListener("click", function () { reseedNode(view.id, node.id); });
        actions.appendChild(btn);
      }
    });
    panel.appendChild(actions);
  }
  function renderRetired() {
    var host = document.getElementById("retired");
    clear(host);
    host.appendChild(el("h2", { text: "Extraction decisions" }));
    if (!payload.retiredIds.length) {
      host.appendChild(el("p", { text: "No retired node IDs were derived from extraction.decided." }));
      return;
    }
    var list = el("ul");
    payload.retiredIds.forEach(function (id) {
      list.appendChild(el("li", { text: id + " — removed after review" }));
    });
    host.appendChild(list);
  }
  function renderAll() {
    renderBanner();
    document.getElementById("static-preview-note").hidden = true;
    var atlas = document.getElementById("atlas");
    var shell = document.getElementById("explorer-shell");
    atlas.hidden = state.page !== "atlas";
    shell.hidden = state.page === "atlas";
    document.getElementById("search").value = state.q;
    renderSearch();
    if (state.page === "atlas") {
      renderAtlas();
      return;
    }
    renderConceptHero();
    renderControls();
    renderGraph();
    renderPanel();
    renderRetired();
  }

  document.getElementById("wordmark").addEventListener("click", openAtlas);
  document.getElementById("back-to-atlas").addEventListener("click", openAtlas);
  document.getElementById("nav-concepts").addEventListener("click", openAtlas);
  document.getElementById("nav-explorer").addEventListener("click", openAdvanced);
  document.getElementById("advanced").addEventListener("click", openAdvanced);
  document.getElementById("fit").addEventListener("click", function () { renderGraph(); });
  document.getElementById("search").addEventListener("input", function (event) {
    state.q = event.target.value;
    writeHash();
    renderSearch();
  });
  var svg = document.getElementById("graph");
  svg.addEventListener("pointerdown", function (event) {
    if (event.button !== 0) return;
    pan = { on: true, x: event.clientX, y: event.clientY };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", function (event) {
    if (!pan.on) return;
    var rect = svg.getBoundingClientRect();
    vb.x -= (event.clientX - pan.x) * (vb.w / rect.width);
    vb.y -= (event.clientY - pan.y) * (vb.h / rect.height);
    pan.x = event.clientX;
    pan.y = event.clientY;
    applyViewBox();
  });
  svg.addEventListener("pointerup", function () { pan.on = false; });
  svg.addEventListener("pointercancel", function () { pan.on = false; });
  svg.addEventListener("wheel", function (event) {
    event.preventDefault();
    var factor = event.deltaY < 0 ? 0.9 : 1.1;
    var rect = svg.getBoundingClientRect();
    var px = (event.clientX - rect.left) / rect.width;
    var py = (event.clientY - rect.top) / rect.height;
    var nx = vb.x + px * vb.w;
    var ny = vb.y + py * vb.h;
    vb.w *= factor;
    vb.h *= factor;
    vb.x = nx - px * vb.w;
    vb.y = ny - py * vb.h;
    applyViewBox();
  }, { passive: false });
  window.addEventListener("hashchange", function () {
    state = restoreFromHash();
    renderAll();
  });
  state = restoreFromHash();
  renderAll();
})();
`.trim();

export function renderHtmlExplorer(payload: ExplorerPayload): string {
	const json = embedJson(payload);
	const invariants = payload.nodes.filter((node) => node.role === "invariant" && node.visibility === "internal").length;
	const choices = payload.nodes.filter((node) => node.kind === "decision").length;
	const assumptions = payload.nodes.filter((node) => node.role === "assumption").length;
	const staticChoiceRows = payload.nodes
		.filter((node) => node.kind === "decision")
		.sort((a, b) => a.id.localeCompare(b.id))
		.map(
			(node) => `<details class="record">
<summary><span class="record-id">${escapeHtml(node.id)}</span><span class="record-title"><strong>${escapeHtml(node.slug.replaceAll("-", " "))}</strong><span>${escapeHtml(node.statement)}</span></span><span class="record-toggle" aria-hidden="true">+</span></summary>
<div class="record-body"><div><section class="brief-section"><h3>Claim</h3><p class="record-statement">${escapeHtml(node.statement)}</p></section></div><aside class="record-side"><div class="record-meta">${[
				node.status,
				node.visibility,
				node.role,
			]
				.filter(Boolean)
				.map((value) => `<span>${escapeHtml(value!)}</span>`)
				.join("")}</div></aside></div>
</details>`,
		)
		.join("\n");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pelaggio decision corpus</title>
<style>${STYLES}</style>
</head>
<body>
<header class="app-bar">
<button type="button" class="wordmark" id="wordmark"><span class="mark">P</span><span>Pelaggio corpus</span></button>
<nav class="app-nav" aria-label="Corpus navigation">
<button type="button" id="nav-concepts">Index</button>
<button type="button" id="nav-explorer">Technical trace</button>
</nav>
<div class="status-pill" id="status-pill"></div>
<div class="global-search">
<input id="search" type="search" placeholder="Search intent, choices, machinery…" autocomplete="off" aria-label="Search corpus">
<ul id="search-results"></ul>
</div>
</header>
<main class="atlas" id="atlas">
<div class="eyebrow">A change starts by finding the fact it touches</div>
<h1>Before changing Pelaggio, find what must survive.</h1>
<p class="atlas-lede">Choose a decision, invariant, or assumption. Each brief names the encoded consequence of changing it, the earliest reason to raise, and the evidence or machinery that currently supports it. Missing semantics are shown as gaps, not filled with generated rationale.</p>
<div class="corpus-tabs" id="corpus-tabs" role="tablist" aria-label="Corpus record types">
<button type="button" class="corpus-tab" role="tab" aria-selected="true"><strong>Choices</strong><span>${choices} records</span></button>
<button type="button" class="corpus-tab" role="tab" aria-selected="false"><strong>Invariants</strong><span>${invariants} records</span></button>
<button type="button" class="corpus-tab" role="tab" aria-selected="false"><strong>Assumptions</strong><span>${assumptions} records</span></button>
</div>
<div class="index-intro"><h2 id="index-title">Decisions deliberately made</h2><p id="index-description">Change or remove one only after checking the obligations and premises attached to it.</p></div>
<p class="preview-note" id="static-preview-note">This static preview shows the Choices index. Open the page in a browser to switch categories, search, and inspect relationships.</p>
<section class="record-list" id="record-list">${staticChoiceRows}</section>
</main>
<div id="explorer-shell" hidden>
<section id="concept-hero" hidden>
<div class="concept-hero-inner">
<div>
<button type="button" class="quiet-button" id="back-to-atlas">← Concept index</button>
<div class="eyebrow">Corpus concept</div>
<h1 id="concept-title"></h1>
<p id="concept-summary"></p>
</div>
<div class="hero-stats">
<div><strong id="concept-records"></strong><span>records</span></div>
<div><strong id="concept-relations"></strong><span>relations</span></div>
<div><strong id="concept-debt"></strong><span>with signals</span></div>
</div>
</div>
</section>
<header id="banner">
<h1>Assurance graph explorer</h1>
<p id="banner-meta"></p>
<p id="banner-warning">ADR-0027: this graph and page are an experimental, non-authoritative projection of the current checkout. They are not authority.</p>
</header>
<section id="controls">
<label>View <select id="view-picker"></select></label>
<p id="view-question"></p>
<label id="seed-control" hidden>Seed <select id="seed-picker"></select></label>
<div id="depth-controls" hidden></div>
<div id="relation-controls" hidden></div>
<button type="button" id="fit">Fit</button>
<button type="button" class="quiet-button" id="advanced">Advanced explorer</button>
</section>
<nav id="crumbs" aria-label="session breadcrumbs"></nav>
<div id="workspace">
<div id="canvas">
<svg id="graph" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Assurance graph. Placement and order are visual only.">
<defs>
<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
<path d="M0,0 L8,4 L0,8 z" fill="#64748b"></path>
</marker>
<pattern id="unrealized-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
<rect width="6" height="6" fill="#fecaca"></rect>
<rect width="2" height="6" fill="#b91c1c" fill-opacity="0.45"></rect>
</pattern>
</defs>
<g id="graph-root"></g>
</svg>
</div>
<aside id="panel" hidden></aside>
</div>
<section id="debt-list" hidden></section>
<section id="legend">
<p>Placement and order are visual only. Layout has no semantic meaning: columns group kind, and nodes are sorted by id within a column. Edges are exactly the engine result.</p>
<ul>
<li><span class="swatch" style="background:#60a5fa"></span>invariant</li>
<li><span class="swatch" style="background:#f59e0b"></span>constraint</li>
<li><span class="swatch" style="background:#a78bfa"></span>assumption</li>
<li><span class="swatch" style="background:#2dd4bf"></span>decision</li>
<li><span class="swatch" style="background:#cbd5e1"></span>realization</li>
<li>dashed stroke = internal visibility</li>
<li>hatched fill = unrealized intent</li>
</ul>
</section>
<section id="retired"></section>
</div>
<script type="application/json" id="assurance-explorer-payload">${json}</script>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>
`;
}
