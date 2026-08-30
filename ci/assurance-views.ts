import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHtmlExplorer } from "./assurance-explorer.js";
import { type AssuranceGraph, type AssuranceView, type GraphEdge, type GraphNode, loadShadowGraph, loadViews, REPO_ROOT, readShadowGraphRaw, type SourceGrounding, shadowGraphPath } from "./assurance-graph.js";
import { type AssuranceObservation, type ObservationResolution, observationKey, resolveObservations } from "./assurance-observations.js";
import { readSourceWithinRoot } from "./root-files.js";

export type { AssuranceGraph, AssuranceView, GraphEdge, GraphNode, SourceGrounding } from "./assurance-graph.js";
export { readSourceWithinRoot, renderHtmlExplorer };
export type QueryArgs = { node?: string; source?: string; seeds?: string[] };
export type Diagnostic = { check: string; node: string; message: string };
/** Optional harness inputs for diagnostics; omitted in pure in-memory stress tests. */
export type DiagnosticsEnv = {
	readSource?: (path: string) => string | undefined;
	resolveObservations?: (observations: readonly AssuranceObservation[]) => Map<string, ObservationResolution>;
	sourceGrounding?: SourceGrounding[];
};

const ENGINE_MODES = new Set(["all-of-kind", "seeded-neighborhood", "neighborhood", "upstream-intent", "diagnostics"]);
const EXPLORER_PARAMETERS = new Set(["node", "node-or-source"]);
const GENERATED_DIR = "docs/assurance/generated";

