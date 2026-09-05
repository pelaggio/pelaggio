import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExample, digest, exampleDir } from "../scripts/example.js";

function withCapture(run: (directory: string) => void) {
	const directory = mkdtempSync(join(tmpdir(), "site-capture-"));
	try {
		cpSync(exampleDir, directory, { recursive: true });
		run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
test("both scenarios publish exact captured bytes", () => {
	const example = createExample();
	assert.deepEqual(
		example.scenarios.map((s) => s.id),
		["csv", "import"],
	);
	for (const artifact of example.receipt.artifacts) assert.equal(artifact.sha256, digest(example.files[artifact.path]!));
	assert.deepEqual(createExample(), example);
});
test("altering a plan without updating its source receipt fails the build", () =>
	withCapture((directory) => {
		writeFileSync(join(directory, "csv/plan.md"), "Unrecorded replacement");
		assert.throws(() => createExample(directory), /capture digest mismatch/);
	}));
test("baseline results never substitute for missing candidate evidence", () =>
	withCapture((directory) => {
		const path = join(directory, "manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		manifest.scenarios.csv.artifacts = manifest.scenarios.csv.artifacts.filter((a: { path: string }) => a.path !== "csv/candidate-checks.json");
		writeFileSync(path, JSON.stringify(manifest));
		assert.equal(createExample(directory).scenarios[0]!.evaluation, null);
	}));
test("candidate checks must identify the displayed revision", () =>
	withCapture((directory) => {
		const path = join(directory, "manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		const bytes = JSON.stringify({ revision: "0".repeat(40), passed: true, cases: [] });
		writeFileSync(join(directory, "csv/candidate-checks.json"), bytes);
		manifest.scenarios.csv.artifacts = manifest.scenarios.csv.artifacts.filter((a: { path: string }) => a.path !== "csv/candidate-checks.json");
		manifest.scenarios.csv.artifacts.push({ path: "csv/candidate-checks.json", sha256: digest(bytes) });
		writeFileSync(path, JSON.stringify(manifest));
		assert.throws(() => createExample(directory), /checks must identify the captured candidate/);
	}));

test("a failing check cannot become a passing summary", () =>
	withCapture((directory) => {
		const path = join(directory, "manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		const bytes = JSON.stringify({ revision: manifest.scenarios.csv.candidateRevision, passed: true, cases: [{ name: "Export all rows", result: "fail" }] });
		writeFileSync(join(directory, "csv/candidate-checks.json"), bytes);
		manifest.scenarios.csv.artifacts = manifest.scenarios.csv.artifacts.filter((a: { path: string }) => a.path !== "csv/candidate-checks.json");
		manifest.scenarios.csv.artifacts.push({ path: "csv/candidate-checks.json", sha256: digest(bytes) });
		writeFileSync(path, JSON.stringify(manifest));
		assert.throws(() => createExample(directory), /check summary must agree/);
	}));

test("completed execution without a successful local ship remains a candidate", () =>
	withCapture((directory) => {
		const path = join(directory, "manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(createExample(directory).scenarios[0]!.status, "Delivered locally");
		manifest.scenarios.csv.latestOutcome.steps = manifest.scenarios.csv.latestOutcome.steps.filter((step: { name: string }) => step.name !== "ship");
		writeFileSync(path, JSON.stringify(manifest));
		assert.equal(createExample(directory).scenarios[0]!.status, "Candidate preserved");
	}));
