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
		joe: "The list’s filter, not the page you’re on. Unknown status keeps the header and writes nothing — they didn’t 400 it. Every field quoted, header left bare.",
		acceptance: ["All matching rows, any page", "CSV round-trip, including punctuation", "Browser uses the current filter", "Store unchanged"],
		bounds: "No auth · UTF-8 CSV, not spreadsheet apps",
		forks: [
			{ fork: "Status-query semantics", taken: "Exact-match, as the list. Unknown → header-only 200.", notTaken: "Reject unknown status with 400." },
			{ fork: "Field quoting", taken: "Quote every data field; leave the header unquoted.", notTaken: "Quote only when a field contains comma, quote, or a break." },
		],
		run: {
			elapsed: "37 min",
			attempts: 4,
			steps: [
				{ name: "shakedown-plan", provider: "grok", model: "grok-code-fast-1", turns: 6, tokensIn: 48120, tokensOut: 2140, cost: 0.18 },
				{ name: "implement", provider: "codex", model: "gpt-5-codex", turns: 14, tokensIn: 126400, tokensOut: 8420, cost: 0.42 },
				{ name: "shakedown-code", provider: "grok", model: "grok-code-fast-1", turns: 8, tokensIn: 71880, tokensOut: 3210, cost: 0.24 },
				{ name: "ship", provider: "grok", model: "grok-code-fast-1", turns: 4, tokensIn: 30650, tokensOut: 1080, cost: 0.08 },
			],
			constraints: ["Shakedown used a different provider than implement.", "Shipped to a local git remote, not a GitHub pull request.", "Grok ran with unsandboxed fallback — no Landlock on the host."],
		},
	},
	import: {
		label: "Interrupted import",
		request: "Let me resume an interrupted import without starting over or duplicating the work.",
		context: "The app saves each imported record. Restarting the original importer duplicates records already saved.",
		charter: "Restart the same command without duplicates. Preserve existing records and report conflicting content explicitly.",
		plan: "The plan uses stored records and their IDs as progress evidence. It compares complete records and checks conflicts before writing new rows.",
		decision: "It chooses the existing store over a separate checkpoint journal. The boundary is one writer and process interruption.",
		result: "The independent checks kill an import after partial progress, restart it, repeat a completed import, and exercise conflicting and invalid input.",
		joe: "Same command after a kill, keyed off the records already there — not a journal. Conflicts named before any write. If the ids were already dirty, it stops and leaves the store.",
		acceptance: ["Same command after a kill, no duplicates", "Completed import is idempotent", "Conflicts named before any write", "Malformed input fails before writes"],
		bounds: "One writer · Process interrupt, not power loss or two processes",
		forks: [
			{ fork: "Restart identity", taken: "Persisted records, indexed by stable id.", notTaken: "Source hash and a separate checkpoint journal." },
			{ fork: "Conflict timing", taken: "Preflight all conflicts before writing.", notTaken: "Stop at the first conflict during incremental commits." },
			{ fork: "Pre-existing duplicate ids", taken: "Fail visibly; leave the store for repair.", notTaken: "Collapse equals, or migrate existing data." },
		],
		run: {
			elapsed: "38 min",
			attempts: 4,
			steps: [
				{ name: "shakedown-plan", provider: "grok", model: "grok-code-fast-1", turns: 7, tokensIn: 54310, tokensOut: 2680, cost: 0.21 },
				{ name: "implement", provider: "codex", model: "gpt-5-codex", turns: 16, tokensIn: 141200, tokensOut: 9760, cost: 0.51 },
				{ name: "shakedown-code", provider: "grok", model: "grok-code-fast-1", turns: 9, tokensIn: 80640, tokensOut: 3580, cost: 0.28 },
				{ name: "ship", provider: "grok", model: "grok-code-fast-1", turns: 4, tokensIn: 28940, tokensOut: 940, cost: 0.07 },
			],
			constraints: ["Shakedown used a different provider than implement.", "Shipped to a local git remote, not a GitHub pull request.", "Grok ran with unsandboxed fallback — no Landlock on the host."],
		},
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
			runEvidence:
				"Illustrative meter: model names, wall clock, attempt count, tokens, turns, and costs below are authored examples, not measurements from this capture. The saved attempts record unpinned models and no token, turn, or cost measurements.",
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
