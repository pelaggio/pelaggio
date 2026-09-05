import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIT_PROMPT, INIT_COMMAND, RUN_COMMAND } from "../src/lib/copy.ts";

describe("landing copy", () => {
	it("leads install with npx, not a workspace command", () => {
		assert.equal(INIT_COMMAND, "npx pelaggio init");
		assert.equal(RUN_COMMAND, "npx pelaggio run --cycles 1 --verbose");
		assert.match(FIT_PROMPT, /Do not start a cycle/);
		assert.match(FIT_PROMPT, /quality rubric/);
		assert.doesNotMatch(FIT_PROMPT, /\bpnpm pelaggio\b/);
	});
});
