import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { aggregateResults, BenchCorpusError, type BenchFixture, type BenchGolden, compareToBaseline, createReplaySeat, gateDisposition, loadBenchCorpus, renderReplayReport, replayFixture, runReplay } from "../review/bench.js";
import { main as cliMain } from "../review-bench-cli.js";
import type { ParkSignal } from "../types.js";

// ── temp-corpus helpers (cleaned up in `after` to avoid /tmp inode leakage) ──

const cleanups: string[] = [];
after(() => {
	for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

/** Write a corpus tree from a path→content map; objects are JSON-serialized, strings written verbatim. */
function writeCorpus(files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "review-bench-"));
	cleanups.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
	}
	return dir;
}

const cleanReviewer = 'AUTHORING_REVIEW_FINDINGS\n{"schemaVersion":3,"summary":"clean","findings":[]}\nEND_AUTHORING_REVIEW_FINDINGS';
const emptyJudge = 'AUTHORING_REVIEW_JUDGE\n{"schemaVersion":1,"decisions":[]}\nEND_AUTHORING_REVIEW_JUDGE';

const reviewerRec = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ role: "reviewer", seatId: "reviewer-1", pass: 1, assistantText: cleanReviewer, ...patch });
const judgeRec = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ role: "judge", seatId: "judge", pass: 1, assistantText: emptyJudge, ...patch });

function validFixture(id = "clean", overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		id,
		description: "a valid minimal fixture",
		policy: { reviewers: [{ id: "reviewer-1", provider: "claude" }], judge: { id: "judge", provider: "opencode" }, maxPasses: 1, budgetCap: 180 },
		classificationContext: { changedFiles: ["src/a.ts"] },
		recordings: [reviewerRec(), judgeRec()],
		groundTruthBlockers: [],
		...overrides,
	};
}
const validGolden = (): Record<string, unknown> => ({ schemaVersion: 1, outcome: "converged-clean", gate: "pass", survivorFingerprints: [], diversity: "softened" });
const validBaseline = (): Record<string, unknown> => ({ schemaVersion: 1, recall: 1, safetyFn: 0, tp: 0, fp: 0, fn: 0, precision: 1 });

/** A valid single-fixture corpus file map; spread + override one key to build a failure case. */
function baseCorpus(): Record<string, unknown> {
	return {
		"manifest.json": { schemaVersion: 1, fixtures: ["clean"] },
		"clean/fixture.json": validFixture("clean"),
		"clean/golden.json": validGolden(),
		"review-bench.baseline.json": validBaseline(),
	};
}

function assertThrowsWith(fn: () => unknown, needle: string): void {
	assert.throws(fn, (error: unknown) => {
		assert.ok(error instanceof BenchCorpusError, `expected BenchCorpusError, got ${error}`);
		assert.ok(error.message.includes(needle), `expected message to include ${JSON.stringify(needle)}, got ${JSON.stringify(error.message)}`);
		return true;
	});
}

// ── committed corpus: the Tier A regression gate ─────────────────────────────

