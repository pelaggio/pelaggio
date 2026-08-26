import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { type AssuranceGraph, type AssuranceView, diagnostics, type QueryArgs, selectView } from "../assurance-views.ts";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const graph = JSON.parse(readFileSync(resolve(repo, "docs/assurance/shadow-graph.json"), "utf8")) as AssuranceGraph;
const catalog = JSON.parse(readFileSync(resolve(repo, "docs/assurance/views.json"), "utf8")) as { views: AssuranceView[] };

/** Realization removed as a node kind — the reduction `corpus-convergence.md` §2 leaves unresolved. */
function withoutRealization(source: AssuranceGraph): AssuranceGraph {
	const dropped = new Set(source.nodes.filter((node) => node.kind === "realization").map((node) => node.id));
	return {
		...source,
		nodes: source.nodes.filter((node) => node.kind !== "realization"),
		edges: source.edges.filter((edge) => !dropped.has(edge.from) && !dropped.has(edge.to)),
	};
}

/** Parameters are derived, not named, so the fixture survives a node being renamed or retired. */
function argsFor(view: AssuranceView, source: AssuranceGraph): QueryArgs {
	if (view.parameter === "node") {
		const realized = new Set(source.edges.filter((e) => e.relation === "implements").map((e) => e.to));
		const seed = source.nodes.filter((n) => n.role === "invariant" && realized.has(n.id)).sort((a, b) => a.id.localeCompare(b.id))[0];
		assert.ok(seed, "no realized invariant to parameterize the `why` view with");
		return { node: seed.id };
	}
	if (view.parameter === "node-or-source") {
		const adr = [...new Set(source.nodes.flatMap((n) => n.sources ?? []))].filter((s) => /^ADR-\d{4}/.test(s)).sort()[0];
		assert.ok(adr, "no ADR source to parameterize the `affected` view with");
		return { source: adr.split(/\s/)[0] };
	}
	return {};
}

const answer = (source: AssuranceGraph, view: AssuranceView) => {
	const args = argsFor(view, source);
	if (view.mode === "diagnostics") return (selectView(source, view, args).diagnostics ?? diagnostics(source)).length;
	return selectView(source, view, args).nodes.length;
};

describe("question corpus against the materialized graph", () => {
	it("every declared view answers — a broken seed is a silently unaskable question", () => {
		for (const view of catalog.views) {
			assert.doesNotThrow(() => answer(graph, view), `view ${view.id} does not answer`);
			assert.ok(answer(graph, view) > 0, `view ${view.id} answers empty`);
		}
	});

	it("every seeded view's seeds resolve to real nodes", () => {
		// `review` is seeded on a realization. When that node goes, the view stops being a
		// question rather than returning a smaller answer — which is the failure this catches.
		const ids = new Set(graph.nodes.map((node) => node.id));
		for (const view of catalog.views) {
			for (const seed of view.seeds ?? []) assert.ok(ids.has(seed), `view ${view.id} seeds on missing node ${seed}`);
		}
	});
});

describe("A-1: does the kernel reduction survive the question corpus? (#670)", () => {
	// `corpus-convergence.md` §2 leaves Realization unresolved, and #670's A-1 bets the reduction
	// survives falsification against these questions — wrong-if a question loses necessary meaning
	// when Realization is removed. This ablates it and measures, so the bet has evidence either way.
	// These assertions record a MEASUREMENT, not a design lock: a kernel change that re-expresses
	// these facts elsewhere should edit this list, and thereby record the decision.
	const cut = withoutRealization(graph);

	it("pure-intent views are unaffected — the ablation is not just breaking the graph", () => {
		for (const id of ["architecture", "trust"]) {
			const view = catalog.views.find((candidate) => candidate.id === id);
			assert.ok(view, `missing view ${id}`);
			assert.equal(answer(cut, view), answer(graph, view), `${id} should not depend on Realization`);
		}
	});

	it("at least one question becomes unanswerable, not merely thinner", () => {
		const broken = catalog.views.filter((view) => {
			try {
				answer(cut, view);
				return false;
			} catch {
				return true;
			}
		});
		assert.ok(broken.length > 0, "expected a view seeded on a realization");
		assert.deepEqual(
			broken.map((view) => view.id),
			["review"],
		);
	});

	it("debt inverts rather than shrinks — the checks stop discriminating", () => {
		// Removing the primitive does not retire `invariant-without-realization`; it makes it
		// vacuously true everywhere. A check that fires on everything has stopped measuring.
		const view = catalog.views.find((candidate) => candidate.mode === "diagnostics");
		assert.ok(view, "no diagnostics view");
		assert.ok(answer(cut, view) > answer(graph, view), "expected debt findings to increase under ablation");
	});

	it("names which questions depend on Realization", () => {
		const dependent = catalog.views
			.filter((view) => {
				try {
					return answer(cut, view) !== answer(graph, view);
				} catch {
					return true;
				}
			})
			.map((view) => view.id)
			.sort();
		assert.deepEqual(dependent, ["affected", "debt", "landing", "review", "why"]);
	});
});
