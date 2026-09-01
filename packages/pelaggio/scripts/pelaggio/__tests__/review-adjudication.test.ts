import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parsePatch } from "diff";
import { PR_REVIEW_MARKER } from "../github-posting.js";
import { type NewPrReviewFleetGateRecord, type PrReviewGateRecord, writePrReviewGateRecord } from "../pr-review-gate-record.js";
import {
	adjudicationSourcesDir,
	bindLiveSafetyVerification,
	buildAdjudicationSourceDraft,
	crossCheckAdjudicationSource,
	evaluateInterdiffPolicy,
	fleetRecordDigestOf,
	isEligibleFleetGateRecord,
	listAdjudicationSourceRecords,
	mapFindingToInspectionHunk,
	normalizeGitPath,
	type PrAdjudicationSourceDraft,
	type PrAdjudicationSourceRecordV1,
	type PrAdjudicationSurvivorEntry,
	readAdjudicationSourceRecord,
	renderOperatorAdjudicationComment,
	selectUnambiguousFleetGateRecord,
	validateAdjudicationSourceRecord,
	writeAdjudicationSourceRecord,
} from "../review/adjudication.js";
import { materializeAuthoringFinding, type ReviewFinding, reviewFindingFingerprint } from "../review/findings.js";
import { BASELINE_TAXONOMY, type TaxonomyConfig, tierOf } from "../review/taxonomy.js";
import { LOCAL_MODE_MARKER } from "../review-sweep.js";
import { fetchReviewFindingsOutcome } from "../revise-sweep.js";
import type { GhRunner } from "../roadmap/github-issues.js";

const REVIEWED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST = "c".repeat(64);
const OVERSIZE_MESSAGE = "x".repeat(1024 * 1024);
const dirs: string[] = [];

function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "review-adjudication-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
	return { severity: "must-fix", message: "Null deref in the parser.", path: "src/a.ts", line: 10, ...over };
}

function survivor(over: Partial<PrAdjudicationSurvivorEntry> = {}): PrAdjudicationSurvivorEntry {
	const baseFinding = over.finding ?? finding();
	const materialized = materializeAuthoringFinding(baseFinding, { changedFiles: ["src/a.ts"] }, BASELINE_TAXONOMY);
	return {
		finding: baseFinding,
		fingerprint: reviewFindingFingerprint(baseFinding),
		class: materialized.class,
		classification: materialized.classification,
		tier: tierOf(materialized.class, BASELINE_TAXONOMY),
		verification: { id: "C1", decision: "survives", rationale: "Confirmed against the inspected head." },
		hunk: { path: "src/a.ts", start: 8, end: 14 },
		...over,
	};
}

function draft(over: Partial<PrAdjudicationSourceDraft> = {}): PrAdjudicationSourceDraft {
	const entry = survivor();
	return {
		prNumber: 497,
		itemId: "497",
		reviewedSha: REVIEWED,
		agreement: "consensus-block",
		requiredCells: 2,
		completedCells: 2,
		survivorCount: 1,
		survivors: [entry],
		refuted: [],
		...over,
	};
}

function record(over: Partial<PrAdjudicationSourceRecordV1> = {}): PrAdjudicationSourceRecordV1 {
	return { schemaVersion: 1, ...draft(), fleetRecordDigest: DIGEST, ...over };
}

function fleet(over: Partial<NewPrReviewFleetGateRecord> = {}): NewPrReviewFleetGateRecord {
	return {
		producer: "fleet",
		prNumber: 497,
		headSha: REVIEWED,
		itemId: "497",
		gate: "block",
		ok: true,
		subtype: "consensus-block",
		agreement: "consensus-block",
		survivorCount: 1,
		cost: 1,
		costEstimated: false,
		turns: 4,
		elapsedMs: 1_000,
		runner: "local",
		reviewedAt: "2026-08-13T12:00:00.000Z",
		...over,
	};
}

function inspectionDiff(opts: { path?: string; newStart?: number; old?: string; next?: string } = {}): string {
	const path = opts.path ?? "src/a.ts";
	const start = opts.newStart ?? 8;
	const old = opts.old ?? "old line";
	const next = opts.next ?? "new line";
	return [`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},5 +${start},5 @@`, " context", " context", `-${old}`, `+${next}`, " context", " context", ""].join("\n");
}

function replacementDiff(path: string, oldStart: number, oldLine: string, newLine: string): string {
	return [`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`, `@@ -${oldStart},1 +${oldStart},1 @@`, `-${oldLine}`, `+${newLine}`, ""].join("\n");
}

function insertionDiff(path: string, oldStart: number, line: string): string {
	return [`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`, `@@ -${oldStart},0 +${oldStart + 1},1 @@`, `+${line}`, ""].join("\n");
}

function paddedReplacementDiff(path: string, oldStart: number, addedCount: number): string {
	const added = Array.from({ length: addedCount }, (_, i) => `+new line ${i + 1}`);
	return [`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`, `@@ -${oldStart},1 +${oldStart},${addedCount} @@`, "-old", ...added, ""].join("\n");
}

function multiInsertionDiff(path: string, oldStart: number, addedCount: number): string {
	const added = Array.from({ length: addedCount }, (_, i) => `+inserted ${i + 1}`);
	return [`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`, `@@ -${oldStart},0 +${oldStart + 1},${addedCount} @@`, ...added, ""].join("\n");
}

/** One insertion hunk per anchor, each within the per-hunk bound — the #510 aggregate exploit shape. */
function anchoredInsertionsDiff(path: string, anchors: readonly number[], addedPerHunk: number): string {
	const lines = [`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`];
	let newOffset = 0;
	for (const anchor of anchors) {
		lines.push(`@@ -${anchor},0 +${anchor + 1 + newOffset},${addedPerHunk} @@`);
		for (let i = 0; i < addedPerHunk; i++) lines.push(`+inserted ${anchor}.${i + 1}`);
		newOffset += addedPerHunk;
	}
	lines.push("");
	return lines.join("\n");
}

