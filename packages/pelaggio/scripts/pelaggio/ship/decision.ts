import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { EffectsManifestError, type ShipDecisionEffect } from "../effects.js";
import type { ShipTargetName, StepResult } from "../types.js";
import { SHIP_TARGET_NAMES } from "./index.js";

const SHIP_DECISION_RE = /SHIP_DECISION\s*([\s\S]*?)\s*END_SHIP_DECISION/g;
// A PR body far past any real deliverable + appended review record. Bounds the file read.
const MAX_PR_BODY_BYTES = 512 * 1024;

/** The fixed, harness-owned location the ship worker writes the PR body to, relative to the worktree. */
export function shipBodyFile(itemId: string): string {
	return `.dev/ship/pr-body-${itemId}.md`;
}

/**
 * Remove the harness-owned PR body scratch file after a successful PR-mode ship dispatch.
 * Resolves only `shipBodyFile(itemId)` under `worktree`; removes a regular file, no-ops if
 * absent, and leaves symlinks / non-files untouched (does not follow). Mutation-free relative
 * to the parser so a failed resolve can still retry against the retained file.
 */
export function cleanupShipBodyFile(worktree: string, itemId: string): void {
	const path = resolve(worktree, shipBodyFile(itemId));
	try {
		const st = lstatSync(path);
		// lstat: leave symlinks and non-regular nodes; only unlink a plain file.
		if (!st.isFile()) return;
		unlinkSync(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
		throw e;
	}
}

export function parseShipDecisionEffect(step: StepResult, expected: { itemId: string; target: ShipTargetName; worktree: string }): ShipDecisionEffect {
	const haystack = step.assistantText;
	// assistantText is chronological, while the ship worker may correct an earlier draft in its
	// final message. Preserve the former final-message precedence by selecting the last block.
	const match = [...haystack.matchAll(SHIP_DECISION_RE)].at(-1);
	if (!match) throw new EffectsManifestError("invalid_manifest", "ship decision block not found");

	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1] ?? "");
	} catch (e) {
		throw new EffectsManifestError("invalid_manifest", "ship decision block is not valid JSON", { cause: e });
	}
	if (!isRecord(parsed)) throw new EffectsManifestError("invalid_manifest", "ship decision must be a JSON object");
	if (!SHIP_TARGET_NAMES.includes(parsed.target as ShipTargetName)) throw new EffectsManifestError("invalid_manifest", "ship decision target must be a valid ship target");
	if (parsed.target !== expected.target) throw new EffectsManifestError("invalid_manifest", `ship decision target ${String(parsed.target)} does not match configured target ${expected.target}`);
	if (parsed.itemId !== undefined && parsed.itemId !== expected.itemId) throw new EffectsManifestError("invalid_manifest", `ship decision itemId ${String(parsed.itemId)} does not match ${expected.itemId}`);
	if (!isNonEmptyString(parsed.headBranch)) throw new EffectsManifestError("invalid_manifest", "ship decision headBranch must be a non-empty string");
	if (!isNonEmptyString(parsed.prTitle)) throw new EffectsManifestError("invalid_manifest", "ship decision prTitle must be a non-empty string");

	// The PR body travels only as a file at a fixed, harness-owned location inside the worktree so a
	// large, quote/newline-heavy body never has to survive hand-escaped JSON in prose (#303).
	// Constrained to that exact path — never an arbitrary worktree file — and read symlink-safe
	// (#312). Inline `prBody` is no longer accepted; if both keys are present the file wins and the
	// leftover scalar is ignored (no dual-source merge).
	const expectedBodyFile = shipBodyFile(expected.itemId);
	if (!isNonEmptyString(parsed.prBodyFile)) {
		throw new EffectsManifestError("invalid_manifest", `ship decision must provide a non-empty prBodyFile (exactly ${expectedBodyFile})`);
	}
	if (parsed.prBodyFile !== expectedBodyFile) {
		throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile must be exactly ${expectedBodyFile}, got ${String(parsed.prBodyFile)}`);
	}
	const prBody = readPrBodyFile(expected.worktree, expectedBodyFile);
	if (prBody.trim() === "") {
		throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile is empty: ${expectedBodyFile}`);
	}

	return {
		kind: "ship.ShipDecision",
		target: expected.target,
		itemId: expected.itemId,
		headBranch: parsed.headBranch,
		prTitle: parsed.prTitle,
		prBody,
	};
}

/** Read the PR body from the fixed worktree-owned scratch file, fail-closed on any symlink in the path,
 *  any escape of the worktree, a non-regular file, or a body over the size bound. All validation runs
 *  through a single descriptor that is *opened first*, then checked — so there is no canonicalize→open
 *  swap window: `O_NOFOLLOW` rejects a symlinked leaf at open time, and the descriptor's own real path
 *  (via `/proc/self/fd`) is what gets containment-checked, catching an ancestor symlink as resolved at
 *  open on the pinned inode. The size bound is enforced while reading (a concurrent writer can grow the
 *  file after `fstat`), not from a stale stat snapshot (#312). Note: the `canonical === lexical` check is
 *  byte-exact, so a case-insensitive/normalizing filesystem could false-reject — acceptable here because
 *  the path is a fully harness-owned literal on the Linux run host and the direction is fail-closed. */
function readPrBodyFile(worktree: string, relPath: string): string {
	const worktreeReal = realpathSync(worktree);
	const lexical = resolve(worktreeReal, relPath);
	// Lexical containment: `relPath` embeds the harness-controlled itemId, but never let a crafted id
	// resolve to a `..`/absolute segment outside the worktree (defence-in-depth; itemId is constrained today).
	const within = relative(worktreeReal, lexical);
	if (within === "" || within.startsWith("..") || isAbsolute(within)) {
		throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile escapes the worktree: ${relPath}`);
	}
	let fd: number;
	try {
		// O_NOFOLLOW: a symlinked leaf fails to open here rather than being silently followed.
		fd = openSync(lexical, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile not found or not a plain file: ${relPath}`);
	}
	try {
		// Where the pinned descriptor actually points, with ancestor symlinks resolved as at open time.
		// Comparing this to the lexical path rejects any symlink in the chain and any escape, TOCTOU-free.
		let canonical: string;
		try {
			canonical = realpathSync(`/proc/self/fd/${fd}`);
		} catch {
			canonical = realpathSync(lexical); // non-Linux fallback: best-effort, narrower window
		}
		if (canonical !== lexical) {
			throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile path must not contain a symlink: ${relPath}`);
		}
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile is not a regular file: ${relPath}`);
		// Read up to MAX+1 bytes off the descriptor and reject if it overflows — enforcing the bound during
		// the read, so a writer that grows the file after fstat cannot slip a larger body past the check.
		const buf = Buffer.allocUnsafe(MAX_PR_BODY_BYTES + 1);
		let total = 0;
		let n: number;
		do {
			n = readSync(fd, buf, total, buf.length - total, null);
			total += n;
		} while (n > 0 && total <= MAX_PR_BODY_BYTES);
		if (total > MAX_PR_BODY_BYTES) throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile exceeds ${MAX_PR_BODY_BYTES} bytes: ${relPath}`);
		return buf.subarray(0, total).toString("utf-8");
	} finally {
		closeSync(fd);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}
