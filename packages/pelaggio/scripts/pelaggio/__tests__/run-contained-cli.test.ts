import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRunContainedArgs, runContainedCli } from "../run-contained-cli.js";

describe("run-contained CLI", () => {
	it("parses command and self-test modes", () => {
		assert.deepEqual(parseRunContainedArgs(["--worktree", "/tmp/w", "--debug", "--", "node", "a"]), { worktree: "/tmp/w", debug: true, mode: { kind: "command", argv: ["node", "a"] } });
		assert.deepEqual(parseRunContainedArgs(["--self-test"], "/cwd"), { worktree: "/cwd", debug: false, mode: { kind: "self-test" } });
	});

	it("rejects malformed and ambiguous arguments", () => {
		assert.throws(() => parseRunContainedArgs(["node"]), /unknown option/);
		assert.throws(() => parseRunContainedArgs(["--debug"]), /requires --/);
		assert.throws(() => parseRunContainedArgs(["--self-test", "--", "node"]), /cannot be combined/);
		assert.throws(() => parseRunContainedArgs(["--"]), /missing command/);
	});

	it("prints JSON and propagates command/self-test status", async () => {
		let output = "";
		assert.equal(
			await runContainedCli(["--", "node"], {
				run: async () => ({ status: 7, signal: null, writeSet: [] }),
				stdout: (text) => {
					output += text;
				},
			}),
			7,
		);
		assert.deepEqual(JSON.parse(output), { status: 7, signal: null, writeSet: [] });
		assert.equal(await runContainedCli(["--self-test"], { selfTest: async () => ({ passed: false, probes: [] }), stdout: () => undefined }), 1);
	});
});
