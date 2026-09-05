import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const exampleDir = resolve(root, "experiments/model-delivery/captures/2026-09-05-completed");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type Artifact = { path: string; sha256: string };
type Step = { name: string; provider: string; ok: boolean; subtype?: string; detail?: string; outputTail?: string };
type Attempt = { outcome: string; reason?: string; steps: Step[] };
type Evaluation = { revision: string; passed: boolean; cases: { name: string; result: string }[] };
type Capture = { harnessSha: string; shippingMode: string; operatorInterventions: string[]; scenarios: Record<string, { candidateRevision: string; latestOutcome: Attempt; artifacts: Artifact[] }> };
const stories = {
	csv: {
		label: "CSV export",
		request: "Let me export the filtered work list as CSV.",
		context: "The app already filters by status and shows ten rows per page.",
		charter: "Export every matching row, including later pages. Preserve text and order. Keep the header when nothing matches.",

		plan: "The plan reuses the list’s filtering logic and adds a native download link. Its URL updates as soon as the selection changes.",
		decision: "It preserves the existing exact-match filter semantics. Unknown status values produce an empty export with a header.",

		result: "The independent checks exercise all 23 matching rows across pages, CSV text round-tripping, and downloads after changing the filter.",
	},
	import: {
		label: "Interrupted import",
		request: "Let me resume an interrupted import without starting over or duplicating the work.",
		context: "The app saves each imported record. Restarting the original importer duplicates records already saved.",
		charter: "Restart the same command without duplicates. Preserve existing records and report conflicting content explicitly.",

		plan: "The plan uses stored records and their IDs as progress evidence. It compares complete records and checks conflicts before writing new rows.",
		decision: "It chooses the existing store over a separate checkpoint journal. The boundary is one writer and process interruption.",

		result: "The independent checks kill an import after partial progress, restart it, repeat a completed import, and exercise conflicting and invalid input.",
	},
};
export function createExample(directory = exampleDir) {
	const capture: Capture = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
	const files: Record<string, string> = { "capture.json": readFileSync(resolve(directory, "manifest.json"), "utf8") };
	const scenarios = Object.entries(stories).map(([id, story]) => {
		const record = capture.scenarios[id];
		assert.ok(record, `missing ${id} capture`);
		assert.match(record.candidateRevision, /^[a-f0-9]{40}$/);
		for (const artifact of record.artifacts) {
			assert.ok(artifact.path.startsWith(`${id}/`) && !artifact.path.split("/").includes(".."), "artifact must stay in its scenario");
			const bytes = readFileSync(resolve(directory, artifact.path), "utf8");
			assert.equal(digest(bytes), artifact.sha256, `capture digest mismatch: ${artifact.path}`);
			files[artifact.path] = bytes;
		}
		for (const name of ["charter.md", "plan.md", "attempts.json", "baseline-checks.json"]) assert.ok(files[`${id}/${name}`], `missing ${id}/${name}`);
		const attempts: Attempt[] = JSON.parse(files[`${id}/attempts.json`]!);
		const evaluation: Evaluation | null = files[`${id}/candidate-checks.json`] ? JSON.parse(files[`${id}/candidate-checks.json`]!) : null;
		if (evaluation) {
			assert.equal(evaluation.revision, record.candidateRevision, "checks must identify the captured candidate");
			assert.equal(evaluation.passed, evaluation.cases.length > 0 && evaluation.cases.every((check) => check.result === "pass"), "check summary must agree with case results");
		}
		const steps = attempts.flatMap((attempt) => attempt.steps);
		const implemented = steps.some((step) => step.name === "implement" && step.ok);
		const latest = record.latestOutcome;
		const shipped = latest.outcome === "completed" && latest.steps.some((step) => step.name === "ship" && step.ok && /ship-merged: ITEM-1\b/.test(step.outputTail ?? ""));
		const status = shipped ? "Delivered locally" : implemented ? "Candidate preserved" : "Stopped before implementation";
		return {
			id,
			...story,
			revision: record.candidateRevision,
			status,
			implemented,
			shipped,
			evaluation,
			attempts,
			artifacts: record.artifacts,
			planText: files[`${id}/plan.md`]!,
			charterText: files[`${id}/charter-input.md`] ?? files[`${id}/charter.md`]!,
			charterPath: files[`${id}/charter-input.md`] ? `${id}/charter-input.md` : `${id}/charter.md`,

			handoff: shipped ? "The pipeline reports local delivery. Read the checks and remaining limits before drawing conclusions about the change." : "The run stopped before delivery. Its history preserves the reason and the work so far.",
		};
	});
	const receipt = {
		kind: "site-model-execution-capture",
		harnessSha: capture.harnessSha,
		shippingMode: capture.shippingMode,
		operatorInterventions: capture.operatorInterventions,
		artifacts: Object.entries(files).map(([path, bytes]) => ({ path, sha256: digest(bytes) })),
	};
	return { scenarios, receipt, files };
}
export async function writeExample() {
	const example = createExample();
	const output = resolve(root, "packages/site/public/example");
	rmSync(output, { recursive: true, force: true });
	mkdirSync(output, { recursive: true });
	cpSync(resolve(root, "docs/ai-delivery/v0.1"), resolve(root, "packages/site/public/ai-delivery/v0.1"), { recursive: true });
	for (const [name, bytes] of Object.entries({ ...example.files, "view.json": json(example), "receipt.json": json(example.receipt) })) {
		mkdirSync(dirname(resolve(output, name)), { recursive: true });
		writeFileSync(resolve(output, name), bytes);
	}
	return example;
}
