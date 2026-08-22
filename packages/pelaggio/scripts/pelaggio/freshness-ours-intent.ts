import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * every probe passes; the up-to-date classification refuses to trust ancestry while
 * an unconfirmed intent's merge participates in it.
 *
 * Trust direction — the opposite of `freshness-gate-record.ts`: that store must not
 * be read back because a planted record would AUTHORIZE skipping gates. This record
 * only ever BLOCKS: reading it from disk is safe because forging one can at worst
 * force a spurious re-proof or a fail-closed refusal (denial, never laundering).
 * Deleting a record to launder requires a main-repo `.dev/` write — the same
 * capability class as planting `.git/info/grafts`, outside the worktree
 * write-guard's threat model (documented residual, not defended here).
 *
 * Single-writer: only the harness freshness path writes these records (one JSON file
 * per branch, atomic tmp+rename — no shared-file concurrent append). Readers are
 * tolerant-with-diagnostic: an unreadable or malformed record surfaces as
 * `unreadable` for the caller to fail closed on, never as `absent`. An unconfirmed
 * record persists until an operator or a successful re-proof clears it — it is
 * never auto-expired into a pass.
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
	if (record.mergeOid !== undefined && (typeof record.mergeOid !== "string" || !OID_RE.test(record.mergeOid))) return null;
	if (typeof record.recordedAt !== "string" || !Number.isFinite(Date.parse(record.recordedAt))) return null;
	if (record.confirmedAt !== undefined && (typeof record.confirmedAt !== "string" || !Number.isFinite(Date.parse(record.confirmedAt)))) return null;
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
	try {
		atomicWrite(mainRepo, { ...read.record, state: "confirmed", mergeOid, confirmedAt: new Date().toISOString() });
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
