import type { Stats } from "@cdhorne/claude-autopilot";
import { useEffect, useState } from "react";
import { ApiError, getStats } from "../lib/api.js";
import { formatTokens, formatUsd } from "../lib/format.js";
import { useRepos } from "../lib/repo.js";

const POLL_MS = 30_000;

export function StatsView() {
	const reposState = useRepos();
	const currentRepo = reposState.status === "ready" ? reposState.current : null;
	const [stats, setStats] = useState<Stats | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (!currentRepo) return;
		let cancelled = false;
		setStats(undefined);
		const tick = async () => {
			try {
				const s = await getStats(currentRepo);
				if (!cancelled) {
					setStats(s);
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
	}, [currentRepo]);

	if (reposState.status === "empty") return <p className="text-slate-500">No repos configured.</p>;
	if (reposState.status === "loading") return <p className="text-slate-500">Loading…</p>;
	if (error) return <p className="text-red-700">Error loading stats: {error}</p>;
	if (!stats) return <p className="text-slate-500">Loading…</p>;

	const stepKeys = Array.from(new Set([...Object.keys(stats.costByStep), ...Object.keys(stats.avgRetriesByStep), ...Object.keys(stats.rethinkRateByStep)])).sort();
	const totalTokens = stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.cacheRead + stats.totalTokens.cacheCreation;

	return (
		<div className="space-y-8">
			<h1 className="text-2xl font-semibold">Stats — {currentRepo}</h1>

			<section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Card label="Cycles" value={String(stats.totalCycles)} />
				<Card label="Completed" value={String(stats.completedCycles)} />
				<Card label="Failed" value={String(stats.failedCycles)} />
				<Card label="Parked" value={String(stats.parkedCycles)} />
				<Card label="Total cost" value={formatUsd(stats.totalCostUsd)} />
				<Card label="Total tokens" value={formatTokens(totalTokens)} />
				<Card label="Cache hit" value={`${(stats.cacheHitRatio * 100).toFixed(1)}%`} />
				<Card label="Avg shakedown" value={stats.avgShakedownIterations.toFixed(2)} />
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold">Per-step</h2>
				<table>
					<thead>
						<tr>
							<th>Step</th>
							<th>Avg retries</th>
							<th>Rethink rate</th>
							<th>Cost</th>
						</tr>
					</thead>
					<tbody>
						{stepKeys.map((k) => (
							<tr key={k}>
								<td>{k}</td>
								<td>{(stats.avgRetriesByStep[k] ?? 0).toFixed(2)}</td>
								<td>{((stats.rethinkRateByStep[k] ?? 0) * 100).toFixed(1)}%</td>
								<td>{formatUsd(stats.costByStep[k] ?? 0)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold">Items delivered ({stats.itemsDelivered.length})</h2>
				<ul className="space-y-1 text-sm">
					{stats.itemsDelivered
						.slice(-20)
						.reverse()
						.map((i) => (
							<li key={`${i.id}-${i.date}`}>
								<code>{i.id}</code> · {i.date} · {formatUsd(i.cost)}
								{i.parked ? " · parked" : ""}
							</li>
						))}
				</ul>
			</section>

			{stats.recentFailures.length > 0 && (
				<section>
					<h2 className="mb-2 text-lg font-semibold">Recent failures</h2>
					<ul className="space-y-1 text-sm">
						{stats.recentFailures.map((f) => (
							<li key={`${f.ts}-${f.item ?? "?"}-${f.error ?? "?"}`}>
								<span className="text-slate-500">{f.ts}</span> · {f.item ?? "?"} · {f.error ?? "?"}
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

function Card({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded border border-slate-200 bg-white p-3">
			<div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
			<div className="mt-1 text-xl font-semibold">{value}</div>
		</div>
	);
}
