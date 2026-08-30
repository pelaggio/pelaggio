/** Pure text formatting helpers (L0). */

export function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The single escaping rule for model-authored text on PUBLIC comment surfaces (the fleet
 *  review comment and the operator-adjudication comment). Lives here — a leaf module — so
 *  review/adjudication.ts can share it without a pr-review-cli → step-runner import cycle. */
export function escapeMarkdown(value: string): string {
	return escapeHtml(value).replace(/([\\`*_[\]{}()#+.!|>-])/g, "\\$1");
}

// ── Blocked / stalled-ask parsing ──────────────────────────────────────

/** Format milliseconds as human-readable wait time: "4h 32m", "12m", "<1m". */
export function fmtWait(ms: number): string {
	const totalMin = Math.ceil(ms / 60_000);
	if (totalMin < 1) return "<1m";
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h === 0) return `${m}m`;
	if (m === 0) return `${h}h`;
	return `${h}h ${m}m`;
}

// `--item` on an already-claimed id is refused by pick's worktree-exists guard (#56) — the
// working re-entry path is `--resume <id>`, one process per id. `--resume` doesn't accept a
// list, so multiple parked items print one hint line each.
export function formatResumeHint(ids: string[]): string {
	return ids.map((id) => `pnpm pelaggio --resume ${id}`).join("\n          ");
}

/** Escape a literal for use inside a `RegExp` source. */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
