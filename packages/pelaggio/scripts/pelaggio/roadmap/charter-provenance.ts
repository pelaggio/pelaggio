import { type CreateItemOpts, isScope, type ReviewProvenance, type Scope } from "./types.js";

/**
 * One canonical charter-review provenance marker (#367) so GitHub, Linear, Beads, and markdown persist
 * compatible bytes instead of hand-rolling incompatible strings. Rendered as an HTML comment appended to
 * the item body/description; parsed back on read so `reviewDigest` / level / deferred round-trip.
 */
const MARKER_RE = /<!--\s*pelaggio:charter-review\s+v1\s+([^>]*?)\s*-->/;

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

/** Remove any existing marker (used before re-stamping on activation). */
export function stripCharterMarker(body: string): string {
	return body.replace(MARKER_RE, "").replace(/\n{3,}/g, "\n\n");
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

/** Parse a marker out of arbitrary text. Returns null when no marker is present (legacy items). */
export function parseCharterMarker(text: string): ParsedProvenance | null {
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
