import type { ShipTargetName } from "@pelaggio/server/types";
import type { RoadmapItem } from "pelaggio";
import { type SyntheticEvent, useEffect, useState } from "react";
import { ApiError, getRoadmap, startRun } from "../lib/api.js";
import { retryInit, useRepos } from "../lib/repo.js";

const SHIP_TARGETS: ShipTargetName[] = ["direct-push", "pull-request", "auto-merge-pr"];

export function StartForm() {
	const reposState = useRepos();
	const currentRepo = reposState.status === "ready" ? reposState.current : null;
	const [items, setItems] = useState<RoadmapItem[] | undefined>(undefined);
	const [item, setItem] = useState("");
	const [parallel, setParallel] = useState<string>("");
	const [cycles, setCycles] = useState<string>("");
	const [shipTarget, setShipTarget] = useState<string>("");
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!currentRepo) return;
		let cancelled = false;
		setItems(undefined);
		setError(undefined);
		void (async () => {
			try {
				const res = await getRoadmap(currentRepo);
				if (cancelled) return;
				setItems(res.items);
				setItem(res.items[0]?.id ?? "");
			} catch (err) {
				if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [currentRepo]);

	const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (!item || !currentRepo) return;
		setBusy(true);
		setError(undefined);
		try {
			const body = {
				repo: currentRepo,
				item,
				...(parallel ? { parallel: Number(parallel) } : {}),
				...(cycles ? { cycles: Number(cycles) } : {}),
				...(shipTarget ? { shipTarget: shipTarget as ShipTargetName } : {}),
			};
			const res = await startRun(body);
			window.location.assign(`/ui/runs/?id=${encodeURIComponent(res.id)}`);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : String(err));
			setBusy(false);
		}
	};

	if (reposState.status === "loading") return <p className="text-slate-500">Loading…</p>;
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
	if (reposState.status === "empty") return <p className="text-slate-500">No repos configured.</p>;
	if (items === undefined && !error) return <p className="text-slate-500">Loading roadmap…</p>;

	return (
		<form onSubmit={submit} className="space-y-4">
			<h1 className="text-2xl font-semibold">Start a run</h1>
			<p className="text-sm text-slate-600">
				repo: <code>{currentRepo}</code>
			</p>
			<label className="block">
				<span className="mb-1 block text-sm font-medium">Item</span>
				<select value={item} onChange={(e) => setItem(e.target.value)} required>
					{items?.map((i) => (
						<option key={i.id} value={i.id}>
							{i.id} — {i.title}
						</option>
					))}
				</select>
			</label>
			<label className="block">
				<span className="mb-1 block text-sm font-medium">Parallel (optional)</span>
				<input type="number" min="1" value={parallel} onChange={(e) => setParallel(e.target.value)} />
			</label>
			<label className="block">
				<span className="mb-1 block text-sm font-medium">Cycles (optional)</span>
				<input type="number" min="1" value={cycles} onChange={(e) => setCycles(e.target.value)} />
			</label>
			<label className="block">
				<span className="mb-1 block text-sm font-medium">Ship target (optional)</span>
				<select value={shipTarget} onChange={(e) => setShipTarget(e.target.value)}>
					<option value="">(default)</option>
					{SHIP_TARGETS.map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</select>
			</label>
			{error && <p className="rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}
			<button type="submit" disabled={busy || !item}>
				{busy ? "Starting…" : "Start run"}
			</button>
		</form>
	);
}
