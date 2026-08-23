import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type GraphNode = { id: string; kind: string; slug: string; statement: string };
export type GraphEdge = { from: string; relation: string; to: string };
export type AssuranceGraph = { schemaVersion: string; nodes: GraphNode[]; edges: GraphEdge[] };
export type AssuranceView = {
  id: string;
  question: string;
  mode: string;
  kinds?: string[];
  relations?: string[];
  seeds?: string[];
  depth?: number;
};

export function selectView(graph: AssuranceGraph, view: AssuranceView): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const relations = new Set(view.relations ?? []);
  const selected = new Set<string>();

  if (view.mode === "all-of-kind") {
    const kinds = new Set(view.kinds ?? []);
    for (const node of graph.nodes) if (kinds.has(node.kind)) selected.add(node.id);
  } else if (view.mode === "seeded-neighborhood") {
    for (const seed of view.seeds ?? []) {
      if (!byId.has(seed)) throw new Error(`view ${view.id} references missing seed ${seed}`);
      selected.add(seed);
    }
    let frontier = new Set(selected);
    for (let level = 0; level < (view.depth ?? 1); level++) {
      const next = new Set<string>();
      for (const edge of graph.edges) {
        if (!relations.has(edge.relation)) continue;
        if (frontier.has(edge.from)) next.add(edge.to);
        if (frontier.has(edge.to)) next.add(edge.from);
      }
      for (const id of next) selected.add(id);
      frontier = next;
    }
  } else {
    throw new Error(`view ${view.id} mode ${view.mode} is query-only and cannot be statically rendered`);
  }

  const nodes = [...selected].map((id) => byId.get(id)!).sort((a, b) => a.id.localeCompare(b.id));
  const edges = graph.edges
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to) && relations.has(edge.relation))
    .sort((a, b) => `${a.from}:${a.relation}:${a.to}`.localeCompare(`${b.from}:${b.relation}:${b.to}`));
  return { nodes, edges };
}

function mermaidId(id: string): string {
  return id.replaceAll("-", "_");
}

function escapeLabel(label: string): string {
  return label.replaceAll('"', "'");
}

export function renderMermaid(graph: AssuranceGraph, view: AssuranceView): string {
  const selected = selectView(graph, view);
  const lines = [
    `# ${view.id} assurance view`,
    "",
    `> ${view.question}`,
    "",
    `Generated from shadow-graph.json schema ${graph.schemaVersion} via ci/assurance-views.ts. Do not edit this projection by hand.`,
    "",
    "```mermaid",
    "flowchart TB",
  ];
  for (const node of selected.nodes) lines.push(`  ${mermaidId(node.id)}[\"${escapeLabel(node.slug)}\"]`);
  for (const edge of selected.edges) {
    lines.push(`  ${mermaidId(edge.from)} -->|${edge.relation}| ${mermaidId(edge.to)}`);
  }
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
