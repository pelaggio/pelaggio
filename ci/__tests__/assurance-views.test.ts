import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { type AssuranceGraph, type AssuranceView, DEBT_CHECKS, diagnostics, renderMermaid, selectView } from "../assurance-views.ts";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const graph = JSON.parse(readFileSync(resolve(repo, "docs/assurance/shadow-graph.json"), "utf8")) as AssuranceGraph & { relationKinds: Record<string, unknown> };
const catalog = JSON.parse(readFileSync(resolve(repo, "docs/assurance/views.json"), "utf8")) as { views: AssuranceView[] };
const nodeIds = new Set(graph.nodes.map((node) => node.id));
const views = new Map(catalog.views.map((view) => [view.id, view]));

function view(id: string): AssuranceView {
	const value = views.get(id);
	assert.ok(value, `missing assurance view ${id}`);
	return value;
}

describe("assurance question catalog", () => {
	it("has stable unique IDs and only references known graph vocabulary", () => {
		assert.equal(views.size, catalog.views.length, "view IDs must be unique");
		for (const candidate of catalog.views) {
			assert.ok(candidate.question.length > 0, `${candidate.id} needs a question`);
			for (const relation of candidate.relations ?? []) assert.ok(relation in graph.relationKinds, `${candidate.id} references unknown relation ${relation}`);
			for (const seed of candidate.seeds ?? []) assert.ok(nodeIds.has(seed), `${candidate.id} references missing seed ${seed}`);
		}
	});

	it("bakes in the high-value operator questions", () => {
		for (const id of ["architecture", "why", "affected", "debt", "trust", "review", "landing"]) assert.ok(views.has(id), `missing ${id} view`);
	});

	it("separates semantic queries from presentation concerns", () => {
		const forbidden = new Set(["color", "position", "x", "y", "layout", "icon", "shape", "renderer"]);
		for (const candidate of catalog.views) for (const key of Object.keys(candidate)) assert.ok(!forbidden.has(key), `${candidate.id} leaks presentation key ${key}`);
	});

	it("keeps public views on projection-safe proposition nodes", () => {
		for (const candidate of catalog.views.filter((v) => v.audience?.includes("public"))) {
			const selected = selectView(graph, candidate);
			for (const node of selected.nodes) {
				assert.equal(node.kind, "proposition", `${candidate.id} leaks ${node.kind} ${node.id} to public projection`);
				assert.equal(node.role, "invariant", `${candidate.id} exposes non-invariant proposition ${node.id}`);
			}
		}
	});
});

/** Minimal in-memory mutation that should make `check` fire, for reachability of each declared check. */
function injectDebtFor(check: string): AssuranceGraph {
	const broken = structuredClone(graph) as AssuranceGraph;
	if (check === "orphan-realization") broken.nodes.push({ id: "CTR-X", kind: "realization", slug: "orphan", statement: "s" });
	if (check === "decision-without-intent") broken.nodes.push({ id: "DEC-X", kind: "decision", slug: "aimless", statement: "s" });
	if (check === "unused-assumption") broken.nodes.push({ id: "ASM-X", kind: "proposition", role: "assumption", visibility: "internal", slug: "unused", statement: "s" });
	if (check === "assumption-without-falsifier") {
		broken.nodes.push({ id: "ASM-X", kind: "proposition", role: "assumption", visibility: "internal", slug: "unfalsified", statement: "s" });
		broken.edges.push({ from: "DEC-0001", relation: "assumes", to: "ASM-X" });
	}
	if (check === "invariant-without-realization") broken.nodes.push({ id: "CLM-X", kind: "proposition", role: "invariant", visibility: "internal", slug: "unrealized", statement: "s" });
	if (check === "projection-overreach") {
		broken.nodes.push({ id: "CLM-X", kind: "proposition", role: "invariant", visibility: "internal", slug: "unrealized", statement: "s" });
		broken.nodes.push({ id: "TC-X", kind: "proposition", role: "invariant", visibility: "public", slug: "overreach", statement: "s", projection: { status: "guarantee" } });
		broken.edges.push({ from: "TC-X", relation: "projects", to: "CLM-X" });
	}
	if (check === "constraint-without-enforcement") broken.nodes.push({ id: "CON-X", kind: "proposition", role: "constraint", slug: "unbound", statement: "s" });
	return broken;
}

