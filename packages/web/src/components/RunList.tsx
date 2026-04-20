import type { RunSummary } from "@cdhorne/claude-autopilot-server/types";
import { useEffect, useState } from "react";
import { ApiError, listRuns } from "../lib/api.js";
import { formatDate, statusBadgeClass } from "../lib/format.js";

const POLL_MS = 5_000;

export function RunList() {
	const [runs, setRuns] = useState<RunSummary[] | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		const tick = async () => {
			try {
				const res = await listRuns();
				if (!cancelled) {
					setRuns(res.runs);
					setError(undefined);
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
			}
		};
		tick();
		const id = setInterval(tick, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	if (error) return <p className="text-red-700">Error loading runs: {error}</p>;
	if (runs === undefined) return <p className="text-slate-500">Loading…</p>;
	if (runs.length === 0)
		return (
			<p className="text-slate-500">
				No runs yet. <a href="/ui/start/">Start one</a>.
			</p>
		);

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
					<tr key={r.id}>
						<td>
							<a href={`/ui/runs/?id=${encodeURIComponent(r.id)}`} className="block min-h-[44px] py-2">
								{r.item}
							</a>
						</td>
						<td>{r.lastStep ?? "—"}</td>
						<td>
							<span className={statusBadgeClass(r.status)}>{r.status}</span>
						</td>
						<td className="text-sm text-slate-600">{formatDate(r.startedAt)}</td>
						<td className="text-sm text-slate-600">{formatDate(r.endedAt)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
