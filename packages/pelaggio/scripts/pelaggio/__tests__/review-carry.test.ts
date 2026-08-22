import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULTS } from "../config.js";
import { fleetRecordDigestOf } from "../review/adjudication.js";
import {
	buildCarryDispositionDraft,
	type CarrySourceSelection,
	computeTouchedPaths,
	FINDING_DISPOSITION_MAX_ENTRIES,
	listPrFindingDispositionRecords,
	type PrCarryRefutedEntry,
	type PrCarrySurvivorEntry,
	type PrFindingDispositionRecordV1,
	planCarry,
	readPrFindingDispositionRecord,
	selectCarrySource,
	validatePrFindingDispositionRecord,
	writePrFindingDispositionRecord,
} from "../review/carry.js";
import { type ReviewFinding, reviewFindingFingerprint } from "../review/findings.js";

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "review-carry-"));
	tmpDirs.push(dir);
	return dir;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const HEAD = "d".repeat(40);
const TAXONOMY = DEFAULTS.review.taxonomy;

function finding(message: string, path?: string, line?: number): ReviewFinding {
	return { severity: "must-fix", message, ...(path !== undefined ? { path } : {}), ...(line !== undefined ? { line } : {}) };
}

function survivor(f: ReviewFinding, over: Partial<PrCarrySurvivorEntry> = {}): PrCarrySurvivorEntry {
	return { finding: f, fingerprint: reviewFindingFingerprint(f), class: "correctness-regression", tier: "safety", verification: { id: "C1", rationale: "Still present." }, ...over };
}

function refuted(f: ReviewFinding, over: Omit<Partial<PrCarryRefutedEntry>, "refutation"> & { refutation?: Partial<PrCarryRefutedEntry["refutation"]> } = {}): PrCarryRefutedEntry {
	const { refutation, ...rest } = over;
	return {
		finding: f,
		fingerprint: reviewFindingFingerprint(f),
		class: "judgment",
		tier: "judgment",
		...rest,
		refutation: { provenance: "verified", id: "C2", refutedAtSha: SHA_A, ...refutation },
	};
}

function record(over: Partial<PrFindingDispositionRecordV1> = {}): PrFindingDispositionRecordV1 {
	return {
		schemaVersion: 1,
		prNumber: 495,
		itemId: "495",
		headSha: SHA_A,
		gate: "block",
		agreement: "consensus-block",
		ok: true,
		fleetRecordDigest: "0".repeat(64),
		reviewedAt: "2026-08-20T12:00:00.000Z",
		survived: [survivor(finding("Unfixed bug.", "src/a.ts", 7))],
		refuted: [refuted(finding("Stale worry.", "src/other.ts", 5))],
		...over,
	};
}

