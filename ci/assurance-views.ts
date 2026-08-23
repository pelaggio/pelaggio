import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type GraphNode = { id: string; kind: string; slug: string; statement: string; sources?: string[] };
export type GraphEdge = { from: string; relation: string; to: string };
export type AssuranceGraph = { schemaVersion: string; nodes: GraphNode[]; edges: GraphEdge[] };
export type AssuranceView = {
  id: string;
  question: string;
  mode: string;
  audience?: string[];
  kinds?: string[];
  relations?: string[];
  seeds?: string[];
  depth?: number;
  checks?: string[];
};
export type QueryArgs = { node?: string; source?: string };
export type Diagnostic = { check: string; node: string; message: string };

function index(graph: AssuranceGraph) {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function induced(graph: AssuranceGraph, selected: Set<string>, relations: Set<string>) {
  const byId = index(graph);
  const nodes = [...selected].map((id) => byId.get(id)!).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
  const edges = graph.edges
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to) && relations.has(edge.relation))
    .sort((a, b) => `${a.from}:${a.relation}:${a.to}`.localeCompare(`${b.from}:${b.relation}:${b.to}`));
  return { nodes, edges };
}

function neighborhood(graph: AssuranceGraph, seeds: string[], relations: Set<string>, depth: number) {
  const byId = index(graph);
  const selected = new Set<string>();
  for (const seed of seeds) {
    if (!byId.has(seed)) throw new Error(`missing query seed ${seed}`);
    selected.add(seed);
  }
  let frontier = new Set(selected);
  for (let level = 0; level < depth; level++) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (!relations.has(edge.relation)) continue;
      if (frontier.has(edge.from)) next.add(edge.to);
      if (frontier.has(edge.to)) next.add(edge.from);
    }
    for (const id of next) selected.add(id);
    frontier = next;
  }
  return induced(graph, selected, relations);
}

export function diagnostics(graph: AssuranceGraph): Diagnostic[] {
  const out: Diagnostic[] = [];
  const outgoing = (id: string, rel?: string) => graph.edges.filter((e) => e.from === id && (!rel || e.relation === rel));
  const incoming = (id: string, rel?: string) => graph.edges.filter((e) => e.to === id && (!rel || e.relation === rel));

  for (const node of graph.nodes) {
    if (node.kind === "construction" && !outgoing(node.id).some((e) => e.relation === "implements" || e.relation === "derived-from")) {
      out.push({ check: "orphan-construction", node: node.id, message: "construction has no articulated intent or decision" });
    }
    if (node.kind === "decision" && !outgoing(node.id).some((e) => e.relation === "implements" || e.relation === "assumes" || e.relation === "derived-from" || e.relation === "supersedes")) {
      out.push({ check: "decision-without-intent", node: node.id, message: "decision has no semantic relationship" });
    }
    if (node.kind === "assumption" && incoming(node.id, "assumes").length === 0) {
      out.push({ check: "unused-assumption", node: node.id, message: "assumption is not relied upon by any decision or claim" });
    }
  }
  return out.sort((a, b) => `${a.check}:${a.node}`.localeCompare(`${b.check}:${b.node}`));
}

export function selectView(graph: AssuranceGraph, view: AssuranceView, args: QueryArgs = {}): { nodes: GraphNode[]; edges: GraphEdge[]; diagnostics?: Diagnostic[] } {
  const relations = new Set(view.relations ?? []);

  if (view.mode === "all-of-kind") {
    const kinds = new Set(view.kinds ?? []);
    return induced(graph, new Set(graph.nodes.filter((node) => kinds.has(node.kind)).map((node) => node.id)), relations);
  }

  if (view.mode === "seeded-neighborhood") return neighborhood(graph, view.seeds ?? [], relations, view.depth ?? 1);

  if (view.mode === "neighborhood") {
    if (!args.node) throw new Error(`view ${view.id} requires node`);
    return neighborhood(graph, [args.node], relations, view.depth ?? 1);
  }

  if (view.mode === "upstream-intent") {
    const seeds = new Set<string>();
    if (args.node) seeds.add(args.node);
    if (args.source) for (const node of graph.nodes) if (node.sources?.includes(args.source)) seeds.add(node.id);
    if (seeds.size === 0) throw new Error(`view ${view.id} requires a resolvable node or source`);
    return neighborhood(graph, [...seeds], relations, view.depth ?? 3);
  }

  if (view.mode === "diagnostics") return { nodes: [], edges: [], diagnostics: diagnostics(graph) };

  throw new Error(`unsupported view mode ${view.mode}`);
}

function mermaidId(id: string): string { return id.replaceAll("-", "_"); }
function escapeLabel(label: string): string { return label.replaceAll('"', "'"); }

export function renderMermaid(graph: AssuranceGraph, view: AssuranceView): string {
  const selected = selectView(graph, view);
  const lines = [
    `# ${view.id} assurance view`, "", `> ${view.question}`, "",
    `Generated from shadow-graph.json schema ${graph.schemaVersion} via ci/assurance-views.ts. Do not edit this projection by hand.`, "", "```mermaid", "flowchart TB",
  ];
  for (const node of selected.nodes) lines.push(`  ${mermaidId(node.id)}[\"${escapeLabel(node.slug)}\"]`);
  for (const edge of selected.edges) lines.push(`  ${mermaidId(edge.from)} -->|${edge.relation}| ${mermaidId(edge.to)}`);
  lines.push("```", "");
  return lines.join("\n");
}

if (process.argv.includes("--write")) {
  const repo = resolve(new URL("..", import.meta.url).pathname);
  const graph = JSON.parse(readFileSync(resolve(repo, "docs/assurance/shadow-graph.json"), "utf8")) as AssuranceGraph;
  const catalog = JSON.parse(readFileSync(resolve(repo, "docs/assurance/views.json"), "utf8"));
  for (const id of ["architecture", "review"]) {
    const view = catalog.views.find((candidate: AssuranceView) => candidate.id === id) as AssuranceView | undefined;
    if (!view) throw new Error(`missing view ${id}`);
    writeFileSync(resolve(repo, `docs/assurance/generated/${id}.md`), renderMermaid(graph, view));
  }
}
