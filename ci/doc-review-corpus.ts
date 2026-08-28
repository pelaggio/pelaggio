/**
 * Scoped fixture export of the local document-review corpus in `.dev/doc-review-records/`.
 *
 * This exists because `.dev/` is gitignored — deliberately, so its churn cannot false-fire the
 * git-state confinement audit — which also means it is absent from every claim worktree. An item
 * that must diagnose seat behaviour FROM those records therefore cannot run in a cycle at all
 * (#677 blocked on exactly this). Sharing or symlinking `.dev/` into a worktree would fix the
 * symptom by spending the property that makes the audit trustworthy, so instead the harness
 * exports a scoped, fingerprinted COPY that is tracked in git and is therefore present wherever
 * the branch is.
 *
 * The general form of this — declared step inputs materialised by the harness — is #685. This is
 * the narrow stopgap that unblocks its first consumer.
 *
 * Scope: seat OUTCOMES only. Document paths, digests and byte lengths are dropped (they describe
 * what was reviewed, not how the seat behaved). Records carry no `assistantText` or `subtype`, so
 * there is no model text to leak — which is also precisely why this corpus cannot settle
 * decoration-vs-non-emission, and why #677 needs new instrumentation for that half.
 *
 * Regenerate:  npx tsx ci/doc-review-corpus.ts --write
 * Inspect:     npx tsx ci/doc-review-corpus.ts
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORDS_DIR = join(repo, ".dev", "doc-review-records");
const FIXTURE = join(repo, "ci", "doc-review-seat-corpus.json");

export interface SeatOutcome {
	runId: string;
	createdAt: string;
	pass: number;
	role: "reviewer" | "judge";
	seatId?: string;
	provider?: string;
	model?: string;
	/** reviewer `ok`, judge `valid` — the harness's own readability verdict for the seat. */
	readable: boolean;
	turns?: number;
	cost?: number;
	/** Harness-authored diagnostic. Classified by the consumer; never relabelled here. */
	diagnostic?: string;
	verdict?: string;
}

export interface SeatCorpus {
	fingerprint: string;
	recordCount: number;
	seatCount: number;
	generatedFrom: string;
	note: string;
	seats: SeatOutcome[];
}

interface RawSeat {
	identity?: { seatId?: string; provider?: string; model?: string };
	ok?: boolean;
	valid?: boolean;
	turns?: number;
	cost?: number;
	diagnostic?: string;
	verdict?: { verdict?: string };
}

interface RawPass {
	pass?: number;
	reviewers?: RawSeat[];
	judge?: RawSeat;
}

export function buildCorpus(dir = RECORDS_DIR): SeatCorpus {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	const hash = createHash("sha256");
	const seats: SeatOutcome[] = [];
	for (const file of files) {
		const raw = readFileSync(join(dir, file));
		hash.update(raw);
		const record = JSON.parse(raw.toString("utf8"));
		const runId: string = record.runId ?? file.replace(/\.json$/, "");
		const createdAt: string = record.createdAt ?? "";
		const passes: RawPass[] = record.result?.passes ?? [];
		passes.forEach((pass, index) => {
			const passNumber: number = pass.pass ?? index + 1;
			for (const reviewer of pass.reviewers ?? []) {
				seats.push({
					runId,
					createdAt,
					pass: passNumber,
					role: "reviewer",
					seatId: reviewer.identity?.seatId,
					provider: reviewer.identity?.provider,
					model: reviewer.identity?.model,
					readable: reviewer.ok === true,
					turns: reviewer.turns,
					cost: reviewer.cost,
					diagnostic: reviewer.diagnostic,
					verdict: reviewer.verdict?.verdict,
				});
			}
			if (pass.judge) {
				seats.push({
					runId,
					createdAt,
					pass: passNumber,
					role: "judge",
					seatId: pass.judge.identity?.seatId,
					provider: pass.judge.identity?.provider,
					model: pass.judge.identity?.model,
					readable: pass.judge.valid === true,
					turns: pass.judge.turns,
					cost: pass.judge.cost,
					diagnostic: pass.judge.diagnostic,
				});
			}
		});
	}
	return {
		fingerprint: `${files.length}:${hash.digest("hex").slice(0, 12)}`,
		recordCount: files.length,
		seatCount: seats.length,
		generatedFrom: ".dev/doc-review-records/",
		note: "Seat outcomes only. Scoped export — see ci/doc-review-corpus.ts. Regenerate with --write.",
		seats,
	};
}

/** Entry-point only: importing this module must not read the filesystem or write the fixture. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\u0000")) {
	const corpus = buildCorpus();
	if (process.argv.includes("--write")) {
		writeFileSync(FIXTURE, `${JSON.stringify(corpus, null, "\t")}\n`);
		console.log(`wrote ${FIXTURE}`);
	}
	console.log(`fingerprint=${corpus.fingerprint} records=${corpus.recordCount} seats=${corpus.seatCount}`);
	const unreadable = corpus.seats.filter((s) => !s.readable);
	console.log(`unreadable seats: ${unreadable.length} (${Math.round((100 * unreadable.length) / corpus.seatCount)}%)`);
}