describe("finding-disposition record store", () => {
	it("round-trips a record through the atomic write and strict read", () => {
		const root = tmpRoot();
		const path = writePrFindingDispositionRecord(root, record());
		assert.match(path, new RegExp(`495-${SHA_A}\\.json$`));
		assert.deepEqual(readPrFindingDispositionRecord(root, 495, SHA_A), record());
		const listing = listPrFindingDispositionRecords(root);
		assert.deepEqual(listing.invalid, []);
		assert.deepEqual(listing.records, [record()]);
	});

	it("refuses unknown keys at every level", () => {
		const cases: unknown[] = [
			{ ...record(), extra: 1 },
			record({ survived: [{ ...survivor(finding("A.", "src/a.ts", 1)), extra: 1 } as unknown as PrCarrySurvivorEntry] }),
			record({ refuted: [{ ...refuted(finding("B.", "src/b.ts", 1)), extra: 1 } as unknown as PrCarryRefutedEntry] }),
			record({ survived: [survivor({ ...finding("A.", "src/a.ts", 1), extra: 1 } as unknown as ReviewFinding)] }),
			record({ survived: [survivor(finding("A.", "src/a.ts", 1), { verification: { id: "C1", rationale: "R.", extra: 1 } as unknown as PrCarrySurvivorEntry["verification"] })] }),
			record({ refuted: [refuted(finding("B.", "src/b.ts", 1), { refutation: { extra: 1 } as unknown as PrCarryRefutedEntry["refutation"] })] }),
		];
		for (const value of cases) assert.throws(() => validatePrFindingDispositionRecord(value), /invalid/);
	});

	it("refuses structural forgeries fail-closed", () => {
		const f = finding("A defect.", "src/a.ts", 1);
		const cases: [string, unknown][] = [
			["short sha", record({ headSha: "abc123" })],
			["bad digest", record({ fleetRecordDigest: "zz" })],
			["bad reviewedAt", record({ reviewedAt: "not-a-date" })],
			["fingerprint mismatch", record({ survived: [{ ...survivor(f), fingerprint: "forged" }] })],
			["duplicate within array", record({ survived: [survivor(f), survivor(f)], refuted: [] })],
			["duplicate across arrays", record({ survived: [survivor(f)], refuted: [refuted(f)] })],
			["non-must-fix severity", record({ survived: [survivor({ ...f, severity: "nice" } as ReviewFinding)] })],
			["bad tier", record({ survived: [survivor(f, { tier: "urgent" as unknown as "safety" })] })],
			["bad provenance", record({ refuted: [refuted(finding("B.", "src/b.ts"), { refutation: { provenance: "guessed" as unknown as "verified" } })] })],
			["bad refutation id", record({ refuted: [refuted(finding("B.", "src/b.ts"), { refutation: { id: "X1" } })] })],
			["short refutedAtSha", record({ refuted: [refuted(finding("B.", "src/b.ts"), { refutation: { refutedAtSha: "abc" } })] })],
			["malformed class", record({ refuted: [refuted(finding("B.", "src/b.ts"), { class: "Not A Class" })] })],
			[
				"line without path",
				record({
					survived: [{ ...survivor(f), finding: { severity: "must-fix", message: "A defect.", line: 3 } as ReviewFinding, fingerprint: reviewFindingFingerprint({ severity: "must-fix", message: "A defect.", line: 3 } as ReviewFinding) }],
				}),
			],
			["bad gate", record({ gate: "park" as unknown as "pass" })],
			["bad agreement", record({ agreement: "maybe" as unknown as "invalid" })],
		];
		for (const [label, value] of cases) assert.throws(() => validatePrFindingDispositionRecord(value), /invalid/, label);
	});

	it("refuses entry-cap overflow and oversized files, and read fails closed to null", () => {
		const many = Array.from({ length: FINDING_DISPOSITION_MAX_ENTRIES + 1 }, (_, i) => survivor(finding(`Bug ${i}.`, "src/a.ts", i + 1)));
		assert.throws(() => validatePrFindingDispositionRecord(record({ survived: many, refuted: [] })), /invalid survived/);
		// Oversized serialization refuses at write time…
		const huge = record({ survived: [survivor(finding(`Huge. ${"x".repeat(1_100_000)}`, "src/a.ts", 1))], refuted: [] });
		assert.throws(() => writePrFindingDispositionRecord(tmpRoot(), huge), /invalid size/);
		// …and an oversized/malformed on-disk file reads as null and lists as invalid.
		const root = tmpRoot();
		writeFileSync(join(root, `495-${SHA_A}.json`), "{not json");
		assert.equal(readPrFindingDispositionRecord(root, 495, SHA_A), null);
		const listing = listPrFindingDispositionRecords(root);
		assert.deepEqual(listing.records, []);
		assert.deepEqual(listing.invalid, [`495-${SHA_A}.json`]);
	});
});

