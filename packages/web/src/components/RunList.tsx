import type { RunSummary } from "@pelaggio/server/types";
import { useEffect, useState } from "react";
import { ApiError, listRuns } from "../lib/api.js";
import { formatDate, formatRunState, formatRunTitle, formatUsd, runStateBadgeClass } from "../lib/format.js";
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
			<p className="wrap pt-10 text-fail">
				Failed to load repos: {reposState.error}
				<button type="button" onClick={() => void retryInit()} className="btn-inline ml-2">
					retry
				</button>
			</p>
		);
	}
	if (reposState.status === "empty") {
		return <p className="wrap pt-10 text-ink-soft">No repos configured.</p>;
	}
	if (reposState.status === "loading" || runs === undefined) {
		return <p className="wrap pt-10 text-ink-soft">Loading…</p>;
	}
	if (error) return <p className="wrap pt-10 text-fail">Error loading runs: {error}</p>;

	const repoOrder = reposState.repos.map((r) => r.slug);
	const live = runs.filter((r) => r.status === "running");
	const rest = runs.filter((r) => r.status !== "running");

	return (
		<div className="pb-20">
			<div className="wrap pt-10 pb-6 md:pt-14">
				<p className="eyebrow">This station</p>
				<div className="mt-3 flex flex-wrap items-end justify-between gap-4">
					<h1 className="font-display text-2xl font-medium tracking-tight text-ink md:text-[2.5rem] md:leading-[1.1]">Runs</h1>
					<label className="flex min-h-11 items-center gap-2 text-sm text-ink-soft">
						<input type="checkbox" checked={groupAll} onChange={(e) => setGroupAll(e.target.checked)} className="size-4" />
						All repos
					</label>
				</div>
				<p className="mt-3 max-w-xl text-[17px] text-ink-soft">Pause, resume, and start stay on this machine. One operator, one worktree.</p>
			</div>

			{live.length > 0 && (
				<section className="mb-10">
					<div className="wrap mb-4">
						<p className="eyebrow">Offshore now</p>
					</div>
					<ul className="wrap grid gap-3">
						{live.map((r) => (
							<LiveCard key={r.id} r={r} />
						))}
					</ul>
				</section>
			)}

			<section className="wrap">
				{rest.length === 0 && live.length === 0 ? (
					<>
						<p className="eyebrow">History</p>
						<p className="mt-4 text-ink-soft">
							No runs yet.{" "}
							<a href="/ui/start/" className="text-accent">
								Start one
							</a>
							.
						</p>
					</>
				) : rest.length === 0 ? null : (
					<>
						<p className="eyebrow">History</p>
						{groupAll ? (
							<GroupedList runs={rest} repoOrder={repoOrder} />
						) : (
							<ul className="mt-4 border-t border-foam-line">
								{rest.map((r) => (
									<RunRow key={r.id} r={r} />
								))}
							</ul>
						)}
					</>
				)}
			</section>
		</div>
	);
}

function GroupedList({ runs, repoOrder }: { runs: RunSummary[]; repoOrder: string[] }) {
	const groups = new Map<string, RunSummary[]>();
	for (const r of runs) {
		const arr = groups.get(r.repo);
		if (arr) arr.push(r);
		else groups.set(r.repo, [r]);
	}
	const known = repoOrder.filter((s) => groups.has(s));
	const unknown = [...groups.keys()].filter((s) => !repoOrder.includes(s));
	return (
		<ul className="mt-4 border-t border-foam-line">
			{[...known, ...unknown].map((slug) => (
				<li key={slug}>
					<p className="border-b border-foam-line bg-foam-2/60 px-1 py-2 font-mono text-2xs tracking-label text-ink-soft uppercase">{slug}</p>
					<ul>
						{groups.get(slug)!.map((r) => (
							<RunRow key={r.id} r={r} />
						))}
					</ul>
				</li>
			))}
		</ul>
	);
}

function LiveCard({ r }: { r: RunSummary }) {
	const stateLabel = formatRunState(r.status, r.activity);
	const title = formatRunTitle(r);
	const inner = (
		<>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="font-mono text-2xs text-ink-soft">
						{r.item ? `${r.repo}#${r.item}` : (r.mode ?? r.id)}
						{r.lastStep ? ` · ${r.lastStep}` : ""}
					</p>
					<p className="mt-1 font-display text-lg font-semibold tracking-tight text-ink">{title}</p>
				</div>
				<span className={runStateBadgeClass(r.status, r.activity)}>{stateLabel}</span>
			</div>
			<p className="mt-3 font-mono text-2xs text-ink-soft">{formatDate(r.startedAt)}</p>
		</>
	);
	return (
		<li>
			{r.source === "supervised" ? (
				<a href={`/ui/runs/?id=${encodeURIComponent(r.id)}`} className="block border border-foam-line bg-foam-2 px-5 py-4 no-underline hover:no-underline hover:shadow-[0_0_0_1px_rgba(7,26,46,0.12)]">
					{inner}
				</a>
			) : (
				<div className="border border-foam-line bg-foam-2 px-5 py-4">
					{inner}
					<p className="mt-2 font-mono text-2xs tracking-label text-ink-soft uppercase">external</p>
				</div>
			)}
		</li>
	);
}

function RunRow({ r }: { r: RunSummary }) {
	const stateLabel = formatRunState(r.status, r.activity);
	const title = formatRunTitle(r);
	const inner = (
		<>
			<div className="min-w-0 flex-1">
				<p className="font-mono text-2xs text-ink-soft">
					{r.item ? `${r.repo}#${r.item}` : r.id}
					<span className="text-ink-soft/70">
						{" "}
						· {formatDate(r.startedAt)}
						{r.endedAt ? ` · ${formatDate(r.endedAt)}` : ""}
					</span>
				</p>
				<p className="mt-1 font-display text-[17px] font-semibold tracking-tight text-ink">{title}</p>
				{r.lastStep && <p className="mt-1 font-mono text-2xs text-ink-soft">{r.lastStep}</p>}
			</div>
			<div className="flex flex-wrap items-center gap-2 sm:justify-end">
				{r.source !== "supervised" && <span className="font-mono text-2xs tracking-label text-ink-soft uppercase">external</span>}
				{r.lastCost != null && <span className="font-mono text-xs text-ink-soft tabular-nums">{formatUsd(r.lastCost)}</span>}
				<span className={runStateBadgeClass(r.status, r.activity)}>{stateLabel}</span>
			</div>
		</>
	);
	return (
		<li>
			{r.source === "supervised" ? (
				<a href={`/ui/runs/?id=${encodeURIComponent(r.id)}`} className="flex min-h-14 flex-col gap-2 border-b border-foam-line py-4 no-underline hover:bg-foam-2 hover:no-underline sm:flex-row sm:items-center sm:justify-between">
					{inner}
				</a>
			) : (
				<div className="flex min-h-14 flex-col gap-2 border-b border-foam-line py-4 sm:flex-row sm:items-center sm:justify-between">{inner}</div>
			)}
		</li>
	);
}
