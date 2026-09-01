/**
 * Landing-cost baseline over the local fleet gate records in `.dev/pr-review-gate-records/`.
 *
 * This is INSTRUMENTATION, not a check: it exits 0 regardless and prints a table. It exists so a
 * throughput claim about a process change (the assurance/assessment stack, `review.carry`, seat
 * parallelism) can be tested against a pre-change baseline instead of an impression.
 *
 * Every number here is per-ROLL evidence the harness already persisted. `cost` is the fleet's own
 * reported spend and is mostly notional against a subscription pool — read rolls and wall-clock as
 * the scarce resources, and cost as their proxy.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_FINDING_CLOSURES, type ReviewFindingClosure } from "../packages/pelaggio/scripts/pelaggio/review/findings.js";

export interface GateRecord {
	prNumber: number;
	itemId?: string;
	headSha: string;
	gate: string;
	ok: boolean;
	subtype?: string;
	agreement?: string;
	breakerReason?: string;
	iterations?: number;
	survivorCount?: number;
	cost?: number;
	costEstimated?: boolean;
	turns?: number;
	reviewedAt?: string;
	schemaVersion?: number;
	producer?: string;
	recurrenceFindings?: readonly { closure?: string }[];
}

export function repoRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadGateRecords(dir: string): GateRecord[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
	const records: GateRecord[] = [];
	for (const name of names) {
		try {
			records.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as GateRecord);
		} catch {
			/* a truncated record is evidence of a crashed roll, not a reason to fail the report */
		}
	}
	return records.sort((a, b) => (a.reviewedAt ?? "").localeCompare(b.reviewedAt ?? ""));
}

export interface PrRollup {
	prNumber: number;
	itemId?: string;
	rolls: number;
	distinctHeads: number;
	cost: number;
	passes: number;
	blocks: number;
	finalGate: string;
	finalSurvivors: number;
	agreements: Record<string, number>;
}

/** One row per PR. `distinctHeads` separates a genuine re-push (a repair round) from a re-roll of
 *  the SAME sha (an infra/quota retry) — conflating them overstates the repair rate. */
export function rollupByPr(records: readonly GateRecord[]): PrRollup[] {
	const byPr = new Map<number, GateRecord[]>();
	for (const r of records) {
		const list = byPr.get(r.prNumber);
		if (list) list.push(r);
		else byPr.set(r.prNumber, [r]);
	}
	return [...byPr.entries()]
		.map(([prNumber, rs]) => {
			const last = rs[rs.length - 1];
			const agreements: Record<string, number> = {};
			for (const r of rs) {
				const key = r.agreement ?? "unknown";
				agreements[key] = (agreements[key] ?? 0) + 1;
			}
			return {
				prNumber,
				...(last.itemId ? { itemId: last.itemId } : {}),
				rolls: rs.length,
				distinctHeads: new Set(rs.map((r) => r.headSha)).size,
				cost: rs.reduce((sum, r) => sum + (r.cost ?? 0), 0),
				passes: rs.filter((r) => r.gate === "pass").length,
				blocks: rs.filter((r) => r.gate === "block").length,
				finalGate: last.gate,
				finalSurvivors: last.survivorCount ?? 0,
				agreements,
			};
		})
		.sort((a, b) => b.cost - a.cost);
}

export interface Baseline {
	prs: number;
	rolls: number;
	totalCost: number;
	costPerRoll: number;
	rollsPerPr: number;
	singleRollPrs: number;
	repeatRollPrs: number;
	reachedPass: number;
	costPerPassingPr: number;
	survivorsPerBlock: number;
	agreements: Record<string, number>;
	/** Blocks whose breaker was `invalid-pass` while the record was structurally complete (ok=true):
	 *  the #525/#593 mislabel — a genuine verdict SPLIT riding the invalid channel. */
	mislabelledSplits: number;
	/** Classified confirmed-survivor observations only. Absence is not a fifth mode. */
	closureModes: Record<ReviewFindingClosure, number>;
}