describe("selectCarrySource", () => {
	/** Ancestry oracle over ordered SHAs: A → B → C → HEAD. */
	const ORDER = [SHA_A, SHA_B, SHA_C, HEAD];
	const linearAncestry = (ancestor: string, descendant: string): boolean => {
		const a = ORDER.indexOf(ancestor);
		const d = ORDER.indexOf(descendant);
		return a !== -1 && d !== -1 && a <= d;
	};
	const fleetBytesFor = new Map<string, Buffer>();
	function boundRecord(headSha: string, over: Partial<PrFindingDispositionRecordV1> = {}): PrFindingDispositionRecordV1 {
		const bytes = Buffer.from(`fleet-${headSha}`);
		fleetBytesFor.set(headSha, bytes);
		return record({ headSha, fleetRecordDigest: fleetRecordDigestOf(bytes), ...over });
	}
	const readFleetBytes = (_pr: number, headSha: string): Buffer | null => fleetBytesFor.get(headSha) ?? null;
	function select(records: PrFindingDispositionRecordV1[], over: Partial<Parameters<typeof selectCarrySource>[1]> = {}, invalid: string[] = []): CarrySourceSelection {
		return selectCarrySource({ records, invalid }, { prNumber: 495, itemId: "495", reviewedSha: HEAD, isAncestor: linearAncestry, readFleetBytes, ...over });
	}

	it("selects a single ancestor prior and binds it to the exact fleet bytes", () => {
		const prior = boundRecord(SHA_A);
		assert.deepEqual(select([prior]), { kind: "selected", record: prior });
	});

	it("returns none with no relevant priors; same-SHA and wrong pr/item records are excluded", () => {
		assert.deepEqual(select([]), { kind: "none" });
		assert.deepEqual(select([boundRecord(HEAD)]), { kind: "none" }, "same-SHA rerun behaves exactly as today");
		assert.deepEqual(select([boundRecord(SHA_A, { prNumber: 496 })]), { kind: "none" });
		assert.deepEqual(select([boundRecord(SHA_A, { itemId: "other" })]), { kind: "none" });
	});

	it("refuses on force-push (no ancestors) rather than guessing", () => {
		const rebased = boundRecord("e".repeat(40));
		const selection = select([rebased]);
		assert.equal(selection.kind, "refused");
		assert.match((selection as { reason: string }).reason, /force-push or rebase/);
	});

	it("picks the maximal record of an ordered chain and refuses an unordered set", () => {
		const older = boundRecord(SHA_A);
		const newer = boundRecord(SHA_B);
		assert.deepEqual(select([older, newer]), { kind: "selected", record: newer });
		// Unordered: two ancestors of HEAD with no ancestry between them (diverged-then-merged).
		const divergent = (_ancestor: string, descendant: string): boolean => descendant === HEAD;
		const selection = select([older, newer], { isAncestor: divergent });
		assert.equal(selection.kind, "refused");
		assert.match((selection as { reason: string }).reason, /not totally ordered/);
		assert.match((selection as { reason: string }).reason, new RegExp(`495-${SHA_A}\\.json`));
	});

	it("never consults reviewedAt: a forged future timestamp does not change selection", () => {
		const older = boundRecord(SHA_A, { reviewedAt: "2099-01-01T00:00:00.000Z" });
		const newer = boundRecord(SHA_B, { reviewedAt: "2020-01-01T00:00:00.000Z" });
		assert.deepEqual(select([older, newer]), { kind: "selected", record: newer });
	});

	it("refuses on a missing fleet record or a digest mismatch", () => {
		const missing = select([record({ headSha: SHA_A, fleetRecordDigest: "1".repeat(64) })], { readFleetBytes: () => null });
		assert.equal(missing.kind, "refused");
		assert.match((missing as { reason: string }).reason, /missing/);
		const mismatch = select([record({ headSha: SHA_A, fleetRecordDigest: "1".repeat(64) })], { readFleetBytes: () => Buffer.from("different bytes") });
		assert.equal(mismatch.kind, "refused");
		assert.match((mismatch as { reason: string }).reason, /not bound to the exact on-disk fleet gate record/);
	});

	it("refuses when the store holds a malformed record for the targeted PR", () => {
		const selection = select([boundRecord(SHA_A)], {}, [`495-${SHA_B}.json`]);
		assert.equal(selection.kind, "refused");
		assert.match((selection as { reason: string }).reason, /malformed record/);
		// Malformed files for OTHER PRs do not poison this PR's carry.
		assert.equal(select([boundRecord(SHA_A)], {}, [`77-${SHA_B}.json`]).kind, "selected");
	});
});

describe("computeTouchedPaths", () => {
	it("parses NUL-separated name-only output through normalizeGitPath", () => {
		const touched = computeTouchedPaths("src/a.ts\0./src/b.ts\0\0");
		assert.deepEqual([...touched].sort(), ["src/a.ts", "src/b.ts"]);
	});

	it("a --no-renames rename contributes BOTH sides as touched", () => {
		// With --no-renames a rename is a delete + create; both paths appear in name-only output.
		const touched = computeTouchedPaths("src/old-name.ts\0src/new-name.ts\0");
		assert.ok(touched.has("src/old-name.ts") && touched.has("src/new-name.ts"));
	});
});

