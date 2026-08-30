/**
 * The one loader and the one type for the shadow assurance graph and its views catalog
 * (plan step 10). Six sites parsed `docs/assurance/shadow-graph.json` independently, with two
 * competing TypeScript declarations of its shape; four parsed `views.json` with ad-hoc types.
 * Everything now goes through here, so the shape can only drift in one place.
 *
 * `views.json` declares which graph schema it was authored against (`graphSchema`) — an explicit
 * compatibility field, not equality with its own `schemaVersion` (the catalog is an independently
 * versioned representation, per ADR-0027's replaceable-representation boundary).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AssuranceObservation } from "./assurance-observations.js";

export const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
export const SHADOW_GRAPH_RELATIVE = "docs/assurance/shadow-graph.json";
export const VIEWS_RELATIVE = "docs/assurance/views.json";

export type GraphNode = {
	id: string;
	kind: string;
	statement: string;
	slug: string;
	role?: string;
	status?: string;
	visibility?: string;
	externalId?: string;
	sources?: string[];
	codeEvidence?: string[];
	wrongIf?: string;
	revisitIf?: string;
	projection?: { status?: string; scope?: string };
	observations?: AssuranceObservation[];
};
export type GraphEdge = { from: string; relation: string; to: string };
export type SourceGrounding = { node: string; path: string; anchors: string[] };
export type RelationKind = { from: string[]; to: string[] };
export type InvariantIndexEntry = { anchor: string; nodes?: string[]; construction?: string };

export type AssuranceGraph = {
	schemaVersion: string;
	status?: string;
	authority?: string;
	nodeKinds?: string[];
	propositionRoles?: string[];
	decisionStatuses?: string[];
	relationKinds?: Record<string, RelationKind>;
	nodes: GraphNode[];
	edges: GraphEdge[];
	adrMap?: Record<string, string[]>;
	sourceGrounding?: SourceGrounding[];
	invariantIndex?: { entries: InvariantIndexEntry[] };
};

export type AssuranceView = {
	id: string;
	question: string;
	mode: string;
	audience?: string[];
	visibility?: string[];
	/** Which query argument the view takes; absent for views that take none. */
	parameter?: "node" | "node-or-source";
	kinds?: string[];
	roles?: string[];
	statuses?: string[];
	seeds?: string[];
	seedKinds?: string[];
	relations?: string[];
	depth?: number;
	direction?: "upstream" | "downstream" | "both";
	checks?: string[];
};
export type ViewsCatalog = {
	schemaVersion: string;
	/** The `shadow-graph.json` schema this catalog was authored against. */
	graphSchema: string;
	status?: string;
	views: AssuranceView[];
};

export function shadowGraphPath(repo = REPO_ROOT): string {
	return resolve(repo, SHADOW_GRAPH_RELATIVE);
}
export function viewsPath(repo = REPO_ROOT): string {
	return resolve(repo, VIEWS_RELATIVE);
}

/** Parse the graph as its typed shape. The file's key order is preserved by `readShadowGraphRaw` for rewriters. */
export function loadShadowGraph(repo = REPO_ROOT): AssuranceGraph {
	const graph = JSON.parse(readFileSync(shadowGraphPath(repo), "utf8")) as AssuranceGraph;
	if (typeof graph.schemaVersion !== "string" || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
		throw new Error(`${SHADOW_GRAPH_RELATIVE}: not an assurance graph (schemaVersion/nodes/edges missing)`);
	}
	return graph;
}

/** The graph as an ordered record, for the `--write` path that must not reorder keys. */
export function readShadowGraphRaw(repo = REPO_ROOT): Record<string, unknown> {
	return JSON.parse(readFileSync(shadowGraphPath(repo), "utf8")) as Record<string, unknown>;
}

export function loadViews(repo = REPO_ROOT): ViewsCatalog {
	const catalog = JSON.parse(readFileSync(viewsPath(repo), "utf8")) as ViewsCatalog;
	if (typeof catalog.schemaVersion !== "string" || typeof catalog.graphSchema !== "string" || !Array.isArray(catalog.views)) {
		throw new Error(`${VIEWS_RELATIVE}: not a views catalog (schemaVersion/graphSchema/views missing)`);
	}
	return catalog;
}