describe("adjudication source store", () => {
	it("writes and reads a validated record with 0o600 and atomic replacement", () => {
		const dir = root();
		const path = writeAdjudicationSourceRecord(dir, record());
		assert.equal(path, join(dir, `497-${REVIEWED}.json`));
		assert.equal(statSync(path).mode & 0o777, 0o600);
		const stored = readAdjudicationSourceRecord(dir, 497, REVIEWED);
		assert.ok(stored);
		assert.equal(stored.schemaVersion, 1);
		assert.equal(stored.reviewedSha, REVIEWED);
		assert.equal(stored.survivors[0]?.fingerprint, reviewFindingFingerprint(finding()));
		assert.equal(stored.survivors[0]?.tier, "safety");
		assert.equal(stored.survivors[0]?.class, "correctness-regression");

		const replacement = record({ itemId: "replaced" });
		writeAdjudicationSourceRecord(dir, replacement);
		assert.equal(readAdjudicationSourceRecord(dir, 497, REVIEWED)?.itemId, "replaced");
		assert.deepEqual(
			listAdjudicationSourceRecords(dir).map((entry) => entry.itemId),
			["replaced"],
		);
	});

	it("lists only identity-matching records and ignores a missing root", () => {
		assert.deepEqual(listAdjudicationSourceRecords(join(root(), "missing")), []);
		const dir = root();
		writeAdjudicationSourceRecord(dir, record());
		writeAdjudicationSourceRecord(dir, record({ prNumber: 498, reviewedSha: HEAD, itemId: "498" }));
		writeFileSync(join(dir, "not-a-record.json"), "{}\n");
		writeFileSync(join(dir, `497-${HEAD}.json`), JSON.stringify({ ...record(), reviewedSha: REVIEWED }));
		assert.deepEqual(
			listAdjudicationSourceRecords(dir).map((entry) => [entry.prNumber, entry.reviewedSha]),
			[
				[497, REVIEWED],
				[498, HEAD],
			],
		);
	});

	it("rejects duplicate survivors, malformed schema, SHA, class, and tier", () => {
		const entry = survivor();
		assert.throws(() => validateAdjudicationSourceRecord({ ...record(), schemaVersion: 2 }));
		const invalid = [
			{ ...record(), survivors: [entry, { ...entry }], survivorCount: 2 },
			{ ...record(), reviewedSha: "abc" },
			{ ...record(), agreement: "consensus-pass" },
			{ ...record(), agreement: "invalid" },
			{ ...record(), requiredCells: 2, completedCells: 1 },
			{ ...record(), survivorCount: 0, survivors: [] },
			{ ...record(), survivors: [{ ...entry, class: "not a class" }] },
			{ ...record(), survivors: [{ ...entry, tier: "maybe" }] },
			{ ...record(), survivors: [{ ...entry, verification: { ...entry.verification, decision: "refuted" } }] },
			{ ...record(), survivors: [{ ...entry, fingerprint: "tampered" }] },
			// hunk.path must be single-line — same trust-boundary rule as finding.path (#598)
			{ ...record(), survivors: [{ ...entry, hunk: { ...entry.hunk, path: "src/a\n.ts" } }] },
			{ ...record(), survivors: [{ ...entry, hunk: { ...entry.hunk, path: "src/a\r.ts" } }] },
			{ ...record(), extra: true },
			{ ...record(), fleetRecordDigest: "nope" },
		];
		for (const value of invalid) {
			assert.throws(() => writeAdjudicationSourceRecord(root(), value as PrAdjudicationSourceRecordV1));
		}
	});

	it("validates refuted entries: decision, fingerprint integrity, survivor overlap, and count binding (#525)", () => {
		const entry = survivor();
		const goneFinding = finding({ message: "Alleged bug, refuted." });
		const gone = { finding: goneFinding, fingerprint: reviewFindingFingerprint(goneFinding), verification: { id: "C2", decision: "refuted" as const, rationale: "Not reproducible." } };
		// Valid: survivorCount binds survivors + refuted (the fleet carried count).
		const dir = root();
		writeAdjudicationSourceRecord(dir, record({ refuted: [gone], survivorCount: 2 }));
		assert.equal(readAdjudicationSourceRecord(dir, 497, REVIEWED)?.survivorCount, 2);
		const invalid = [
			// count not including the refuted entry
			{ ...record(), refuted: [gone] },
			// a refuted entry cannot claim survives
			{ ...record(), refuted: [{ ...gone, verification: { ...gone.verification, decision: "survives" } }], survivorCount: 2 },
			// one carried fingerprint cannot be both surviving and refuted
			{ ...record(), refuted: [{ finding: finding(), fingerprint: entry.fingerprint, verification: gone.verification }], survivorCount: 2 },
			// fingerprint must recompute from the finding
			{ ...record(), refuted: [{ ...gone, fingerprint: "tampered" }], survivorCount: 2 },
			// closed keys
			{ ...record(), refuted: [{ ...gone, hunk: { path: "src/a.ts", start: 1, end: 2 } }], survivorCount: 2 },
			// at least one genuine survivor
			{ ...record(), survivors: [], refuted: [gone], survivorCount: 1 },
			// rationale must be single-line — same trust-boundary rule as finding.message
			{ ...record(), refuted: [{ ...gone, verification: { ...gone.verification, rationale: "line one\nline two" } }], survivorCount: 2 },
			{ ...record(), survivors: [{ ...entry, verification: { ...entry.verification, rationale: "line one\nline two" } }] },
		];
		for (const value of invalid) {
			assert.throws(() => writeAdjudicationSourceRecord(root(), value as unknown as PrAdjudicationSourceRecordV1));
		}
	});

	/** One renderer input with an injection planted in exactly the given model-authored fields. */
	function renderWithInjection(inject: { survivorMessage?: string; survivorPath?: string; refutedMessage?: string; refutedPath?: string; dispositionRationale?: string; liveRationale?: string }): string {
		const survivorFinding = finding({
			...(inject.survivorMessage !== undefined ? { message: inject.survivorMessage } : {}),
			...(inject.survivorPath !== undefined ? { path: inject.survivorPath } : {}),
		});
		const survivorEntry = survivor({ finding: survivorFinding });
		const goneFinding = finding({
			message: inject.refutedMessage ?? "Alleged bug, refuted.",
			...(inject.refutedPath !== undefined ? { path: inject.refutedPath } : {}),
		});
		return renderOperatorAdjudicationComment({
			prNumber: 497,
			sourceSha: REVIEWED,
			headSha: HEAD,
			interdiffDigest: DIGEST,
			adjudicator: "op",
			survivors: [survivorEntry],
			refuted: [{ finding: goneFinding, fingerprint: reviewFindingFingerprint(goneFinding), verification: { id: "C2", decision: "refuted", rationale: inject.liveRationale ?? "Not reproducible." } }],
			dispositions: { [survivorEntry.fingerprint]: { disposition: "fixed", rationale: inject.dispositionRationale ?? "Contained by the source hunk." } },
		});
	}

	it("escapes every model-authored comment field so an injected marker cannot make the PASS comment a scrape target (#597 sweep)", () => {
		// fetchReviewFindings/revise-sweep selects any TRUSTED comment whose body contains the
		// fleet marker, and the operator PASS comment is trusted — so every model-authored field
		// on this surface must pass through the shared escapeMarkdown rule. Each field is tested
		// in isolation with both scrape-relevant markers.
		for (const marker of [PR_REVIEW_MARKER, LOCAL_MODE_MARKER]) {
			const inject = `pwn ${marker} tail`;
			const bodies: Array<[string, string]> = [
				["survivor message", renderWithInjection({ survivorMessage: inject })],
				["survivor path", renderWithInjection({ survivorPath: inject })],
				["refuted message", renderWithInjection({ refutedMessage: inject })],
				["refuted path", renderWithInjection({ refutedPath: inject })],
				["disposition rationale", renderWithInjection({ dispositionRationale: `Live isolated verification C1 refuted the finding (${inject}).` })],
				["live/fleet refutation rationale", renderWithInjection({ liveRationale: inject })],
			];
			for (const [field, body] of bodies) {
				assert.ok(!body.includes(marker), `${field}: the raw marker must not appear (${marker})`);
				assert.ok(body.includes("&lt;"), `${field}: escaped, not dropped`);
				assert.match(body, /### Findings/, `${field}: comment still renders legibly`);
				assert.match(body, /Carried findings already refuted by the fleet/, `${field}: refuted section intact`);
			}
		}
	});

	it("the actual revise-sweep marker matcher rejects a fully injected operator comment before any authority lookup (#597)", () => {
		const inject = `pwn ${PR_REVIEW_MARKER} tail`;
		const body = renderWithInjection({
			survivorMessage: inject,
			survivorPath: inject,
			refutedMessage: inject,
			refutedPath: inject,
			dispositionRationale: inject,
			liveRationale: inject,
		});
		const ghCalls: string[][] = [];
		const gh: GhRunner = (args) => {
			ghCalls.push([...args]);
			return { stdout: JSON.stringify({ comments: [{ body, createdAt: "2026-08-21T00:00:00Z", author: { login: "someone" } }] }), stderr: "", status: 0 };
		};
		// The selector's marker filter (`body.includes(PR_REVIEW_MARKER)`) runs before the trust
		// check; an escaped body must be rejected by the filter itself — exactly one gh call (the
		// pr view), never an identity/permission lookup, and nothing written.
		assert.equal(fetchReviewFindingsOutcome(gh, "o/r", 497, join(root(), "findings.md")), "no-trusted-comment");
		assert.equal(ghCalls.length, 1, "the marker filter must reject before any authority lookup");
	});

	it("rejects incomplete cells, non-surviving verification, and digest/count mismatches on read", () => {
		const dir = root();
		const path = writeAdjudicationSourceRecord(dir, record());
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		writeFileSync(path, `${JSON.stringify({ ...raw, requiredCells: 2, completedCells: 1 })}\n`);
		assert.equal(readAdjudicationSourceRecord(dir, 497, REVIEWED), null);

		writeAdjudicationSourceRecord(dir, record());
		const again = JSON.parse(readFileSync(path, "utf8")) as { survivors: Array<{ verification: { decision: string } }> };
		again.survivors[0]!.verification.decision = "refuted";
		writeFileSync(path, `${JSON.stringify(again)}\n`);
		assert.equal(readAdjudicationSourceRecord(dir, 497, REVIEWED), null);
	});

	it("rejects an oversized record", () => {
		const dir = root();
		const huge = survivor({ finding: finding({ message: OVERSIZE_MESSAGE }), fingerprint: reviewFindingFingerprint(finding({ message: OVERSIZE_MESSAGE })) });
		assert.throws(() => writeAdjudicationSourceRecord(dir, record({ survivors: [huge], survivorCount: 1 })));
		const path = join(dir, `497-${REVIEWED}.json`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, `${"a".repeat(1024 * 1024 + 8)}\n`);
		assert.equal(readAdjudicationSourceRecord(dir, 497, REVIEWED), null);
	});

	it("round-trips a disagreement adjudication source record", () => {
		const dir = root();
		writeAdjudicationSourceRecord(dir, record({ agreement: "disagreement" }));
		assert.equal(readAdjudicationSourceRecord(dir, 497, REVIEWED)?.agreement, "disagreement");
	});

	it("adjudicationSourcesDir lands under .dev", () => {
		assert.equal(adjudicationSourcesDir("/repo"), join("/repo", ".dev", "pr-review-adjudication-sources"));
	});
});

describe("emission-time classification", () => {
	it("bare finding strip omits closure so sidecar FINDING_KEYS stay closed (#756)", () => {
		const withClosure: ReviewFinding = { ...finding(), closure: "policy" };
		const built = buildAdjudicationSourceDraft({
			prNumber: 497,
			itemId: "497",
			reviewedSha: REVIEWED,
			agreement: "consensus-block",
			requiredCells: 1,
			completedCells: 1,
			ok: true,
			survivors: [withClosure],
			verifications: new Map([[reviewFindingFingerprint(withClosure), { id: "C1", decision: "survives" as const, rationale: "Still present." }]]),
			inspectionDiff: inspectionDiff(),
			changedFiles: ["src/a.ts"],
			taxonomy: BASELINE_TAXONOMY,
		});
		assert.ok(built);
		assert.equal("closure" in built.survivors[0]!.finding, false);
		assert.deepEqual(Object.keys(built.survivors[0]!.finding).sort(), ["line", "message", "path", "severity"]);
	});

	it("captures correctness-regression/safety for ambiguous schema-v1 findings", () => {
		const built = buildAdjudicationSourceDraft({
			prNumber: 497,
			itemId: "497",
			reviewedSha: REVIEWED,
			agreement: "consensus-block",
			requiredCells: 1,
			completedCells: 1,
			ok: true,
			survivors: [finding()],
			verifications: new Map([[reviewFindingFingerprint(finding()), { id: "C1", decision: "survives" as const, rationale: "Still present." }]]),
			inspectionDiff: inspectionDiff(),
			changedFiles: ["src/a.ts"],
			taxonomy: BASELINE_TAXONOMY,
		});
		assert.ok(built);
		assert.equal(built.survivors[0]?.class, "correctness-regression");
		assert.equal(built.survivors[0]?.tier, "safety");
		assert.equal(built.survivors[0]?.classification.kind, "default-safety");
	});

	it("stores the emission-time judgment tier from an allowlisted ruleId, not operator prose", () => {
		const judged: ReviewFinding & { ruleId: string } = { ...finding(), ruleId: "pelaggio/judgment/docs" };
		const taxonomy: TaxonomyConfig = BASELINE_TAXONOMY;
		const built = buildAdjudicationSourceDraft({
			prNumber: 497,
			itemId: "497",
			reviewedSha: REVIEWED,
			agreement: "consensus-block",
			requiredCells: 1,
			completedCells: 1,
			ok: true,
			survivors: [judged],
			verifications: new Map([[reviewFindingFingerprint(judged), { id: "C1", decision: "survives" as const, rationale: "Still present." }]]),
			inspectionDiff: inspectionDiff(),
			changedFiles: ["src/a.ts"],
			taxonomy,
		});
		assert.ok(built);
		assert.equal(built.survivors[0]?.tier, "judgment");
		assert.equal(built.survivors[0]?.class, "judgment");
	});

	it("emits a draft for a complete disagreement split and suppresses non-adjudicable shapes (#525)", () => {
		const base = {
			prNumber: 497,
			itemId: "497",
			reviewedSha: REVIEWED,
			requiredCells: 3,
			completedCells: 3,
			ok: true,
			survivors: [finding()],
			verifications: new Map([[reviewFindingFingerprint(finding()), { id: "C1", decision: "survives" as const, rationale: "Still present." }]]),
			inspectionDiff: inspectionDiff(),
			changedFiles: ["src/a.ts"],
			taxonomy: BASELINE_TAXONOMY,
		} as const;
		const built = buildAdjudicationSourceDraft({ ...base, agreement: "disagreement" });
		assert.ok(built);
		assert.equal(built.agreement, "disagreement");
		assert.equal(buildAdjudicationSourceDraft({ ...base, agreement: "consensus-pass" }), undefined);
		assert.equal(buildAdjudicationSourceDraft({ ...base, agreement: "invalid" }), undefined);
		assert.equal(buildAdjudicationSourceDraft({ ...base, agreement: "disagreement", ok: false }), undefined);
	});

	it("splits latest-refuted carried findings into refuted entries instead of suppressing the draft (#525 must-fix)", () => {
		const surviving = finding();
		// Unmappable on purpose (line outside every hunk): refuted entries need no hunk, so this
		// must NOT suppress the draft the way an unmappable SURVIVOR does.
		const gone = finding({ message: "Alleged bug, refuted.", line: 99 });
		const base = {
			prNumber: 497,
			itemId: "497",
			reviewedSha: REVIEWED,
			agreement: "disagreement",
			requiredCells: 3,
			completedCells: 3,
			ok: true,
			survivors: [surviving, gone],
			inspectionDiff: inspectionDiff(),
			changedFiles: ["src/a.ts"],
			taxonomy: BASELINE_TAXONOMY,
		} as const;
		const built = buildAdjudicationSourceDraft({
			...base,
			verifications: new Map([
				[reviewFindingFingerprint(surviving), { id: "C1", decision: "survives" as const, rationale: "Still present." }],
				[reviewFindingFingerprint(gone), { id: "C2", decision: "refuted" as const, rationale: "Fixed in the final iteration." }],
			]),
		});
		assert.ok(built);
		assert.equal(built.survivorCount, 2);
		assert.equal(built.survivors.length, 1);
		assert.equal(built.survivors[0]?.finding.message, surviving.message);
		assert.deepEqual(built.refuted, [{ finding: gone, fingerprint: reviewFindingFingerprint(gone), verification: { id: "C2", decision: "refuted", rationale: "Fixed in the final iteration." } }]);
		// Round-trips through the store and stays bindable.
		const dir = root();
		writeAdjudicationSourceRecord(dir, { ...built, fleetRecordDigest: DIGEST });
		assert.equal(readAdjudicationSourceRecord(dir, 497, REVIEWED)?.refuted.length, 1);
		// All-refuted leaves nothing to adjudicate — no draft.
		assert.equal(
			buildAdjudicationSourceDraft({
				...base,
				verifications: new Map([
					[reviewFindingFingerprint(surviving), { id: "C1", decision: "refuted" as const, rationale: "Gone." }],
					[reviewFindingFingerprint(gone), { id: "C2", decision: "refuted" as const, rationale: "Gone." }],
				]),
			}),
			undefined,
		);
	});
});

describe("fleet eligibility and binding", () => {
	it("accepts a complete v2 consensus-block, including a budget breaker with a complete matrix", () => {
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet() }), true);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ breakerReason: "budget" }) }), true);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ breakerReason: "max-passes" }) }), true);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ breakerReason: "diminishing-returns" }) }), true);
	});

	it("accepts current verdict-split and historical invalid-pass disagreement records (#593)", () => {
		// Live shape from .dev/pr-review-gate-records/589-c0051a…json: a genuine verdict split
		// (claude=pass, codex=block, grok=pass) historically labeled `invalid-pass` even though
		// ok=true proves every review was structurally valid.
		const prShape = fleet({ subtype: "invalid-pass", agreement: "disagreement", breakerReason: "invalid-pass", iterations: 1, survivorCount: 4 });
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...prShape }), true);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ agreement: "disagreement" }) }), true);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ subtype: "verdict-split", breakerReason: "verdict-split", agreement: "disagreement" }) }), true);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ breakerReason: "invalid-pass", agreement: "disagreement" }) }), true);
		// A genuinely broken run (parse/infra failure) keeps ok=false / agreement=invalid — refused.
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ ok: false, agreement: "invalid", breakerReason: "invalid-pass" }) }), false);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ agreement: "invalid", breakerReason: "invalid-pass" }) }), false);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ ok: false, agreement: "disagreement", breakerReason: "invalid-pass" }) }), false);
	});

	it("pins the loop-unreachable consensus-block+invalid-pass combo as eligible on completeness alone (#525, deliberate)", () => {
		// The convergence loop never emits breaker invalid-pass alongside consensus-block. If such
		// a record appears anyway, eligibility keys on the completeness fields (ok, agreement,
		// survivors) — refusing on the breaker token would add no integrity, since a forged record
		// can name any breaker. Pinned so the INELIGIBLE_BREAKERS loosening stays deliberate.
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ breakerReason: "invalid-pass" }) }), true);
	});

	it("refuses v1, operator, pass, broken-review, diversity, zero-survivor, and mismatched-count cases", () => {
		assert.equal(
			isEligibleFleetGateRecord({
				schemaVersion: 1,
				prNumber: 497,
				headSha: REVIEWED,
				itemId: "497",
				gate: "block",
				ok: true,
				subtype: "consensus-block",
				agreement: "consensus-block",
				survivorCount: 1,
				cost: 1,
				costEstimated: false,
				turns: 4,
				runner: "local",
				reviewedAt: "2026-08-13T12:00:00.000Z",
			}),
			false,
		);
		assert.equal(
			isEligibleFleetGateRecord({
				schemaVersion: 2,
				producer: "operator-adjudication",
				agreement: "not-run",
				prNumber: 497,
				itemId: "497",
				headSha: HEAD,
				gate: "pass",
				runner: "local",
				reviewedAt: "2026-08-13T12:00:00.000Z",
				adjudicator: "op",
				reviewedSourceSha: REVIEWED,
				interdiffDigest: DIGEST,
				dispositions: {},
			}),
			false,
		);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ gate: "pass", agreement: "consensus-pass", survivorCount: 0 }) }), false);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ agreement: "consensus-pass" }) }), false);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ agreement: "invalid" }) }), false);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ breakerReason: "provider-diversity", agreement: "invalid" }) }), false);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ breakerReason: "provider-diversity" }) }), false);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ ok: false }) }), false);
		assert.equal(isEligibleFleetGateRecord({ schemaVersion: 2, ...fleet({ survivorCount: 0 }) }), false);
	});

	it("scopes fleet records to the target PR and item before refusing ambiguity (#510, #514)", () => {
		const older = { schemaVersion: 2, ...fleet({ reviewedAt: "2026-08-01T00:00:00.000Z" }) } as PrReviewGateRecord;
		const forgedNewer = { schemaVersion: 2, ...fleet({ reviewedAt: "2027-01-01T00:00:00.000Z", headSha: HEAD }) } as PrReviewGateRecord;
		const otherPr = { schemaVersion: 2, ...fleet({ prNumber: 500 }) } as PrReviewGateRecord;
		const otherItem = { schemaVersion: 2, ...fleet({ itemId: "500", headSha: HEAD }) } as PrReviewGateRecord;
		const operator = {
			schemaVersion: 2 as const,
			producer: "operator-adjudication" as const,
			agreement: "not-run" as const,
			prNumber: 497,
			itemId: "497",
			headSha: HEAD,
			gate: "pass" as const,
			runner: "local" as const,
			reviewedAt: "2026-08-03T00:00:00.000Z",
			adjudicator: "op",
			reviewedSourceSha: REVIEWED,
			interdiffDigest: DIGEST,
			dispositions: {},
		};
		assert.deepEqual(selectUnambiguousFleetGateRecord([], 497, "497"), { kind: "none" });
		assert.deepEqual(selectUnambiguousFleetGateRecord([operator], 497, "497"), { kind: "none" });
		assert.deepEqual(selectUnambiguousFleetGateRecord([older, operator, otherPr, otherItem], 497, "497"), { kind: "one", record: older });
		// A forged record with a future model-supplied reviewedAt must NOT win selection — two
		// qualifying fleet records refuse, naming both files.
		const ambiguous = selectUnambiguousFleetGateRecord([older, operator, forgedNewer], 497, "497");
		assert.equal(ambiguous.kind, "ambiguous");
		assert.deepEqual(ambiguous.kind === "ambiguous" ? ambiguous.files : [], [`497-${REVIEWED}.json`, `497-${HEAD}.json`].sort());
	});

	it("cross-checks identity, counts, agreement, and the exact fleet-file digest", () => {
		const dir = root();
		const path = writePrReviewGateRecord(dir, fleet());
		const bytes = readFileSync(path);
		const source = record({ fleetRecordDigest: fleetRecordDigestOf(bytes) });
		assert.deepEqual(crossCheckAdjudicationSource(source, { schemaVersion: 2, ...fleet() }, bytes, { prNumber: 497, itemId: "497" }), { ok: true });
		assert.equal(crossCheckAdjudicationSource(source, { schemaVersion: 2, ...fleet() }, Buffer.from("tampered"), { prNumber: 497, itemId: "497" }).ok, false);
		assert.equal(crossCheckAdjudicationSource({ ...source, prNumber: 1 }, { schemaVersion: 2, ...fleet() }, bytes, { prNumber: 497, itemId: "497" }).ok, false);
		// #525: the agreements must match EXACTLY — a consensus-block sidecar cannot bind a
		// disagreement fleet record or vice versa, while a matching disagreement pair binds.
		const splitFleet = fleet({ agreement: "disagreement", breakerReason: "invalid-pass", subtype: "invalid-pass" });
		const splitPath = writePrReviewGateRecord(root(), splitFleet);
		const splitBytes = readFileSync(splitPath);
		const splitSource = record({ agreement: "disagreement", fleetRecordDigest: fleetRecordDigestOf(splitBytes) });
		assert.deepEqual(crossCheckAdjudicationSource(splitSource, { schemaVersion: 2, ...splitFleet }, splitBytes, { prNumber: 497, itemId: "497" }), { ok: true });
		assert.equal(crossCheckAdjudicationSource(source, { schemaVersion: 2, ...splitFleet }, splitBytes, { prNumber: 497, itemId: "497" }).ok, false);
		assert.equal(crossCheckAdjudicationSource({ ...splitSource, agreement: "consensus-block" }, { schemaVersion: 2, ...splitFleet }, splitBytes, { prNumber: 497, itemId: "497" }).ok, false);
		// The fleet carried count includes refuted-retained findings: survivors + refuted must bind it.
		const goneFinding = finding({ message: "Alleged bug, refuted." });
		const gone = { finding: goneFinding, fingerprint: reviewFindingFingerprint(goneFinding), verification: { id: "C2", decision: "refuted" as const, rationale: "Not reproducible." } };
		const carriedFleet = fleet({ agreement: "disagreement", breakerReason: "invalid-pass", subtype: "invalid-pass", survivorCount: 2 });
		const carriedPath = writePrReviewGateRecord(root(), carriedFleet);
		const carriedBytes = readFileSync(carriedPath);
		const carriedSource = record({ agreement: "disagreement", refuted: [gone], survivorCount: 2, fleetRecordDigest: fleetRecordDigestOf(carriedBytes) });
		assert.deepEqual(crossCheckAdjudicationSource(carriedSource, { schemaVersion: 2, ...carriedFleet }, carriedBytes, { prNumber: 497, itemId: "497" }), { ok: true });
		assert.equal(crossCheckAdjudicationSource({ ...carriedSource, refuted: [] }, { schemaVersion: 2, ...carriedFleet }, carriedBytes, { prNumber: 497, itemId: "497" }).ok, false);
		assert.equal(
			crossCheckAdjudicationSource(
				{ ...source, survivorCount: 2, survivors: [survivor(), survivor({ finding: finding({ message: "other" }), fingerprint: reviewFindingFingerprint(finding({ message: "other" })) })] },
				{ schemaVersion: 2, ...fleet() },
				bytes,
				{ prNumber: 497, itemId: "497" },
			).ok,
			false,
		);
	});
});

