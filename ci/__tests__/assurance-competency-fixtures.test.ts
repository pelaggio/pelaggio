import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { loadShadowGraph, loadViews } from "../assurance-graph.js";
import { diagnostics, selectView } from "../assurance-views.js";

type Edge = { from: string; relation: string; to: string };
type Diagnostic = { check: string; node: string };
type Fixture = {
	id: string;
	prompt: string;
	query: { view: string; node: string };
	expectNodes: string[];
	expectEdges: Edge[];
	forbidEdges?: Edge[];
	expectDiagnostics?: Diagnostic[];
};

const repo = resolve(new URL("../..", import.meta.url).pathname);
const graph = loadShadowGraph(repo);
const views = new Map(loadViews(repo).views.map((view) => [view.id, view]));
const document = JSON.parse(readFileSync(resolve(repo, "docs/assurance/competency-fixtures.json"), "utf8")) as {
	schemaVersion: string;
	status: string;
	fixtures: Fixture[];
};

const edgeKey = (edge: Edge) => `${edge.from}:${edge.relation}:${edge.to}`;
const diagnosticKey = (item: Diagnostic) => `${item.check}:${item.node}`;

describe("assurance competency fixtures", () => {
	it("answer consequential change questions from existing semantics", () => {
		assert.equal(document.status, "experimental-shadow-only");
		assert.ok(document.fixtures.length >= 7);
		const ids = new Set<string>();
		const allEdges = new Set(graph.edges.map(edgeKey));
		const liveDiagnostics = new Set(diagnostics(graph).map(diagnosticKey));

		for (const fixture of document.fixtures) {
			assert.ok(!ids.has(fixture.id), `duplicate fixture ${fixture.id}`);
			ids.add(fixture.id);
			assert.ok(fixture.prompt.trim().length > 0, `${fixture.id} needs an operator prompt`);
			const view = views.get(fixture.query.view);
			assert.ok(view, `${fixture.id} names missing view ${fixture.query.view}`);
			const result = selectView(graph, view, { node: fixture.query.node });
			const resultNodes = new Set(result.nodes.map((node) => node.id));
			const resultEdges = new Set(result.edges.map(edgeKey));

			for (const node of fixture.expectNodes) assert.ok(resultNodes.has(node), `${fixture.id} must expose ${node}`);
			for (const edge of fixture.expectEdges) assert.ok(resultEdges.has(edgeKey(edge)), `${fixture.id} must expose ${edgeKey(edge)}`);
			for (const edge of fixture.forbidEdges ?? []) assert.ok(!allEdges.has(edgeKey(edge)), `${fixture.id} must refuse ${edgeKey(edge)}`);
			for (const diagnostic of fixture.expectDiagnostics ?? []) assert.ok(liveDiagnostics.has(diagnosticKey(diagnostic)), `${fixture.id} must expose debt ${diagnosticKey(diagnostic)}`);
		}
	});
});
