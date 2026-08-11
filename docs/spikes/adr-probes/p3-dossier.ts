#!/usr/bin/env tsx

/**
 * P3 — Change Dossier assembler (throwaway spike scaffolding).
 *
 * Assembles source provenance for one item from DURABLE artifacts only, and classifies each of the
 * twelve questions G requires the dossier to answer:
 *
 *   durable      — answered from local append-only/content-addressed state
 *   mutable-join — answerable only by reading provider sessions, GitHub, or another mutable source
 *   unanswerable — no artifact carries it
 *
 * The classification IS the probe: G's falsification signal is "answering basic provenance questions
 * requires mutable joins". Nothing here stores transcripts; where a transcript would be the only
 * source, the answer is recorded as unanswerable rather than solved by storing one.
 *
 * Run: npx tsx docs/spikes/adr-probes/p3-dossier.ts --item <id> [--repo <mainRepo>] [--json]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { item: { type: "string" }, repo: { type: "string" }, json: { type: "boolean" } } });
const item = values.item ?? "";
const repo = resolve(values.repo ?? "/home/chris/workspace/pelaggio");

type Source = "durable" | "mutable-join" | "unanswerable";
interface Answer {
	question: string;
	source: Source;
	from: string;
	value: unknown;
}

function cycleRecords(): Record<string, any>[] {
	const path = resolve(repo, ".dev/pelaggio-log.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		})
		.filter((r) => String(r.item ?? "") === item);
}

function attemptRecords(): string[] {
	const dir = resolve(repo, ".dev/attempts", item.toLowerCase().replace(/[^a-z0-9._-]+/gi, "-"));
	// `<n>.json` are the attempt records; `.marks/<n>` are empty O_EXCL high-water marks. Counting
	// the directory wholesale counts the marks dir as an attempt and over-reports by one.
	return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
}

/**
 * `ExecutionReceiptDescriptor.path` is **worktree-relative** (`types.ts:67`), and every pipeline
 * item works in a sibling worktree — so resolving it under the main repo reports `present: false`
 * for every receipt regardless of the truth. An earlier revision of this probe did exactly that,
 * and the resulting "0 present on disk" was read as evidence that the receipt join was broken
 * before worktree destruction. It was an instrument artifact; the receipts were where their
 * contract says they are. Resolve against the item worktree first, then the main repo.
 */
function receipts(records: Record<string, any>[], worktree: string | null): { step: string; path: string; sha256: string; present: boolean; root: string | null }[] {
	return records
		.flatMap((r) => (r.steps ?? []).map((s: any) => ({ step: s.name, receipt: s.executionReceipt })))
		.filter((s) => s.receipt)
		.map((s) => {
			const roots = [worktree, repo].filter((r): r is string => !!r);
			const root = roots.find((r) => existsSync(resolve(r, s.receipt.path))) ?? null;
			return { step: s.step, path: s.receipt.path, sha256: s.receipt.sha256, present: root !== null, root };
		});
}

/** The item worktree, if it still exists — receipts and review records live under it, not main. */
function itemWorktree(): string | null {
	const guess = resolve(repo, "..", `pelaggio-${item.toLowerCase()}`);
	return existsSync(guess) ? guess : null;
}

const records = cycleRecords();
const last = records[records.length - 1];
// Lineage spans EVERY cycle record for the item, not just the last. Reading only the final record
// silently drops failed and superseded attempts — the exact conflation F is about, in the probe
// that measures F. `last` is retained only where the question is genuinely about the final state.
const steps: any[] = records.flatMap((r: any) => r.steps ?? []);
const attempts = attemptRecords();
const worktree = itemWorktree();
const rcpts = receipts(records, worktree);