describe("source-hunk mapping", () => {
	it("maps first and last lines of a hunk and keeps multiple findings in one hunk", () => {
		const patches = parsePatch(inspectionDiff({ newStart: 8 }));
		assert.deepEqual(mapFindingToInspectionHunk(finding({ line: 8 }), patches), { path: "src/a.ts", start: 8, end: 12 });
		assert.deepEqual(mapFindingToInspectionHunk(finding({ line: 12 }), patches), { path: "src/a.ts", start: 8, end: 12 });
		assert.deepEqual(mapFindingToInspectionHunk(finding({ line: 10 }), patches), { path: "src/a.ts", start: 8, end: 12 });
	});

	it("maps each finding onto its own hunk when a file has several", () => {
		const path = "src/a.ts";
		const diff = [
			`diff --git a/${path} b/${path}`,
			`index 1111111..2222222 100644`,
			`--- a/${path}`,
			`+++ b/${path}`,
			`@@ -8,5 +8,5 @@`,
			" context",
			" context",
			"-old",
			"+new",
			" context",
			" context",
			`@@ -40,2 +40,2 @@`,
			" keep",
			"-old",
			"+new",
			"",
		].join("\n");
		const patches = parsePatch(diff);
		assert.deepEqual(mapFindingToInspectionHunk(finding({ line: 10 }), patches), { path: "src/a.ts", start: 8, end: 12 });
		assert.deepEqual(mapFindingToInspectionHunk(finding({ line: 41 }), patches), { path: "src/a.ts", start: 40, end: 41 });
	});

	it("returns null for locationless, /dev/null, deleted, and unmappable findings", () => {
		const patches = parsePatch(inspectionDiff());
		assert.equal(mapFindingToInspectionHunk({ severity: "must-fix", message: "no loc" }, patches), null);
		assert.equal(mapFindingToInspectionHunk(finding({ path: "/dev/null", line: 1 }), patches), null);
		assert.equal(mapFindingToInspectionHunk(finding({ line: 99 }), patches), null);
		assert.equal(normalizeGitPath("/dev/null"), null);
		const deleted = parsePatch(["diff --git a/src/a.ts b/src/a.ts", "deleted file mode 100644", "index 111..000", "--- a/src/a.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-gone", ""].join("\n"));
		assert.equal(mapFindingToInspectionHunk(finding({ line: 1 }), deleted), null);
	});

	it("suppresses the whole draft when any survivor is unmappable", () => {
		const located = finding();
		const missing = { severity: "must-fix" as const, message: "no location" };
		const built = buildAdjudicationSourceDraft({
			prNumber: 497,
			itemId: "497",
			reviewedSha: REVIEWED,
			agreement: "consensus-block",
			requiredCells: 1,
			completedCells: 1,
			ok: true,
			survivors: [located, missing],
			verifications: new Map([
				[reviewFindingFingerprint(located), { id: "C1", decision: "survives" as const, rationale: "A" }],
				[reviewFindingFingerprint(missing), { id: "C2", decision: "survives" as const, rationale: "B" }],
			]),
			inspectionDiff: inspectionDiff(),
			changedFiles: ["src/a.ts"],
			taxonomy: BASELINE_TAXONOMY,
		});
		assert.equal(built, undefined);
	});
});

