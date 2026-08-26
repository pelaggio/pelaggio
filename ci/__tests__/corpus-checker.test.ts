import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const dir = resolve(repo, "docs/agent-context/data/corpus");
const checker = resolve(dir, "check_corpus.py");
const corpus = resolve(dir, "corpus.json");

const run = (target: string) => spawnSync("python3", [checker, target], { encoding: "utf8" });

describe("successor corpus checker", () => {
	// The checker's rules — a constraint binds only the harness, an assumption carries exactly one of
	// wrongIf/revisitIf, a renderer never names a node the corpus lacks — were author-run and nothing
	// forced them, which by `guarded-actions.md` §8.2 makes them a diagnostic rather than a bound.
	// This is the chokepoint that makes them load-bearing. Scope is `corpus.json` only: the frozen
	// per-pass snapshots predate those rules and are expected to fail, which is why they are excluded
	// rather than grandfathered.
	it("passes clean on the live corpus", () => {
		const result = run(corpus);
		assert.equal(result.status, 0, `check_corpus.py failed:\n${result.stdout}${result.stderr}`);
		assert.match(result.stdout, /0 error\(s\), 0 warning\(s\)/);
	});

	it("is actually reachable — checker and corpus both exist at the paths this test pins", () => {
		// Without this, a rename would turn the test above into a silent no-op via a spawn error.
		assert.ok(existsSync(checker), "check_corpus.py is missing");
		assert.ok(existsSync(corpus), "corpus.json is missing");
	});

	it("fails closed on an invalid corpus", () => {
		// A gate that cannot fail is not a gate: prove the non-zero exit on a corpus the rules reject.
		const broken = resolve(repo, "docs/agent-context/data/corpus/corpus.p1.json");
		const result = run(broken);
		assert.notEqual(result.status, 0, "a snapshot predating the current rules must not pass");
	});
});