const answers: Answer[] = [
	// The charter lives in the roadmap adapter's store (a GitHub issue here), which is mutable and
	// editable after the fact. Nothing copies it into the lineage at claim time.
	{ question: "why did this work exist / what was chartered?", source: "mutable-join", from: "roadmap adapter (GitHub issue body) — not captured into lineage", value: null },
	{ question: "what context and skill were supplied?", source: "unanswerable", from: "skill bodies are expanded into the prompt; no prompt or skill digest is recorded per step", value: null },
	{ question: "which Agent Driver / provider / model acted?", source: "durable", from: ".dev/pelaggio-log.jsonl steps[].provider/.model + provenance.drivers", value: steps.map((s) => `${s.name}:${s.provider}/${s.model ?? "default"}`) },
	{ question: "under what authority / sandbox profile?", source: "unanswerable", from: "no authority profile is declared or recorded per step (see P2)", value: null },
	{ question: "what did each step and attempt produce?", source: "durable", from: "steps[].filesChanged + executionReceipt", value: steps.map((s) => ({ step: s.name, files: s.filesChanged ?? null, receipt: s.executionReceipt?.sha256?.slice(0, 12) ?? null })) },
	{ question: "what deterministic checks ran?", source: "unanswerable", from: "check invocations are inside step execution; no typed record of which gates ran", value: null },
	// Gate records are keyed `<pr>-<headSha>` and carry `itemId`; an unfiltered COUNT of every record
	// in the store answers nothing about this item and would report unrelated reviews as evidence.
	// Select by itemId, and report what the records actually carry: a gate disposition, not findings.
	// Findings live in the rendered PR comment (mutable), so the resolution half stays a mutable-join.
	(() => {
		const dir = resolve(repo, ".dev/pr-review-gate-records");
		const mine = existsSync(dir)
			? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(readFileSync(resolve(dir, f), "utf8")); } catch { return null; } }).filter((r: any) => r && String(r.itemId) === item)
			: [];
		return {
			question: "what did reviewers find, and how were findings fixed/refuted?",
			source: (mine.length > 0 ? "mutable-join" : "unanswerable") as Source,
			from: mine.length > 0 ? ".dev/pr-review-gate-records carries the DISPOSITION for this item; the findings and their resolution live only in the rendered PR comment" : "no gate record for this item",
			value: mine.map((r: any) => ({ pr: r.prNumber, head: String(r.headSha ?? "").slice(0, 7), gate: r.gate, survivors: r.survivorCount })),
		};
	})(),
	// Split deliberately: park CAUSE became durable with #457, but ATTEMPT LINEAGE (supersession,
	// which attempt produced which output) needs the #467 registry. An item that ran before it has
	// the former and not the latter, so one verdict for both would be wrong in one direction.
	{ question: "what parks/retries occurred, and why?", source: records.some((r) => r.parked !== undefined) ? "durable" : "unanswerable", from: ".dev/pelaggio-log.jsonl record.parked/parkReason (#457)", value: records.map((r) => ({ cycle: r.cycle, parked: r.parked ?? false, reason: r.parkReason ?? null })) },
	{ question: "what attempt lineage / supersession occurred?", source: attempts.length > 0 ? "durable" : "unanswerable", from: attempts.length > 0 ? ".dev/attempts/<item>/ registry (#467)" : "no attempt registry for this item — predates #467, so supersession is unrecoverable", value: attempts },
	{ question: "why was the final candidate authorized to land?", source: "mutable-join", from: "branch-protection status checks on GitHub — not mirrored into lineage", value: null },
	{ question: "what exact commit/tree resulted?", source: "durable", from: "provenance.git (branch, mainShaAtStart, worktree)", value: last?.provenance?.git ?? null },
	{ question: "what did it cost?", source: "durable", from: "sum of every cycle record's total_cost for this item — NOT the last record only", value: { total: records.reduce((sum: number, r: any) => sum + (r.total_cost ?? 0), 0), estimated: records.some((r: any) => r.costEstimated), cycles: records.length } },
	{ question: "what semantic surfaces were reconciled?", source: "unanswerable", from: "no reconciliation capability exists (K is unimplemented)", value: null },
];

const tally = answers.reduce<Record<Source, number>>((acc, a) => ({ ...acc, [a.source]: (acc[a.source] ?? 0) + 1 }), { durable: 0, "mutable-join": 0, unanswerable: 0 });

const dossier = {
	item,
	assembledFrom: { cycleRecords: records.length, steps: steps.length, attemptRecords: attempts.length, executionReceipts: rcpts },
	transcriptsStored: false,
	answers,
	tally,
};

if (values.json) console.log(JSON.stringify(dossier, null, 2));
else {
	console.log(`\n  P3 — Change Dossier for item ${item}\n  ${"-".repeat(76)}`);
	console.log(`  cycle records: ${records.length}   steps: ${steps.length}   attempts: ${attempts.length}   receipts: ${rcpts.length} (${rcpts.filter((r) => r.present).length} present on disk)`);
	for (const a of answers) console.log(`  [${a.source.padEnd(12)}] ${a.question}\n${" ".repeat(17)}← ${a.from}`);
	console.log(`\n  durable ${tally.durable} / mutable-join ${tally["mutable-join"]} / unanswerable ${tally.unanswerable}\n`);
}