export type ExplorerHref = { label: string; href?: string };
export type ExplorerCanonicalNode = {
	id: string;
	kind: string;
	statement: string;
	slug: string;
	role?: string;
	status?: string;
	visibility: string;
	externalId?: string;
	wrongIf?: string;
	revisitIf?: string;
	projection?: { status?: string; scope?: string };
	sources: ExplorerHref[];
	codeEvidence: ExplorerHref[];
	observations: { kind: string; id: string; path: string }[];
	grounding: { path: string; href?: string; anchors: string[] }[];
};
export type ExplorerViewKind = "parameterized" | "static" | "debt";
export type ExplorerViewMeta = {
	id: string;
	question: string;
	mode: string;
	parameter?: "node" | "node-or-source";
	relations: string[];
	depth?: number;
	defaultDepth: number;
	depths: number[];
	kind: ExplorerViewKind;
};
export type ExplorerGraphHit = { nodeIdxs: number[]; edgeIdxs: number[] };
export type ExplorerParameterizedResults = Record<string, Record<string, Record<string, ExplorerGraphHit>>>;
export type ExplorerStaticResults = Record<string, ExplorerGraphHit>;
export type ExplorerDebtResults = { diagnostics: Diagnostic[] };
export type ExplorerViewResults = ExplorerParameterizedResults | ExplorerStaticResults | ExplorerDebtResults;
export type ExplorerPayload = {
	graphSchemaVersion: string;
	catalogSchemaVersion: string;
	status?: string;
	authority?: string;
	commitSha: string;
	views: ExplorerViewMeta[];
	nodes: ExplorerCanonicalNode[];
	sources: ExplorerHref[];
	edges: GraphEdge[];
	retiredIds: string[];
	results: Record<string, ExplorerViewResults>;
};
export type ExplorerPayloadOpts = { commitSha: string; diagnosticsEnv: DiagnosticsEnv; adrFiles: string[] };

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
export function defaultDiagnosticsEnv(graph: AssuranceGraph, repo: string = REPO_ROOT): DiagnosticsEnv {
	return {
		sourceGrounding: graph.sourceGrounding ?? [],
		readSource: (path) => readSourceWithinRoot(repo, path),
		resolveObservations: (observations) => resolveObservations(repo, observations),
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

function edgeIdentity(edge: GraphEdge): string {
	return `${edge.from}:${edge.relation}:${edge.to}`;
}

const HREF_SEGMENT = /^[A-Za-z0-9._@-]+$/;

/** Fail closed: only a plain repo-relative file path becomes an href (no scheme, no absolute path, no `..`, no backslash). A rejected path keeps its label and renders as text. */
function generatedHref(repoPath: string): string | undefined {
	const segments = repoPath.split("/");
	if (segments.some((segment) => segment === ".." || !HREF_SEGMENT.test(segment))) return undefined;
	return posix.relative(GENERATED_DIR, repoPath);
}

function classifyExplorerView(view: AssuranceView): ExplorerViewKind {
	if (!ENGINE_MODES.has(view.mode)) throw new Error(`unsupported view mode ${view.mode} on ${view.id}`);
	if (view.parameter !== undefined && !EXPLORER_PARAMETERS.has(view.parameter)) throw new Error(`unsupported view parameter ${view.parameter} on ${view.id}`);
	if (view.parameter === "node" || view.parameter === "node-or-source") return "parameterized";
	if (view.mode === "diagnostics") return "debt";
	return "static";
}

function relationMasks(relations: string[]): { mask: number; subset: string[] }[] {
	const count = 1 << relations.length;
	const out: { mask: number; subset: string[] }[] = [];
	for (let mask = 0; mask < count; mask++) {
		const subset: string[] = [];
		for (let i = 0; i < relations.length; i++) if (mask & (1 << i)) subset.push(relations[i]);
		out.push({ mask, subset });
	}
	return out;
}

function engineDefaultDepth(view: AssuranceView): number {
	if (view.mode === "upstream-intent") return 3;
	return 1;
}

function explorerDefaultDepth(view: AssuranceView): number {
	return view.depth ?? engineDefaultDepth(view);
}

function explorerDepthWindow(views: AssuranceView[]): number[] {
	const parameterized = views.filter((view) => view.parameter === "node" || view.parameter === "node-or-source");
	const defaults = parameterized.map(explorerDefaultDepth);
	for (const depth of defaults) {
		if (!Number.isSafeInteger(depth) || depth < 1) throw new Error(`parameterized explorer depth must be a positive integer, got ${depth}`);
	}
	const maxDepth = Math.max(0, ...defaults);
	return Array.from({ length: maxDepth }, (_, index) => index + 1);
}

function sourceSeedKey(source: string): string {
	return `source:${source}`;
}

function livePrefixWidths(nodes: GraphNode[]): Map<string, Set<number>> {
	const prefixes = new Map<string, Set<number>>();
	for (const node of nodes) {
		const match = /^([A-Z]+)-(\d+)$/.exec(node.id);
		if (!match) continue;
		const widths = prefixes.get(match[1]) ?? new Set<number>();
		widths.add(match[2].length);
		prefixes.set(match[1], widths);
	}
	return prefixes;
}

function deriveRetiredIds(graph: AssuranceGraph): string[] {
	const live = new Set(graph.nodes.map((node) => node.id));
	const prefixes = livePrefixWidths(graph.nodes);
	const alts = [...prefixes.entries()].flatMap(([prefix, widths]) => [...widths].map((width) => `${prefix}-\\d{${width}}`));
	if (alts.length === 0) return [];
	const tokenRe = new RegExp(`(?:${alts.join("|")})`, "g");
	const retired = new Set<string>();
	for (const note of graph.extraction?.decided ?? []) {
		for (const token of note.match(tokenRe) ?? []) {
			if (!live.has(token)) retired.add(token);
		}
	}
	return [...retired].sort();
}

function adrFilesByPrefix(adrFiles: string[]): Map<string, string[]> {
	const byPrefix = new Map<string, string[]>();
	for (const file of adrFiles) {
		const match = /^(\d{4})-/.exec(file);
		if (!match) continue;
		const list = byPrefix.get(match[1]) ?? [];
		list.push(file);
		byPrefix.set(match[1], list);
	}
	return byPrefix;
}

function sourceHref(source: string, adrByPrefix: Map<string, string[]>): ExplorerHref {
	const adr = /^ADR-(\d{4})$/.exec(source);
	if (!adr) return { label: source, href: generatedHref(source) };
	const files = adrByPrefix.get(adr[1]) ?? [];
	if (files.length > 1) throw new Error(`duplicate ADR files for ${source}: ${files.join(", ")}`);
	if (files.length === 0) return { label: source };
	return { label: source, href: generatedHref(`docs/decisions/${files[0]}`) };
}

function toCanonicalNode(node: GraphNode, adrByPrefix: Map<string, string[]>, grounding: SourceGrounding[]): ExplorerCanonicalNode {
	return {
		id: node.id,
		kind: node.kind,
		statement: node.statement,
		slug: node.slug,
		role: node.role,
		status: node.status,
		visibility: node.visibility ?? "internal",
		externalId: node.externalId,
		wrongIf: node.wrongIf,
		revisitIf: node.revisitIf,
		projection: node.projection,
		sources: (node.sources ?? []).map((source) => sourceHref(source, adrByPrefix)),
		codeEvidence: (node.codeEvidence ?? []).map((path) => ({ label: path, href: generatedHref(path) })),
		observations: (node.observations ?? []).map((observation) => ({ kind: observation.kind, id: observation.id, path: observation.path })),
		grounding: grounding.map((entry) => ({ path: entry.path, href: generatedHref(entry.path), anchors: entry.anchors })),
	};
}

function toHit(selected: { nodes: GraphNode[]; edges: GraphEdge[] }, nodeIndex: Map<string, number>, edgeIndex: Map<string, number>): ExplorerGraphHit {
	return {
		nodeIdxs: selected.nodes.map((node) => {
			const idx = nodeIndex.get(node.id);
			if (idx === undefined) throw new Error(`result node ${node.id} missing from canonical table`);
			return idx;
		}),
		edgeIdxs: selected.edges.map((edge) => {
			const idx = edgeIndex.get(edgeIdentity(edge));
			if (idx === undefined) throw new Error(`result edge ${edgeIdentity(edge)} missing from canonical table`);
			return idx;
		}),
	};
}

export function buildExplorerPayload(graph: AssuranceGraph, catalog: { schemaVersion: string; views: AssuranceView[] }, opts: ExplorerPayloadOpts): ExplorerPayload {
	const adrByPrefix = adrFilesByPrefix(opts.adrFiles);
	const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
	const sources = [...new Set(graph.nodes.flatMap((node) => node.sources ?? []))].sort();
	const edges = [...graph.edges].sort((a, b) => edgeIdentity(a).localeCompare(edgeIdentity(b)));
	const nodeIndex = new Map(nodes.map((node, idx) => [node.id, idx]));
	const edgeIndex = new Map(edges.map((edge, idx) => [edgeIdentity(edge), idx]));
	const groundingByNode = new Map<string, SourceGrounding[]>();
	for (const entry of graph.sourceGrounding ?? []) {
		const list = groundingByNode.get(entry.node) ?? [];
		list.push(entry);
		groundingByNode.set(entry.node, list);
	}

	const depthWindow = explorerDepthWindow(catalog.views);
	const views: ExplorerViewMeta[] = catalog.views.map((view) => {
		const kind = classifyExplorerView(view);
		return {
			id: view.id,
			question: view.question,
			mode: view.mode,
			parameter: view.parameter,
			relations: view.relations ?? [],
			depth: view.depth,
			defaultDepth: explorerDefaultDepth(view),
			depths: kind === "parameterized" ? depthWindow : [],
			kind,
		};
	});

	const results: Record<string, ExplorerViewResults> = {};
	for (const view of catalog.views) {
		const kind = classifyExplorerView(view);
		const relations = view.relations ?? [];
		const masks = relationMasks(relations);
		if (kind === "debt") {
			const selected = selectView(graph, view, {}, opts.diagnosticsEnv);
			results[view.id] = { diagnostics: selected.diagnostics ?? [] };
			continue;
		}
		if (kind === "static") {
			const byMask: ExplorerStaticResults = {};
			for (const { mask, subset } of masks) {
				byMask[String(mask)] = toHit(selectView(graph, { ...view, relations: subset }), nodeIndex, edgeIndex);
			}
			results[view.id] = byMask;
			continue;
		}
		const bySeed: ExplorerParameterizedResults = {};
		const seeds: { key: string; args: QueryArgs }[] = graph.nodes.map((node) => ({ key: node.id, args: { node: node.id } }));
		if (view.parameter === "node-or-source") {
			for (const source of sources) seeds.push({ key: sourceSeedKey(source), args: { source } });
		}
		for (const seed of seeds) {
			const byDepth: Record<string, Record<string, ExplorerGraphHit>> = {};
			for (const depth of depthWindow) {
				const byMask: Record<string, ExplorerGraphHit> = {};
				for (const { mask, subset } of masks) {
					byMask[String(mask)] = toHit(selectView(graph, { ...view, depth, relations: subset }, seed.args), nodeIndex, edgeIndex);
				}
				byDepth[String(depth)] = byMask;
			}
			bySeed[seed.key] = byDepth;
		}
		results[view.id] = bySeed;
	}

	return {
		graphSchemaVersion: graph.schemaVersion,
		catalogSchemaVersion: catalog.schemaVersion,
		status: graph.status,
		authority: graph.authority,
		commitSha: opts.commitSha,
		views,
		nodes: nodes.map((node) => toCanonicalNode(node, adrByPrefix, groundingByNode.get(node.id) ?? [])),
		sources: sources.map((source) => sourceHref(source, adrByPrefix)),
		edges,
		retiredIds: deriveRetiredIds(graph),
		results,
	};
}

function readHeadSha(repo: string): string {
	const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
	if (git.status !== 0) {
		if (git.error) throw new Error(`git rev-parse HEAD failed: ${git.error.message}`);
		throw new Error(`git rev-parse HEAD failed (exit ${git.status}): ${(git.stderr || git.stdout).trim()}`);
	}
	const sha = git.stdout.trim();
	if (!sha) throw new Error("git rev-parse HEAD returned an empty SHA");
	const status = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
	if (status.status !== 0) {
		if (status.error) throw new Error(`git status --porcelain failed: ${status.error.message}`);
		throw new Error(`git status --porcelain failed (exit ${status.status}): ${(status.stderr || status.stdout).trim()}`);
	}
	return status.stdout.trim() ? `${sha}-dirty` : sha;
}

export function writeHtmlExplorer(repo = REPO_ROOT): string {
	const graph = loadShadowGraph(repo);
	const catalog = loadViews(repo);
	const adrFiles = readdirSync(resolve(repo, "docs/decisions")).filter((name) => name.endsWith(".md"));
	const payload = buildExplorerPayload(graph, catalog, {
		commitSha: readHeadSha(repo),
		diagnosticsEnv: defaultDiagnosticsEnv(graph, repo),
		adrFiles,
	});
	const outDir = resolve(repo, GENERATED_DIR);
	mkdirSync(outDir, { recursive: true });
	const outPath = resolve(outDir, "explorer.html");
	writeFileSync(outPath, renderHtmlExplorer(payload));
	return outPath;
}

function writeMermaidProjections(repo: string): void {
	const graph = loadShadowGraph(repo);
	const catalog = loadViews(repo);
	for (const id of ["architecture", "review"]) {
		const view = catalog.views.find((candidate: AssuranceView) => candidate.id === id);
		if (!view) throw new Error(`missing view ${id}`);
		writeFileSync(resolve(repo, `${GENERATED_DIR}/${id}.md`), renderMermaid(graph, view));
	}
	const stored = readShadowGraphRaw(repo);
	const regenerated: Record<string, unknown> = {};
	for (const key of Object.keys(stored)) regenerated[key] = key === "adrMap" ? adrMapFromSources(graph) : stored[key];
	writeFileSync(shadowGraphPath(repo), `${JSON.stringify(regenerated, null, "\t")}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const repo = REPO_ROOT;
	if (process.argv.includes("--write")) writeMermaidProjections(repo);
	if (process.argv.includes("--html")) console.log(writeHtmlExplorer(repo));
}
