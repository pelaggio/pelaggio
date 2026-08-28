import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const dir = resolve(repo, "docs/agent-context/data/corpus");
const checker = resolve(dir, "check_corpus.py");
const corpusPath = resolve(dir, "corpus.json");
const renderMd = resolve(dir, "render_md.py");
const renderCorpus = resolve(dir, "render_corpus.py");
const corpusCss = resolve(dir, "corpus.css");

const htmlEscape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

const renderers = [
	{
		path: renderMd,
		constraintStart: "## Constraints",
		constraintEnd: "## Assumptions",
		encodeStatement: (value: string) => value,
	},
	{
		path: renderCorpus,
		constraintStart: "<h2>Constraints</h2>",
		constraintEnd: "<h2>Assumptions</h2>",
		encodeStatement: htmlEscape,
	},
];

type Renderer = (typeof renderers)[number];

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

function constraintSection(emitted: string, renderer: Renderer) {
	const start = emitted.indexOf(renderer.constraintStart);
	assert.notEqual(start, -1, `constraint heading missing from ${renderer.path} output`);
	const end = emitted.indexOf(renderer.constraintEnd, start + renderer.constraintStart.length);
	assert.notEqual(end, -1, `heading after constraints missing from ${renderer.path} output`);
	return emitted.slice(start, end);
}

function assertConstraintsProjected(renderer: Renderer) {
	const outputPath = join(mkdtempSync(join(tmpdir(), "corpus-render-")), "out");
	const result = spawnSync("python3", [renderer.path, corpusPath, outputPath], { encoding: "utf8" });
	assert.equal(result.status, 0, `renderer failed:\n${result.stdout}${result.stderr}`);

	const section = constraintSection(readFileSync(outputPath, "utf8"), renderer);
	const liveCorpus = corpus();
	const polarityConstraint = liveCorpus.nodes.find((node) => node.id === "CON-30");
	assert.ok(polarityConstraint, "CON-30 is missing from the live corpus");
	assert.match(section, /\bCON-30\b/, `CON-30 missing from ${renderer.path} Constraints section`);
	assert.ok(section.includes(renderer.encodeStatement(polarityConstraint.statement)), `CON-30 statement missing from ${renderer.path} Constraints section`);

	for (const id of liveCorpus.nodes.filter((node) => node.role === "constraint").map((node) => node.id)) {
		assert.match(section, new RegExp(`\\b${id}\\b`), `${id} missing from ${renderer.path} Constraints section`);
	}
}

function withoutConstraintSelection(renderer: Renderer): Renderer {
	const scratch = mkdtempSync(join(tmpdir(), "corpus-render-mutant-"));
	copyFileSync(checker, join(scratch, "check_corpus.py"));
	copyFileSync(corpusCss, join(scratch, "corpus.css"));
	const source = readFileSync(renderer.path, "utf8");
	const selector = 'by("proposition", "constraint")';
	assert.equal(source.split(selector).length - 1, 1, `expected one constraint selector in ${renderer.path}`);
	const mutatedPath = join(scratch, "renderer.py");
	writeFileSync(mutatedPath, source.replace(selector, "[]"));
	return { ...renderer, path: mutatedPath };
}

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
		assert.ok(existsSync(renderMd), "render_md.py is missing");
		assert.ok(existsSync(renderCorpus), "render_corpus.py is missing");
	});

	it("both renderers project every live constraint id", () => {
		for (const renderer of renderers) {
			assertConstraintsProjected(renderer);
		}
	});

	it("fails when either renderer drops its constraint selection", () => {
		for (const renderer of renderers) {
			assert.throws(() => assertConstraintsProjected(withoutConstraintSelection(renderer)), /CON-30 missing from .* Constraints section/);
		}
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
		// Both guards read node statements only, so the corpus's own `scope` and `note` sat outside
		// them — `scope.doesNotClaim` was carrying "reduce blast radius" past the thesis guard.
		["causal language in scope", (c) => (c.scope.doesNotClaim += " This reduces risk."), /scope\.doesNotClaim: causal-outcome/],
		["causal language in a top-level note", (c) => (c.note += " It improves recall."), /note: causal-outcome/],
		// The id regex was narrowed to two digits to spare foreign refs, which blinded it to a
		// permitted three-digit id. Zero-padding is the discriminator, not length.
		["a retired three-digit id", (c) => (c.authority += " see INV-100"), /prose names INV-100/],
	];

	// The same narrowing must not resume flagging the antecedent repo's ids, which `sources` exists
	// to carry — a guard that rejects the field built for external references is worse than none.
	const permitted: [string, (c) => void][] = [
		["a zero-padded foreign id in sources", (c) => c.nodes[0].sources.push("pelaggio CON-0003")],
		["a zero-padded foreign id in authority", (c) => (c.authority += " see pelaggio DEC-0012")],
	];

	for (const [label, mutate, expected] of violations) {
		it(`fails closed on ${label}`, () => {
			const result = check(mutate);
			assert.notEqual(result.status, 0, `expected a non-zero exit for ${label}`);
			assert.match(result.stdout, expected);
		});
	}

	for (const [label, mutate] of permitted) {
		it(`still admits ${label}`, () => {
			const result = check(mutate);
			assert.equal(result.status, 0, `expected a clean exit for ${label}:\n${result.stdout}`);
		});
	}
});
