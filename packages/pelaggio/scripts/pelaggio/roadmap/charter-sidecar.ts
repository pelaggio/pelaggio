import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Scope } from "./types.js";

/**
 * Markdown's deterministic ID-to-provenance sidecar (#367). Markdown rows are single-line and format-
 * strict, so charter-review state (deferred / digest / level) lives in `.dev/charter-reviews/items/<id>.json`
 * rather than being mangled into the row regex. Committed alongside the row under the mutation lock.
 */
export interface CharterSidecar {
	deferred: boolean;
	reviewDigest?: string;
	reviewLevel?: string;
	scope?: Scope;
}

export function charterSidecarRelPath(id: string): string {
	return join(".dev", "charter-reviews", "items", `${id.toUpperCase()}.json`);
}

export function charterSidecarPath(repo: string, id: string): string {
	return join(repo, charterSidecarRelPath(id));
}

export function readCharterSidecar(repo: string, id: string): CharterSidecar | null {
	const path = charterSidecarPath(repo, id);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as CharterSidecar;
	} catch {
		return null;
	}
}

/** Atomically write the sidecar and return its absolute path (caller commits it under the lock). */
export function writeCharterSidecar(repo: string, id: string, data: CharterSidecar): string {
	const path = charterSidecarPath(repo, id);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
	return path;
}
