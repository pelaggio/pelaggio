import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { describe, it } from "node:test";
import { loadShadowGraph, loadViews } from "../assurance-graph.js";
import {
	type AssuranceView,
	buildExplorerPayload,
	defaultDiagnosticsEnv,
	diagnostics,
	type ExplorerCanonicalNode,
	type ExplorerDebtResults,
	type ExplorerGraphHit,
	type ExplorerParameterizedResults,
	type ExplorerPayload,
	type ExplorerStaticResults,
	renderHtmlExplorer,
	selectView,
} from "../assurance-views.ts";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const graph = loadShadowGraph(repo);
const catalog = loadViews(repo);
const adrFiles = readdirSync(resolve(repo, "docs/decisions")).filter((name) => name.endsWith(".md"));
const env = defaultDiagnosticsEnv(graph);
const COMMIT_SHA = "test-sha-not-from-git";
const payload = buildExplorerPayload(graph, catalog, { commitSha: COMMIT_SHA, diagnosticsEnv: env, adrFiles });

function masksFor(relations: string[]): { mask: number; subset: string[] }[] {
	const count = 1 << relations.length;
	const out: { mask: number; subset: string[] }[] = [];
	for (let mask = 0; mask < count; mask++) {
		const subset: string[] = [];
		for (let i = 0; i < relations.length; i++) if (mask & (1 << i)) subset.push(relations[i]!);
		out.push({ mask, subset });
	}
	return out;
}

function generatedHref(repoPath: string): string {
	return posix.relative("docs/assurance/generated", repoPath);
}

function expectedSourceHref(source: string): { label: string; href?: string } {
	const adr = /^ADR-(\d{4})$/.exec(source);
	if (!adr) return { label: source, href: generatedHref(source) };
	const files = adrFiles.filter((name) => name.startsWith(`${adr[1]}-`));
	assert.ok(files.length <= 1, `duplicate ADR files for ${source}`);
	if (files.length === 0) return { label: source };
	return { label: source, href: generatedHref(`docs/decisions/${files[0]}`) };
}

function identities(hit: ExplorerGraphHit): { nodes: string[]; edges: { from: string; relation: string; to: string }[] } {
	return {
		nodes: hit.nodeIdxs.map((idx) => payload.nodes[idx]!.id),
		edges: hit.edgeIdxs.map((idx) => payload.edges[idx]!),
	};
}

function assertHitMatches(label: string, hit: ExplorerGraphHit, selected: { nodes: { id: string }[]; edges: { from: string; relation: string; to: string }[] }): void {
	const got = identities(hit);
	assert.deepEqual(
		got.nodes,
		selected.nodes.map((node) => node.id),
		label,
	);
	assert.deepEqual(got.edges, selected.edges, label);
}

function staticHit(viewId: string, mask: number): ExplorerGraphHit {
	return (payload.results[viewId] as ExplorerStaticResults)[String(mask)]!;
}

function parameterizedHit(viewId: string, seedKey: string, depth: number, mask: number): ExplorerGraphHit {
	return (payload.results[viewId] as ExplorerParameterizedResults)[seedKey]![String(depth)]![String(mask)]!;
}

function expectedDefaultDepth(view: AssuranceView): number {
	if (view.depth !== undefined) return view.depth;
	if (view.mode === "upstream-intent") return 3;
	return 1;
}

