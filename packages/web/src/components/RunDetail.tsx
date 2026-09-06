import type { PersistedRun, RunStatus } from "@pelaggio/server/types";
import { useCallback, useEffect, useState } from "react";
import { ApiError, getRun, pauseRun, resumeRun, stopRun } from "../lib/api.js";
import { formatDate, formatRunState, formatRunTitle, runStateBadgeClass } from "../lib/format.js";
import { LogStream } from "./LogStream.js";

interface RunDetailProps {
	id: string;
}

const PAUSEABLE: RunStatus[] = ["running"];
const RESUMEABLE: RunStatus[] = ["paused", "parked"];
const STOPPABLE: RunStatus[] = ["running", "paused"];
const LIVE: RunStatus[] = ["running", "paused"];
const POLL_MS = 5_000;

export function RunDetail({ id }: RunDetailProps) {
	const [run, setRun] = useState<PersistedRun | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setRun(await getRun(id));
			setError(undefined);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : String(err));
		}
	}, [id]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Poll while live so idle/park transitions appear without relying on sparse SSE.
	const liveStatus = run?.status;
	useEffect(() => {
		if (!liveStatus || !LIVE.includes(liveStatus)) return;
		const timer = setInterval(() => {
			void refresh();
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [liveStatus, refresh]);

	const act = async (label: string, fn: () => Promise<PersistedRun>) => {
		if (!window.confirm(`${label} run ${id}?`)) return;
		setBusy(true);
		try {
			const next = await fn();
			setRun(next);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : String(err));
		} finally {
			setBusy(false);
			void refresh();
		}
	};

	if (error && !run) return <p className="wrap pt-10 text-fail">Error: {error}</p>;
	if (!run) return <p className="wrap pt-10 text-ink-soft">Loading…</p>;

	const stateLabel = formatRunState(run.status, run.activity);
	const live = LIVE.includes(run.status);

	return (
		<div>
			<div className="wrap py-6 md:py-8">
				<a href="/ui/" className="mb-4 flex min-h-11 w-fit items-center font-mono text-xs text-ink-soft">
					← Runs
				</a>
				<p className="eyebrow">
					{run.mode ?? "item run"}
					{run.item ? ` · ${run.repo}#${run.item}` : ` · ${run.repo}`}
				</p>
				<div className="mt-2 flex flex-wrap items-start justify-between gap-3">
					<h1 className="max-w-3xl font-display text-xl font-medium tracking-tight text-ink md:text-2xl">{formatRunTitle(run)}</h1>
					<span className={runStateBadgeClass(run.status, run.activity)}>{stateLabel}</span>
				</div>
				<p className="mt-2 font-mono text-xs text-ink-soft">
					{run.id}
					{run.shipTarget ? ` · ship ${run.shipTarget}` : ""}
					{run.watchDailyBudget != null ? ` · day-budget $${run.watchDailyBudget}` : ""}
					{run.verbose === true ? " · verbose" : ""}
					{run.parallel != null ? ` · parallel ${run.parallel}` : ""}
					{run.cycles != null ? ` · cycles ${run.cycles}` : ""}
					{` · ${formatDate(run.startedAt)}`}
					{run.endedAt ? ` · ended ${formatDate(run.endedAt)}` : ""}
					{run.exitCode != null ? ` · exit ${run.exitCode}` : ""}
				</p>
				{run.error && <p className="mt-4 border border-fail/30 bg-fail/5 px-4 py-3 text-sm text-fail">{run.error}</p>}

				<div className="mt-6 flex flex-wrap gap-2">
					<button type="button" className="btn-primary" disabled={busy || !PAUSEABLE.includes(run.status)} onClick={() => act("Pause", () => pauseRun(id))}>
						Pause
					</button>
					<button type="button" className="btn-primary" disabled={busy || !RESUMEABLE.includes(run.status)} onClick={() => act("Resume", () => resumeRun(id))}>
						Resume
					</button>
					<button type="button" className="btn-quiet" disabled={busy || !STOPPABLE.includes(run.status)} onClick={() => act("Stop", () => stopRun(id))}>
						Stop
					</button>
					<button type="button" className="btn-ghost" onClick={() => void refresh()}>
						Refresh
					</button>
				</div>
			</div>

			<section className="offshore">
				<div className="wrap py-8 md:py-10">
					<p className="eyebrow">{live ? "Offshore" : "Returned"}</p>
					<h2 className="mt-2 mb-5 font-display text-xl font-medium tracking-tight text-foam">{live ? "Live log" : "Log"}</h2>
					<LogStream id={id} />
				</div>
			</section>

			{error && <p className="wrap py-4 text-sm text-fail">{error}</p>}
		</div>
	);
}
