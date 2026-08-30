/**
 * Local staleness quarantine (#217). Open items that git history / body markers /
 * done-siblings show are already implemented or obsolete are recorded here so
 * `roadmap next` and `roadmap claim` skip them until an operator resolves them.
 *
 * The store is harness-local state under `MAIN_REPO/.dev/` (gitignored, never a
 * provider label and never an auto-close). It is resolved to the worktree holding
 * `refs/heads/main` via the shared `mainWorktree()` redirect so quarantine written
 * by `/tidy` on main is visible to `claim`/`next` from a sibling worktree and vice
 * versa. This is a harness-internal `fs` write under the roadmap mutation lock — not
 * a tool-call write — so it neither triggers nor bypasses the worktree write-guard,
 * mirroring the decisions-register precedent.
 *
 * Entries are fingerprint-bound: an entry gates the item only while the live item's
 * content fingerprint still equals the stored one. A retitled/rewritten item auto-
 * expires out of quarantine (the operator "resolved" it by editing) without an
 * explicit clear. Sticky `keep` entries (human-confirmed false positives) are
 * suppressed from gating but retained for listing until the fingerprint changes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mainWorktree } from "../git.js";
import { writeAtomically } from "../record-store.js";
import { type RegisterName, registerPath } from "../registers.js";
import { withMutationLock } from "./mutation-lock.js";
import type { StaleHit } from "./stale-scan.js";
import type { RoadmapItemStatus } from "./types.js";

export type StaleReason = "shipped-by-commit" | "superseded-marker" | "title-match-done";

export interface StaleQuarantineEntry {
	readonly fingerprint: string;
	readonly reason: StaleReason;
	/** Commit SHAs, sibling ids, or short notes — machine-readable evidence for the operator. */
	readonly evidence: readonly string[];
	/** ISO date the entry was first recorded (stable across re-scans of the same fingerprint). */
	readonly quarantinedAt: string;
	/** Present only for a human-confirmed false positive: gating skips it, listing keeps it. */
	readonly disposition?: "keep";
}

export interface StaleQuarantineFile {
	readonly version: 1;
	readonly entries: Readonly<Record<string, StaleQuarantineEntry>>;
}

const QUARANTINE_FILE: RegisterName = "stale-quarantine.json";
const EMPTY: StaleQuarantineFile = { version: 1, entries: {} };

function normalize(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Content fingerprint of an item as it is right now. Binds a quarantine entry to a
 *  specific title/deps/body so an operator edit auto-expires the entry. */
export function itemFingerprint(item: Pick<RoadmapItemStatus, "id" | "title" | "deps" | "body">): string {
	return createHash("sha256")
		.update([normalize(item.id), normalize(item.title), normalize(item.deps), normalize(item.body ?? "")].join("\0"))
		.digest("hex")
		.slice(0, 32);
}

/** Pure: file location for an already-resolved main repo. */
export function quarantinePath(mainRepo: string): string {
	return registerPath(mainRepo, QUARANTINE_FILE);
}

function readFileAt(mainRepo: string): StaleQuarantineFile {
	const path = quarantinePath(mainRepo);
	if (!existsSync(path)) return EMPTY;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as StaleQuarantineFile;
		if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) return EMPTY;
		return parsed;
	} catch {
		// A corrupt store must not break gating — fail open to an empty quarantine.
		return EMPTY;
	}
}

/** Load the quarantine store, redirecting to the main worktree. Never throws. */
export function loadQuarantine(repo: string): StaleQuarantineFile {
	return readFileAt(mainWorktree(repo));
}

