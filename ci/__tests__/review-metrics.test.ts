import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PrReviewSecurityTelemetry } from "../../packages/pelaggio/scripts/pelaggio/pr-review-gate-record.js";
import { corpusDigest, formatBaselineRows, type GateRecord, loadReviewCorpus, measurementSummary, summarize, summarizeAuthoring, widenedCorpusDigest } from "../review-metrics.js";

function record(over: Partial<GateRecord> = {}): GateRecord {
	return {
		prNumber: 1,
		headSha: "a".repeat(40),
		gate: "block",
		ok: true,
		...over,
	};
}

describe("review-metrics closure modes (#756)", () => {
	it("counts only fleet-v2 classified confirmed-survivor observations in canonical order", () => {
		const records: GateRecord[] = [
			record({
				schemaVersion: 2,
				producer: "fleet",
				recurrenceFindings: [{ closure: "patch" }, { closure: "construction" }, { closure: "construction" }, { closure: "authority" }, { closure: "policy" }, {}, { closure: "nope" }, { closure: "" }],
			}),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 2, headSha: "b".repeat(40) }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 3, headSha: "c".repeat(40), recurrenceFindings: [] }),
			record({ schemaVersion: 1, prNumber: 4, headSha: "d".repeat(40), recurrenceFindings: [{ closure: "patch" }] }),
			record({
				schemaVersion: 2,
				producer: "operator-adjudication",
				prNumber: 5,
				headSha: "e".repeat(40),
				recurrenceFindings: [{ closure: "policy" }],
			}),
		];
		const s = summarize(records);
		assert.deepEqual(s.closureModes, { patch: 1, construction: 2, authority: 1, policy: 1 });
		assert.deepEqual(Object.keys(s.closureModes), ["patch", "construction", "authority", "policy"]);
	});

	it("returns four zeroes without throwing when closure data is absent", () => {
		assert.deepEqual(summarize([]).closureModes, { patch: 0, construction: 0, authority: 0, policy: 0 });
		assert.deepEqual(summarize([record()]).closureModes, { patch: 0, construction: 0, authority: 0, policy: 0 });
		assert.deepEqual(summarize([record({ schemaVersion: 2, producer: "fleet", recurrenceFindings: undefined })]).closureModes, {
			patch: 0,
			construction: 0,
			authority: 0,
			policy: 0,
		});
	});

	it("appends the closure row after the existing table rows without rewording them", () => {
		const s = summarize([
			record({
				schemaVersion: 2,
				producer: "fleet",
				agreement: "disagreement",
				breakerReason: "invalid-pass",
				recurrenceFindings: [{ closure: "patch" }, { closure: "construction" }],
			}),
		]);
		const rows = formatBaselineRows(s).split("\n");
		assert.equal(rows[0], "  PRs gated                1");
		assert.ok(rows[1]?.startsWith("  rolls                    "));
		assert.ok(rows[2]?.startsWith("  single-roll / repeat     "));
		assert.ok(rows[3]?.startsWith("  reached a pass           "));
		assert.ok(rows[4]?.startsWith("  cost                     "));
		assert.ok(rows[5]?.startsWith("  survivors per block      "));
		assert.ok(rows[6]?.startsWith("  agreement               "));
		assert.equal(rows[7], "  mislabelled splits       1  (ok=true + disagreement stamped invalid-pass)");
		assert.equal(rows[8], "  closure modes            patch=1 construction=1 authority=0 policy=0   (classified confirmed-survivor observations)");
		assert.equal(rows[9], "  security-review coverage  0 / 1 instrumented fleet rolls");
		assert.equal(rows[10], "  red-team trigger rate     0 / 0 (0%)");
		assert.equal(rows[11], "  red-team-only must-fixes  0   (verified surviving digest set-difference)");
		assert.ok(rows.length > 12);
	});
});

