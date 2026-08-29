import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDeferredItems, parsePickItem, parsePickResult, pickDivergedFromPin } from "../pick-parse.js";

describe("pickDivergedFromPin (#332)", () => {
	// Mirrors the github adapter's parseItemId: a number from feat/issue-N, #N, or issue-N; else null.
	const ghParse = async (t: string): Promise<string | null> => {
		const m = t.match(/feat\/issue-(\d+)/) ?? t.match(/#(\d+)/) ?? t.match(/\bissue[- ]?(\d+)\b/i);
		return m ? m[1] : null;
	};

	it("no divergence when the resolved id equals the pin (bare numbers)", async () => {
		assert.equal(await pickDivergedFromPin("286", "286", ghParse), false);
	});

	it("DIVERGENCE when the pick claimed a different id (the #332 bug: 286→337)", async () => {
		assert.equal(await pickDivergedFromPin("286", "337", ghParse), true);
	});

	it("normalizes #N / feat/issue-N / issue-N to the same id (no false divergence)", async () => {
		assert.equal(await pickDivergedFromPin("#286", "feat/issue-286", ghParse), false);
		assert.equal(await pickDivergedFromPin("issue-286", "286", ghParse), false);
	});

	it("detects divergence across id formats", async () => {
		assert.equal(await pickDivergedFromPin("286", "feat/issue-337", ghParse), true);
		assert.equal(await pickDivergedFromPin("#286", "337", ghParse), true);
	});

	it("markdown-style letter ids compare exactly", async () => {
		const mdParse = async (t: string): Promise<string | null> => (/^[A-Z]+-?\d[\dA-Z-]*$/.test(t) ? t : null);
		assert.equal(await pickDivergedFromPin("TOOL-16", "TOOL-16", mdParse), false);
		assert.equal(await pickDivergedFromPin("TOOL-16", "TOOL-17", mdParse), true);
	});

	it("does not falsely diverge on a mixed-case markdown pin (getItem is case-insensitive)", async () => {
		// The markdown parser only recognizes UPPERCASE ids → a lowercase pin falls back to its raw
		// string ("tool-16") while the resolved canonical id is "TOOL-16". Case-insensitive compare
		// keeps them equal (they are the same item). (codex #344 review)
		const mdParse = async (t: string): Promise<string | null> => (/^[A-Z]+-?\d[\dA-Z-]*$/.test(t) ? t : null);
		assert.equal(await pickDivergedFromPin("tool-16", "TOOL-16", mdParse), false);
		assert.equal(await pickDivergedFromPin("Tool-16", "TOOL-16", mdParse), false);
		// A genuinely different item still diverges regardless of case.
		assert.equal(await pickDivergedFromPin("tool-16", "TOOL-17", mdParse), true);
	});
});

describe("parseDeferredItems (#115)", () => {
	it("parses deferred-item markers into CreateItemOpts with deferred:true", () => {
		const text = ["Some review prose.", 'deferred-item: {"title": "Add retries", "scope": "S", "deps": "T-1, T-2"}', 'deferred-item: {"title": "Doc the flag"}', "more prose"].join("\n");
		const items = parseDeferredItems(text);
		assert.equal(items.length, 2);
		assert.deepEqual(items[0], { title: "Add retries", scope: "S", deps: ["T-1", "T-2"], deferred: true });
		assert.deepEqual(items[1], { title: "Doc the flag", deferred: true });
	});

	it("skips malformed JSON, title-less, and invalid-scope entries gracefully", () => {
		const text = [
			"deferred-item: {not json}",
			'deferred-item: {"scope": "M"}', // no title
			'deferred-item: {"title": "  "}', // blank title
			'deferred-item: {"title": "Keep", "scope": "HUGE"}', // invalid scope dropped, item kept
		].join("\n");
		const items = parseDeferredItems(text);
		assert.deepEqual(items, [{ title: "Keep", deferred: true }]);
	});

	it("returns [] when there are no markers", () => {
		assert.deepEqual(parseDeferredItems("just a normal review with no deferrals"), []);
	});

	it("handles a `}` inside a string value and normalizes lowercase scope", () => {
		const items = parseDeferredItems('deferred-item: {"title": "fix the } brace", "scope": "s"}');
		assert.deepEqual(items, [{ title: "fix the } brace", scope: "S", deferred: true }]);
	});

	it("does not match a mid-line/prose mention of deferred-item: (line-anchored)", () => {
		assert.deepEqual(parseDeferredItems('The reviewer said deferred-item: {"title": "X"} inline in a sentence.'), []);
	});

	it("dedups by title (createItem is not idempotent)", () => {
		const items = parseDeferredItems(['deferred-item: {"title": "Add retries"}', 'deferred-item: {"title": "add retries", "scope": "M"}'].join("\n"));
		assert.equal(items.length, 1, "case-insensitive title dedup keeps the first");
		assert.equal(items[0].title, "Add retries");
	});

	it("accepts deps as a JSON array (not just a CSV string) (#353)", () => {
		const arr = parseDeferredItems('deferred-item: {"title": "Slice B", "deps": ["TOOL-99", " TOOL-100 ", ""]}');
		assert.deepEqual(arr, [{ title: "Slice B", deps: ["TOOL-99", "TOOL-100"], deferred: true }]);
		const csv = parseDeferredItems('deferred-item: {"title": "Slice C", "deps": "A, B"}');
		assert.deepEqual(csv[0].deps, ["A", "B"]);
	});

	it("dedups across call sites via a shared seen set (plan + shakedown both parse) (#353)", () => {
		const seen = new Set<string>();
		const plan = parseDeferredItems('deferred-item: {"title": "Shared slice", "scope": "M"}', seen);
		assert.equal(plan.length, 1, "first (plan) parse creates it");
		// The same marker echoed in the shakedown text must NOT create a second item.
		const shakedown = parseDeferredItems('deferred-item: {"title": "shared slice"}\ndeferred-item: {"title": "New one"}', seen);
		assert.deepEqual(
			shakedown.map((i) => i.title),
			["New one"],
			"already-seen title is skipped; only the genuinely-new one is created",
		);
	});
});

describe("parsePickResult", () => {
	it("accepts the already-claimed tag (issue #12 race loser)", () => {
		assert.equal(parsePickResult("pick-result: already-claimed"), "already-claimed");
	});

	it("returns null when no tag is present", () => {
		assert.equal(parsePickResult("nothing to see here"), null);
	});

	it("parses claimed", () => {
		assert.equal(parsePickResult("done\npick-result: claimed\n"), "claimed");
	});

	it("parses blocked", () => {
		assert.equal(parsePickResult("pick-result: blocked"), "blocked");
	});

	it("parses unknown-id", () => {
		assert.equal(parsePickResult("pick-result: unknown-id"), "unknown-id");
	});

	it("parses already-done", () => {
		assert.equal(parsePickResult("pick-result: already-done"), "already-done");
	});

	it("parses worktree-exists", () => {
		assert.equal(parsePickResult("pick-result: worktree-exists"), "worktree-exists");
	});

	it("parses queue-empty", () => {
		assert.equal(parsePickResult("pick-result: queue-empty"), "queue-empty");
	});

	it("parses stale-quarantined (#217)", () => {
		assert.equal(parsePickResult("pick-result: stale-quarantined"), "stale-quarantined");
	});

	it("last occurrence wins", () => {
		const text = "pick-result: queue-empty\nsome summary...\npick-result: claimed\n";
		assert.equal(parsePickResult(text), "claimed");
	});

	it("tolerates leading/trailing whitespace", () => {
		assert.equal(parsePickResult("   pick-result:  blocked   "), "blocked");
	});

	it("is case-insensitive on the key", () => {
		assert.equal(parsePickResult("PICK-RESULT: claimed"), "claimed");
	});

	it("returns null for unknown tag", () => {
		assert.equal(parsePickResult("pick-result: bogus"), null);
	});
});

describe("parsePickItem", () => {
	it("parses a plain ID", () => {
		assert.equal(parsePickItem("pick-item: TOOL-9"), "TOOL-9");
	});

	it("parses a nested/hierarchical ID", () => {
		assert.equal(parsePickItem("pick-item: COMP-11C-II"), "COMP-11C-II");
	});

	it("parses a bare-numeric github issue ID — the authoritative marker must win over free text (#332)", () => {
		assert.equal(parsePickItem("Requested issue 286.\npick-item: 337\npick-result: claimed"), "337");
		assert.equal(parsePickItem("pick-item: 286"), "286");
	});

	it("returns null when absent", () => {
		assert.equal(parsePickItem("nothing to see here"), null);
	});

	it("last occurrence wins when repeated", () => {
		const text = "pick-item: TOOL-1\nsummary...\npick-item: TOOL-2\n";
		assert.equal(parsePickItem(text), "TOOL-2");
	});

	it("rejects malformed values", () => {
		assert.equal(parsePickItem("pick-item: foo bar"), null);
		assert.equal(parsePickItem("pick-item: lowercase-99"), null);
		assert.equal(parsePickItem("pick-item: "), null);
	});
});
