import { type ActivationExpectation, type CreateItemOpts, isScope, type ReviewProvenance, type Scope } from "./types.js";

/**
 * One canonical charter-review provenance marker (#367) so GitHub, Linear, Beads, and markdown persist
 * compatible bytes instead of hand-rolling incompatible strings. Rendered as an HTML comment appended to
 * the item body/description; parsed back on read so `reviewDigest` / level / deferred round-trip.
 */
const MARKER_RE = /<!--\s*pelaggio:charter-review\s+v1\s+([^>]*?)\s*-->/;
/** Global twin, used to strip *every* marker and to count them. Deliberately a separate object: a
 *  shared `g`-flagged regex carries `lastIndex` between calls, which would make parsing depend on
 *  what was stripped before it. `String.replace`/`String.match` both reset it, so this stays pure. */
const MARKER_RE_ALL = /<!--\s*pelaggio:charter-review\s+v1\s+([^>]*?)\s*-->/g;

export interface ParsedProvenance {
	reviewDigest?: string;
	level?: string;
	scope?: Scope;
	deferred: boolean;
	origin?: string;
}

/** Render the stable one-line marker. Fields with no value are omitted; a missing digest ⇒ `digest=none`. */
export function renderCharterMarker(provenance: ReviewProvenance): string {
	const parts = [
		`digest=${provenance.reviewDigest || "none"}`,
		`level=${provenance.level}`,
		...(provenance.scope ? [`scope=${provenance.scope}`] : []),
		`deferred=${provenance.deferred ? "true" : "false"}`,
		...(provenance.origin ? [`origin=${provenance.origin}`] : []),
	];
	return `<!-- pelaggio:charter-review v1 ${parts.join(" ")} -->`;
}

/** Append the marker to a body/description, replacing any existing marker so activation can rewrite it. */
export function withCharterMarker(body: string, provenance: ReviewProvenance): string {
	const marker = renderCharterMarker(provenance);
	const stripped = stripCharterMarker(body);
	return stripped.trim() === "" ? marker : `${stripped.replace(/\n*$/, "")}\n\n${marker}`;
}

/**
 * Remove *every* existing marker (used before re-stamping on activation).
 *
 * Strips exhaustively, not just the first match. Bodies are attacker-controlled: with a single-match
 * strip, planting two markers meant one survived restamping and sat *ahead* of the genuine one that
 * `withCharterMarker` appends — and `parseCharterMarker` trusted the first it found. That let an
 * injected `deferred=false` and a forged digest be read back as harness-stamped provenance.
 */
export function stripCharterMarker(body: string): string {
	return body.replace(MARKER_RE_ALL, "").replace(/\n{3,}/g, "\n\n");
}

/** True when the gate stamped charter fields on these opts (skip the marker for raw/legacy createItem calls). */
export function hasCharterProvenance(opts: CreateItemOpts): boolean {
	return opts.reviewLevel !== undefined || opts.reviewDigest !== undefined || opts.deferred === true;
}

/** Build the adapter-facing provenance from gate-stamped create opts (origin maps to create|harness-deferral). */
export function provenanceFromCreateOpts(opts: CreateItemOpts): ReviewProvenance {
	return {
		reviewDigest: opts.reviewDigest ?? "",
		level: opts.reviewLevel ?? "off",
		...(opts.scope ? { scope: opts.scope } : {}),
		origin: opts.origin === "harness-deferral" ? "harness-deferral" : "create",
		deferred: opts.deferred === true,
	};
}

/**
 * Parse a marker out of arbitrary text. Returns null when no marker is present (legacy items) **and**
 * when more than one is present.
 *
 * Ambiguity is refused rather than resolved. Picking the first or the last marker just moves which
 * position an attacker has to write to; a body carrying two markers is not trustworthy provenance
 * under any rule. Null is already the fail-closed answer here — callers simply adopt no digest and no
 * level, so the item reads as un-reviewed and the gate demands a real review.
 */
export function parseCharterMarker(text: string): ParsedProvenance | null {
	const all = text.match(MARKER_RE_ALL);
	if (!all) return null;
	if (all.length > 1) return null;
	const m = text.match(MARKER_RE);
	if (!m) return null;
	const fields = new Map<string, string>();
	for (const token of (m[1] ?? "").trim().split(/\s+/)) {
		const eq = token.indexOf("=");
		if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
	}
	const digest = fields.get("digest");
	const scopeRaw = fields.get("scope");
	return {
		...(digest && digest !== "none" ? { reviewDigest: digest } : {}),
		...(fields.get("level") ? { level: fields.get("level") } : {}),
		...(scopeRaw && isScope(scopeRaw) ? { scope: scopeRaw } : {}),
		deferred: fields.get("deferred") === "true",
		...(fields.get("origin") ? { origin: fields.get("origin") } : {}),
	};
}

/** Raised when the item changed under an in-flight activation review. Distinguishable so the gate can
 *  report a stale review rather than crash the caller. */
export class CharterActivationStaleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CharterActivationStaleError";
	}
}

/**
 * Refuse to restamp when the item no longer matches what the panel reviewed.
 *
 * Called by every adapter *before* any mutation, so a mismatch leaves the deferred label and the
 * deferred state intact — the same fail-closed ordering the adapters already use for a failed edit.
 * Omitting `expected` keeps the legacy unchecked behaviour for callers that have no snapshot.
 */
export function assertActivationInputsUnchanged(id: string, expected: ActivationExpectation | undefined, current: { title: string; body: string }): void {
	if (!expected) return;
	const changed = current.title !== expected.title ? "title" : current.body !== expected.body ? "body" : null;
	if (!changed) return;
	throw new CharterActivationStaleError(`activateItem: ${id} changed while its activation review was running (${changed} differs); the verdict describes content that is no longer current, so the item stays deferred — re-run activation`);
}
