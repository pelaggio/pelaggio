import type { RunStatus } from "@pelaggio/server/types";

export function formatDate(iso: string | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString();
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const remS = s % 60;
	if (m < 60) return `${m}m ${remS}s`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	return `${h}h ${remM}m`;
}

export function formatUsd(n: number): string {
	if (!Number.isFinite(n)) return "—";
	if (n === 0) return "$0.00";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "—";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatItemId(id: string, repo: string | null | undefined): string {
	if (!repo || !/^\d+$/.test(id)) return id;
	return `${repo}#${id}`;
}

const STATUS_CLASSES: Record<RunStatus, string> = {
	running: "bg-blue-100 text-blue-800",
	completed: "bg-green-100 text-green-800",
	failed: "bg-red-100 text-red-800",
	parked: "bg-amber-100 text-amber-800",
	paused: "bg-slate-200 text-slate-800",
	abandoned: "bg-zinc-200 text-zinc-700",
};

export function statusBadgeClass(status: RunStatus): string {
	return `inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[status]}`;
}
