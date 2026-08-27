import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSnapshot, charterProse, computeSignals, declaredDeps, fingerprint, hasAcceptanceEvidence, hasLegacyVocabulary, type IssueRecord, intakeTrend, isEmptyCharter, labelNames } from "../backlog-audit.ts";

function issue(over: Partial<IssueRecord> & { number: number }): IssueRecord {
	return {
		title: `item ${over.number}`,
		body: "",
		state: "open",
		labels: ["autopilot"],
		created_at: "2026-08-01T00:00:00Z",
		updated_at: "2026-08-01T00:00:00Z",
		...over,
	};
}

describe("charter prose", () => {
	it("strips the adapter's machine-readable preamble", () => {
		assert.equal(charterProse("Depends on: 170, 171\nScope: L\n"), "");
		assert.equal(charterProse("Scope: M\n\n## Problem\nreal text"), "## Problem\nreal text");
	});

	it("flags a title-only charter and clears one carrying an outcome", () => {
		assert.equal(isEmptyCharter("Depends on: 257\nScope: L"), true);
		assert.equal(isEmptyCharter(null), true);
		assert.equal(isEmptyCharter("Scope: S\n\n## Outcome\nThe worktree write-guard refuses a write outside the item's declared write-set, so a scoped item cannot silently widen its blast radius."), false);
	});
});

describe("acceptance evidence", () => {
	it("recognizes every shape a later step could bind a check to", () => {
		assert.equal(hasAcceptanceEvidence("## Acceptance\n- it works"), true);
		assert.equal(hasAcceptanceEvidence("## Evidence / test\nunit test"), true);
		assert.equal(hasAcceptanceEvidence("- [ ] `pnpm check` green"), true);
		assert.equal(hasAcceptanceEvidence("AC-1 the gate refuses a moved head"), true);
		assert.equal(hasAcceptanceEvidence("AC-2 clean head\n  verify: pnpm test:ci"), true);
	});

	// No-false-fire: prose that merely discusses acceptance is not an acceptance surface, and a
	// completed checkbox is a record of work, not a binding a planner can act on.
	it("does not fire on prose about acceptance or on a ticked box", () => {
		assert.equal(hasAcceptanceEvidence("The reviewer will decide whether to accept this."), false);
		assert.equal(hasAcceptanceEvidence("- [x] already done"), false);
	});
});

describe("legacy vocabulary", () => {
	it("catches identifiers that did not survive the autopilot → pelaggio rename", () => {
		assert.equal(hasLegacyVocabulary("`packages/autopilot/scripts/autopilot/pr-review-cli.ts`"), true);
		assert.equal(hasLegacyVocabulary("consumer on `@cdhorne/claude-autopilot` 0.1.0"), true);
		assert.equal(hasLegacyVocabulary("`~/.config/autopilot-server/repos.yml`"), true);
	});

	// No-false-fire: `autopilot` is the LIVE roadmap label and the live run mode. Bare uses of the
	// word are current vocabulary, not drift — only the renamed package/path/artifact ids are.
	it("does not fire on the live autopilot label or run mode", () => {
		assert.equal(hasLegacyVocabulary("labelled `autopilot`, picked by the autopilot sweep"), false);
		assert.equal(hasLegacyVocabulary("`packages/pelaggio/scripts/pelaggio/config.ts`"), false);
		assert.equal(hasLegacyVocabulary("repo var AUTOPILOT_REVIEW_RUNNER=local"), false);
	});
});

describe("declared dependencies", () => {
	it("reads the preamble and ignores prose mentions of an issue number", () => {
		assert.deepEqual(declaredDeps("Depends on: 170, 171\nScope: L"), [170, 171]);
		assert.deepEqual(declaredDeps("**Depends on** 557"), [557]);
		assert.deepEqual(declaredDeps("Follows #495; supersedes #455."), []);
	});
});

describe("signals", () => {
	const issues: IssueRecord[] = [
		issue({ number: 10, state: "closed" }),
		issue({ number: 11, state: "closed" }),
		issue({ number: 12 }),
		// deps all closed → unblocked
		issue({ number: 20, body: "Depends on: 10, 11\nScope: L" }),
		// one dep still open → NOT unblocked
		issue({ number: 21, body: "Depends on: 10, 12\nScope: L" }),
		// no declared deps → NOT unblocked (absence of a dependency is not a resolved one)
		issue({ number: 22, body: "## Outcome\n".padEnd(200, "x") }),
		issue({ number: 23, labels: ["enhancement"] }),
		{ ...issue({ number: 99 }), pull_request: {} },
	];
	const signals = computeSignals(issues);

	it("drops pull requests and closed items", () => {
		assert.deepEqual(
			signals.map((s) => s.number),
			[12, 20, 21, 22, 23],
		);
	});

	it("calls an item unblocked only when it declared deps and every one closed", () => {
		const by = new Map(signals.map((s) => [s.number, s]));
		assert.equal(by.get(20)?.unblocked, true);
		assert.equal(by.get(21)?.unblocked, false);
		assert.equal(by.get(22)?.unblocked, false);
	});

	it("calls an item unpickable only when the roadmap label is absent", () => {
		const by = new Map(signals.map((s) => [s.number, s]));
		assert.equal(by.get(23)?.unpickable, true);
		assert.equal(by.get(22)?.unpickable, false);
	});

	it("reads label objects and bare strings alike", () => {
		assert.deepEqual(labelNames(["autopilot", { name: "deferred" }, {}]), ["autopilot", "deferred"]);
	});
});

describe("intake trend", () => {
	it("buckets by half-month and counts every item ever filed, not just open ones", () => {
		const rows = intakeTrend([
			issue({ number: 1, created_at: "2026-07-03T00:00:00Z", state: "closed" }),
			issue({ number: 2, created_at: "2026-07-20T00:00:00Z", body: `## Outcome\n${"x".repeat(150)}\n\n## Acceptance\n- [ ] x` }),
			issue({ number: 3, created_at: "2026-07-16T00:00:00Z" }),
		]);
		assert.deepEqual(rows, [
			{ period: "2026-07-H1", filed: 1, empty: 1, withAcceptance: 0 },
			{ period: "2026-07-H2", filed: 2, empty: 1, withAcceptance: 1 },
		]);
	});
});

describe("fingerprint", () => {
	it("is stable under reordering and moves when a charter changes", () => {
		const a = issue({ number: 1, body: "one" });
		const b = issue({ number: 2, body: "two" });
		assert.equal(fingerprint([a, b]), fingerprint([b, a]));
		assert.notEqual(fingerprint([a, b]), fingerprint([a, { ...b, body: "two!" }]));
		assert.notEqual(fingerprint([a, b]), fingerprint([a, { ...b, state: "closed" }]));
		assert.ok(fingerprint([a, b]).startsWith("2:"));
	});

	it("excludes pull requests from the corpus it names", () => {
		const a = issue({ number: 1 });
		assert.equal(fingerprint([a]), fingerprint([a, { ...issue({ number: 2 }), pull_request: {} }]));
	});
});

describe("snapshot", () => {
	it("carries the derived signals and the corpus identity, never the bodies", () => {
		const snap = buildSnapshot([issue({ number: 1, body: "secret charter text" })], "2026-08-27");
		assert.equal(snap.openCount, 1);
		assert.equal(snap.observedAt, "2026-08-27");
		assert.ok(!JSON.stringify(snap).includes("secret charter text"));
	});
});
