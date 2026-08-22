import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Intent/confirmation bracket for the freshness `-s ours` shortcut (#571).
 *
 * Why it exists: the shortcut's post-merge probes can fail in ways that leave the
 * unproven ours merge in branch history (the `^2` probe itself erroring, or a
 * concurrent commit landing atop the merge before the probes — either defeats the
 * rollback's HEAD-recognition precondition). Ancestry alone would then classify the
 * branch `up-to-date` on the very merge whose proof never completed. The harness
 * therefore durably records INTENT before creating the merge and CONFIRMS only after
 * every probe passes; the freshness classifications refuse to trust ancestry while
 * an unconfirmed intent's merge participates in it.
 *
 * Trust: the store is NOT block-only — an `intent` record only ever blocks, but a
 * FORGED `state: "confirmed"` record (or a deletion; a deleted store reads empty and
 * absent allows) would launder, because absent and confirmed both allow.
 *
 * ⚠ RESIDUAL, stated plainly: a seat with composed-path Bash write access to
 * `MAIN_REPO/.dev` can delete or forge this store despite the literal-path deny
 * register — the deny register NARROWS, #511 harness-attested evidence CLOSES.
 * Until #511 lands (explicitly deferred with the #510/#424 arms-race cluster),
 * this bracket defends against accidental and direct-path interference, not a
 * determined in-jail adversary. The `.git/info/grafts` class of main-repo writes
 * sits in the same conceded capability class.
 *
 * Single-writer: only the harness freshness path writes these records (one JSON file
 * per branch, atomic tmp+rename — no shared-file concurrent append). Readers are
 * tolerant-with-diagnostic: an unreadable or malformed record surfaces as
 * `unreadable` for the caller to fail closed on, never as `absent`. An unconfirmed
 * record persists until an operator or a successful re-proof clears it — it is
 * never auto-expired into a pass.
 *
 * TODO(/tidy): confirmed records accumulate one file per branch until the branch's
 * next integration clears them; teach `/tidy`'s stale-worktree sweep to prune
 * confirmed records for deleted branches. Never prune `intent` records there.
 */
export interface FreshnessOursIntentV1 {
	schemaVersion: 1;
	branch: string;
	/** Commit OID captured before the ours merge; the merge must sit exactly on it. */
	headOid: string;
	/** Fetched origin/main OID the merge must carry as its second parent. */
	originMainOid: string;
	/** Tree OID of `headOid`; the merge commit must preserve it byte-for-byte. */
	expectedTreeOid: string;
	state: "intent" | "confirmed";
	/** The probe-verified merge commit OID; present once confirmed. */
	mergeOid?: string;
	recordedAt: string;
	confirmedAt?: string;
}

export type NewFreshnessOursIntent = Omit<FreshnessOursIntentV1, "schemaVersion" | "state" | "mergeOid" | "confirmedAt">;

export type FreshnessOursIntentRead = { kind: "absent" } | { kind: "record"; record: FreshnessOursIntentV1 } | { kind: "unreadable"; detail: string };

/** Store directory name under `MAIN_REPO/.dev/` — sibling of `freshness-gate-records`. */
export const FRESHNESS_OURS_INTENTS_DIR = "freshness-ours-intents";
const OID_RE = /^[0-9a-f]{40}$/i;

export function freshnessOursIntentsDir(mainRepo: string): string {
	return resolve(mainRepo, ".dev", FRESHNESS_OURS_INTENTS_DIR);
}

function recordPath(mainRepo: string, branch: string): string {
	return resolve(freshnessOursIntentsDir(mainRepo), `${encodeURIComponent(branch)}.json`);
}

function validate(value: unknown): FreshnessOursIntentV1 | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1) return null;
	if (typeof record.branch !== "string" || record.branch.length === 0) return null;
	if (typeof record.headOid !== "string" || !OID_RE.test(record.headOid)) return null;
	if (typeof record.originMainOid !== "string" || !OID_RE.test(record.originMainOid)) return null;
	if (typeof record.expectedTreeOid !== "string" || !OID_RE.test(record.expectedTreeOid)) return null;
	if (record.state !== "intent" && record.state !== "confirmed") return null;
	// Strict conditional shape: "confirmed" REQUIRES a probe-bound mergeOid + confirmedAt
	// (a confirmed record missing them carries no probe evidence and must read as invalid,
	// never be skipped-as-confirmed); "intent" requires their ABSENCE — the writer never
	// produces them, so their presence is tampering or corruption, not a variant.
	if (record.state === "confirmed") {
		if (typeof record.mergeOid !== "string" || !OID_RE.test(record.mergeOid)) return null;
		if (typeof record.confirmedAt !== "string" || !Number.isFinite(Date.parse(record.confirmedAt))) return null;
	} else if (record.mergeOid !== undefined || record.confirmedAt !== undefined) {
		return null;
	}
	if (typeof record.recordedAt !== "string" || !Number.isFinite(Date.parse(record.recordedAt))) return null;
	return {
		schemaVersion: 1,
		branch: record.branch,
		headOid: record.headOid,
		originMainOid: record.originMainOid,
		expectedTreeOid: record.expectedTreeOid,
		state: record.state,
		...(record.mergeOid !== undefined ? { mergeOid: record.mergeOid } : {}),
		recordedAt: record.recordedAt,
		...(record.confirmedAt !== undefined ? { confirmedAt: record.confirmedAt } : {}),
	};
}