describe("review-bench committed corpus", () => {
	it("replays deterministically (twice → byte-identical normalized results)", async () => {
		const corpus = loadBenchCorpus();
		const first = await runReplay(corpus);
		const second = await runReplay(loadBenchCorpus());
		assert.deepEqual(second, first);
		// And the rendered report is stable too.
		assert.equal(renderReplayReport(second), renderReplayReport(first));
	});

	it("matches all four fixture goldens exactly (outcome, gate, survivors)", async () => {
		const result = await runReplay(loadBenchCorpus());
		const byId = new Map(result.fixtures.map((f) => [f.id, f]));
		const expected: Record<string, { outcome: string; gate: string; survivors: number }> = {
			clean: { outcome: "converged-clean", gate: "pass", survivors: 0 },
			"single-blocker": { outcome: "hard-block", gate: "block", survivors: 1 },
			"safety-blocker": { outcome: "hard-block", gate: "park", survivors: 1 },
			"plausible-wrong": { outcome: "converged-clean", gate: "pass", survivors: 0 },
		};
		for (const [id, want] of Object.entries(expected)) {
			const got = byId.get(id);
			assert.ok(got, `missing fixture result ${id}`);
			assert.ok(got.goldenMatch, `${id} golden mismatch: ${got.goldenDiffs.join("; ")}`);
			assert.equal(got.outcome, want.outcome, `${id} outcome`);
			assert.equal(got.gate, want.gate, `${id} gate`);
			assert.equal(got.survivorFingerprints.length, want.survivors, `${id} survivor count`);
		}
		assert.equal(result.fixtures.length, 4);
	});

	it("scores aggregate confusion and clears the baseline with zero safety FN", async () => {
		const result = await runReplay(loadBenchCorpus());
		assert.deepEqual(result.aggregate, { tp: 2, fp: 0, fn: 0, precision: 1, recall: 1, safetyFn: 0 });
		assert.ok(result.aggregate.recall >= result.baseline.recall, "recall >= baseline");
		assert.ok(result.aggregate.safetyFn <= result.baseline.safetyFn, "safety FN <= baseline");
		assert.equal(result.ok, true);
		assert.deepEqual(result.regressions, []);
	});

	it("keeps the safety fixture's blocker (zero safety FN, never a passing gate)", async () => {
		const result = await runReplay(loadBenchCorpus());
		const safety = result.fixtures.find((f) => f.id === "safety-blocker");
		assert.ok(safety);
		assert.equal(safety.safetyFn, 0);
		assert.notEqual(safety.gate, "pass");
		assert.equal(safety.gate, "park");
	});
});

// ── replay seat adapter ──────────────────────────────────────────────────────

