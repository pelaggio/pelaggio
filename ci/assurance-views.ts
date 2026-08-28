import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AssuranceObservation, type ObservationResolution, observationKey, resolveObservations } from "./assurance-observations.js";
import { readSourceWithinRoot } from "./root-files.js";

export { readSourceWithinRoot };

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

export type GraphNode = {
	id: string;
	kind: string;
	slug: string;
	statement: string;
	role?: string;
	status?: string;
	visibility?: string;
	sources?: string[];
	wrongIf?: string;
	revisitIf?: string;
	projection?: { status?: string };
	observations?: AssuranceObservation[];
};
export type GraphEdge = { from: string; relation: string; to: string };
export type AssuranceGraph = { schemaVersion: string; nodes: GraphNode[]; edges: GraphEdge[]; sourceGrounding?: SourceGrounding[] };
export type AssuranceView = {
	id: string;
	question: string;
	mode: string;
	audience?: string[];
	kinds?: string[];
	roles?: string[];
	visibility?: string[];
	relations?: string[];
	seeds?: string[];
	depth?: number;
	checks?: string[];
	parameter?: "node" | "node-or-source";
};
export type QueryArgs = { node?: string; source?: string; seeds?: string[] };
export type Diagnostic = { check: string; node: string; message: string };
export type SourceGrounding = { node: string; path: string; anchors: string[] };
/** Optional harness inputs for diagnostics; omitted in pure in-memory stress tests. */
export type DiagnosticsEnv = {
	readSource?: (path: string) => string | undefined;
	resolveObservations?: (observations: readonly AssuranceObservation[]) => Map<string, ObservationResolution>;
	sourceGrounding?: SourceGrounding[];
};

/** Every check the `debt` view may declare. `views.json` is bound to this list by test. */
export const DEBT_CHECKS = [
	"orphan-realization",
	"invariant-without-realization",
	"decision-without-intent",
	"unused-assumption",
	"stale-source-grounding",
	"stale-realization",
	"projection-overreach",
	"constraint-without-enforcement",
	"assumption-without-falsifier",
	"decision-without-realization",
] as const;

function index(graph: AssuranceGraph) {
	return new Map(graph.nodes.map((node) => [node.id, node]));
}

function induced(graph: AssuranceGraph, selected: Set<string>, relations: Set<string>) {
	const byId = index(graph);
	const nodes = [...selected]
		.map((id) => byId.get(id)!)
		.filter(Boolean)
		.sort((a, b) => a.id.localeCompare(b.id));
	const edges = graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to) && relations.has(edge.relation)).sort((a, b) => `${a.from}:${a.relation}:${a.to}`.localeCompare(`${b.from}:${b.relation}:${b.to}`));
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

/** Default environment: the graph's own groundings, read from the repository, so the `debt` view fires every check it declares. */
export function defaultDiagnosticsEnv(graph: AssuranceGraph): DiagnosticsEnv {
	return {
		sourceGrounding: graph.sourceGrounding ?? [],
		readSource: (path) => readSourceWithinRoot(REPO_ROOT, path),
		resolveObservations: (observations) => resolveObservations(REPO_ROOT, observations),
	};
}

