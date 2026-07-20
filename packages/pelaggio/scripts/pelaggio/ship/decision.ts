import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { EffectsManifestError, type ShipDecisionEffect } from "../effects.js";
import type { ShipTargetName, StepResult } from "../types.js";
import { SHIP_TARGET_NAMES } from "./index.js";

const SHIP_DECISION_RE = /SHIP_DECISION\s*([\s\S]*?)\s*END_SHIP_DECISION/;
// A PR body far past any real deliverable + appended review record. Bounds the file read.
const MAX_PR_BODY_BYTES = 512 * 1024;

/** The fixed, harness-owned location the ship worker writes the PR body to, relative to the worktree. */
export function shipBodyFile(itemId: string): string {
	return `.dev/ship/pr-body-${itemId}.md`;
}

export function parseShipDecisionEffect(step: StepResult, expected: { itemId: string; target: ShipTargetName; worktree: string }): ShipDecisionEffect {
	const haystack = `${step.text}\n${step.fullText}`;
	const match = haystack.match(SHIP_DECISION_RE);
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

	// The PR body travels as a file at a fixed, harness-owned location inside the worktree so a large,
	// quote/newline-heavy body never has to survive hand-escaped JSON in prose (#303). Constrained to
	// that exact path — never an arbitrary worktree file — and read symlink-safe (#312). A legacy inline
	// `prBody` is still accepted as a small-body fallback.
	const expectedBodyFile = shipBodyFile(expected.itemId);
	let prBody: string | undefined;
	if (isNonEmptyString(parsed.prBodyFile)) {
		if (parsed.prBodyFile !== expectedBodyFile) throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile must be exactly ${expectedBodyFile}, got ${String(parsed.prBodyFile)}`);
		prBody = readPrBodyFile(expected.worktree, expectedBodyFile);
	} else if (isNonEmptyString(parsed.prBody)) {
		prBody = parsed.prBody;
	}
	if (prBody === undefined || prBody.trim() === "") {
		throw new EffectsManifestError("invalid_manifest", `ship decision must provide a non-empty prBodyFile (exactly ${expectedBodyFile}) or an inline prBody`);
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

/** Read the PR body from the fixed worktree-owned scratch file, fail-closed on any symlink in the path
 *  (the canonicalized path is compared to the lexical one, so an ancestor symlink can neither escape the
 *  worktree nor redirect the read at host/secret files), a non-regular file, or one over the size bound.
 *  Validation and consumption go through a single descriptor (open → fstat → read) so they refer to the
 *  same object with no swap window (#312). */
function readPrBodyFile(worktree: string, relPath: string): string {
	const worktreeReal = realpathSync(worktree);
	const lexical = resolve(worktreeReal, relPath);
	let real: string;
	try {
		real = realpathSync(lexical);
	} catch {
		throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile not found: ${relPath}`);
	}
	// A symlink anywhere in the path makes the canonical path differ from the lexical one. The worker
	// must write a plain regular file at the exact location; a symlink is how a compromised worker would
	// escape confinement or point the read at host/secret files.
	if (real !== lexical) throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile path must not contain a symlink: ${relPath}`);
	const fd = openSync(real, "r");
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile is not a regular file: ${relPath}`);
		if (stat.size > MAX_PR_BODY_BYTES) throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile exceeds ${MAX_PR_BODY_BYTES} bytes: ${relPath}`);
		return readFileSync(fd, "utf-8");
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
