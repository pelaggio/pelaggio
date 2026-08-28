import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildLiveReadabilityCorpus, loadTrackedCorpus, measureSeatReadability, type SeatCorpus, type SeatOutcome } from "../doc-review-corpus.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const corpus = JSON.parse(readFileSync(join(repo, "ci", "doc-review-seat-corpus.json"), "utf8")) as SeatCorpus;

describe("doc-review seat corpus fixture", () => {
	it("is internally consistent and fingerprinted", () => {
		assert.match(corpus.fingerprint, /^\d+:[0-9a-f]{12}$/, "fingerprint is <recordCount>:<sha256 prefix>");
		assert.equal(corpus.seats.length, corpus.seatCount, "seatCount must match the array it counts");
		assert.equal(Number(corpus.fingerprint.split(":")[0]), corpus.recordCount, "fingerprint record count must match recordCount");
		assert.ok(corpus.recordCount > 0 && corpus.seatCount > 0);
	});

	/**
	 * The fixture exists so an item can classify seat readability inside a claim worktree, where
	 * `.dev/` is absent (#677 blocked on exactly that; #685 is the general fix). If a future scoping
	 * pass drops one of these fields the fixture silently stops answering the question it was cut for,
	 * so the classification surface is pinned rather than left to the exporter's discretion.
	 */
	it("carries the fields a readability classification needs", () => {
		for (const seat of corpus.seats) {
			assert.ok(seat.runId, "every seat names its run");
			assert.ok(seat.role === "reviewer" || seat.role === "judge", `unexpected role: ${seat.role}`);
			assert.equal(typeof seat.readable, "boolean", "readability is the harness verdict, never inferred from absence");
		}
		const unreadable = corpus.seats.filter((s) => !s.readable);
		assert.ok(unreadable.length > 0, "a corpus with no unreadable seat cannot exercise the question it was cut for");
		assert.ok(
			unreadable.every((s) => typeof s.diagnostic === "string" && s.diagnostic.length > 0),
			"an unreadable seat without a diagnostic is unclassifiable — the export dropped the discriminator",
		);
	});

	/** Scope guard: seat OUTCOMES only. Document identity and model text must not leak in. */
	it("stays scoped to seat outcomes", () => {
		const forbidden = ["document", "assistantText", "fullText", "digest", "byteLength", "path"];
		for (const seat of corpus.seats as unknown as Record<string, unknown>[]) {
			for (const key of forbidden) assert.ok(!(key in seat), `seat carries out-of-scope field '${key}'`);
		}
		assert.ok(!("document" in (corpus as unknown as Record<string, unknown>)), "corpus must not carry document identity");
	});
});

describe("measureSeatReadability — tracked 106-run fixture", () => {
	it("reproduces the baseline fractions, provider attribution, and optional projected diversity", () => {
		const loaded = loadTrackedCorpus();
		assert.equal(loaded.fingerprint, "106:d079b12dce4d");
		assert.equal(loaded.recordCount, 106);
		const measurement = measureSeatReadability(loaded);
		assert.equal(measurement.fingerprint, "106:d079b12dce4d");
		assert.deepEqual(measurement.judgeInvalid, { numerator: 34, denominator: 106 });
		assert.deepEqual(measurement.judgeBlockNotFound, { numerator: 32, denominator: 106 });
		assert.deepEqual(measurement.judgeSplitSkipped, { numerator: 16, denominator: 106 });
		assert.deepEqual(measurement.reviewerBlockNotFound, { numerator: 18, denominator: 318 });
		const attributed = measurement.blockNotFoundByModel.reduce((sum, row) => sum + row.count, 0);
		assert.equal(attributed, 50);
		assert.ok(measurement.blockNotFoundByModel.every((row) => row.provider === "claude" && row.model === "claude-opus-5"));
		const turnsCounted = measurement.blockNotFoundByTurns.reduce((sum, row) => sum + row.count, 0);
		assert.equal(turnsCounted, 50);
		assert.ok(measurement.blockNotFoundByTurns.every((row) => row.turns === undefined || row.turns < 60));
	});
});