describe("review-metrics security-review telemetry (#746)", () => {
	function telemetry(over: Partial<PrReviewSecurityTelemetry> = {}): PrReviewSecurityTelemetry {
		return {
			triggered: true,
			reasons: ["path:packages/server/src/config.ts"],
			standardMustFixDigests: [],
			redTeamMustFixDigests: [],
			...over,
		};
	}

	it("counts coverage only from well-shaped fleet-v2 objects and excludes operator/historical", () => {
		const records: GateRecord[] = [
			record({ schemaVersion: 2, producer: "fleet", securityReview: telemetry() }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 2, headSha: "b".repeat(40), securityReview: telemetry({ triggered: false, reasons: [] }) }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 3, headSha: "c".repeat(40) }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 4, headSha: "d".repeat(40), securityReview: { triggered: true, reasons: [] } }),
			record({ schemaVersion: 1, prNumber: 5, headSha: "e".repeat(40), securityReview: telemetry() }),
			record({
				schemaVersion: 2,
				producer: "operator-adjudication",
				prNumber: 6,
				headSha: "f".repeat(40),
				securityReview: telemetry({ redTeamMustFixDigests: ["a".repeat(64)] }),
			}),
		];
		const s = summarize(records);
		assert.equal(s.securityReview.fleetRolls, 4);
		assert.equal(s.securityReview.instrumented, 2);
		assert.equal(s.securityReview.triggered, 1);
		assert.equal(s.securityReview.redTeamOnlyMustFixes, 0);
	});

	it("counts red-team-only must-fixes as a per-record set difference", () => {
		const shared = "a".repeat(64);
		const only = "b".repeat(64);
		const s = summarize([
			record({
				schemaVersion: 2,
				producer: "fleet",
				securityReview: telemetry({
					standardMustFixDigests: [shared],
					redTeamMustFixDigests: [shared, only],
				}),
			}),
			record({
				schemaVersion: 2,
				producer: "fleet",
				prNumber: 2,
				headSha: "b".repeat(40),
				securityReview: telemetry({
					standardMustFixDigests: [only],
					redTeamMustFixDigests: [only],
				}),
			}),
		]);
		assert.equal(s.securityReview.redTeamOnlyMustFixes, 1);
		assert.equal(s.securityReview.triggered, 2);
		assert.equal(s.securityReview.instrumented, 2);
	});

	it("uses the fleet-v2 validator and excludes malformed telemetry from evidence", () => {
		const valid = telemetry({ redTeamMustFixDigests: ["b".repeat(64)] });
		const records: GateRecord[] = [
			record({ schemaVersion: 2, producer: "fleet", securityReview: valid }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 2, headSha: "b".repeat(40), securityReview: { ...valid, reasons: [123] } }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 3, headSha: "c".repeat(40), securityReview: { ...valid, redTeamMustFixDigests: ["not-a-digest"] } }),
		];
		const s = summarize(records);
		assert.deepEqual(s.securityReview, { fleetRolls: 3, instrumented: 1, triggered: 1, redTeamOnlyMustFixes: 1 });
	});

	it("returns zeros without throwing when telemetry is absent", () => {
		assert.deepEqual(summarize([]).securityReview, { fleetRolls: 0, instrumented: 0, triggered: 0, redTeamOnlyMustFixes: 0 });
		assert.deepEqual(summarize([record()]).securityReview, { fleetRolls: 0, instrumented: 0, triggered: 0, redTeamOnlyMustFixes: 0 });
	});
});

