import type { StatsResponse } from "@pelaggio/server/types";
import { useEffect, useState } from "react";
import { ApiError, getStats } from "../lib/api.js";
import { formatItemLabel, formatTokens, formatUsd } from "../lib/format.js";
import { retryInit, useRepos } from "../lib/repo.js";

const POLL_MS = 30_000;

export function StatsView() {
	const reposState = useRepos();
	const currentRepo = reposState.status === "ready" ? reposState.current : null;
	const [stats, setStats] = useState<StatsResponse | undefined>(undefined);
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

	if (reposState.status === "error") {
		return (
			<p className="wrap pt-10 text-fail">
				Failed to load repos: {reposState.error}
				<button type="button" onClick={() => void retryInit()} className="btn-inline ml-2">
					retry
				</button>
			</p>
		);
	}
	if (reposState.status === "empty") return <p className="wrap pt-10 text-ink-soft">No repos configured.</p>;
	if (reposState.status === "loading") return <p className="wrap pt-10 text-ink-soft">Loading…</p>;
	if (error) return <p className="wrap pt-10 text-fail">Error loading stats: {error}</p>;
	if (!stats) return <p className="wrap pt-10 text-ink-soft">Loading…</p>;

	const stepKeys = Array.from(new Set([...Object.keys(stats.costByStep), ...Object.keys(stats.avgRetriesByStep), ...Object.keys(stats.maxTurnsRetriesByStep), ...Object.keys(stats.rethinkRateByStep)])).sort();
	const totalTokens = stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.cacheRead + stats.totalTokens.cacheCreation;
	// Sorted by spend / count descending — the top row is the one worth acting on.
	const providerKeys = Object.keys(stats.costByProvider).sort((a, b) => (stats.costByProvider[b] ?? 0) - (stats.costByProvider[a] ?? 0));
	const parkKeys = Object.keys(stats.parksByClass).sort((a, b) => (stats.parksByClass[b] ?? 0) - (stats.parksByClass[a] ?? 0));
	const blockKeys = Object.keys(stats.blocksByKind).sort((a, b) => (stats.blocksByKind[b] ?? 0) - (stats.blocksByKind[a] ?? 0));
	const failKeys = Object.keys(stats.failuresByCause).sort((a, b) => (stats.failuresByCause[b] ?? 0) - (stats.failuresByCause[a] ?? 0));

	return (
		<div className="wrap pb-20 pt-10 md:pt-14">
			<p className="eyebrow">This repository · {currentRepo}</p>
			<h1 className="mt-3 font-display text-2xl font-medium tracking-tight text-ink md:text-[2.5rem] md:leading-[1.1]">Stats</h1>
			<p className="mt-3 max-w-xl text-[17px] text-ink-soft">Reducer over this repo's recorded cycles. Cost is self-reported.</p>

			<dl className="mt-10 grid grid-cols-2 gap-px overflow-hidden border border-foam-line bg-foam-line sm:grid-cols-4">
				<Card label="Cycles" value={String(stats.totalCycles)} />
				<Card label="Completed" value={String(stats.completedCycles)} />
				<Card label="Failed" value={String(stats.failedCycles)} />
				<Card label="Parked" value={String(stats.parkedCycles)} />
				<Card label="Blocked" value={String(stats.blockedCycles)} />
				<Card label="Total cost" value={formatUsd(stats.totalCostUsd)} hint="self-reported" />
				<Card label="Total tokens" value={formatTokens(totalTokens)} />
				<Card label="Cache hit" value={`${(stats.cacheHitRatio * 100).toFixed(1)}%`} />
				<Card label="Avg shakedown" value={stats.avgShakedownIterations.toFixed(2)} />
			</dl>

			<section className="mt-12">
				<h2 className="font-display text-xl font-medium tracking-tight text-ink">Per-step</h2>
				<div className="mt-4 overflow-x-auto">
					<table>
						<thead>
							<tr>
								<th>Step</th>
								<th>Avg retries</th>
								<th>Turn-limit retries</th>
								<th>Rethink rate</th>
								<th>Cost</th>
							</tr>
						</thead>
						<tbody>
							{stepKeys.map((k) => (
								<tr key={k}>
									<th scope="row" className="font-mono text-xs font-normal text-ink">
										{k}
									</th>
									<td className="font-mono text-sm tabular-nums">{(stats.avgRetriesByStep[k] ?? 0).toFixed(2)}</td>
									<td className="font-mono text-sm tabular-nums">{stats.maxTurnsRetriesByStep[k] ?? 0}</td>
									<td className="font-mono text-sm tabular-nums">{((stats.rethinkRateByStep[k] ?? 0) * 100).toFixed(1)}%</td>
									<td className="font-mono text-sm tabular-nums">{formatUsd(stats.costByStep[k] ?? 0)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			{providerKeys.length > 0 && (
				<section className="mt-12">
					<h2 className="font-display text-xl font-medium tracking-tight text-ink">Per-provider</h2>
					<p className="mt-1 text-sm text-ink-soft">Single-harness counts. Not a bake-off.</p>
					<div className="mt-4 overflow-x-auto">
						<table>
							<thead>
								<tr>
									<th>Provider</th>
									<th>Cost</th>
									<th>Steps</th>
									<th>Tokens</th>
								</tr>
							</thead>
							<tbody>
								{providerKeys.map((p) => {
									const t = stats.tokensByProvider[p];
									const total = t ? t.input + t.output + t.cacheRead + t.cacheCreation : 0;
									return (
										<tr key={p}>
											<th scope="row" className="font-mono text-xs font-normal text-ink">
												{p}
											</th>
											<td className="font-mono text-sm tabular-nums">
												{stats.costEstimatedByProvider[p] ? "~" : ""}
												{formatUsd(stats.costByProvider[p] ?? 0)}
											</td>
											<td className="font-mono text-sm tabular-nums">{stats.stepsByProvider[p] ?? 0}</td>
											<td className="font-mono text-sm tabular-nums">{formatTokens(total)}</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</section>
			)}

			{(parkKeys.length > 0 || blockKeys.length > 0 || failKeys.length > 0) && (
				<section className="mt-12">
					<h2 className="font-display text-xl font-medium tracking-tight text-ink">Outcomes</h2>
					<div className="mt-4 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
						{parkKeys.length > 0 && (
							<div>
								<h3 className="font-mono text-2xs tracking-label text-ink-soft uppercase">Parked by cause</h3>
								<ul className="mt-2 text-sm">
									{parkKeys.map((k) => (
										<li key={k} className="border-b border-foam-line py-2">
											<code>{k}</code> · {stats.parksByClass[k]}
											{k === "unrecorded" ? <span className="text-ink-soft"> (logged before classification)</span> : ""}
											{k === "unknown" ? <span className="text-ink-soft"> (stored member not in runtime allowlist)</span> : ""}
										</li>
									))}
								</ul>
							</div>
						)}
						{blockKeys.length > 0 && (
							<div>
								<h3 className="font-mono text-2xs tracking-label text-ink-soft uppercase">Blocked by kind</h3>
								<ul className="mt-2 text-sm">
									{blockKeys.map((k) => (
										<li key={k} className="border-b border-foam-line py-2">
											<code>{k}</code> · {stats.blocksByKind[k]}
											{k === "unrecorded" ? <span className="text-ink-soft"> (logged before classification)</span> : ""}
											{k === "unknown" ? <span className="text-ink-soft"> (stored member not in runtime allowlist)</span> : ""}
										</li>
									))}
								</ul>
							</div>
						)}
						{failKeys.length > 0 && (
							<div>
								<h3 className="font-mono text-2xs tracking-label text-ink-soft uppercase">Failed by cause</h3>
								<ul className="mt-2 text-sm">
									{failKeys.map((k) => (
										<li key={k} className="border-b border-foam-line py-2">
											<code>{k}</code> · {stats.failuresByCause[k]}
											{k === "unrecorded" ? <span className="text-ink-soft"> (logged before classification)</span> : ""}
											{k === "unknown" ? <span className="text-ink-soft"> (stored member not in runtime allowlist)</span> : ""}
										</li>
									))}
								</ul>
							</div>
						)}
					</div>
				</section>
			)}

			<section className="mt-12">
				<h2 className="font-display text-xl font-medium tracking-tight text-ink">Items delivered ({stats.itemsDelivered.length})</h2>
				<ul className="mt-3">
					{stats.itemsDelivered
						.slice(-20)
						.reverse()
						.map((i) => (
							<li key={`${i.id}-${i.date}`} className="border-b border-foam-line py-2.5 text-sm">
								<code>{formatItemLabel(i.id, currentRepo, i.itemTitle)}</code>
								<span className="text-ink-soft">
									{" "}
									· {i.date} · {formatUsd(i.cost)}
									{i.parked ? " · parked" : ""}
								</span>
							</li>
						))}
				</ul>
			</section>

			{stats.recentFailures.length > 0 && (
				<section className="mt-12">
					<h2 className="font-display text-xl font-medium tracking-tight text-ink">Recent failures</h2>
					<ul className="mt-3">
						{stats.recentFailures.map((f) => (
							<li key={`${f.ts}-${f.item ?? "?"}-${f.error ?? "?"}`} className="border-b border-foam-line py-2.5 text-sm">
								<span className="text-ink-soft">{f.ts}</span> · {f.item ? formatItemLabel(f.item, currentRepo, f.itemTitle) : "?"} · {f.error ?? "?"}
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className="bg-surface px-5 py-4">
			<dt className="font-mono text-micro tracking-label text-ink-soft uppercase">{label}</dt>
			<dd className="mt-1 font-display text-xl font-semibold tracking-tight text-ink tabular-nums">{value}</dd>
			{hint ? <p className="mt-0.5 font-mono text-2xs text-ink-soft">{hint}</p> : null}
		</div>
	);
}