describe("query stress tests", () => {
	it("why executes as a parameterized neighborhood rather than a catalog promise", () => {
		const result = selectView(graph, view("why"), { node: "DEC-0014" });
		const ids = new Set(result.nodes.map((node) => node.id));
		for (const id of ["DEC-0014", "ASM-0002", "CLM-0016", "CLM-0009", "CTR-0003"]) assert.ok(ids.has(id), `why review must expose ${id}`);
	});

	it("affected can start from a source artifact and recover durable intent", () => {
		const result = selectView(graph, view("affected"), { source: "ADR-0022" });
		const ids = new Set(result.nodes.map((node) => node.id));
		assert.ok(ids.has("CLM-0016"), "ADR-0022 changes must recover independent-evaluation intent");
	});

	it("debt diagnostics detect an injected orphan realization", () => {
		const broken = structuredClone(graph) as AssuranceGraph;
		broken.nodes.push({ id: "CTR-X", kind: "realization", slug: "orphan", statement: "Synthetic orphan for stress test." });
		assert.ok(diagnostics(broken).some((issue) => issue.check === "orphan-realization" && issue.node === "CTR-X"));
	});

	it("debt diagnostics detect an unused empirical assumption role", () => {
		const broken = structuredClone(graph) as AssuranceGraph;
		broken.nodes.push({ id: "ASM-X", kind: "proposition", role: "assumption", visibility: "internal", slug: "unused", statement: "Synthetic unused assumption." });
		assert.ok(diagnostics(broken).some((issue) => issue.check === "unused-assumption" && issue.node === "ASM-X"));
	});

	it("every check the debt view declares is implemented, and nothing is declared that is not", () => {
		const declared = [...(view("debt").checks ?? [])].sort();
		assert.deepEqual(declared, [...DEBT_CHECKS].sort(), "views.json debt.checks must equal the checks diagnostics() implements");
		const produced = new Set(diagnostics(graph, { sourceGrounding: graph.sourceGrounding, readSource: () => undefined }).map((issue) => issue.check));
		// With every source unreadable, stale-source-grounding fires for each grounding; the structural checks
		// fire on the live corpus wherever debt exists. Every declared check must be reachable by some input.
		for (const check of DEBT_CHECKS) {
			const reachable = produced.has(check) || diagnostics(injectDebtFor(check)).some((issue) => issue.check === check);
			assert.ok(reachable, `${check} is declared but no input makes diagnostics() emit it`);
		}
	});

	it("stale-source-grounding fires through the debt view itself, not only through an injected environment", () => {
		const clean = selectView(graph, view("debt"));
		assert.ok(!(clean.diagnostics ?? []).some((i) => i.check === "stale-source-grounding"), "live groundings must all resolve");
		const broken = structuredClone(graph) as AssuranceGraph;
		broken.sourceGrounding = [{ node: "CLM-0006", path: "docs/decisions/0014-mechanism-policy-separation-spine.md", anchors: ["this phrase is not in the ADR"] }];
		assert.ok((selectView(broken, view("debt")).diagnostics ?? []).some((i) => i.check === "stale-source-grounding" && i.node === "CLM-0006"));
		const consumerEnv = { sourceGrounding: broken.sourceGrounding, readSource: () => "this phrase is not in the ADR" };
		assert.ok(!(selectView(broken, view("debt"), {}, consumerEnv).diagnostics ?? []).some((i) => i.check === "stale-source-grounding"), "debt view must use an explicitly supplied grounding environment");
	});

	it("stale-source-grounding fires when an anchor leaves its source and stays silent when it remains", () => {
		const grounding = [{ node: "CLM-0006", path: "x.md", anchors: ["determinism lives in the harness"] }];
		assert.ok(diagnostics(graph, { sourceGrounding: grounding, readSource: () => "unrelated prose" }).some((i) => i.check === "stale-source-grounding" && i.node === "CLM-0006"));
		assert.ok(!diagnostics(graph, { sourceGrounding: grounding, readSource: () => "determinism lives in the harness, judgment in the worker" }).some((i) => i.check === "stale-source-grounding"));
	});

	it("projection-overreach fires only for a guarantee whose projected intent nothing realizes", () => {
		const broken = structuredClone(graph) as AssuranceGraph;
		broken.nodes.push({ id: "CLM-X", kind: "proposition", role: "invariant", visibility: "internal", slug: "unrealized", statement: "Synthetic unrealized internal intent." });
		broken.nodes.push({ id: "TC-X", kind: "proposition", role: "invariant", visibility: "public", slug: "overreach", statement: "Synthetic public guarantee.", projection: { status: "guarantee" } });
		broken.edges.push({ from: "TC-X", relation: "projects", to: "CLM-X" });
		assert.ok(diagnostics(broken).some((i) => i.check === "projection-overreach" && i.node === "TC-X"));
		const overreaching = broken.nodes.find((n) => n.id === "TC-X");
		assert.ok(overreaching);
		overreaching.projection = { status: "best_effort" };
		assert.ok(!diagnostics(broken).some((i) => i.check === "projection-overreach" && i.node === "TC-X"), "best_effort honestly reports an absent mechanism — no false fire");
	});

	it("constraint-without-enforcement fires", () => {
		const intentOnly: AssuranceGraph = {
			schemaVersion: "0.2.0",
			nodes: [
				{ id: "CON-X", kind: "proposition", role: "constraint", slug: "unbound", statement: "s" },
				{ id: "DEC-Y", kind: "decision", slug: "intent", statement: "s" },
			],
			edges: [{ from: "CON-X", relation: "constrains", to: "DEC-Y" }],
		};
		const intentHits = (selectView(intentOnly, view("debt")).diagnostics ?? []).filter((d) => d.check === "constraint-without-enforcement");
		assert.ok(
			intentHits.some((d) => d.node === "CON-X"),
			"constrains → decision is intent-only, not enforcement",
		);
		assert.equal(intentHits.length, 1);

		const decisionImplements: AssuranceGraph = {
			schemaVersion: "0.2.0",
			nodes: [
				{ id: "CON-X", kind: "proposition", role: "constraint", slug: "unbound", statement: "s" },
				{ id: "DEC-Y", kind: "decision", slug: "choice", statement: "s" },
			],
			edges: [{ from: "DEC-Y", relation: "implements", to: "CON-X" }],
		};
		const choiceHits = (selectView(decisionImplements, view("debt")).diagnostics ?? []).filter((d) => d.check === "constraint-without-enforcement");
		assert.ok(
			choiceHits.some((d) => d.node === "CON-X"),
			"decision implements constraint is a choice, not a mechanism",
		);
		assert.equal(choiceHits.length, 1);
	});

	it("assumption-without-falsifier fires when neither accountability condition is substantive", () => {
		const missing: AssuranceGraph = {
			schemaVersion: "0.2.0",
			nodes: [
				{ id: "DEC-Y", kind: "decision", slug: "choice", statement: "s" },
				{ id: "ASM-X", kind: "proposition", role: "assumption", slug: "unfalsified", statement: "s" },
			],
			edges: [{ from: "DEC-Y", relation: "assumes", to: "ASM-X" }],
		};
		assert.ok(diagnostics(missing).some((d) => d.check === "assumption-without-falsifier" && d.node === "ASM-X"));

		const blank = structuredClone(missing);
		const blankNode = blank.nodes.find((n) => n.id === "ASM-X");
		assert.ok(blankNode);
		blankNode.wrongIf = "   \n\t  ";
		assert.ok(diagnostics(blank).some((d) => d.check === "assumption-without-falsifier" && d.node === "ASM-X"));

		const short = structuredClone(missing);
		const shortNode = short.nodes.find((n) => n.id === "ASM-X");
		assert.ok(shortNode);
		shortNode.wrongIf = "x".repeat(39);
		assert.ok(diagnostics(short).some((d) => d.check === "assumption-without-falsifier" && d.node === "ASM-X"));

		const shortRevisit = structuredClone(missing);
		const shortRevisitNode = shortRevisit.nodes.find((n) => n.id === "ASM-X");
		assert.ok(shortRevisitNode);
		shortRevisitNode.revisitIf = "x".repeat(39);
		assert.ok(diagnostics(shortRevisit).some((d) => d.check === "assumption-without-falsifier" && d.node === "ASM-X"));
	});

	it("assumption-without-falsifier fires when both accountability conditions are present", () => {
		const observation = "x".repeat(40);
		const ambiguous: AssuranceGraph = {
			schemaVersion: "0.2.0",
			nodes: [
				{ id: "DEC-Y", kind: "decision", slug: "choice", statement: "s" },
				{ id: "ASM-X", kind: "proposition", role: "assumption", slug: "ambiguous", statement: "s", wrongIf: observation, revisitIf: observation },
			],
			edges: [{ from: "DEC-Y", relation: "assumes", to: "ASM-X" }],
		};
		assert.ok(diagnostics(ambiguous).some((d) => d.check === "assumption-without-falsifier" && d.node === "ASM-X"));
	});

	it("assumption-without-falsifier accepts a substantive wrongIf or revisitIf at the inclusive floor", () => {
		const observation = "x".repeat(40);
		const floor: AssuranceGraph = {
			schemaVersion: "0.2.0",
			nodes: [
				{ id: "DEC-Y", kind: "decision", slug: "choice", statement: "s" },
				{ id: "ASM-X", kind: "proposition", role: "assumption", slug: "falsified", statement: "s", wrongIf: observation },
			],
			edges: [{ from: "DEC-Y", relation: "assumes", to: "ASM-X" }],
		};
		assert.ok(!diagnostics(floor).some((d) => d.check === "assumption-without-falsifier"));

		const longer: AssuranceGraph = {
			...floor,
			nodes: floor.nodes.map((n) => (n.id === "ASM-X" ? { ...n, wrongIf: `${observation} and then some` } : n)),
		};
		assert.ok(!diagnostics(longer).some((d) => d.check === "assumption-without-falsifier"));

		const padded: AssuranceGraph = {
			...floor,
			nodes: floor.nodes.map((n) => (n.id === "ASM-X" ? { ...n, wrongIf: `  ${observation}  ` } : n)),
		};
		assert.ok(!diagnostics(padded).some((d) => d.check === "assumption-without-falsifier"), "surrounding whitespace is trimmed before the floor");

		const revisitOnly: AssuranceGraph = {
			schemaVersion: "0.2.0",
			nodes: [
				{ id: "DEC-Y", kind: "decision", slug: "choice", statement: "s" },
				{ id: "ASM-X", kind: "proposition", role: "assumption", slug: "revisited", statement: "s", revisitIf: observation },
			],
			edges: [{ from: "DEC-Y", relation: "assumes", to: "ASM-X" }],
		};
		assert.ok(!diagnostics(revisitOnly).some((d) => d.check === "assumption-without-falsifier"), "a revisit-only assumption is accountable without claiming a counterexample");
	});

	it("constraint-without-enforcement accepts either encoding", () => {
		const viaConstrains: AssuranceGraph = {
			schemaVersion: "0.2.0",
			nodes: [
				{ id: "CON-X", kind: "proposition", role: "constraint", slug: "bound", statement: "s" },
				{ id: "CTR-Y", kind: "realization", slug: "mech", statement: "s" },
			],
			edges: [{ from: "CON-X", relation: "constrains", to: "CTR-Y" }],
		};
		assert.ok(!(selectView(viaConstrains, view("debt")).diagnostics ?? []).some((d) => d.check === "constraint-without-enforcement"));

		const viaImplements: AssuranceGraph = {
			schemaVersion: "0.2.0",
			nodes: [
				{ id: "CON-X", kind: "proposition", role: "constraint", slug: "bound", statement: "s" },
				{ id: "CTR-Y", kind: "realization", slug: "mech", statement: "s" },
			],
			edges: [{ from: "CTR-Y", relation: "implements", to: "CON-X" }],
		};
		assert.ok(!(selectView(viaImplements, view("debt")).diagnostics ?? []).some((d) => d.check === "constraint-without-enforcement"));
	});

	it("query modes fail loudly when required parameters are absent or unknown", () => {
		assert.throws(() => selectView(graph, view("why")), /requires node/);
		assert.throws(() => selectView(graph, view("affected"), { source: "ADR-9999" }), /resolvable/);
	});

	it("seeded-neighborhood prefers QueryArgs.seeds over catalog seeds", () => {
		const review = view("review");
		const catalogIds = new Set(selectView(graph, review).nodes.map((node) => node.id));
		assert.ok(catalogIds.has("DEC-0014"), "catalog review seeds must still resolve");
		const overridden = selectView(graph, review, { seeds: ["CLM-0002"] });
		const ids = new Set(overridden.nodes.map((node) => node.id));
		assert.ok(ids.has("CLM-0002"), "override seed must appear in the selected neighborhood");
		assert.notDeepEqual([...ids].sort(), [...catalogIds].sort(), "caller seeds must replace catalog seeds rather than union with them");
	});

	it("seeded-neighborhood fails loudly when neither override nor catalog seeds are present", () => {
		const seedless: AssuranceView = { ...view("review"), seeds: undefined };
		assert.throws(() => selectView(graph, seedless), /requires seeds/);
		assert.throws(() => selectView(graph, view("review"), { seeds: [] }), /requires seeds/);
	});
});