describe("planCarry eligibility (I3 + D3)", () => {
	const eligible = refuted(finding("Stale worry.", "src/other.ts", 5));

	it("seeds every prior survivor unconditionally and marks only eligible refuted entries auto-refutable", () => {
		const s = finding("Unfixed bug.", "src/a.ts", 7);
		const plan = planCarry(record({ survived: [survivor(s)], refuted: [eligible] }), new Set(["src/a.ts"]), TAXONOMY);
		assert.equal(plan.priorSha, SHA_A);
		assert.deepEqual([...plan.seedSurvivors.keys()], [reviewFindingFingerprint(s)]);
		assert.deepEqual([...plan.autoRefutable.keys()], [eligible.fingerprint]);
		const carried = plan.autoRefutable.get(eligible.fingerprint);
		assert.deepEqual(carried?.refutation, { provenance: "carried", id: "C2", refutedAtSha: SHA_A });
		assert.deepEqual(plan.carriedForward, [carried]);
	});

	it("a pathless entry is never auto-refutable", () => {
		const plan = planCarry(record({ survived: [], refuted: [refuted(finding("Repo-level worry."))] }), new Set(), TAXONOMY);
		assert.equal(plan.autoRefutable.size, 0);
		assert.deepEqual(plan.carriedForward, []);
	});

	it("a touched anchoring path forces fresh re-verification (not auto-refutable)", () => {
		const plan = planCarry(record({ survived: [], refuted: [eligible] }), new Set(["src/other.ts"]), TAXONOMY);
		assert.equal(plan.autoRefutable.size, 0);
	});

	it("safety never self-clears — by recorded tier AND by current-taxonomy resolution of the class", () => {
		const byRecordedTier = refuted(finding("Recorded safety.", "src/s.ts", 1), { class: "correctness-regression", tier: "safety" });
		assert.equal(planCarry(record({ survived: [], refuted: [byRecordedTier] }), new Set(), TAXONOMY).autoRefutable.size, 0);
		// Taxonomy-shift: recorded judgment under an extended taxonomy, but the CURRENT taxonomy
		// does not classify the id — unclassified resolves safety (belt-and-braces).
		const byCurrentResolution = refuted(finding("Was judgment.", "src/j.ts", 1), { class: "custom-risk", tier: "judgment" });
		assert.equal(planCarry(record({ survived: [], refuted: [byCurrentResolution] }), new Set(), TAXONOMY).autoRefutable.size, 0);
		// The same entry IS eligible when the current taxonomy still classifies the id judgment.
		// (Built directly: resolveTaxonomy would demand an owner signature for the extension.)
		const extended = { ...TAXONOMY, classes: new Map([...TAXONOMY.classes, ["custom-risk", "judgment"] as const]) };
		assert.equal(planCarry(record({ survived: [], refuted: [byCurrentResolution] }), new Set(), extended).autoRefutable.size, 1);
	});

	it("throws on survivor/refuted fingerprint overlap (non-validated record leaked in)", () => {
		const f = finding("Twice.", "src/t.ts", 1);
		const forged = { ...record(), survived: [survivor(f)], refuted: [refuted(f)] };
		assert.throws(() => planCarry(forged, new Set(), TAXONOMY), /both survived and refuted/);
	});
});