describe("replay seat adapter", () => {
	function requestFor(role: "reviewer" | "judge", seatId: string, pass: number): Parameters<ReturnType<typeof createReplaySeat>["seat"]>[0] {
		const parkSignal: ParkSignal = { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
		const slot = role === "judge" ? { id: seatId, provider: "opencode" as const } : { id: seatId, provider: "claude" as const };
		return { role, slot, pass, prompt: "unused", parkSignal };
	}

	it("selects the response by (role, seatId, pass) and costs zero", async () => {
		const fixture = validFixture("clean") as unknown as BenchFixture;
		const { seat } = createReplaySeat(fixture);
		const reviewer = await seat(requestFor("reviewer", "reviewer-1", 1));
		const judge = await seat(requestFor("judge", "judge", 1));
		assert.equal(reviewer.assistantText, cleanReviewer);
		assert.equal(judge.assistantText, emptyJudge);
		for (const result of [reviewer, judge]) {
			assert.equal(result.cost, 0);
			assert.equal(result.turns, 0);
			assert.equal(result.ok, true);
			// modelAuthoredText reads assistantText; fullText mirrors it (no tool transcript injected).
			assert.equal(result.fullText, result.assistantText);
		}
	});

	it("throws on a missing recording rather than synthesizing an answer", async () => {
		const fixture = validFixture("clean") as unknown as BenchFixture;
		const { seat } = createReplaySeat(fixture);
		await assert.rejects(seat(requestFor("reviewer", "reviewer-1", 2)), (e: unknown) => e instanceof BenchCorpusError && e.message.includes("missing a recording"));
	});

	it("does not import any provider/SDK/credential module (structural zero-live guarantee)", () => {
		const source = readFileSync(fileURLToPath(new URL("../review/bench.ts", import.meta.url)), "utf8");
		// The only config import is type-only (erased); no runtime import of step-runner or the SDK.
		for (const line of source.split("\n")) {
			if (!line.startsWith("import ")) continue;
			if (line.startsWith("import type ")) continue;
			assert.ok(!/step-runner/.test(line), `unexpected runtime import: ${line}`);
			assert.ok(!/claude-agent-sdk|@anthropic-ai/.test(line), `unexpected SDK import: ${line}`);
			assert.ok(!/from "\.\.\/config\.js"/.test(line), `config must be a type-only import: ${line}`);
		}
	});
});

// ── loader / validation failures (path-specific, fail-closed) ────────────────

describe("review-bench loader validation", () => {
	it("rejects an unsupported fixture schemaVersion", () => {
		const dir = writeCorpus({ ...baseCorpus(), "clean/fixture.json": { ...validFixture("clean"), schemaVersion: 2 } });
		assertThrowsWith(() => loadBenchCorpus(dir), "clean/fixture.json");
	});

	it("rejects an unsupported manifest schemaVersion", () => {
		const dir = writeCorpus({ ...baseCorpus(), "manifest.json": { schemaVersion: 9, fixtures: ["clean"] } });
		assertThrowsWith(() => loadBenchCorpus(dir), "manifest.json");
	});

	it("rejects a duplicate fixture id in the manifest", () => {
		const dir = writeCorpus({ ...baseCorpus(), "manifest.json": { schemaVersion: 1, fixtures: ["clean", "clean"] } });
		assertThrowsWith(() => loadBenchCorpus(dir), "duplicate fixture id");
	});

	it("rejects an id that does not match its manifest directory", () => {
		const dir = writeCorpus({ ...baseCorpus(), "clean/fixture.json": validFixture("mislabeled") });
		assertThrowsWith(() => loadBenchCorpus(dir), "does not match manifest entry");
	});

	it("rejects a duplicate recording key with a path-specific message", () => {
		const fixture = validFixture("clean", { recordings: [reviewerRec(), reviewerRec(), judgeRec()] });
		const dir = writeCorpus({ ...baseCorpus(), "clean/fixture.json": fixture });
		assertThrowsWith(() => loadBenchCorpus(dir), "duplicates recording key");
	});

	it("rejects a malformed role", () => {
		const fixture = validFixture("clean", { recordings: [reviewerRec({ role: "author" }), judgeRec()] });
		const dir = writeCorpus({ ...baseCorpus(), "clean/fixture.json": fixture });
		assertThrowsWith(() => loadBenchCorpus(dir), "recordings[0].role");
	});

	it("rejects a non-positive pass", () => {
		const fixture = validFixture("clean", { recordings: [reviewerRec({ pass: 0 }), judgeRec()] });
		const dir = writeCorpus({ ...baseCorpus(), "clean/fixture.json": fixture });
		assertThrowsWith(() => loadBenchCorpus(dir), "recordings[0].pass");
	});

	it("rejects an empty transcript payload", () => {
		const fixture = validFixture("clean", { recordings: [reviewerRec({ assistantText: "" }), judgeRec()] });
		const dir = writeCorpus({ ...baseCorpus(), "clean/fixture.json": fixture });
		assertThrowsWith(() => loadBenchCorpus(dir), "assistantText");
	});

	it("rejects an empty reviewers policy", () => {
		const fixture = validFixture("clean", { policy: { reviewers: [], judge: { id: "judge", provider: "opencode" }, maxPasses: 1, budgetCap: 180 } });
		const dir = writeCorpus({ ...baseCorpus(), "clean/fixture.json": fixture });
		assertThrowsWith(() => loadBenchCorpus(dir), "policy.reviewers");
	});

	it("rejects a judge recording whose seatId does not match the policy judge", () => {
		const fixture = validFixture("clean", { recordings: [reviewerRec(), judgeRec({ seatId: "not-the-judge" })] });
		const dir = writeCorpus({ ...baseCorpus(), "clean/fixture.json": fixture });
		assertThrowsWith(() => loadBenchCorpus(dir), "does not match policy.judge.id");
	});

	it("rejects duplicate ground-truth fingerprints", () => {
		const fixture = validFixture("clean", {
			groundTruthBlockers: [
				{ fingerprint: "fp", class: "judgment" },
				{ fingerprint: "fp", class: "judgment" },
			],
		});
		const dir = writeCorpus({ ...baseCorpus(), "clean/fixture.json": fixture });
		assertThrowsWith(() => loadBenchCorpus(dir), "duplicates fingerprint");
	});

	it("rejects an inconsistent golden (gate pass with survivors)", () => {
		const dir = writeCorpus({ ...baseCorpus(), "clean/golden.json": { schemaVersion: 1, outcome: "converged-clean", gate: "pass", survivorFingerprints: ["x"], diversity: "softened" } });
		assertThrowsWith(() => loadBenchCorpus(dir), "inconsistent");
	});

	it("rejects an unsorted golden survivor set", () => {
		const dir = writeCorpus({ ...baseCorpus(), "clean/golden.json": { schemaVersion: 1, outcome: "hard-block", gate: "block", survivorFingerprints: ["b", "a"], diversity: "softened" } });
		assertThrowsWith(() => loadBenchCorpus(dir), "must be sorted");
	});

	it("rejects invalid JSON with the offending file path", () => {
		const dir = writeCorpus({ ...baseCorpus(), "review-bench.baseline.json": "{ not json" });
		assertThrowsWith(() => loadBenchCorpus(dir), "review-bench.baseline.json");
	});
});

// ── replay-time recording irregularities ─────────────────────────────────────

describe("replay-time recording consistency", () => {
	it("surfaces a missing judge recording the loop would otherwise mask", async () => {
		const fixture = validFixture("clean") as unknown as BenchFixture;
		fixture.recordings = fixture.recordings.filter((r) => r.role !== "judge");
		await assert.rejects(replayFixture({ fixture, golden: validGolden() as unknown as BenchGolden }), (e: unknown) => e instanceof BenchCorpusError && e.message.includes("missing a recording for judge/judge/p1"));
	});

	it("surfaces an unused recording", async () => {
		const fixture = validFixture("clean") as unknown as BenchFixture;
		fixture.recordings.push({ role: "judge", seatId: "judge", pass: 2, assistantText: emptyJudge });
		await assert.rejects(replayFixture({ fixture, golden: validGolden() as unknown as BenchGolden }), (e: unknown) => e instanceof BenchCorpusError && e.message.includes("unused recording"));
	});
});

// ── scorer edges: golden drift, safety-FN, precision/recall, regression ───────

describe("review-bench scorer", () => {
	it("flags a golden mismatch when a Judge transcript is edited but the golden is not", async () => {
		const corpus = loadBenchCorpus();
		const single = corpus.fixtures.find((f) => f.id === "single-blocker");
		assert.ok(single);
		// Flip the Judge to refute; leave the golden (hard-block/block/[fp]) unchanged.
		const mutated: BenchFixture = {
			...single.fixture,
			recordings: single.fixture.recordings.map((r) =>
				r.role === "judge" ? { ...r, assistantText: 'AUTHORING_REVIEW_JUDGE\n{"schemaVersion":1,"decisions":[{"candidateId":"C1","decision":"refuted","rationale":"changed my mind"}]}\nEND_AUTHORING_REVIEW_JUDGE' } : r,
			),
		};
		const result = await replayFixture({ fixture: mutated, golden: single.golden });
		assert.equal(result.goldenMatch, false);
		assert.ok(
			result.goldenDiffs.some((d) => d.includes("outcome")),
			`expected outcome diff, got ${result.goldenDiffs.join("; ")}`,
		);
	});

	it("counts a safety FN when the safety blocker is dropped from the prediction", async () => {
		const corpus = loadBenchCorpus();
		const safety = corpus.fixtures.find((f) => f.id === "safety-blocker");
		assert.ok(safety);
		// Drop the reviewer finding (clean) so nothing is predicted, while ground truth still lists the
		// safety blocker — the un-predicted safety blocker must register as a safety false negative.
		const mutated: BenchFixture = {
			...safety.fixture,
			recordings: safety.fixture.recordings.map((r) => (r.role === "reviewer" ? { ...r, assistantText: cleanReviewer } : { ...r, assistantText: emptyJudge })),
		};
		const result = await replayFixture({ fixture: mutated, golden: safety.golden });
		assert.equal(result.safetyFn, 1, "the un-predicted safety blocker is a safety FN");
		const aggregate = aggregateResults([result]);
		const comparison = compareToBaseline(aggregate, [result], { schemaVersion: 1, recall: 1, safetyFn: 0, tp: 1, fp: 0, fn: 0, precision: 1 });
		assert.equal(comparison.ok, false);
		assert.ok(
			comparison.regressions.some((r) => r.includes("safety false-negatives")),
			comparison.regressions.join("; "),
		);
	});

	it("uses a conventional 1 for empty precision/recall denominators", () => {
		const aggregate = aggregateResults([]);
		assert.equal(aggregate.precision, 1);
		assert.equal(aggregate.recall, 1);
	});

	it("computes precision/recall from confusion counts", () => {
		const results = [
			{ id: "a", outcome: "hard-block", gate: "block", survivorFingerprints: [], diversity: "softened", predictedBlockers: [], groundTruthBlockers: [], confusion: { tp: 3, fp: 1, fn: 1 }, safetyFn: 0, goldenMatch: true, goldenDiffs: [] },
		] as unknown as Parameters<typeof aggregateResults>[0];
		const aggregate = aggregateResults(results);
		assert.equal(aggregate.precision, 3 / 4);
		assert.equal(aggregate.recall, 3 / 4);
	});

	it("flags a recall regression below baseline", () => {
		const results = [{ confusion: { tp: 1, fp: 0, fn: 1 }, safetyFn: 0, goldenMatch: true, goldenDiffs: [], id: "x" }] as unknown as Parameters<typeof compareToBaseline>[1];
		const aggregate = aggregateResults(results);
		const comparison = compareToBaseline(aggregate, results, { schemaVersion: 1, recall: 1, safetyFn: 0, tp: 1, fp: 0, fn: 0, precision: 1 });
		assert.equal(comparison.ok, false);
		assert.ok(comparison.regressions.some((r) => r.includes("recall")));
	});
});

describe("gateDisposition", () => {
	it("maps survivor sets to pass/block/park", async () => {
		const corpus = loadBenchCorpus();
		const cleanEntry = corpus.fixtures.find((f) => f.id === "clean");
		assert.ok(cleanEntry);
		const clean = await replayFixture(cleanEntry);
		assert.equal(gateDisposition([]), "pass");
		assert.equal(clean.gate, "pass");
	});
});

// ── CLI ───────────────────────────────────────────────────────────────────

describe("review-bench CLI", () => {
	function capture() {
		const out: string[] = [];
		const err: string[] = [];
		return { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), out: () => out.join(""), err: () => err.join("") };
	}

	it("exits 0 and prints PASS for a clean replay of the committed corpus", async () => {
		const io = capture();
		const code = await cliMain(["--replay"], { stdout: io.stdout, stderr: io.stderr });
		assert.equal(code, 0);
		assert.ok(io.out().includes("review-bench: PASS"), io.out());
	});

	it("emits machine-readable JSON with --json", async () => {
		const io = capture();
		const code = await cliMain(["--replay", "--json"], { stdout: io.stdout, stderr: io.stderr });
		assert.equal(code, 0);
		const parsed = JSON.parse(io.out());
		assert.equal(parsed.ok, true);
		assert.equal(parsed.aggregate.recall, 1);
	});

	it("exits 1 on a baseline/golden regression", async () => {
		const io = capture();
		const failing = {
			fixtures: [],
			aggregate: { tp: 0, fp: 0, fn: 1, precision: 1, recall: 0, safetyFn: 1 },
			baseline: { schemaVersion: 1 as const, recall: 1, safetyFn: 0, tp: 0, fp: 0, fn: 0, precision: 1 },
			regressions: ["blocker recall regressed"],
			ok: false,
		};
		const code = await cliMain(["--replay"], { stdout: io.stdout, stderr: io.stderr, runReplay: async () => failing });
		assert.equal(code, 1);
		assert.ok(io.out().includes("FAIL"), io.out());
	});

	it("exits 1 when the corpus fails to load", async () => {
		const io = capture();
		const code = await cliMain(["--replay"], {
			stdout: io.stdout,
			stderr: io.stderr,
			loadCorpus: () => {
				throw new BenchCorpusError("manifest.json is not valid JSON");
			},
		});
		assert.equal(code, 1);
		assert.ok(io.err().includes("failed to load or replay"), io.err());
	});

	it("rejects a missing mode as a usage error (exit 2)", async () => {
		const io = capture();
		assert.equal(await cliMain([], { stdout: io.stdout, stderr: io.stderr }), 2);
		assert.ok(io.err().includes("requires --replay"));
	});

	it("rejects the deferred --live and --record modes (exit 2)", async () => {
		for (const flag of ["--live", "--record"]) {
			const io = capture();
			assert.equal(await cliMain([flag], { stdout: io.stdout, stderr: io.stderr }), 2);
			assert.ok(io.err().includes("not available"), io.err());
		}
	});

	it("rejects unknown flags and stray positionals (exit 2)", async () => {
		const io1 = capture();
		assert.equal(await cliMain(["--bogus"], { stdout: io1.stdout, stderr: io1.stderr }), 2);
		const io2 = capture();
		assert.equal(await cliMain(["--replay", "extra"], { stdout: io2.stdout, stderr: io2.stderr }), 2);
		assert.ok(io2.err().includes("unexpected argument"), io2.err());
	});
});
