import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type RegisterName, registerPath } from "./registers.js";

/**
 * Record that the deterministic PR-mode freshness gates (`typecheck:ratchet` backstop +
 * `verifyPrShipFreshness`) passed for one exact worktree HEAD (#424).
 *
 * Why it exists: once a freshness merge is committed, a gate failure ends the cycle
 * but the branch now *contains* `origin/main` — a ship resume classifies it
 * `up-to-date`, which previously skipped the very gates that failed. Gate completion
 * is therefore an explicit recorded fact bound to the head SHA, never inferred from
 * freshness state.
 *
 * Trust (#424 gate review → #511): completion is trusted ONLY within the process that ran
 * the gates — an in-memory registry seeded by `writeFreshnessGateRecord` and consulted by
 * `readFreshnessGateRecord`. The on-disk store under `MAIN_REPO/.dev/` is observability,
 * never authorization: the step-runner's Bash denial matches only the literal
 * `.dev/freshness-gate-records` string, so a hooked command can compose the path through
 * variables and plant an exact-SHA record — a losing string-matching arms race. Removing
 * the forgery's value is the fix: a cross-process resume always re-runs the deterministic
 * gates (they are cheap), and hermetic evidence binding is the chartered #511
 * harness-attestation work.
 */
export interface FreshnessGateRecordV1 {
	schemaVersion: 1;
	itemId: string;
	headSha: string;
	/** "skipped" when the target repo's package.json has no typecheck:ratchet script (consumer repos). */
	typecheck: "passed" | "skipped";
	recordedAt: string;
}

export type NewFreshnessGateRecord = Omit<FreshnessGateRecordV1, "schemaVersion">;

/** Store directory name under `MAIN_REPO/.dev/`. Exported so the step-runner's Bash register
 *  denial names the exact same path as the store — the deny list must not drift. */
export const FRESHNESS_GATE_RECORDS_DIR: RegisterName = "freshness-gate-records";
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** #511: the only trusted source — process-local, seeded exclusively by `writeFreshnessGateRecord`. */
const IN_PROCESS_RECORDS = new Map<string, FreshnessGateRecordV1>();

function registryKey(mainRepo: string, headSha: string): string {
	return `${resolve(mainRepo)}\0${headSha.toLowerCase()}`;
}

export function freshnessGateRecordsDir(mainRepo: string): string {
	return registerPath(mainRepo, FRESHNESS_GATE_RECORDS_DIR);
}

function recordPath(mainRepo: string, headSha: string): string {
	return resolve(freshnessGateRecordsDir(mainRepo), `${headSha.toLowerCase()}.json`);
}

function validate(value: unknown): FreshnessGateRecordV1 | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1) return null;
	if (typeof record.itemId !== "string" || record.itemId.length === 0) return null;
	if (typeof record.headSha !== "string" || !SHA_RE.test(record.headSha)) return null;
	if (record.typecheck !== "passed" && record.typecheck !== "skipped") return null;
	if (typeof record.recordedAt !== "string" || !Number.isFinite(Date.parse(record.recordedAt))) return null;
	return { schemaVersion: 1, itemId: record.itemId, headSha: record.headSha, typecheck: record.typecheck, recordedAt: record.recordedAt };
}

export function writeFreshnessGateRecord(mainRepo: string, record: NewFreshnessGateRecord): string {
	const complete = validate({ ...record, schemaVersion: 1 });
	if (!complete) throw new Error("freshness gate record: invalid record");
	// Trust anchor first: the in-process registry is what reads consult, so a same-process
	// resume skip works even when the observability write below fails (the caller logs it).
	IN_PROCESS_RECORDS.set(registryKey(mainRepo, complete.headSha), complete);
	const dir = freshnessGateRecordsDir(mainRepo);
	mkdirSync(dir, { recursive: true });
	const path = recordPath(mainRepo, complete.headSha);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(complete, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

/**
 * Read gate completion for a head SHA. #511: consults ONLY the in-process registry — the
 * disk store is deliberately never read back, so a planted file cannot authorize skipping
 * the deterministic ship gates. Absent (including after any process restart) reads as
 * null, which simply re-runs the gates.
 */
export function readFreshnessGateRecord(mainRepo: string, headSha: string): FreshnessGateRecordV1 | null {
	if (!SHA_RE.test(headSha)) return null;
	return IN_PROCESS_RECORDS.get(registryKey(mainRepo, headSha)) ?? null;
}

/** Test seam: clear process-local trust to simulate a cross-process resume. */
export function __clearFreshnessGateRecordsForTests(): void {
	IN_PROCESS_RECORDS.clear();
}