describe("buildCarryDispositionDraft", () => {
	const base = {
		prNumber: 495,
		itemId: "495",
		reviewedSha: HEAD,
		gate: "block" as const,
		agreement: "consensus-block" as const,
		ok: true,
		changedFiles: ["src/a.ts"],
		taxonomy: TAXONOMY,
	};
	const empty = { survivors: new Map<string, ReviewFinding>(), verifications: new Map(), refutedThisRun: new Map(), autoRefutable: new Map(), carriedForward: [] as PrCarryRefutedEntry[] };

	it("returns undefined without full identity (no itemId / short sha / bad pr)", () => {
		assert.equal(buildCarryDispositionDraft({ ...base, ...empty, itemId: " " }), undefined);
		assert.equal(buildCarryDispositionDraft({ ...base, ...empty, reviewedSha: "abc123" }), undefined);
		assert.equal(buildCarryDispositionDraft({ ...base, ...empty, prNumber: 0 }), undefined);
	});

	it("enriches survivors with emission-time class/tier and survives-evidence; missing evidence records null", () => {
		const s = finding("Unfixed bug.", "src/a.ts", 7);
		const fp = reviewFindingFingerprint(s);
		const withEvidence = buildCarryDispositionDraft({
			...base,
			...empty,
			survivors: new Map([[fp, s]]),
			verifications: new Map([[fp, { id: "C1", decision: "survives" as const, rationale: "Confirmed." }]]),
		});
		assert.deepEqual(withEvidence?.survived, [{ finding: s, fingerprint: fp, class: "correctness-regression", tier: "safety", verification: { id: "C1", rationale: "Confirmed." } }]);
		// Retained-because-incomplete (or latest evidence refuted but re-added fail-closed): null.
		const without = buildCarryDispositionDraft({ ...base, ...empty, survivors: new Map([[fp, s]]) });
		assert.equal(without?.survived[0]?.verification, null);
	});

	it("records rule 1-3 refuted entries: verified this run, auto-refuted chains, and carried-forward memory", () => {
		const verifiedNow = finding("Refuted fresh.", "src/a.ts", 3);
		const verifiedFp = reviewFindingFingerprint(verifiedNow);
		const auto = refuted(finding("Auto-refuted.", "src/other.ts", 5), { refutation: { provenance: "carried" } });
		const memory = refuted(finding("Never re-seen.", "src/quiet.ts", 9), { refutation: { provenance: "carried" } });
		const draft = buildCarryDispositionDraft({
			...base,
			...empty,
			refutedThisRun: new Map([
				[verifiedFp, { id: "C1", finding: verifiedNow }],
				[auto.fingerprint, { id: "C3", finding: auto.finding }],
			]),
			autoRefutable: new Map([[auto.fingerprint, auto]]),
			carriedForward: [auto, memory],
		});
		assert.ok(draft);
		const byFp = new Map(draft.refuted.map((entry) => [entry.fingerprint, entry]));
		// Rule 1: refuted by THIS run's valid pass — provenance verified, bound to this head.
		assert.deepEqual(byFp.get(verifiedFp)?.refutation, { provenance: "verified", id: "C1", refutedAtSha: HEAD });
		// Rule 2: auto-refuted this run — the prior report stays the refuting authority (chained).
		assert.deepEqual(byFp.get(auto.fingerprint)?.refutation, { provenance: "carried", id: "C2", refutedAtSha: SHA_A });
		// Rule 3: eligible memory not re-encountered survives reviewer-sampling gaps.
		assert.deepEqual(byFp.get(memory.fingerprint)?.refutation, { provenance: "carried", id: "C2", refutedAtSha: SHA_A });
		assert.equal(draft.refuted.length, 3);
	});

	it("a terminally-carried fingerprint is a survivor, never refutation memory (fail-closed re-add)", () => {
		const f = finding("Disputed.", "src/a.ts", 4);
		const fp = reviewFindingFingerprint(f);
		const chained = refuted(f, { refutation: { provenance: "carried" } });
		const draft = buildCarryDispositionDraft({
			...base,
			...empty,
			survivors: new Map([[fp, f]]),
			refutedThisRun: new Map([[fp, { id: "C1", finding: f }]]),
			autoRefutable: new Map([[fp, chained]]),
			carriedForward: [chained],
		});
		assert.ok(draft);
		assert.deepEqual(draft.refuted, []);
		assert.equal(draft.survived[0]?.fingerprint, fp);
	});

	it("a pass-record has empty survived and keeps the refutation memory", () => {
		const memory = refuted(finding("Old refutation.", "src/quiet.ts", 9), { refutation: { provenance: "carried" } });
		const draft = buildCarryDispositionDraft({ ...base, ...empty, gate: "pass", agreement: "consensus-pass", carriedForward: [memory] });
		assert.ok(draft);
		assert.deepEqual(draft.survived, []);
		assert.equal(draft.refuted[0]?.fingerprint, memory.fingerprint);
		assert.equal(draft.gate, "pass");
	});
});