describe("static projections", () => {
	it("architecture view is every internal invariant proposition, not every proposition", () => {
		const selected = selectView(graph, view("architecture"));
		const invariants = graph.nodes
			.filter((node) => node.kind === "proposition" && node.role === "invariant" && (node.visibility ?? "internal") === "internal")
			.map((node) => node.id)
			.sort();
		assert.deepEqual(
			selected.nodes.map((node) => node.id),
			invariants,
		);
	});

	it("trust view is public proposition projections rather than an external-claim class", () => {
		const selected = selectView(graph, view("trust"));
		assert.ok(selected.nodes.length > 0);
		assert.ok(selected.nodes.every((node) => node.kind === "proposition" && node.visibility === "public"));
	});

	it("review view makes strategy, assumption role, realization, and surviving intent visible together", () => {
		const selectedIds = new Set(selectView(graph, view("review")).nodes.map((node) => node.id));
		for (const id of ["DEC-0014", "CTR-0003", "ASM-0002", "CLM-0016", "CLM-0009", "CLM-0008"]) assert.ok(selectedIds.has(id), `review view must contain ${id}`);
	});

	for (const id of ["architecture", "review"]) {
		it(`${id} Mermaid projection is generated from the corpus`, () => {
			const expected = renderMermaid(graph, view(id));
			const checkedIn = readFileSync(resolve(repo, `docs/assurance/generated/${id}.md`), "utf8");
			assert.equal(checkedIn, expected, `run node --import tsx ci/assurance-views.ts --write after changing ${id}`);
		});
	}
});