describe("review metrics profile coverage (#757)", () => {
	const participation = (profile: "full" | "docs") => ({
		configuredReviewers: ["codex", "grok"],
		configuredVerifier: "codex",
		labels: ["standard"],
		selection: { profile, reviewerSlots: profile === "docs" ? [1] : [0, 1] },
		iterations: [{ reviewReturned: profile === "docs" ? [true] : [true, true] }],
	});
	it("reports observed profile rolls and overlapping PR cohorts, never invented landings", () => {
		const fleet = { schemaVersion: 2, producer: "fleet" };
		const records = [
			record({ ...fleet, participation: participation("full") }),
			record({ ...fleet, headSha: "b".repeat(40), gate: "pass", participation: participation("docs") }),
			record({ ...fleet, headSha: "c".repeat(40), gate: "pass", participation: participation("docs") }),
			record({ ...fleet, prNumber: 2, participation: participation("docs") }),
			record({ ...fleet, prNumber: 3 }),
			record({ ...fleet, prNumber: 4, participation: { ...participation("docs"), selection: { profile: "future", reviewerSlots: [1] } } }),
			record({ ...fleet, prNumber: 5, producer: "operator-adjudication", participation: participation("docs") }),
			record({ prNumber: 6, schemaVersion: 1, participation: participation("full") }),
		];
		const summary = summarize(records);
		assert.deepEqual(summary.reviewIntensity, {
			fleetRolls: 6,
			instrumented: 4,
			overlappingPrs: 1,
			profiles: [
				{ profile: "full", prs: 1, rolls: 1, repeatRolls: 0, reachedPass: 0, rollsPerPr: 1 },
				{ profile: "docs", prs: 2, rolls: 3, repeatRolls: 1, reachedPass: 1, rollsPerPr: 1.5 },
			],
		});
		const rows = formatBaselineRows(summary);
		assert.match(rows, /profile coverage.*4 \/ 6/);
		assert.match(rows, /landing.*unavailable/i);
		assert.match(rows, /post-landing.*unavailable/i);
		assert.match(rows, /overlapping.*1/);
	});
	it("does not classify absent or malformed selection metadata as full", () => {
		const old = { ...participation("full"), selection: undefined };
		const summary = summarize([record({ schemaVersion: 2, producer: "fleet", participation: old })]);
		assert.equal(summary.reviewIntensity.instrumented, 0);
		assert.ok(summary.reviewIntensity.profiles.every((row) => row.rolls === 0));
	});
});

