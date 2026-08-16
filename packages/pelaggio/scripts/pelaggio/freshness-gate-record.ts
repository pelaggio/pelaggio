import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Durable record that the deterministic PR-mode freshness gates (`typecheck:ratchet`
 * backstop + `verifyPrShipFreshness`) passed for one exact worktree HEAD (#424).
 *
 * Why it exists: once a freshness merge is committed, a gate failure ends the cycle
 * but the branch now *contains* `origin/main` — a ship resume classifies it
 * `up-to-date`, which previously skipped the very gates that failed. Gate completion
 * is therefore an explicit recorded fact bound to the head SHA, never inferred from
 * freshness state.
 *
 * Trust: the store lives under `MAIN_REPO/.dev/` and is harness-owned, like the
 * pr-review gate records — a seat that could forge a record could skip the ship
 * gates, so the step-runner denies agent access to it. Reads fail closed: an
 * invalid or mismatched record reads as null, which simply re-runs the
 * deterministic gates.
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
export const FRESHNESS_GATE_RECORDS_DIR = "freshness-gate-records";
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export function freshnessGateRecordsDir(mainRepo: string): string {
	return resolve(mainRepo, ".dev", FRESHNESS_GATE_RECORDS_DIR);
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
	const dir = freshnessGateRecordsDir(mainRepo);
	mkdirSync(dir, { recursive: true });
	const path = recordPath(mainRepo, complete.headSha);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(complete, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

export function readFreshnessGateRecord(mainRepo: string, headSha: string): FreshnessGateRecordV1 | null {
	if (!SHA_RE.test(headSha)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(recordPath(mainRepo, headSha), "utf8"));
	} catch {
		return null;
	}
	const record = validate(parsed);
	if (!record || record.headSha.toLowerCase() !== headSha.toLowerCase()) return null;
	return record;
}