describe("assurance HTML explorer payload", () => {
	it("preserves catalog questions, every graph node, and injected commit metadata", () => {
		assert.deepEqual(
			payload.views.map((view) => ({ id: view.id, question: view.question })),
			catalog.views.map((view) => ({ id: view.id, question: view.question })),
		);
		assert.deepEqual(
			payload.nodes.map((node) => node.id),
			[...graph.nodes.map((node) => node.id)].sort((a, b) => a.localeCompare(b)),
		);
		const expectedSources = [...new Set(graph.nodes.flatMap((node) => node.sources ?? []))].sort().map(expectedSourceHref);
		assert.deepEqual(payload.sources, expectedSources);
		assert.equal(payload.graphSchemaVersion, graph.schemaVersion);
		assert.equal(payload.catalogSchemaVersion, catalog.schemaVersion);
		assert.equal(payload.status, graph.status);
		assert.equal(payload.authority, graph.authority);
		assert.equal(payload.commitSha, COMMIT_SHA);
	});

	it("matches selectView for every parameterless view and declared-relation mask", () => {
		for (const view of catalog.views) {
			if (view.parameter || view.mode === "diagnostics") continue;
			for (const { mask, subset } of masksFor(view.relations ?? [])) {
				assertHitMatches(`${view.id} mask ${mask}`, staticHit(view.id, mask), selectView(graph, { ...view, relations: subset }));
			}
		}
	});

	it("matches selectView for every node or source seed, catalog-derived depth, and declared-relation mask", () => {
		const parameterized = catalog.views.filter((view): view is AssuranceView & { parameter: "node" | "node-or-source" } => view.parameter === "node" || view.parameter === "node-or-source");
		const maxDefaultDepth = Math.max(...parameterized.map(expectedDefaultDepth));
		const expectedDepths = Array.from({ length: maxDefaultDepth }, (_, index) => index + 1);
		for (const view of parameterized) {
			const meta = payload.views.find((candidate) => candidate.id === view.id);
			assert.ok(meta);
			assert.equal(meta.defaultDepth, expectedDefaultDepth(view));
			assert.deepEqual(meta.depths, expectedDepths);
			assert.ok(meta.depths.includes(expectedDefaultDepth(view)), `${view.id} default depth missing from explorer window`);
			for (const node of graph.nodes) {
				for (const depth of meta.depths) {
					for (const { mask, subset } of masksFor(view.relations ?? [])) {
						assertHitMatches(`${view.id} ${node.id} depth ${depth} mask ${mask}`, parameterizedHit(view.id, node.id, depth, mask), selectView(graph, { ...view, depth, relations: subset }, { node: node.id }));
					}
				}
			}
			if (view.parameter !== "node-or-source") continue;
			for (const source of payload.sources) {
				for (const depth of meta.depths) {
					for (const { mask, subset } of masksFor(view.relations ?? [])) {
						assertHitMatches(`${view.id} source ${source.label} depth ${depth} mask ${mask}`, parameterizedHit(view.id, `source:${source.label}`, depth, mask), selectView(graph, { ...view, depth, relations: subset }, { source: source.label }));
					}
				}
			}
		}
	});

	it("embeds the live-repo debt snapshot without inventing neighbourhoods or unknown nodes", () => {
		const debtView = catalog.views.find((view) => view.mode === "diagnostics");
		assert.ok(debtView);
		const embedded = (payload.results[debtView.id] as ExplorerDebtResults).diagnostics;
		assert.deepEqual(embedded, selectView(graph, debtView, {}, env).diagnostics);
		assert.deepEqual(embedded, diagnostics(graph, env));
		const canonical = new Set(payload.nodes.map((node) => node.id));
		for (const issue of embedded) assert.ok(canonical.has(issue.node), `debt node ${issue.node} missing from canonical table`);
	});

	it("rewrites local hrefs and derives retired IDs from live prefixes without labeling ADR citations", () => {
		const byId = new Map(graph.nodes.map((node) => [node.id, node]));
		const groundingByNode = new Map<string, NonNullable<typeof graph.sourceGrounding>>();
		for (const entry of graph.sourceGrounding ?? []) {
			const list = groundingByNode.get(entry.node) ?? [];
			list.push(entry);
			groundingByNode.set(entry.node, list);
		}
		for (const node of payload.nodes) {
			const source = byId.get(node.id);
			assert.ok(source);
			assert.equal(node.visibility, source.visibility ?? "internal");
			assert.deepEqual(node.sources, (source.sources ?? []).map(expectedSourceHref));
			assert.deepEqual(
				node.codeEvidence,
				(source.codeEvidence ?? []).map((path) => ({ label: path, href: generatedHref(path) })),
			);
			assert.deepEqual(
				node.grounding,
				(groundingByNode.get(node.id) ?? []).map((entry) => ({ path: entry.path, href: generatedHref(entry.path), anchors: entry.anchors })),
			);
		}
		assert.deepEqual(payload.retiredIds, ["CLM-0014", "CTR-0014", "CTR-0019", "CTR-0020", "CTR-0024"]);
		assert.ok(!payload.retiredIds.some((id) => /^ADR-\d+$/.test(id)), "ADR-shaped tokens that are not node prefixes must not be retired");
	});

	it("escapes JSON so graph prose cannot terminate the application/json script", () => {
		const statement = "</script><!--&\u2028\u2029";
		const synthetic: ExplorerPayload = {
			graphSchemaVersion: "0",
			catalogSchemaVersion: "0",
			commitSha: "embed-test",
			views: [],
			nodes: [
				{
					id: "X-1",
					kind: "proposition",
					statement,
					slug: "inject",
					visibility: "internal",
					sources: [],
					codeEvidence: [],
					observations: [],
					grounding: [],
				} satisfies ExplorerCanonicalNode,
			],
			sources: [],
			edges: [],
			retiredIds: [],
			results: {},
		};
		const html = renderHtmlExplorer(synthetic);
		const marker = '<script type="application/json" id="assurance-explorer-payload">';
		const start = html.indexOf(marker);
		assert.ok(start >= 0, "payload script marker missing");
		const jsonStart = start + marker.length;
		const jsonEnd = html.indexOf("</script>", jsonStart);
		assert.ok(jsonEnd > jsonStart);
		const jsonText = html.slice(jsonStart, jsonEnd);
		assert.equal(jsonText.includes("</script>"), false);
		assert.deepEqual(JSON.parse(jsonText), synthetic);
	});

	it("keeps the presentation module off the query engine", () => {
		const src = readFileSync(new URL("../assurance-explorer.ts", import.meta.url), "utf8");
		assert.doesNotMatch(src, /\bselectView\b/);
		assert.doesNotMatch(src, /from "\.\/assurance-observations\.js"/);
		assert.match(src, /import type \{ ExplorerPayload \}/);
	});
});
