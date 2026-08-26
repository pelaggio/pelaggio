import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const dir = resolve(repo, "docs/agent-context/data/corpus");
const checker = resolve(dir, "check_corpus.py");
const corpusPath = resolve(dir, "corpus.json");

const run = (target: string) => spawnSync("python3", [checker, target], { encoding: "utf8" });
const corpus = () => JSON.parse(readFileSync(corpusPath, "utf8"));

/** Write a mutated corpus to a scratch path and check it. */
function check(mutate: (c: Record<string, never>) => void) {
	const value = corpus();
	mutate(value);
	const path = join(mkdtempSync(join(tmpdir(), "corpus-")), "corpus.json");
	writeFileSync(path, JSON.stringify(value));
	return run(path);
}

const constraint = (c) => c.nodes.find((n) => n.role === "constraint");
const assumption = (c) => c.nodes.find((n) => n.role === "assumption");

describe("successor corpus checker", () => {
	// `check_corpus.py` was invoked by nothing — not the workflow, not a package script, not a
	// test — so every rule it enforces held only when an author remembered to run it. By
	// `guarded-actions.md` §8.2 that is a diagnostic, not a bound. This is the chokepoint.
	it("passes clean on the live corpus", () => {
		const result = run(corpusPath);
		assert.equal(result.status, 0, `check_corpus.py failed:\n${result.stdout}${result.stderr}`);
		assert.match(result.stdout, /0 error\(s\), 0 warning\(s\)/);
	});

	it("is reachable — checker and corpus resolve at the paths this test pins", () => {
		// Without this a rename turns every assertion here into a silent spawn failure.
		assert.ok(existsSync(checker), "check_corpus.py is missing");
		assert.ok(existsSync(corpusPath), "corpus.json is missing");
	});

	// Each rule is injected individually. Asserting only that SOME invalid corpus exits non-zero
	// would pass while any single rule silently stopped firing.
	const violations: [string, (c) => void, RegExp][] = [
		["constraint without binds", (c) => delete constraint(c).binds, /without `binds`/],
		["constraint binding the callee", (c) => (constraint(c).binds = "callee"), /binds 'callee'/],
		["binds on a non-constraint", (c) => (c.nodes.find((n) => n.role === "invariant").binds = "harness"), /only a constraint carries `binds`/],
		[
			"assumption with no condition",
			(c) => {
				const a = assumption(c);
				delete a.wrongIf;
				delete a.revisitIf;
			},
			/neither a wrongIf nor a revisitIf/,
		],
		[
			"assumption with both conditions",
			(c) => {
				const a = assumption(c);
				a.wrongIf = "x";
				a.revisitIf = "y";
			},
			/carries both wrongIf and revisitIf/,
		],
		["duplicate node id", (c) => c.nodes.push({ ...c.nodes[0] }), /duplicate node id/],
		["edge endpoint that is not a node", (c) => (c.edges[0].to = "INV-99"), /not a corpus node|target not a corpus node/],
		["causal language outside an assumption", (c) => (constraint(c).statement += " This reduces cost."), /causal-outcome language/],
		["a retired id cited in prose", (c) => (c.authority += " see CON-99"), /prose names CON-99/],
	];

	for (const [label, mutate, expected] of violations) {
		it(`fails closed on ${label}`, () => {
			const result = check(mutate);
			assert.notEqual(result.status, 0, `expected a non-zero exit for ${label}`);
			assert.match(result.stdout, expected);
		});
	}
});
