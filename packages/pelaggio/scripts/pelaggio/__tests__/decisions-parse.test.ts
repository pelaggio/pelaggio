import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDecisions } from "../decisions.js";

describe("parseDecisions", () => {
	it("retains tolerant, ordered sentinels and parses canonical segments", () => {
		assert.deepEqual(parseDecisions("tool DECISION: ignored\n  DECISION: storage fork | chose: files | alternatives: sqlite | remote\nDECISION:\n decision: lower"), [
			{ fork: "storage fork", chosen: "files", alternatives: "sqlite | remote" },
			{ fork: "(unspecified decision)" },
		]);
	});

	it("keeps partial and non-final sentinels", () => {
		assert.deepEqual(parseDecisions("DECISION: first | chose: yes\nmore text\nDECISION: malformed | pipe"), [{ fork: "first", chosen: "yes" }, { fork: "malformed | pipe" }]);
	});
});
