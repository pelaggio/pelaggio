/** Parse the `pick` step's output and pin/defer signals into typed results (L2). */
import type { CreateItemOpts } from "./roadmap/types.js";

export type PickReason = "claimed" | "blocked" | "unknown-id" | "already-done" | "worktree-exists" | "already-claimed" | "queue-empty" | "stale-quarantined";

const PICK_REASONS: ReadonlySet<PickReason> = new Set(["claimed", "blocked", "unknown-id", "already-done", "worktree-exists", "already-claimed", "queue-empty", "stale-quarantined"]);

/**
 * Parse a structured `pick-result: <tag>` trailing line from the /pick skill output.
 * Last occurrence wins so the skill can safely restate the tag in a summary
 * paragraph. Unknown tags → null. No tag present → null.
 */
export function parsePickResult(text: string): PickReason | null {
	const re = /^[ \t]*pick-result:[ \t]*([a-z-]+)[ \t]*$/gim;
	let last: string | null = null;
	for (const m of text.matchAll(re)) last = m[1].toLowerCase();
	if (last === null) return null;
	return PICK_REASONS.has(last as PickReason) ? (last as PickReason) : null;
}

/**
 * Parse a structured `pick-item: <ID>` line from the /pick skill output.
 * Last occurrence wins. Accepts IDs matching `(?:[A-Z]+-?)?\d[\dA-Z-]*` — the
 * optional letter prefix + hyphens allow both markdown/linear ids (`COMP-11C-II`,
 * `ACME-7`) and bare-numeric github issue ids (`337`). The bare-numeric case is
 * load-bearing: `pick-item:` is the skill's AUTHORITATIVE claim marker (SKILL.md),
 * and rejecting numeric ids here would drop github back to ambiguous free-text
 * `parseItemId` parsing — the exact ambiguity the marker exists to remove (#332).
 * Malformed values → null.
 */
export function parsePickItem(text: string): string | null {
	const re = /^[ \t]*pick-item:[ \t]*([^\s][^\n]*?)[ \t]*$/gim;
	let last: string | null = null;
	for (const m of text.matchAll(re)) last = m[1];
	if (last === null) return null;
	return /^(?:[A-Z]+-?)?\d[\dA-Z-]*$/.test(last) ? last : null;
}

/**
 * #332: decide whether the item a /pick step actually resolved diverged from an explicit
 * `--item` pin. An explicit pin is a deterministic gate — the pick skill's contract is to claim
 * exactly that id (or report done/blocked), never substitute a different ready item — but the
 * resolved id is parsed from pick's OUTPUT, so a diverting skill would silently redirect the whole
 * cycle. Both ids are normalized through the adapter's `parseItemId` (so `#286` / `issue-286` /
 * `feat/issue-286` all reduce to `286`) before comparison; a normalizer returning null falls back
 * to the raw string. Comparison is case-insensitive: the markdown adapter's `getItem` accepts ids
 * case-insensitively (so `--item tool-16` is the same item as the canonical `TOOL-16`), while
 * github (numeric) / linear (uppercase) ids are unaffected by folding — so uppercasing avoids a
 * false `pick:diverted` on a mixed-case pin without ever merging two genuinely-distinct ids.
 * Returns true when the resolved id is not the pinned one.
 */
export async function pickDivergedFromPin(pin: string, resolved: string, parseItemId: (text: string) => Promise<string | null>): Promise<boolean> {
	const requested = ((await parseItemId(pin)) ?? pin).toUpperCase();
	const got = ((await parseItemId(resolved)) ?? resolved).toUpperCase();
	return requested !== got;
}

/**
 * Parse `deferred-item: {json}` markers a shakedown-code step emits (#115). Under pelaggio the
 * model lists deferred follow-ups as these markers instead of running `roadmap create-item` itself
 * (a sandboxed provider can't); the harness creates them post-step. One JSON object per line:
 * `{ "title": "...", "scope"?: "XS|S|M|L|XL", "deps"?: "A, B" }`. Malformed/title-less lines are
 * skipped; every item is flagged `deferred: true`. `deps` accepts a JSON array
 * (`["A","B"]`) or a comma-separated string (`"A, B"`). Pass a shared `seen` set to
 * dedup across multiple call sites (e.g. plan + shakedown-code both parse markers —
 * `createItem` is not idempotent, so a marker echoed in both must create only once).
 */
export function parseDeferredItems(text: string, seen: Set<string> = new Set<string>()): CreateItemOpts[] {
	const SCOPES = new Set(["XS", "S", "M", "L", "XL"]);
	const items: CreateItemOpts[] = [];
	for (const m of text.matchAll(/^[ \t]*deferred-item:[ \t]*(\{.*\})[ \t]*$/gim)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(m[1]);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const rec = parsed as Record<string, unknown>;
		const title = typeof rec.title === "string" ? rec.title.trim() : "";
		if (!title || seen.has(title.toLowerCase())) continue;
		seen.add(title.toLowerCase());
		const scopeRaw = typeof rec.scope === "string" ? rec.scope.toUpperCase() : "";
		const scope = SCOPES.has(scopeRaw) ? (scopeRaw as CreateItemOpts["scope"]) : undefined;
		const deps = Array.isArray(rec.deps)
			? rec.deps.filter((d): d is string => typeof d === "string" && d.trim() !== "").map((d) => d.trim())
			: typeof rec.deps === "string"
				? rec.deps
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;
		items.push({ title, ...(scope ? { scope } : {}), ...(deps && deps.length > 0 ? { deps } : {}), deferred: true });
	}
	return items;
}

// ── Refusal & error classification ─────────────────────────────────────
