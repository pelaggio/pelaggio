import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FifoPolicy, type FlowCandidate, type FlowSnapshot } from "../flow-policy.js";

const policy = new FifoPolicy();

function candidate(id: string, overrides: Partial<FlowCandidate> = {}): FlowCandidate {
	return {
		item: { id, title: `Title ${id}`, deps: "—", sourceRef: `track-${id}`, status: "open" },
		dependencies: [],
		unresolvedDependencies: [],
		fifoOrdinal: 0,
		...overrides,
	};
}

function evaluate(candidates: readonly FlowCandidate[], overrides: Partial<FlowSnapshot> = {}): ReturnType<FifoPolicy["evaluate"]> {
	return policy.evaluate({ candidates, readiness: { kind: "derived" }, ...overrides });
}

describe("FifoPolicy.evaluate", () => {
	it("excludes done, blocked, and in-progress items", () => {
		const candidates = ["open", "unknown", "done", "blocked", "in-progress"].map((status, index) =>
			candidate(String(index), { item: { ...candidate(String(index)).item, status: status as FlowCandidate["item"]["status"] }, fifoOrdinal: index }),
		);
		assert.deepEqual(
			evaluate(candidates).candidates.map(({ item }) => item.id),
			["0", "1"],
		);
	});

	it("requires all known dependencies and rejects unresolved prose", () => {
		const candidates = [
			candidate("ready", { dependencies: [{ reference: "A", satisfied: true }] }),
			candidate("open-dep", { dependencies: [{ reference: "A", satisfied: false }] }),
			candidate("mixed", {
				dependencies: [
					{ reference: "A", satisfied: true },
					{ reference: "A-1", satisfied: false },
				],
			}),
			candidate("prose", { unresolvedDependencies: ["waiting on vendor"] }),
		];
		const result = evaluate(candidates);
		assert.deepEqual(
			result.candidates.map(({ item }) => item.id),
			["ready"],
		);
		assert.deepEqual(
			result.verdicts.map(({ reason }) => reason),
			["eligible", "dependency", "dependency", "unresolved-dependency"],
		);
	});

	it("treats the native ready set as authoritative", () => {
		const omitted = candidate("omitted");
		const admitted = candidate("ADMITTED", { dependencies: [{ reference: "still-open", satisfied: false }] });
		assert.deepEqual(
			evaluate([omitted, admitted], { readiness: { kind: "native", readyIds: ["admitted"] } }).candidates.map(({ item }) => item.id),
			["ADMITTED"],
		);
	});

	it("orders by priority, FIFO ordinal, then ID without mutation", () => {
		const candidates = [candidate("B", { fifoOrdinal: 2 }), candidate("C", { fifoOrdinal: 1 }), candidate("A", { fifoOrdinal: 1 }), candidate("P", { priority: -1, fifoOrdinal: 9 })];
		const before = structuredClone(candidates);
		assert.deepEqual(
			evaluate(candidates).candidates.map(({ item }) => item.id),
			["P", "A", "C", "B"],
		);
		assert.deepEqual(candidates, before);
	});

	it("normalizes topics and returns no candidates when none match", () => {
		const candidates = [candidate("A", { item: { ...candidate("A").item, title: "Flow   Policy" } }), candidate("B")];
		assert.deepEqual(
			evaluate(candidates, { topic: "  FLOW policy " }).candidates.map(({ item }) => item.id),
			["A"],
		);
		assert.deepEqual(evaluate(candidates, { topic: "missing" }).candidates, []);
	});

	it("excludes deferred items from candidates with reason deferred", () => {
		const candidates = [candidate("ready", { fifoOrdinal: 0 }), candidate("later", { item: { ...candidate("later").item, deferred: true }, fifoOrdinal: 1 })];
		const result = evaluate(candidates);
		assert.deepEqual(
			result.candidates.map(({ item }) => item.id),
			["ready"],
		);
		assert.equal(result.verdicts.find((v) => v.id === "later")?.reason, "deferred");
		assert.equal(result.verdicts.find((v) => v.id === "later")?.eligible, false);
		// Deferred items remain in verdicts for display / envelope completeness.
		assert.equal(result.verdicts.length, 2);
	});

	it("status beats deferred for done/blocked/in-progress deferred items", () => {
		const candidates = [candidate("done-def", { item: { ...candidate("done-def").item, status: "done", deferred: true } }), candidate("block-def", { item: { ...candidate("block-def").item, status: "blocked", deferred: true } })];
		const result = evaluate(candidates);
		assert.deepEqual(result.candidates, []);
		assert.deepEqual(
			result.verdicts.map(({ reason }) => reason),
			["status", "status"],
		);
	});

	it("all-deferred snapshot evaluates successfully with empty candidates", () => {
		const candidates = [candidate("a", { item: { ...candidate("a").item, deferred: true } }), candidate("b", { item: { ...candidate("b").item, deferred: true } })];
		const result = evaluate(candidates);
		assert.deepEqual(result.candidates, []);
		assert.equal(result.verdicts.length, 2);
		assert.ok(result.verdicts.every((v) => v.reason === "deferred" && !v.eligible));
	});

	it("excludes only declared scopes above the active threshold", () => {
		const scopes = ["XS", "S", "M", "L", "XL"] as const;
		const result = evaluate(
			scopes.map((scope, fifoOrdinal) => candidate(scope, { item: { ...candidate(scope).item, scope }, fifoOrdinal })),
			{ maxScope: "M" },
		);
		assert.deepEqual(
			result.candidates.map(({ item }) => item.id),
			["XS", "S", "M"],
		);
		assert.deepEqual(
			result.verdicts.slice(3).map(({ reason, blockers }) => ({ reason, blockers })),
			[
				{ reason: "over-scope", blockers: ["L"] },
				{ reason: "over-scope", blockers: ["XL"] },
			],
		);
	});

	it("fails open for undeclared scope, absent threshold, and the XL escape hatch", () => {
		const undeclared = candidate("undeclared");
		const large = candidate("large", { item: { ...candidate("large").item, scope: "L" }, fifoOrdinal: 0 });
		const extraLarge = candidate("extra-large", { item: { ...candidate("extra-large").item, scope: "XL" }, fifoOrdinal: 1 });
		assert.deepEqual(
			evaluate([undeclared, large], { maxScope: "M" }).candidates.map(({ item }) => item.id),
			["undeclared"],
		);
		assert.deepEqual(
			evaluate([large]).candidates.map(({ item }) => item.id),
			["large"],
		);
		assert.deepEqual(
			evaluate([large, extraLarge], { maxScope: "XL" }).candidates.map(({ item }) => item.id),
			["large", "extra-large"],
		);
	});
});

describe("FifoPolicy.isQuickScope", () => {
	const cases: readonly [string, Parameters<FifoPolicy["isQuickScope"]>[0], boolean][] = [
		["standard body overrides bug", { item: { body: "Scope: M\nfix: bug" }, summaryText: "bug" }, false],
		["standard label overrides bug", { item: { labels: ["scope: XL", "bug"] }, summaryText: "fix: bug" }, false],
		["quick body", { item: { body: "Scope: XS" } }, true],
		["quick label", { item: { labels: ["scope/S"] } }, true],
		["bug label", { item: { labels: ["bug"] } }, true],
		["body fix", { item: { body: "fix: parser" } }, true],
		["summary fallback", { item: { body: "Refactor" }, summaryText: "bug in flow" }, true],
		["ordinary feature", { summaryText: "add a feature" }, false],
	];
	for (const [name, input, expected] of cases) it(name, () => assert.equal(policy.isQuickScope(input), expected));
});
