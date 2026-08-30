import type { ExplorerPayload } from "./assurance-views.js";

function embedJson(payload: ExplorerPayload): string {
	return JSON.stringify(payload).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

const STYLES = `
:root { --bg: #f8fafc; --ink: #0f172a; --muted: #475569; --line: #cbd5e1; --card: #fff; --warn: #9a3412; --accent: #1d4ed8; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; }
body { display: flex; flex-direction: column; min-height: 100vh; }
#banner { background: #fff7ed; border-bottom: 1px solid #fdba74; padding: 0.75rem 1rem; }
#banner h1 { font-size: 1rem; margin: 0 0 0.25rem; }
#banner-meta, #banner-warning { margin: 0.15rem 0; color: var(--warn); }
#banner-meta { color: var(--muted); }
#controls { display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; align-items: end; padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); background: var(--card); }
#controls label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 12px; color: var(--muted); }
#view-question { margin: 0; flex: 1 1 16rem; color: var(--muted); }
#depth-controls, #relation-controls { display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; }
#depth-controls[hidden], #relation-controls[hidden], #seed-control[hidden], #search-results:empty, #crumbs:empty, #panel[hidden], #debt-list[hidden] { display: none; }
#search-wrap { position: relative; min-width: 16rem; }
#search-results { position: absolute; z-index: 2; left: 0; right: 0; top: 100%; margin: 0; padding: 0; list-style: none; background: var(--card); border: 1px solid var(--line); max-height: 16rem; overflow: auto; }
#search-results button, #crumbs button, .panel-actions button { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 0.35rem 0.5rem; cursor: pointer; }
#search-results button:hover, #crumbs button:hover { background: #e2e8f0; }
#search-results .source-result { display: flex; align-items: center; gap: 0.35rem; padding: 0.25rem 0.5rem; }
#search-results .source-result button { flex: 1; padding: 0.1rem 0; }
#crumbs { display: flex; flex-wrap: wrap; gap: 0.35rem; padding: 0 1rem 0.5rem; }
#crumbs button { width: auto; border: 1px solid var(--line); background: var(--card); }
#workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, 24rem); flex: 1; min-height: 0; }
#canvas { position: relative; background: #eef2ff; min-height: 28rem; }
#graph { width: 100%; height: 100%; min-height: 28rem; touch-action: none; background: #eef2ff; }
#panel { border-left: 1px solid var(--line); background: var(--card); padding: 1rem; overflow: auto; }
#panel h2 { margin: 0 0 0.5rem; font-size: 1rem; }
#panel dl { margin: 0 0 0.75rem; }
#panel dt { font-size: 11px; text-transform: uppercase; color: var(--muted); margin-top: 0.5rem; }
#panel dd { margin: 0.15rem 0 0; }
#panel .statement { white-space: pre-wrap; }
#panel a { color: var(--accent); }
.badge { display: inline-block; margin: 0.15rem 0.15rem 0 0; padding: 0.1rem 0.35rem; border-radius: 999px; font-size: 11px; background: #fee2e2; color: #991b1b; }
.badge.unrealized { background: #ffedd5; color: #9a3412; }
.incident { margin: 0.2rem 0; }
#debt-list { padding: 1rem; border-top: 1px solid var(--line); background: var(--card); }
#debt-list li { margin: 0.35rem 0; }
#legend, #retired { padding: 0.75rem 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
#legend ul { display: flex; flex-wrap: wrap; gap: 0.75rem 1.25rem; margin: 0.35rem 0 0; padding: 0; list-style: none; }
.swatch { display: inline-block; width: 0.8rem; height: 0.8rem; margin-right: 0.3rem; vertical-align: -1px; border: 1px solid #334155; }
button, select, input { font: inherit; }
input[type="search"], select { padding: 0.3rem 0.4rem; }
.node-label { font-size: 10px; }
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
  var NS = "http://www.w3.org/2000/svg";
  var NODE_W = 168;
  var NODE_H = 46;
  var COL_X = { proposition: 140, decision: 420, realization: 700 };
  var crumbs = [];
  var state = defaultState();
  var vb = { x: 0, y: 0, w: 960, h: 640 };
  var pan = { on: false, x: 0, y: 0 };

  function viewMeta(id) {
    for (var i = 0; i < payload.views.length; i++) if (payload.views[i].id === id) return payload.views[i];
    return null;
  }
  function currentView() { return viewMeta(state.view) || payload.views[0]; }
  function defaultDepth(view) {
    return view.defaultDepth;
  }
  function defaultMask(view) { return (1 << (view.relations ? view.relations.length : 0)) - 1; }
  function defaultState() {
    var view = payload.views[0];
    return { view: view.id, node: "", source: "", depth: defaultDepth(view), rel: defaultMask(view), sel: "", q: "" };
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
	return { view: view.id, node: node, source: source, depth: depth, rel: rel, sel: sel, q: params.get("q") || "" };
  }
  function writeHash() {
    var view = currentView();
    var parts = ["view=" + encodeURIComponent(state.view)];
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
		state = { view: crumb.view, node: crumb.node, source: crumb.source, depth: crumb.depth, rel: crumb.rel, sel: crumb.sel, q: state.q };
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
    state.sel = id;
    writeHash();
    if (currentIds(lookupHit())[id]) renderGraph();
    renderPanel();
  }
  function rememberCrumb() {
	crumbs.push({ view: state.view, node: state.node, source: state.source, depth: state.depth, rel: state.rel, sel: state.sel });
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
  function renderGraph() {
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
        renderGraph();
        renderPanel();
      });
      g.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          state.sel = node.id;
          writeHash();
          renderGraph();
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
    fitTo(laid.width, laid.height);
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
    renderControls();
    renderGraph();
    renderPanel();
    renderRetired();
  }

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
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assurance graph explorer</title>
<style>${STYLES}</style>
</head>
<body>
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
<div id="search-wrap">
<label>Search <input id="search" type="search" placeholder="id, slug, statement, or source" autocomplete="off"></label>
<ul id="search-results"></ul>
</div>
<button type="button" id="fit">Fit</button>
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
<script type="application/json" id="assurance-explorer-payload">${json}</script>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>
`;
}