describe("zero-context interdiff policy", () => {
	const entry = survivor();

	it("accepts an in-range replacement and hashes the exact interdiff bytes", () => {
		const patch = replacementDiff("src/a.ts", 10, "old", "new");
		const result = evaluateInterdiffPolicy({ isAncestor: true, interdiff: patch, survivors: [entry] });
		assert.equal(result.kind, "eligible");
		if (result.kind !== "eligible") return;
		assert.equal(result.digest, createHash("sha256").update(patch).digest("hex"));
		assert.equal(result.dispositions[entry.fingerprint]?.disposition, "fixed");
		assert.match(result.dispositions[entry.fingerprint]?.rationale ?? "", /src\/a\.ts:8-14/);
		assert.match(result.dispositions[entry.fingerprint]?.rationale ?? "", /C1/);
	});

	it("accepts insertions whose old-side anchor is inside the range or on an immediate start/end boundary", () => {
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: insertionDiff("src/a.ts", 10, "mid"), survivors: [entry] }).kind, "eligible");
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: insertionDiff("src/a.ts", 7, "prepend"), survivors: [entry] }).kind, "eligible");
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: insertionDiff("src/a.ts", 14, "append"), survivors: [entry] }).kind, "eligible");
	});

	it("bounds added lines by the covering finding-hunk extent (#497 churn guard)", () => {
		// The recorded hunk src/a.ts:8-14 spans 7 lines — the same bound the deleted-side
		// containment implies. A genuinely minimal replacement stays eligible…
		const minimal = evaluateInterdiffPolicy({ isAncestor: true, interdiff: paddedReplacementDiff("src/a.ts", 10, 3), survivors: [entry] });
		assert.equal(minimal.kind, "eligible");
		// …while a one-line in-range replacement that adds broad unreviewed churn is refused.
		const broad = evaluateInterdiffPolicy({ isAncestor: true, interdiff: paddedReplacementDiff("src/a.ts", 10, 8), survivors: [entry] });
		assert.equal(broad.kind, "refused");
		if (broad.kind === "refused") assert.match(broad.reason, /adds 8 lines, exceeding the 7-line extent/);
		// Pure insertions carry the same bound: an in-range anchor does not authorize bulk additions.
		const insertion = evaluateInterdiffPolicy({ isAncestor: true, interdiff: multiInsertionDiff("src/a.ts", 10, 8), survivors: [entry] });
		assert.equal(insertion.kind, "refused");
		if (insertion.kind === "refused") assert.match(insertion.reason, /adds 8 lines/);
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: multiInsertionDiff("src/a.ts", 10, 7), survivors: [entry] }).kind, "eligible");
	});

	it("enforces an aggregate added-line cap across the whole interdiff (#510: 132 lines vs extent 11)", () => {
		// Recorded finding hunk src/a.ts:10-20 — extent 11. With --unified=0, one insertion hunk
		// per legal anchor (old lines 9..20 → 12 anchors) at 11 added lines each stays within the
		// per-hunk bound on every hunk while adding 132 unreviewed lines in total. The aggregate
		// cap (total added ≤ total deduped covering extent) must refuse it.
		const wideFinding = finding({ line: 15 });
		const wide = survivor({ finding: wideFinding, fingerprint: reviewFindingFingerprint(wideFinding), hunk: { path: "src/a.ts", start: 10, end: 20 } });
		const anchors = Array.from({ length: 12 }, (_, i) => 9 + i);
		const flood = evaluateInterdiffPolicy({ isAncestor: true, interdiff: anchoredInsertionsDiff("src/a.ts", anchors, 11), survivors: [wide] });
		assert.equal(flood.kind, "refused");
		if (flood.kind === "refused") assert.match(flood.reason, /adds 132 lines in total, exceeding the 11-line total extent/);
		// The cap is aggregate IN ADDITION TO per-hunk: several hunks that fit the total stay eligible…
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: anchoredInsertionsDiff("src/a.ts", [9, 14], 5), survivors: [wide] }).kind, "eligible");
		// …while two hunks each within the per-hunk bound but exceeding the total are refused.
		const overTotal = evaluateInterdiffPolicy({ isAncestor: true, interdiff: anchoredInsertionsDiff("src/a.ts", [9, 14], 7), survivors: [wide] });
		assert.equal(overTotal.kind, "refused");
		if (overTotal.kind === "refused") assert.match(overTotal.reason, /adds 14 lines in total, exceeding the 11-line total extent/);
	});

	it("bounds added-line bytes by the replaced lines' own length, clamped to floor/ceiling (#510)", () => {
		// A one-line in-range replacement whose single added line is arbitrarily large must be
		// ineligible: line-count bounds alone cannot see bytes. Short original lines yield the
		// 200-byte floor…
		const huge = evaluateInterdiffPolicy({ isAncestor: true, interdiff: replacementDiff("src/a.ts", 10, "old", "x".repeat(1500)), survivors: [entry] });
		assert.equal(huge.kind, "refused");
		if (huge.kind === "refused") assert.match(huge.reason, /adds a 1500-byte line, exceeding the 200-byte per-line ceiling/);
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: replacementDiff("src/a.ts", 10, "old", "x".repeat(180)), survivors: [entry] }).kind, "eligible");
		// …a genuinely long replaced line raises the ceiling to its own byte length…
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: replacementDiff("src/a.ts", 10, "y".repeat(600), "x".repeat(590)), survivors: [entry] }).kind, "eligible");
		const overOwn = evaluateInterdiffPolicy({ isAncestor: true, interdiff: replacementDiff("src/a.ts", 10, "y".repeat(600), "x".repeat(700)), survivors: [entry] });
		assert.equal(overOwn.kind, "refused");
		if (overOwn.kind === "refused") assert.match(overOwn.reason, /700-byte line, exceeding the 600-byte per-line ceiling/);
		// …and the 1000-byte ceiling caps the allowance no matter how long the original was.
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: replacementDiff("src/a.ts", 10, "y".repeat(5000), "x".repeat(990)), survivors: [entry] }).kind, "eligible");
		const clamped = evaluateInterdiffPolicy({ isAncestor: true, interdiff: replacementDiff("src/a.ts", 10, "y".repeat(5000), "x".repeat(1200)), survivors: [entry] });
		assert.equal(clamped.kind, "refused");
		if (clamped.kind === "refused") assert.match(clamped.reason, /1200-byte line, exceeding the 1000-byte per-line ceiling/);
		// Pure insertions have no original text: the floor is the whole allowance.
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: insertionDiff("src/a.ts", 10, "x".repeat(150)), survivors: [entry] }).kind, "eligible");
		const insertionOver = evaluateInterdiffPolicy({ isAncestor: true, interdiff: insertionDiff("src/a.ts", 10, "x".repeat(250)), survivors: [entry] });
		assert.equal(insertionOver.kind, "refused");
		if (insertionOver.kind === "refused") assert.match(insertionOver.reason, /250-byte line, exceeding the 200-byte per-line ceiling/);
	});

	it("binds live adjudication-time refutation evidence over the stale red-review survives text", () => {
		const result = evaluateInterdiffPolicy({ isAncestor: true, interdiff: replacementDiff("src/a.ts", 10, "old", "new"), survivors: [entry] });
		assert.equal(result.kind, "eligible");
		if (result.kind !== "eligible") return;
		// Containment dispositions never claim repair confirmation from the pre-fix pass.
		assert.doesNotMatch(result.dispositions[entry.fingerprint]?.rationale ?? "", /confirmed the repair/);
		assert.doesNotMatch(result.dispositions[entry.fingerprint]?.rationale ?? "", /Confirmed against the inspected head/);
		const live = new Map([[entry.fingerprint, { id: "C1", decision: "refuted" as const, rationale: "Null guard added; the deref is unreachable." }]]);
		const bound = bindLiveSafetyVerification([entry], result.dispositions, live);
		const rationale = bound[entry.fingerprint]?.rationale ?? "";
		// The LIVE verification's decision and rationale are quoted…
		assert.match(rationale, /refuted the finding \(Null guard added; the deref is unreachable\.\)/);
		// …the stale pre-fix text is never persisted…
		assert.doesNotMatch(rationale, /Confirmed against the inspected head/);
		// …and the record names which pass produced the evidence.
		assert.match(rationale, /adjudication-time/);
		assert.match(rationale, /red-review verification C1/);
		assert.equal(bound[entry.fingerprint]?.disposition, "fixed");
	});

	it("bindLiveSafetyVerification fails closed without live evidence and leaves judgment entries untouched", () => {
		const judgment = survivor({ tier: "judgment", class: "judgment", classification: { kind: "matched", class: "judgment", signal: "ruleId", ruleId: "rule-judgment-docs" } });
		const result = evaluateInterdiffPolicy({ isAncestor: true, interdiff: replacementDiff("src/a.ts", 10, "old", "new"), survivors: [judgment] });
		assert.equal(result.kind, "eligible");
		if (result.kind !== "eligible") return;
		const untouched = bindLiveSafetyVerification([judgment], result.dispositions, new Map());
		assert.deepEqual(untouched, result.dispositions);
		assert.throws(() => bindLiveSafetyVerification([entry], { [entry.fingerprint]: { disposition: "fixed", rationale: "containment only" } }, new Map()), /no live adjudication-time verification evidence/);
	});

	it("refuses extra files, extra hunks, further-out escapes, and uncovered survivors", () => {
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: replacementDiff("src/b.ts", 10, "old", "new"), survivors: [entry] }).kind, "refused");
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: insertionDiff("src/a.ts", 6, "too far"), survivors: [entry] }).kind, "refused");
		const other = survivor({ finding: finding({ message: "other", line: 40 }), fingerprint: reviewFindingFingerprint(finding({ message: "other", line: 40 })), hunk: { path: "src/a.ts", start: 38, end: 44 } });
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: replacementDiff("src/a.ts", 10, "old", "new"), survivors: [entry, other] }).kind, "refused");
	});

	it("refuses mode changes, rename, create, delete, binary, malformed, empty, and non-ancestor history", () => {
		const modeOnly = ["diff --git a/src/a.ts b/src/a.ts", "old mode 100644", "new mode 100755", ""].join("\n");
		const modeResult = evaluateInterdiffPolicy({ isAncestor: true, interdiff: modeOnly, survivors: [entry] });
		assert.equal(modeResult.kind, "refused");
		if (modeResult.kind === "refused") assert.match(modeResult.reason, /changes the file mode/);
		// #510 must-fix: an in-range text edit combined with mode metadata is a chmod smuggle —
		// refused regardless of hunk content, not only when the patch is hunkless.
		const modeWithEdit = ["diff --git a/src/a.ts b/src/a.ts", "old mode 100644", "new mode 100755", "index 1111111..2222222", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,1 +10,1 @@", "-old", "+new", ""].join("\n");
		const modeEditResult = evaluateInterdiffPolicy({ isAncestor: true, interdiff: modeWithEdit, survivors: [entry] });
		assert.equal(modeEditResult.kind, "refused");
		if (modeEditResult.kind === "refused") assert.match(modeEditResult.reason, /changes the file mode/);
		const rename = ["diff --git a/src/a.ts b/src/b.ts", "similarity index 100%", "rename from src/a.ts", "rename to src/b.ts", ""].join("\n");
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: rename, survivors: [entry] }).kind, "refused");
		const created = ["diff --git a/src/c.ts b/src/c.ts", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/src/c.ts", "@@ -0,0 +1,1 @@", "+hello", ""].join("\n");
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: created, survivors: [entry] }).kind, "refused");
		const deleted = ["diff --git a/src/a.ts b/src/a.ts", "deleted file mode 100644", "index 1111111..0000000", "--- a/src/a.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-gone", ""].join("\n");
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: deleted, survivors: [entry] }).kind, "refused");
		const binary = ["diff --git a/src/a.ts b/src/a.ts", "index 1111111..2222222", "Binary files a/src/a.ts and b/src/a.ts differ", ""].join("\n");
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: binary, survivors: [entry] }).kind, "refused");
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: "not a patch", survivors: [entry] }).kind, "refused");
		assert.equal(evaluateInterdiffPolicy({ isAncestor: true, interdiff: "", survivors: [entry] }).kind, "refused");
		assert.match((evaluateInterdiffPolicy({ isAncestor: false, interdiff: replacementDiff("src/a.ts", 10, "old", "new"), survivors: [entry] }) as { reason: string }).reason, /does not descend/);
	});

	it("renders a deterministic operator comment that names every disposition", () => {
		const patch = replacementDiff("src/a.ts", 10, "old", "new");
		const result = evaluateInterdiffPolicy({ isAncestor: true, interdiff: patch, survivors: [entry] });
		assert.equal(result.kind, "eligible");
		if (result.kind !== "eligible") return;
		const body = renderOperatorAdjudicationComment({
			prNumber: 497,
			sourceSha: REVIEWED,
			headSha: HEAD,
			interdiffDigest: result.digest,
			adjudicator: "chris",
			survivors: [entry],
			dispositions: result.dispositions,
		});
		// #510: the operator comment carries its OWN marker. It must never contain the fleet
		// marker that fetchReviewFindings scrapes into revise/implement prompts — a failed status
		// post would otherwise feed this PASS body back as "findings".
		assert.match(body, /<!-- pelaggio-pr-adjudication -->/);
		assert.ok(!body.includes("<!-- pelaggio-pr-review -->"));
		assert.match(body, /Operator adjudication: PASS/);
		assert.match(body, new RegExp(REVIEWED));
		assert.match(body, new RegExp(HEAD));
		assert.match(body, /chris/);
		assert.match(body, /fixed/);
		assert.match(body, /pr-adjudicate --pr 497/);
	});

	it("cites the live at-head confirmation on refuted lines, not only the stale fleet refutation (#598)", () => {
		const goneFinding = finding({ message: "Alleged bug, refuted." });
		const gone = { finding: goneFinding, fingerprint: reviewFindingFingerprint(goneFinding), verification: { id: "C9", decision: "refuted" as const, rationale: "Not reproducible." } };
		const base = {
			prNumber: 497,
			sourceSha: REVIEWED,
			headSha: HEAD,
			interdiffDigest: DIGEST,
			adjudicator: "op",
			survivors: [entry],
			refuted: [gone],
		};
		const liveBound = renderOperatorAdjudicationComment({
			...base,
			dispositions: {
				[entry.fingerprint]: { disposition: "fixed", rationale: "Contained by the source hunk." },
				[gone.fingerprint]: {
					disposition: "refuted",
					rationale:
						"Live isolated verification C2 at the repaired head confirmed the finding remains refuted (Still absent at the repaired head.). " +
						"Fleet verification C9 first refuted it at the reviewed SHA; that stale evidence alone never clears an entry at a different SHA.",
				},
			},
		});
		const line = liveBound.split("\n").find((text) => text.includes("Alleged bug")) ?? "";
		// The line cites the LIVE confirmation (id + head-bound phrasing) that authorized the
		// clearance, with the fleet refutation as provenance — never the stale fleet text alone.
		assert.match(line, /\*\*refuted\*\*/);
		assert.match(line, /Live isolated verification C2 at the repaired head/);
		assert.match(line, /Fleet verification C9 first refuted it at the reviewed SHA/);
		assert.match(line, /no repair required/);
		assert.doesNotMatch(line, /by fleet isolated verification C9/);
		assert.doesNotMatch(line, /Not reproducible/);
		// Without a bound disposition the renderer falls back to the fleet provenance, escaped.
		const fallback = renderOperatorAdjudicationComment({ ...base, dispositions: { [entry.fingerprint]: { disposition: "fixed", rationale: "Contained by the source hunk." } } });
		const fallbackLine = fallback.split("\n").find((text) => text.includes("Alleged bug")) ?? "";
		assert.match(fallbackLine, /\*\*refuted\*\* by fleet isolated verification C9/);
	});

	it("renders model-authored paths in a code span a literal backtick cannot terminate (#598)", () => {
		const render = (path: string): string =>
			renderOperatorAdjudicationComment({
				prNumber: 497,
				sourceSha: REVIEWED,
				headSha: HEAD,
				interdiffDigest: DIGEST,
				adjudicator: "op",
				survivors: [survivor({ finding: finding({ path }) })],
				dispositions: {},
			});
		const body = render("src/`weird`.ts");
		// Space-padded double-backtick fence, intact around the whole location.
		const span = body.match(/\(`` (.+?) ``\)/);
		assert.ok(span, "location renders inside a space-padded double-backtick span");
		const content = span?.[1] ?? "";
		assert.ok(content.includes("weird"));
		assert.ok(content.includes(":10"), "the line number stays inside the span");
		// escapeMarkdown backslash-prefixes every backtick, so the content never carries the
		// adjacent pair that would terminate the fence.
		assert.ok(!content.includes("``"), "no double-backtick run inside the span content");
		// Marker injection through a backtick-laden path stays blocked by the shared escape.
		const evil = render(`a\`\` ${PR_REVIEW_MARKER} \`\`b`);
		assert.ok(!evil.includes(PR_REVIEW_MARKER));
		assert.match(evil, /\(`` (.+?) ``\)/, "the injected path still renders inside an intact span");
	});
});
