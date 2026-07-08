import type { RunSummary } from "@pelaggio/server/types";
import { useEffect, useState } from "react";
import { ApiError, listRuns } from "../lib/api.js";
import { formatDate, formatItemId, statusBadgeClass } from "../lib/format.js";
import { retryInit, useRepos } from "../lib/repo.js";

const POLL_MS = 5_000;

export function RunList() {
	const reposState = useRepos();
	const [groupAll, setGroupAll] = useState(false);
	const [runs, setRuns] = useState<RunSummary[] | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	const currentRepo = reposState.status === "ready" ? reposState.current : null;

	useEffect(() => {
		if (reposState.status === "loading") return;
		if (reposState.status === "empty") {
			setRuns([]);
			setError(undefined);
			return;
		}
		let cancelled = false;
		setRuns(undefined);
		const tick = async () => {
			try {
				const opts = groupAll || !currentRepo ? undefined : { repo: currentRepo };
				const res = await listRuns(opts);
				if (!cancelled) {
					setRuns(res.runs);
					setError(undefined);
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
			}
		};
		void tick();
		const id = setInterval(tick, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [reposState.status, currentRepo, groupAll]);

	if (reposState.status === "error") {
		return (
			<p className="text-red-700">
				Failed to load repos: {reposState.error}
				<button type="button" onClick={() => void retryInit()} className="ml-2 underline">
					retry
				</button>
			</p>
		);
	}
	if (reposState.status === "empty") {
		return <p className="text-slate-500">No repos configured.</p>;
	}
	if (reposState.status === "loading" || runs === undefined) {
		return <p className="text-slate-500">Loading…</p>;
	}
	if (error) return <p className="text-red-700">Error loading runs: {error}</p>;

	const repoOrder = reposState.repos.map((r) => r.slug);

	return (
		<div className="space-y-3">
			<GroupToggle on={groupAll} onChange={setGroupAll} />
			{runs.length === 0 ? (
				<p className="text-slate-500">
					No runs yet. <a href="/ui/start/">Start one</a>.
				</p>
			) : groupAll ? (
				<GroupedTable runs={runs} repoOrder={repoOrder} />
			) : (
				<FlatTable runs={runs} />
			)}
		</div>
	);
}

function GroupToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
	return (
		<label className="flex items-center gap-2 text-sm text-slate-600">
			<input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
			all repos
		</label>
	);
}

function FlatTable({ runs }: { runs: RunSummary[] }) {
	return (
		<table>
			<thead>
				<tr>
					<th>Item</th>
					<th>Step</th>
					<th>Status</th>
					<th>Started</th>
					<th>Ended</th>
				</tr>
			</thead>
			<tbody>
				{runs.map((r) => (
					<RunRow key={r.id} r={r} />
				))}
			</tbody>
		</table>
	);
}

function GroupedTable({ runs, repoOrder }: { runs: RunSummary[]; repoOrder: string[] }) {
	const groups = new Map<string, RunSummary[]>();
	for (const r of runs) {
		const arr = groups.get(r.repo);
		if (arr) arr.push(r);
		else groups.set(r.repo, [r]);
	}
	const known = repoOrder.filter((s) => groups.has(s));
	const unknown = [...groups.keys()].filter((s) => !repoOrder.includes(s));
	const orderedSlugs = [...known, ...unknown];
	return (
		<table>
			<thead>
				<tr>
					<th>Item</th>
					<th>Step</th>
					<th>Status</th>
					<th>Started</th>
					<th>Ended</th>
				</tr>
			</thead>
			{orderedSlugs.map((slug) => (
				<tbody key={slug}>
					<tr className="bg-slate-50">
						<td colSpan={5} className="text-sm font-semibold text-slate-700">
							{slug}
						</td>
					</tr>
					{groups.get(slug)!.map((r) => (
						<RunRow key={r.id} r={r} />
					))}
				</tbody>
			))}
		</table>
	);
}

function RunRow({ r }: { r: RunSummary }) {
	return (
		<tr>
			<td>
				<a href={`/ui/runs/?id=${encodeURIComponent(r.id)}`} className="block min-h-[44px] py-2">
					{formatItemId(r.item, r.repo)}
				</a>
			</td>
			<td>{r.lastStep ?? "—"}</td>
			<td>
				<span className={statusBadgeClass(r.status)}>{r.status}</span>
			</td>
			<td className="text-sm text-slate-600">{formatDate(r.startedAt)}</td>
			<td className="text-sm text-slate-600">{formatDate(r.endedAt)}</td>
		</tr>
	);
}