describe("durable review metrics families (#790)", () => {
	function corpusTest(run: (root: string, put: (family: string, name: string, value: unknown) => void) => void): void {
		const root = mkdtempSync(join(tmpdir(), "review-metrics-"));
		const put = (family: string, name: string, value: unknown): void => {
			mkdirSync(join(root, family), { recursive: true });
			writeFileSync(join(root, family, name), JSON.stringify(value));
		};
		try {
			run(root, put);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	const authoring = (result: Record<string, unknown> = {}): Record<string, unknown> => ({ schemaVersion: 1, runId: "run-1", itemId: "789", createdAt: "2026-09-05T12:00:00Z", blockingBar: "must-fix", result });
	it("counts observed zero while malformed and historical measurements remain unavailable", () => {
		assert.deepEqual(measurementSummary([0, 10, undefined, null, -1, 0.5, "12", NaN, Infinity]), { total: 9, observed: 2, unknown: 7, min: 0, max: 10, mean: 5, sum: 10 });
		assert.deepEqual(measurementSummary([]), { total: 0, observed: 0, unknown: 0 });
		assert.equal(measurementSummary([0.5], false).observed, 1);
	});
	it("summarizes large observation sets without an argument-count limit", () => {
		assert.deepEqual(measurementSummary(Array(200_000).fill(1)), { total: 200_000, observed: 200_000, unknown: 0, min: 1, max: 1, mean: 1, sum: 200_000 });
	});
	it("renders absent and partial PR measurements without invented zeroes", () => {
		const missing = formatBaselineRows(summarize([record()]));
		assert.match(missing, /cost\s+unavailable/);
		assert.match(missing, /survivors per block\s+unavailable/);
		const partial = formatBaselineRows(summarize([record({ cost: 4, survivorCount: 2 }), record({ prNumber: 2 })]));
		assert.match(partial, /cost\s+\$4 observed \(1\/2 rolls; incomplete total\)/);
		assert.match(partial, /survivors per block\s+2 observed mean \(1\/2 block rolls\)/);
		const zero = formatBaselineRows(summarize([record({ cost: 0, survivorCount: 0 })]));
		assert.match(zero, /cost\s+\$0/);
		assert.match(zero, /survivors per block\s+0/);
	});
	it("retains valid historical short and case-insensitive PR SHA identities", () =>
		corpusTest((root, put) => {
			put("pr", "short.json", record({ headSha: "AbCdE12", schemaVersion: 1 }));
			const loaded = loadReviewCorpus(join(root, "pr"), "pr");
			assert.equal(loaded.invalid, 0);
			assert.equal(loaded.records[0]?.headSha, "AbCdE12");
		}));
	it("reads durable authoring runs with separate pass and seat coverage", () =>
		corpusTest((root, put) => {
			put(
				"authoring",
				"a.json",
				authoring({
					elapsedMs: 50,
					cost: 1.5,
					passes: [
						{
							elapsedMs: 40,
							reviewers: [
								{ elapsedMs: 35, identity: { provider: "codex" } },
								{ elapsedMs: 30, identity: { provider: "grok" } },
							],
							judge: { elapsedMs: 5 },
						},
					],
				}),
			);
			put("authoring", "b.json", { ...authoring({ passes: [{ reviewers: [{}, null], judge: { skipped: "no-reviewer-completed" } }, null] }), runId: "legacy" });
			const loaded = loadReviewCorpus(join(root, "authoring"), "authoring");
			assert.equal(loaded.records.length, 2);
			const summary = summarizeAuthoring(loaded.records);
			assert.equal(summary.runs.total, 2);
			assert.equal(summary.runs.mean, 50);
			assert.equal(summary.passes.total, 3);
			assert.equal(summary.passes.unknown, 2);
			assert.equal(summary.reviewers.total, 4);
			assert.equal(summary.reviewers.mean, 32.5);
			assert.equal(summary.judges.total, 2);
			assert.equal(summary.judges.unknown, 1);
			assert.equal(summary.unavailableContainers, 1);
			assert.equal(summary.cost.observed, 1);
			assert.equal(summary.cost.unknown, 1);
			assert.equal(summary.runs.sum, 50); // Concurrent seat durations never become loop wall time.
		}));
	it("rejects wrong families and unusable identities without losing historical runs", () =>
		corpusTest((root, put) => {
			put("authoring", "valid.json", authoring({}));
			for (const [name, value] of Object.entries({
				doc: { ...authoring(), itemId: undefined, document: { path: "x" } },
				future: { ...authoring(), schemaVersion: 2 },
				null: null,
				result: { ...authoring(), result: null },
				identity: { ...authoring(), runId: 3 },
			}))
				put("authoring", `${name}.json`, value);
			writeFileSync(join(root, "authoring", "truncated.json"), "{");
			const loaded = loadReviewCorpus(join(root, "authoring"), "authoring");
			assert.equal(loaded.records.length, 1);
			assert.equal(loaded.invalid, 6);
			assert.equal(summarizeAuthoring(loaded.records).runs.unknown, 1);
			assert.equal(summarizeAuthoring(loaded.records).unavailableContainers, 1);
			assert.equal(loadReviewCorpus(join(root, "missing"), "authoring").availability, "missing");
		}));
	it("preserves PR-only summaries and recognized operator adjudications", () =>
		corpusTest((root, put) => {
			const fleet = record({ schemaVersion: 2, producer: "fleet", cost: 4, reviewedAt: "2026-09-05T00:00:00Z" });
			put("pr", "fleet.json", fleet);
			put("pr", "operator.json", { schemaVersion: 2, producer: "operator-adjudication", prNumber: 2, headSha: "b".repeat(40), gate: "pass", agreement: "not-run" });
			const loaded = loadReviewCorpus(join(root, "pr"), "pr");
			assert.equal(loaded.records.length, 2);
			assert.equal(summarize(loaded.records).totalCost, 4);
			assert.equal(
				measurementSummary(
					loaded.records.map((r) => r.cost),
					false,
				).unknown,
				1,
			);
			assert.deepEqual(summarize(loaded.records.filter((r) => r.prNumber === 1)), summarize([fleet]));
			put("pr", "future.json", { ...fleet, schemaVersion: 9 });
			put("pr", "bad.json", { ...fleet, prNumber: "2" });
			assert.equal(loadReviewCorpus(join(root, "pr"), "pr").invalid, 2);
		}));
	it("excludes unknown dates from cutoff cohorts and fingerprints family and contents deterministically", () =>
		corpusTest((root, put) => {
			put("pr", "a.json", record({ reviewedAt: "2026-09-05T00:00:00Z", cost: 2 }));
			put("pr", "unknown.json", record({ prNumber: 2 }));
			put("pr", "later.json", record({ prNumber: 3, reviewedAt: "2026-09-07T00:00:00Z" }));
			const first = loadReviewCorpus(join(root, "pr"), "pr", "2026-09-06");
			assert.equal(first.records.length, 1);
			assert.equal(first.undated, 1);
			assert.equal(first.excluded, 1);
			const author = loadReviewCorpus(join(root, "author"), "authoring", "2026-09-06");
			const digest = widenedCorpusDigest([first, author]);
			assert.equal(digest, widenedCorpusDigest([author, first]));
			assert.notEqual(digest, widenedCorpusDigest([first]));
			put("pr", "a.json", record({ reviewedAt: "2026-09-05T00:00:00Z", cost: 3 }));
			const changed = loadReviewCorpus(join(root, "pr"), "pr", "2026-09-06");
			assert.equal(corpusDigest(first.records), corpusDigest(changed.records));
			assert.notEqual(digest, widenedCorpusDigest([changed, author]));
			writeFileSync(join(root, "pr", "broken.json"), "{");
			assert.notEqual(widenedCorpusDigest([changed]), widenedCorpusDigest([loadReviewCorpus(join(root, "pr"), "pr", "2026-09-06")]));
		}));
	it("discloses malformed containers, optional fields and filesystem failures", () =>
		corpusTest((root, put) => {
			put(
				"author",
				"a.json",
				authoring({
					elapsedMs: -1,
					cost: "bad",
					passes: [
						{ reviewers: null, judge: null },
						{ reviewers: [], judge: { elapsedMs: 0 } },
					],
				}),
			);
			const a = summarizeAuthoring(loadReviewCorpus(join(root, "author"), "authoring").records);
			assert.equal(a.unavailableContainers, 2);
			assert.equal(a.reviewers.total, 0);
			assert.equal(a.judges.observed, 1);
			assert.equal(a.runs.unknown, 1);
			assert.equal(a.cost.unknown, 1);
			put("pr", "a.json", record({ cost: -1, reviewedAt: "invalid", elapsedMs: null, survivorCount: -1 }));
			const pr = loadReviewCorpus(join(root, "pr"), "pr");
			assert.equal(pr.records.length, 1);
			assert.equal(pr.undated, 1);
			assert.equal(pr.records[0].cost, undefined);
			assert.equal(pr.records[0].survivorCount, undefined);
			assert.equal(loadReviewCorpus(join(root, "pr", "a.json"), "pr").availability, "unreadable");
			mkdirSync(join(root, "pr", "directory.json"));
			assert.equal(loadReviewCorpus(join(root, "pr"), "pr").invalid, 1);
		}));
	it("admits legacy identities and rejects each unsupported identity dimension", () =>
		corpusTest((root, put) => {
			put("pr", "legacy.json", record({ schemaVersion: 1 }));
			put("pr", "schemaless.json", record());
			for (const [name, patch] of Object.entries({ number: { prNumber: 0 }, sha: { headSha: "bad" }, gate: { gate: "unknown" }, producer: { schemaVersion: 2, producer: "unknown" } })) put("pr", `${name}.json`, { ...record(), ...patch });
			assert.equal(loadReviewCorpus(join(root, "pr"), "pr").records.length, 2);
			assert.equal(loadReviewCorpus(join(root, "pr"), "pr").invalid, 4);
			put("author", "good.json", authoring());
			for (const [name, patch] of Object.entries({ item: { itemId: "" }, run: { runId: "" }, bar: { blockingBar: "anything" }, doc: { document: { path: "x" } } })) put("author", `${name}.json`, { ...authoring(), ...patch });
			assert.equal(loadReviewCorpus(join(root, "author"), "authoring").records.length, 1);
			assert.equal(loadReviewCorpus(join(root, "author"), "authoring").invalid, 4);
		}));
	it("applies authoring cutoff without mutable attribution and ignores input enumeration order", () =>
		corpusTest((root, put) => {
			const before = { ...authoring({ passes: [] }), itemId: "recorded-item" };
			const after = { ...authoring({ passes: [] }), createdAt: "2026-09-07T00:00:00Z" };
			put("one", "b.json", after);
			put("one", "a.json", before);
			put("two", "a.json", before);
			put("two", "b.json", after);
			const one = loadReviewCorpus(join(root, "one"), "authoring", "2026-09-06");
			const two = loadReviewCorpus(join(root, "two"), "authoring", "2026-09-06");
			assert.equal(one.records[0].itemId, "recorded-item");
			assert.equal(one.excluded, 1);
			assert.equal(widenedCorpusDigest([one]), widenedCorpusDigest([two]));
			put("one", "undated.json", { ...before, createdAt: null });
			assert.equal(loadReviewCorpus(join(root, "one"), "authoring", "2026-09-06").undated, 1);
			assert.equal(loadReviewCorpus(join(root, "one"), "authoring", "2026-09-06").records.length, 1);
		}));
	it("fingerprints filenames in locale-independent code-unit order", () =>
		corpusTest((root, put) => {
			put("pr", "a.json", record());
			put("pr", "A.json", record({ prNumber: 2 }));
			const loaded = loadReviewCorpus(join(root, "pr"), "pr");
			assert.deepEqual(
				loaded.inventory.map((entry) => entry.name),
				["A.json", "a.json"],
			);
			const inventory = [{ family: "pr", availability: "readable", inventory: loaded.inventory }];
			assert.equal(widenedCorpusDigest([loaded]), `2:${createHash("sha256").update(JSON.stringify(inventory)).digest("hex").slice(0, 12)}`);
		}));

	it("CLI widens only explicitly and reports authoring when PR records are absent", () =>
		corpusTest((root, put) => {
			put("author", "a.json", authoring({ elapsedMs: 0, passes: [] }));
			const cli = (...args: string[]): string => execFileSync(process.execPath, ["--import", "tsx", "ci/review-metrics.ts", join(root, "pr"), ...args], { encoding: "utf8" });
			assert.doesNotMatch(cli(), /Authoring runs/);
			const output = cli("--authoring-dir", join(root, "author"));
			assert.match(output, /Authoring runs.*1/);
			assert.match(output, /PR rolls.*0/);
			assert.match(output, /observed=1\/1.*mean=0/);
			assert.match(output, /unavailable/);
		}));
	it("CLI distinguishes unmeasured and partial PR rows from observed zero", () =>
		corpusTest((root, put) => {
			put("pr", "unknown.json", record({ prNumber: 1 }));
			put("pr", "partial-known.json", record({ prNumber: 2, cost: 4, survivorCount: 2, reviewedAt: "2026-09-05T00:00:00Z" }));
			put("pr", "partial-missing.json", record({ prNumber: 2, headSha: "b".repeat(40), reviewedAt: "2026-09-06T00:00:00Z" }));
			put("pr", "zero.json", record({ prNumber: 3, cost: 0, survivorCount: 0 }));
			const output = execFileSync(process.execPath, ["--import", "tsx", "ci/review-metrics.ts", join(root, "pr")], { encoding: "utf8" });
			assert.match(output, /^ {2}1\s+.*unavailable\s+block\s+unavailable$/m);
			assert.match(output, /^ {2}2\s+.*\$4\.00 observed \(1\/2\)\s+block\s+unavailable$/m);
			assert.match(output, /^ {2}3\s+.*\$0\.00\s+block\s+0$/m);
		}));
});
