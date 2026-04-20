import type { PersistedRun, RunStatus } from "@cdhorne/claude-autopilot-server/types";
import { useCallback, useEffect, useState } from "react";
import { ApiError, getRun, pauseRun, resumeRun, stopRun } from "../lib/api.js";
import { formatDate, statusBadgeClass } from "../lib/format.js";
import { LogStream } from "./LogStream.js";

interface RunDetailProps {
	id: string;
}

const PAUSEABLE: RunStatus[] = ["running"];
const RESUMEABLE: RunStatus[] = ["paused", "parked"];
const STOPPABLE: RunStatus[] = ["running", "paused"];

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

	if (error && !run) return <p className="text-red-700">Error: {error}</p>;
	if (!run) return <p className="text-slate-500">Loading…</p>;

	return (
		<div className="space-y-6">
			<header className="space-y-2">
				<h1 className="text-2xl font-semibold">{run.item}</h1>
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<span className={statusBadgeClass(run.status)}>{run.status}</span>
					<span className="text-slate-600">
						id: <code>{run.id}</code>
					</span>
					{run.shipTarget && <span className="text-slate-600">ship: {run.shipTarget}</span>}
					{run.parallel != null && <span className="text-slate-600">parallel: {run.parallel}</span>}
					{run.cycles != null && <span className="text-slate-600">cycles: {run.cycles}</span>}
				</div>
				<div className="text-sm text-slate-600">
					started {formatDate(run.startedAt)}
					{run.endedAt && ` · ended ${formatDate(run.endedAt)}`}
					{run.exitCode != null && ` · exit ${run.exitCode}`}
				</div>
				{run.error && <p className="rounded bg-red-50 p-3 text-sm text-red-800">{run.error}</p>}
			</header>

			<section className="flex flex-wrap gap-2">
				<button type="button" disabled={busy || !PAUSEABLE.includes(run.status)} onClick={() => act("Pause", () => pauseRun(id))}>
					Pause
				</button>
				<button type="button" disabled={busy || !RESUMEABLE.includes(run.status)} onClick={() => act("Resume", () => resumeRun(id))}>
					Resume
				</button>
				<button type="button" disabled={busy || !STOPPABLE.includes(run.status)} onClick={() => act("Stop", () => stopRun(id))}>
					Stop
				</button>
				<button type="button" onClick={() => void refresh()}>
					Refresh
				</button>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold">Live log</h2>
				<LogStream id={id} />
			</section>

			{error && <p className="text-sm text-red-700">{error}</p>}
		</div>
	);
}