export function summarize(records: readonly GateRecord[]): Baseline {
	const rollups = rollupByPr(records);
	const blocks = records.filter((r) => r.gate === "block");
	const totalCost = records.reduce((sum, r) => sum + (r.cost ?? 0), 0);
	const reachedPass = rollups.filter((r) => r.passes > 0).length;
	const agreements: Record<string, number> = {};
	for (const r of records) {
		const key = r.agreement ?? "unknown";
		agreements[key] = (agreements[key] ?? 0) + 1;
	}
	const div = (n: number, d: number): number => (d === 0 ? 0 : Number((n / d).toFixed(2)));
	const closureModes = Object.fromEntries(REVIEW_FINDING_CLOSURES.map((mode) => [mode, 0])) as Record<ReviewFindingClosure, number>;
	for (const r of records) {
		if (r.schemaVersion !== 2 || r.producer !== "fleet") continue;
		const observations = r.recurrenceFindings;
		if (!Array.isArray(observations)) continue;
		for (const observation of observations) {
			if (!observation || typeof observation !== "object") continue;
			const mode = observation.closure;
			if (typeof mode !== "string" || !(REVIEW_FINDING_CLOSURES as readonly string[]).includes(mode)) continue;
			closureModes[mode as ReviewFindingClosure] += 1;
		}
	}
	return {
		prs: rollups.length,
		rolls: records.length,
		totalCost: Number(totalCost.toFixed(2)),
		costPerRoll: div(totalCost, records.length),
		rollsPerPr: div(records.length, rollups.length),
		singleRollPrs: rollups.filter((r) => r.rolls === 1).length,
		repeatRollPrs: rollups.filter((r) => r.rolls > 1).length,
		reachedPass,
		costPerPassingPr: div(totalCost, reachedPass),
		survivorsPerBlock: div(
			blocks.reduce((sum, r) => sum + (r.survivorCount ?? 0), 0),
			blocks.length,
		),
		agreements,
		mislabelledSplits: records.filter((r) => r.ok && r.breakerReason === "invalid-pass" && r.agreement === "disagreement").length,
		closureModes,
	};
}

/** Stable CLI table rows. Existing rows stay in order; the closure row is appended. */
export function formatBaselineRows(s: Baseline): string {
	return [
		`  PRs gated                ${s.prs}`,
		`  rolls                    ${s.rolls}   (${s.rollsPerPr} per PR)`,
		`  single-roll / repeat     ${s.singleRollPrs} / ${s.repeatRollPrs}`,
		`  reached a pass           ${s.reachedPass} of ${s.prs}`,
		`  cost                     $${s.totalCost}   ($${s.costPerRoll}/roll, $${s.costPerPassingPr}/passing PR)`,
		`  survivors per block      ${s.survivorsPerBlock}`,
		`  agreement               ${Object.entries(s.agreements)
			.map(([k, v]) => ` ${k}=${v}`)
			.join("")}`,
		`  mislabelled splits       ${s.mislabelledSplits}  (ok=true + disagreement stamped invalid-pass)`,
		`  closure modes            patch=${s.closureModes.patch} construction=${s.closureModes.construction} authority=${s.closureModes.authority} policy=${s.closureModes.policy}   (classified confirmed-survivor observations)`,
	].join("\n");
}

/** Stable fingerprint of the exact corpus a number was computed from. A baseline that cannot name
 *  its inputs is not reproducible: this corpus grows while you work, and figures quoted from an
 *  earlier run silently stop matching a later one. */
export function corpusDigest(records: readonly GateRecord[]): string {
	const ids = records.map((r) => `${r.prNumber}-${r.headSha}`).sort();
	return `${ids.length}:${createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 12)}`;
}

function main(): void {
	const args = process.argv.slice(2);
	const untilFlag = args.indexOf("--until");
	// Freeze the cutoff to reproduce a published figure; omit it to measure the live corpus.
	const until = untilFlag === -1 ? undefined : args[untilFlag + 1];
	const dir = args.find((a) => !a.startsWith("--") && a !== until) ?? join(repoRoot(), ".dev", "pr-review-gate-records");
	const all = loadGateRecords(dir);
	const records = until === undefined ? all : all.filter((r) => (r.reviewedAt ?? "") < until);
	if (records.length === 0) {
		process.stdout.write(`no gate records under ${dir}\n`);
		return;
	}
	const s = summarize(records);
	const span = `${records[0].reviewedAt?.slice(0, 10)} → ${records[records.length - 1].reviewedAt?.slice(0, 10)}`;
	const digest = corpusDigest(records);
	process.stdout.write(`\nFleet gate baseline  (${span})\n  corpus ${digest}${until ? `  --until ${until}` : "  (live)"}\n${"─".repeat(72)}\n`);
	process.stdout.write(`${formatBaselineRows(s)}\n`);
	process.stdout.write(`\n  per PR (by cost)\n  ${"─".repeat(68)}\n`);
	process.stdout.write(`  ${"PR".padEnd(6)}${"item".padEnd(7)}${"rolls".padEnd(7)}${"heads".padEnd(7)}${"cost".padEnd(10)}${"final".padEnd(8)}surv\n`);
	for (const r of rollupByPr(records)) {
		process.stdout.write(`  ${String(r.prNumber).padEnd(6)}${(r.itemId ?? "—").padEnd(7)}${String(r.rolls).padEnd(7)}${String(r.distinctHeads).padEnd(7)}${`$${r.cost.toFixed(2)}`.padEnd(10)}${r.finalGate.padEnd(8)}${r.finalSurvivors}\n`);
	}
	process.stdout.write("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