function writeQuarantineAt(mainRepo: string, file: StaleQuarantineFile): void {
	const path = quarantinePath(mainRepo);
	mkdirSync(dirname(path), { recursive: true });
	writeAtomically(path, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Gating set: ids whose live fingerprint still matches a stored entry, EXCLUDING
 * sticky-`keep` dispositions. This is what `roadmap next` / `claim` exclude.
 */
export function activeQuarantineIds(file: StaleQuarantineFile, items: readonly RoadmapItemStatus[]): Set<string> {
	const byId = new Map(items.map((item) => [item.id, item] as const));
	const active = new Set<string>();
	for (const [id, entry] of Object.entries(file.entries)) {
		if (entry.disposition === "keep") continue;
		const item = byId.get(id);
		if (item && itemFingerprint(item) === entry.fingerprint) active.add(id);
	}
	return active;
}

export interface QuarantineListing extends StaleQuarantineEntry {
	readonly id: string;
	/** True when the entry is a sticky `keep` — shown to operators but not gated. */
	readonly suppressed: boolean;
}

/**
 * Listing view for `stale-list`: every fingerprint-matching entry INCLUDING keep-
 * suppressed ones, so operators still see confirmed false positives. Inert entries
 * (fingerprint drifted because the item evolved) are omitted.
 */
export function listQuarantine(file: StaleQuarantineFile, items: readonly RoadmapItemStatus[]): readonly QuarantineListing[] {
	const byId = new Map(items.map((item) => [item.id, item] as const));
	const rows: QuarantineListing[] = [];
	for (const [id, entry] of Object.entries(file.entries)) {
		const item = byId.get(id);
		if (!item || itemFingerprint(item) !== entry.fingerprint) continue;
		rows.push({ ...entry, id, suppressed: entry.disposition === "keep" });
	}
	return rows;
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Upsert scan hits under the mutation lock, then prune entries whose ids are no
 * longer open. A sticky-`keep` entry with a still-matching fingerprint is never
 * overwritten (its human confirmation is durable until the item evolves). Returns
 * the persisted file; the write is skipped when nothing changed.
 */
export async function upsertHits(repo: string, hits: readonly StaleHit[], liveOpenIds: ReadonlySet<string>): Promise<StaleQuarantineFile> {
	const mainRepo = mainWorktree(repo);
	return withMutationLock(mainRepo, () => {
		const current = readFileAt(mainRepo);
		const entries: Record<string, StaleQuarantineEntry> = { ...current.entries };
		const at = today();
		for (const hit of hits) {
			const existing = entries[hit.id];
			// Sticky keep: leave the human-confirmed false positive alone until its fingerprint changes.
			if (existing?.disposition === "keep" && existing.fingerprint === hit.fingerprint) continue;
			// Preserve first-seen date when re-quarantining the same fingerprint so the file does not churn daily.
			const quarantinedAt = existing && existing.fingerprint === hit.fingerprint ? existing.quarantinedAt : at;
			entries[hit.id] = { fingerprint: hit.fingerprint, reason: hit.reason, evidence: [...hit.evidence], quarantinedAt };
		}
		for (const id of Object.keys(entries)) {
			if (!liveOpenIds.has(id)) delete entries[id];
		}
		const next: StaleQuarantineFile = { version: 1, entries };
		if (JSON.stringify(next.entries) !== JSON.stringify(current.entries)) writeQuarantineAt(mainRepo, next);
		return next;
	});
}

/**
 * Mark a quarantine entry as a sticky `keep` (human-confirmed false positive), rebound
 * to the live item's current fingerprint so a later edit clears it. No-op when the id is
 * not quarantined (the CLI reports that case before calling).
 */
export async function resolveKeep(repo: string, id: string, item: RoadmapItemStatus): Promise<void> {
	const mainRepo = mainWorktree(repo);
	await withMutationLock(mainRepo, () => {
		const current = readFileAt(mainRepo);
		const existing = current.entries[id];
		if (!existing) return;
		const entry: StaleQuarantineEntry = { ...existing, fingerprint: itemFingerprint(item), disposition: "keep" };
		writeQuarantineAt(mainRepo, { version: 1, entries: { ...current.entries, [id]: entry } });
	});
}

/** Delete a quarantine entry outright (used after a `--as done` resolve). No-op when absent. */
export async function clearEntry(repo: string, id: string): Promise<void> {
	const mainRepo = mainWorktree(repo);
	await withMutationLock(mainRepo, () => {
		const current = readFileAt(mainRepo);
		if (!(id in current.entries)) return;
		const entries = { ...current.entries };
		delete entries[id];
		writeQuarantineAt(mainRepo, { version: 1, entries });
	});
}
