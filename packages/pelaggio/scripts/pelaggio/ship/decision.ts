import { lstatSync, readFileSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { EffectsManifestError, type ShipDecisionEffect } from "../effects.js";
import type { ShipTargetName, StepResult } from "../types.js";
import { SHIP_TARGET_NAMES } from "./index.js";

const SHIP_DECISION_RE = /SHIP_DECISION\s*([\s\S]*?)\s*END_SHIP_DECISION/;
// A PR body far past any real deliverable + appended review record. Bounds the file read.
const MAX_PR_BODY_BYTES = 512 * 1024;

export function parseShipDecisionEffect(step: StepResult, expected: { itemId: string; target: ShipTargetName; worktree: string }): ShipDecisionEffect {
	const haystack = `${step.text}\n${step.fullText}`;
	const match = haystack.match(SHIP_DECISION_RE);
	if (!match) throw new EffectsManifestError("invalid_manifest", "ship decision block not found");

	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]);
	} catch (e) {
		throw new EffectsManifestError("invalid_manifest", "ship decision block is not valid JSON", { cause: e });
	}
	if (!isRecord(parsed)) throw new EffectsManifestError("invalid_manifest", "ship decision must be a JSON object");
	if (!SHIP_TARGET_NAMES.includes(parsed.target as ShipTargetName)) throw new EffectsManifestError("invalid_manifest", "ship decision target must be a valid ship target");
	if (parsed.target !== expected.target) throw new EffectsManifestError("invalid_manifest", `ship decision target ${String(parsed.target)} does not match configured target ${expected.target}`);
	if (parsed.itemId !== undefined && parsed.itemId !== expected.itemId) throw new EffectsManifestError("invalid_manifest", `ship decision itemId ${String(parsed.itemId)} does not match ${expected.itemId}`);
	if (!isNonEmptyString(parsed.headBranch)) throw new EffectsManifestError("invalid_manifest", "ship decision headBranch must be a non-empty string");
	if (!isNonEmptyString(parsed.prTitle)) throw new EffectsManifestError("invalid_manifest", "ship decision prTitle must be a non-empty string");

	// The PR body travels as a file inside the worktree (`prBodyFile`) so a large, quote/newline-heavy
	// body never has to survive hand-escaped JSON emitted in prose (#303). A legacy inline `prBody` is
	// still accepted as a fallback for small bodies / older skill prompts.
	const prBody = isNonEmptyString(parsed.prBodyFile) ? readPrBodyFile(expected.worktree, parsed.prBodyFile) : isNonEmptyString(parsed.prBody) ? parsed.prBody : undefined;
	if (prBody === undefined || prBody.trim() === "") {
		throw new EffectsManifestError("invalid_manifest", "ship decision must provide a non-empty prBodyFile (worktree-relative path to the PR body) or an inline prBody");
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

/** Read the PR body from a worktree-relative file, fail-closed on any path that escapes the worktree,
 *  is not a regular file (lstat rejects symlinks), or exceeds the size bound. */
function readPrBodyFile(worktree: string, relPath: string): string {
	if (isAbsolute(relPath)) throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile must be worktree-relative, not absolute: ${relPath}`);
	const worktreeAbs = resolve(worktree);
	const abs = resolve(worktreeAbs, relPath);
	const rel = relative(worktreeAbs, abs);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile escapes the worktree: ${relPath}`);
	let stat: Stats;
	try {
		stat = lstatSync(abs);
	} catch {
		throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile not found: ${relPath}`);
	}
	if (!stat.isFile()) throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile is not a regular file (symlinks are rejected): ${relPath}`);
	if (stat.size > MAX_PR_BODY_BYTES) throw new EffectsManifestError("invalid_manifest", `ship decision prBodyFile exceeds ${MAX_PR_BODY_BYTES} bytes: ${relPath}`);
	return readFileSync(abs, "utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}
