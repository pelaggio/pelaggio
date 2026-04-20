import type { RoadmapItem } from "@cdhorne/claude-autopilot";
import type { ShipTargetName } from "@cdhorne/claude-autopilot-server/types";
import { type SyntheticEvent, useEffect, useState } from "react";
import { ApiError, getRoadmap, startRun } from "../lib/api.js";

const SHIP_TARGETS: ShipTargetName[] = ["direct-push", "pull-request", "auto-merge-pr"];

export function StartForm() {
	const [items, setItems] = useState<RoadmapItem[] | undefined>(undefined);
	const [item, setItem] = useState("");
	const [parallel, setParallel] = useState<string>("");
	const [cycles, setCycles] = useState<string>("");
	const [shipTarget, setShipTarget] = useState<string>("");
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void (async () => {
			try {
				const res = await getRoadmap();
				setItems(res.items);
				if (res.items[0]) setItem(res.items[0].id);
			} catch (err) {
				setError(err instanceof ApiError ? err.message : String(err));
			}
		})();
	}, []);

	const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (!item) return;
		setBusy(true);
		setError(undefined);
		try {
			const body = {
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

	if (items === undefined && !error) return <p className="text-slate-500">Loading roadmap…</p>;

	return (
		<form onSubmit={submit} className="space-y-4">
			<h1 className="text-2xl font-semibold">Start a run</h1>
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
