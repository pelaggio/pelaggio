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