describe("measureSeatReadability — projection and paired rates", () => {
	const dirs: string[] = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	const writeRecords = (records: unknown[]): string => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-corpus-"));
		dirs.push(dir);
		mkdirSync(dir, { recursive: true });
		records.forEach((record, index) => {
			writeFileSync(join(dir, `${String(index).padStart(3, "0")}.json`), `${JSON.stringify(record)}\n`);
		});
		return dir;
	};

	const identity = (role: "reviewer" | "judge", seatId: string, provider: string, model?: string) => ({
		role,
		seatId,
		provider,
		...(model ? { model } : {}),
		sessionId: `${role}-${seatId}`,
	});

	it("counts run diversity once per run and reproduces a 12/106 softened shape", () => {
		const runs: SeatOutcome[] = [];
		const summaries: NonNullable<SeatCorpus["runs"]> = [];
		for (let i = 0; i < 106; i++) {
			const runId = `run-${i}`;
			summaries.push({ runId, diversityState: i < 12 ? "softened" : "met" });
			runs.push({
				runId,
				createdAt: "2026-08-01T00:00:00.000Z",
				pass: 1,
				role: "reviewer",
				readable: true,
			});
		}
		const measurement = measureSeatReadability({
			fingerprint: "106:synthetic",
			recordCount: 106,
			seatCount: runs.length,
			generatedFrom: "synthetic",
			note: "synthetic",
			seats: runs,
			runs: summaries,
		});
		assert.deepEqual(measurement.diversitySoftened, { numerator: 12, denominator: 106 });
	});

	it("scopes the softened-diversity denominator to runs with observed diversity", () => {
		const measurement = measureSeatReadability({
			fingerprint: "3:mixed-diversity",
			recordCount: 3,
			seatCount: 0,
			generatedFrom: "synthetic",
			note: "synthetic",
			seats: [],
			runs: [
				{ runId: "softened", diversityState: "softened" },
				{ runId: "met", diversityState: "met" },
				{ runId: "legacy", diversityState: "legacy-unobserved" },
			],
		});
		assert.deepEqual(measurement.diversitySoftened, { numerator: 1, denominator: 2 });
	});

	it("uses Judge attempts as the Judge-rate denominator across multiple passes", () => {
		const judges: SeatOutcome[] = [1, 2].map((pass) => ({
			runId: "multi-pass",
			createdAt: "2026-08-01T00:00:00.000Z",
			pass,
			role: "judge",
			readable: false,
			diagnostic: "authoring review Judge block not found",
		}));
		const measurement = measureSeatReadability({
			fingerprint: "1:multi-pass",
			recordCount: 1,
			seatCount: judges.length,
			generatedFrom: "synthetic",
			note: "synthetic",
			seats: judges,
		});
		assert.deepEqual(measurement.judgeInvalid, { numerator: 2, denominator: 2 });
		assert.deepEqual(measurement.judgeBlockNotFound, { numerator: 2, denominator: 2 });
	});

	it("projects new attempt fields when present and leaves legacy seats unobserved", () => {
		const dir = writeRecords([
			{
				runId: "legacy-run",
				createdAt: "2026-08-01T00:00:00.000Z",
				result: {
					diversity: { state: "met" },
					passes: [
						{
							pass: 1,
							reviewers: [{ identity: identity("reviewer", "claude", "claude", "claude-opus-5"), ok: false, turns: 9, diagnostic: "authoring review findings block not found" }],
							judge: { identity: identity("judge", "judge", "claude", "claude-opus-5"), valid: false, diagnostic: "skipped: human adjudication required" },
						},
					],
				},
			},
			{
				runId: "new-run",
				createdAt: "2026-08-02T00:00:00.000Z",
				result: {
					diversity: { state: "softened" },
					passes: [
						{
							pass: 1,
							reviewers: [
								{
									identity: identity("reviewer", "claude", "claude", "claude-opus-5"),
									ok: false,
									turns: 14,
									diagnostic: "authoring review findings block not found",
									attempts: [
										{
											completion: "returned",
											attempt: 1,
											ok: true,
											subtype: "success",
											cost: 0,
											turns: 14,
											output: { state: "unreadable", code: "block-not-found", source: { chars: 0, hasStartMarker: false, hasEndMarker: false } },
										},
									],
								},
							],
							judge: {
								identity: identity("judge", "judge", "claude", "claude-opus-5"),
								valid: false,
								skipped: "cross-model-split",
								diagnostic: "skipped: human adjudication required",
								attempts: [],
							},
						},
					],
				},
				failedSeatTranscript: { path: ".dev/doc-review-transcripts/new-run.json", sha256: "a".repeat(64) },
				document: { path: "docs/secret.md", digest: "b".repeat(64), byteLength: 12 },
			},
		]);
		const projected = buildLiveReadabilityCorpus(dir);
		assert.equal(projected.recordCount, 2);
		assert.ok(!JSON.stringify(projected).includes("assistantText"));
		assert.ok(!JSON.stringify(projected).includes("docs/secret.md"));
		assert.ok(!("failedSeatTranscript" in projected));
		const legacy = projected.seats.find((s) => s.runId === "legacy-run" && s.role === "reviewer");
		assert.equal(legacy?.attempts, "legacy-unobserved");
		assert.equal(legacy?.subtype, undefined);
		assert.equal(legacy?.source, undefined);
		const fresh = projected.seats.find((s) => s.runId === "new-run" && s.role === "reviewer");
		assert.equal(Array.isArray(fresh?.attempts), true);
		assert.equal(fresh?.subtype, "success");
		assert.deepEqual(fresh?.source, { chars: 0, hasStartMarker: false, hasEndMarker: false });
		const skipped = projected.seats.find((s) => s.runId === "new-run" && s.role === "judge");
		assert.equal(skipped?.skipped, "cross-model-split");
		assert.deepEqual(skipped?.attempts, []);
		const measurement = measureSeatReadability(projected);
		assert.deepEqual(measurement.judgeSplitSkipped, { numerator: 2, denominator: 2 });
		assert.deepEqual(measurement.reviewerBlockNotFound, { numerator: 2, denominator: 2 });
		assert.ok(measurement.unreadableSourceFacts.some((row) => row.source === "legacy-unobserved"));
		assert.ok(measurement.unreadableSourceFacts.some((row) => row.source !== "legacy-unobserved" && row.source.chars === 0));
	});

	it("prefers typed attempt codes on mixed corpora and still classifies legacy diagnostic rows", () => {
		const mixed: SeatCorpus = {
			fingerprint: "2:mixed",
			recordCount: 2,
			seatCount: 2,
			generatedFrom: "synthetic",
			note: "synthetic",
			seats: [
				{
					runId: "legacy",
					createdAt: "2026-08-01T00:00:00.000Z",
					pass: 1,
					role: "judge",
					provider: "claude",
					model: "claude-opus-5",
					readable: false,
					diagnostic: "authoring review Judge block not found",
				},
				{
					runId: "fresh",
					createdAt: "2026-08-02T00:00:00.000Z",
					pass: 1,
					role: "judge",
					provider: "claude",
					model: "claude-opus-5",
					readable: false,
					diagnostic: "authoring review Judge block not found",
					attempts: [
						{
							completion: "returned",
							attempt: 1,
							ok: true,
							subtype: "success",
							cost: 0,
							turns: 8,
							output: { state: "unreadable", code: "invalid-json", source: { chars: 40, hasStartMarker: true, hasEndMarker: true } },
						},
					],
				},
			],
		};
		const measurement = measureSeatReadability(mixed);
		assert.deepEqual(measurement.judgeBlockNotFound, { numerator: 1, denominator: 2 });
		assert.equal(measurement.judgeInvalid.numerator, 2);
	});

	it("attributes block-not-found evidence to the matching retry", () => {
		const measurement = measureSeatReadability({
			fingerprint: "1:retry-attribution",
			recordCount: 1,
			seatCount: 1,
			generatedFrom: "synthetic",
			note: "synthetic",
			seats: [
				{
					runId: "retry",
					createdAt: "2026-08-01T00:00:00.000Z",
					pass: 1,
					role: "reviewer",
					readable: false,
					turns: 17,
					source: { chars: 50, hasStartMarker: true, hasEndMarker: true },
					attempts: [
						{
							completion: "returned",
							attempt: 1,
							ok: true,
							subtype: "success",
							cost: 0,
							turns: 4,
							output: { state: "unreadable", code: "block-not-found", source: { chars: 12, hasStartMarker: false, hasEndMarker: false } },
						},
						{
							completion: "returned",
							attempt: 2,
							ok: true,
							subtype: "success",
							cost: 0,
							turns: 17,
							output: { state: "unreadable", code: "invalid-json", source: { chars: 50, hasStartMarker: true, hasEndMarker: true } },
						},
					],
				},
			],
		});

		assert.deepEqual(measurement.blockNotFoundByTurns, [{ turns: 4, count: 1 }]);
		assert.deepEqual(measurement.unreadableSourceFacts, [{ source: { chars: 12, hasStartMarker: false, hasEndMarker: false }, count: 1 }]);
	});

	it("computes first vs final unreadability over one cohort and exposes a dropped failure through the denominator", () => {
		const recovered: SeatOutcome = {
			runId: "r1",
			createdAt: "2026-08-01T00:00:00.000Z",
			pass: 1,
			role: "reviewer",
			seatId: "claude",
			readable: true,
			attempts: [
				{ completion: "returned", attempt: 1, ok: true, subtype: "success", cost: 0, turns: 4, output: { state: "unreadable", code: "block-not-found", source: { chars: 0, hasStartMarker: false, hasEndMarker: false } } },
				{ completion: "returned", attempt: 2, ok: true, subtype: "success", cost: 0, turns: 4, output: { state: "readable", payload: "empty" } },
			],
		};
		const stillFailed: SeatOutcome = {
			runId: "r2",
			createdAt: "2026-08-01T00:00:00.000Z",
			pass: 1,
			role: "reviewer",
			seatId: "claude",
			readable: false,
			attempts: [{ completion: "returned", attempt: 1, ok: true, subtype: "success", cost: 0, turns: 4, output: { state: "unreadable", code: "block-not-found", source: { chars: 12, hasStartMarker: false, hasEndMarker: false } } }],
		};
		const withDroppedFailure: SeatCorpus = {
			fingerprint: "2:pair",
			recordCount: 2,
			seatCount: 2,
			generatedFrom: "synthetic",
			note: "synthetic",
			seats: [recovered, stillFailed],
		};
		const measurement = measureSeatReadability(withDroppedFailure);
		assert.deepEqual(measurement.firstAttemptUnreadable, { numerator: 2, denominator: 2 });
		assert.deepEqual(measurement.finalAttemptUnreadable, { numerator: 1, denominator: 2 });
		const onlyRecovered = measureSeatReadability({ ...withDroppedFailure, seats: [recovered], seatCount: 1, recordCount: 1 });
		assert.deepEqual(onlyRecovered.finalAttemptUnreadable, { numerator: 0, denominator: 1 });
		if ("unavailable" in measurement.firstAttemptUnreadable || "unavailable" in measurement.finalAttemptUnreadable) throw new Error("paired rates should be available");
		assert.equal(measurement.firstAttemptUnreadable.denominator, measurement.finalAttemptUnreadable.denominator);
	});
});