function atomicWrite(mainRepo: string, record: FreshnessOursIntentV1): void {
	mkdirSync(freshnessOursIntentsDir(mainRepo), { recursive: true });
	const path = recordPath(mainRepo, record.branch);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/** Durably record intent BEFORE the ours merge is created. Throws on failure — the caller must then skip the shortcut. */
export function writeFreshnessOursIntent(mainRepo: string, intent: NewFreshnessOursIntent): void {
	const complete = validate({ ...intent, schemaVersion: 1, state: "intent", recordedAt: intent.recordedAt });
	if (!complete) throw new Error("freshness ours intent: invalid record");
	atomicWrite(mainRepo, complete);
}

/**
 * Mark the branch's intent confirmed with the probe-verified merge OID (atomic
 * replace). Returns false when there is no valid record to confirm or the write
 * fails — callers treat that as retryable (the retrospective gate re-confirms).
 */
export function confirmFreshnessOursIntent(mainRepo: string, branch: string, mergeOid: string): boolean {
	const read = readFreshnessOursIntent(mainRepo, branch);
	if (read.kind !== "record" || !OID_RE.test(mergeOid)) return false;
	const complete = validate({ ...read.record, state: "confirmed", mergeOid, confirmedAt: new Date().toISOString() });
	if (!complete) return false;
	try {
		atomicWrite(mainRepo, complete);
		return true;
	} catch {
		return false;
	}
}

export function readFreshnessOursIntent(mainRepo: string, branch: string): FreshnessOursIntentRead {
	let raw: string;
	try {
		raw = readFileSync(recordPath(mainRepo, branch), "utf-8");
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOENT") return { kind: "absent" };
		return { kind: "unreadable", detail: `ours-intent record read failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "unreadable", detail: "ours-intent record is not valid JSON" };
	}
	const record = validate(parsed);
	if (!record) return { kind: "unreadable", detail: "ours-intent record failed schema validation" };
	return { kind: "record", record };
}

/** Remove the branch's record (any state). Best-effort — a failed removal only re-triggers the gate's diagnostics. */
export function clearFreshnessOursIntent(mainRepo: string, branch: string): void {
	try {
		rmSync(recordPath(mainRepo, branch), { force: true });
	} catch {
		// Best-effort by contract.
	}
}

/** A store entry that cannot be trusted as a record, with its recorded head OID
 *  salvaged when the JSON still carries one — the ancestry key the gate uses to
 *  scope the fail-closed blast radius to histories the entry can actually reach. */
export type FreshnessOursIntentIssue = { entry: string; detail: string; headOid: string | null };

function salvageHeadOid(parsed: unknown): string | null {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const value = (parsed as Record<string, unknown>).headOid;
	return typeof value === "string" && OID_RE.test(value) ? value : null;
}

/**
 * Every record in the store, with untrustworthy entries surfaced as issues for the
 * gate to handle. The ancestry gate scans ALL records — never just the current
 * branch's file — so a branch rename or detached HEAD after a failed probe cannot
 * dodge it. A missing store directory is a valid empty store; any other listing
 * failure, an undecodable filename, a malformed record, or a filename/branch-field
 * mismatch is an issue — diagnostic, never silently absent.
 */
export function listFreshnessOursIntents(mainRepo: string): { records: FreshnessOursIntentV1[]; issues: FreshnessOursIntentIssue[] } {
	let entries: string[];
	try {
		entries = readdirSync(freshnessOursIntentsDir(mainRepo));
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOENT") return { records: [], issues: [] };
		return { records: [], issues: [{ entry: FRESHNESS_OURS_INTENTS_DIR, detail: `ours-intent store unreadable: ${error instanceof Error ? error.message : String(error)}`, headOid: null }] };
	}
	const records: FreshnessOursIntentV1[] = [];
	const issues: FreshnessOursIntentIssue[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue; // atomic-write .tmp leftovers
		let branch: string;
		try {
			branch = decodeURIComponent(entry.slice(0, -".json".length));
		} catch {
			issues.push({ entry, detail: "filename does not decode to a branch", headOid: null });
			continue;
		}
		let raw: string;
		try {
			raw = readFileSync(resolve(freshnessOursIntentsDir(mainRepo), entry), "utf-8");
		} catch (error) {
			issues.push({ entry, detail: `unreadable: ${error instanceof Error ? error.message : String(error)}`, headOid: null });
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			issues.push({ entry, detail: "not valid JSON", headOid: null });
			continue;
		}
		const record = validate(parsed);
		if (!record) {
			issues.push({ entry, detail: "failed schema validation", headOid: salvageHeadOid(parsed) });
			continue;
		}
		if (record.branch !== branch) {
			issues.push({ entry, detail: `record branch ${JSON.stringify(record.branch)} does not match its filename`, headOid: record.headOid });
			continue;
		}
		records.push(record);
	}
	return { records, issues };
}