export function diagnostics(graph: AssuranceGraph, env: DiagnosticsEnv = defaultDiagnosticsEnv(graph)): Diagnostic[] {
	const out: Diagnostic[] = [];
	const byId = index(graph);
	const outgoing = (id: string, rel?: string) => graph.edges.filter((e) => e.from === id && (!rel || e.relation === rel));
	const incoming = (id: string, rel?: string) => graph.edges.filter((e) => e.to === id && (!rel || e.relation === rel));
	const realized = (id: string) => incoming(id, "implements").some((e) => byId.get(e.from)?.kind === "realization");
	const constrainsRealization = (id: string) => outgoing(id, "constrains").some((e) => byId.get(e.to)?.kind === "realization");
	const realizationObservations = graph.nodes.filter((node) => node.kind === "realization").flatMap((node) => node.observations ?? []);
	const observationResolutions = env.resolveObservations?.(realizationObservations);

	for (const node of graph.nodes) {
		if (node.kind === "realization") {
			const observations = node.observations ?? [];
			const stale =
				observations.length === 0
					? ["names no harness observation"]
					: observations
							.map((observation) => observationResolutions?.get(observationKey(observation)) ?? { ok: false as const, reason: "no harness observation resolver result" })
							.filter((result): result is { ok: false; reason: string } => !result.ok)
							.map((result) => result.reason);
			if (stale.length > 0) out.push({ check: "stale-realization", node: node.id, message: stale.join(" | ") });
		}
		if (node.kind === "realization" && !outgoing(node.id).some((e) => e.relation === "implements" || e.relation === "derived-from")) {
			out.push({ check: "orphan-realization", node: node.id, message: "realization has no articulated intent or decision" });
		}
		if (node.kind === "decision" && !outgoing(node.id).some((e) => e.relation === "implements" || e.relation === "assumes" || e.relation === "derived-from" || e.relation === "supersedes")) {
			out.push({ check: "decision-without-intent", node: node.id, message: "decision has no semantic relationship" });
		}
		// Inverse of orphan-realization for current construction: a choice that currently builds
		// something, named only when an incoming derived-from originates at a realization.
		// Choice-to-choice derived-from and outgoing implements/derived-from do not count.
		if (node.kind === "decision" && node.status === "current-construction-choice" && !incoming(node.id, "derived-from").some((e) => byId.get(e.from)?.kind === "realization")) {
			out.push({ check: "decision-without-realization", node: node.id, message: "current construction choice names no realizing machinery" });
		}
		if (node.kind === "proposition" && node.role === "assumption" && incoming(node.id, "assumes").length === 0) {
			out.push({ check: "unused-assumption", node: node.id, message: "assumption is not relied upon by any decision or proposition" });
		}
		if (node.kind === "proposition" && node.role === "assumption") {
			const hasWrongIf = node.wrongIf !== undefined;
			const hasRevisitIf = node.revisitIf !== undefined;
			const accountabilityCondition = node.wrongIf ?? node.revisitIf ?? "";
			if (hasWrongIf === hasRevisitIf || accountabilityCondition.trim().length < 40) {
				out.push({ check: "assumption-without-falsifier", node: node.id, message: "assumption must name exactly one substantive falsifying observation or revisit trigger" });
			}
		}
		// Inverse of orphan-realization: intent that nothing in the repository currently implements. This is
		// debt to look at, not an error — most invariants here are realized by mechanisms the graph has not
		// named yet (see Q14 for the ratcheted public-guarantee subset).
		if (node.kind === "proposition" && node.role === "invariant" && (node.visibility ?? "internal") === "internal" && !realized(node.id)) {
			out.push({ check: "invariant-without-realization", node: node.id, message: "invariant names no implementing realization" });
		}
		// Endpoint kind is load-bearing: a constraint is enforced only by a realization, via either
		// encoding (constraint constrains realization, or realization implements constraint).
		// constrains → proposition/decision is intent-only; decision implements constraint is a choice.
		if (node.kind === "proposition" && node.role === "constraint" && !realized(node.id) && !constrainsRealization(node.id)) {
			out.push({ check: "constraint-without-enforcement", node: node.id, message: "constraint names no enforcing realization" });
		}
		// A public claim published as an unconditional guarantee whose projected internal intent has no
		// implementing realization is stronger than what the graph can stand behind.
		if (node.kind === "proposition" && node.visibility === "public" && node.projection?.status === "guarantee") {
			const targets = outgoing(node.id, "projects").map((e) => e.to);
			if (targets.length > 0 && !targets.some((t) => realized(t) || byId.get(t)?.kind === "decision")) {
				out.push({ check: "projection-overreach", node: node.id, message: "public guarantee projects internal intent that names no implementing realization" });
			}
		}
	}
	for (const grounding of env.sourceGrounding ?? []) {
		const text = env.readSource?.(grounding.path);
		const lost = text === undefined ? grounding.anchors : grounding.anchors.filter((anchor) => !text.includes(anchor));
		if (lost.length > 0) out.push({ check: "stale-source-grounding", node: grounding.node, message: `source anchor no longer present in ${grounding.path}: ${lost.join(" | ")}` });
	}
	return out.sort((a, b) => `${a.check}:${a.node}`.localeCompare(`${b.check}:${b.node}`));
}

export function selectView(graph: AssuranceGraph, view: AssuranceView, args: QueryArgs = {}, diagnosticsEnv?: DiagnosticsEnv): { nodes: GraphNode[]; edges: GraphEdge[]; diagnostics?: Diagnostic[] } {
	const relations = new Set(view.relations ?? []);

	if (view.mode === "all-of-kind") {
		const kinds = new Set(view.kinds ?? []);
		const roles = new Set(view.roles ?? []);
		const visibility = new Set(view.visibility ?? []);
		const selected = graph.nodes.filter((node) => {
			if (kinds.size > 0 && !kinds.has(node.kind)) return false;
			if (roles.size > 0 && !roles.has(node.role ?? "")) return false;
			if (visibility.size > 0 && !visibility.has(node.visibility ?? "internal")) return false;
			return true;
		});
		return induced(graph, new Set(selected.map((node) => node.id)), relations);
	}

	if (view.mode === "seeded-neighborhood") {
		const seeds = args.seeds ?? view.seeds ?? [];
		if (seeds.length === 0) throw new Error(`view ${view.id} requires seeds`);
		return neighborhood(graph, seeds, relations, view.depth ?? 1);
	}

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

	if (view.mode === "diagnostics") return { nodes: [], edges: [], diagnostics: diagnostics(graph, diagnosticsEnv) };

	throw new Error(`unsupported view mode ${view.mode}`);
}

function mermaidId(id: string): string {
	return id.replaceAll("-", "_");
}
function escapeLabel(label: string): string {
	return label.replaceAll('"', "'");
}

/** The ADR -> primitive index, derived from each node's `sources`. Never authored by hand. */
export function adrMapFromSources(graph: AssuranceGraph): Record<string, string[]> {
	const map: Record<string, string[]> = {};
	for (const node of graph.nodes) {
		for (const source of node.sources ?? []) {
			if (!/^ADR-\d{4}$/.test(source)) continue;
			map[source] ??= [];
			map[source].push(node.id);
		}
	}
	const sorted: Record<string, string[]> = {};
	for (const key of Object.keys(map).sort()) sorted[key] = [...new Set(map[key])].sort();
	return sorted;
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
	for (const node of selected.nodes) lines.push(`  ${mermaidId(node.id)}["${escapeLabel(node.slug)}"]`);
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
	// adrMap is generated output: regenerate it from node sources in place, keeping key order stable.
	const stored = JSON.parse(readFileSync(resolve(repo, "docs/assurance/shadow-graph.json"), "utf8")) as Record<string, unknown>;
	const regenerated: Record<string, unknown> = {};
	for (const key of Object.keys(stored)) regenerated[key] = key === "adrMap" ? adrMapFromSources(graph) : stored[key];
	writeFileSync(resolve(repo, "docs/assurance/shadow-graph.json"), `${JSON.stringify(regenerated, null, "\t")}\n`);
}
