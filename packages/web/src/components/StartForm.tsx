import type { ShipTargetName } from "@pelaggio/server/types";
import type { RoadmapItem } from "pelaggio";
import { type SyntheticEvent, useEffect, useState } from "react";
import { ApiError, buildStartBody, getRepoConfig, getRoadmap, type StartFormState, startRun } from "../lib/api.js";
import { retryInit, useRepos } from "../lib/repo.js";

const SHIP_TARGETS: ShipTargetName[] = ["direct-push", "pull-request", "auto-merge-pr"];

export function StartForm() {
	const reposState = useRepos();
	const currentRepo = reposState.status === "ready" ? reposState.current : null;
	const [items, setItems] = useState<RoadmapItem[] | undefined>(undefined);
	const [item, setItem] = useState("");
	const [mode, setMode] = useState<StartFormState["mode"]>("off");
	const [parallel, setParallel] = useState<string>("");
	const [cycles, setCycles] = useState<string>("");
	const [shipTarget, setShipTarget] = useState<string>("");
	const [watchDailyBudget, setWatchDailyBudget] = useState<string>("");
	const [verbose, setVerbose] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!currentRepo) return;
		let cancelled = false;
		setItems(undefined);
		setError(undefined);
		void (async () => {
			try {
				const [roadmap, config] = await Promise.all([getRoadmap(currentRepo), getRepoConfig(currentRepo)]);
				if (cancelled) return;
				setItems(roadmap.items);
				setItem(roadmap.items[0]?.id ?? "");
				if (config.watchDailyBudget != null) {
					setWatchDailyBudget(String(config.watchDailyBudget));
				} else {
					setWatchDailyBudget("");
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [currentRepo]);

	const formState = (): StartFormState => ({
		repo: currentRepo ?? "",
		mode,
		item,
		parallel,
		cycles,
		shipTarget,
		watchDailyBudget,
		verbose,
	});

	const launch = async (state: StartFormState) => {
		if (!currentRepo) return;
		setBusy(true);
		setError(undefined);
		try {
			const body = buildStartBody(state);
			const res = await startRun(body);
			window.location.assign(`/ui/runs/?id=${encodeURIComponent(res.id)}`);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : String(err));
			setBusy(false);
		}
	};

	const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (mode === "off" && !item) return;
		await launch(formState());
	};

	const preset = async (presetMode: "drain" | "watch", presetParallel: number) => {
		await launch({
			...formState(),
			mode: presetMode,
			parallel: String(presetParallel),
			// Continuous presets omit budget unless advanced field already set (watch only).
			watchDailyBudget: presetMode === "watch" ? watchDailyBudget : "",
		});
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

	const continuous = mode === "drain" || mode === "watch";

	return (
		<form onSubmit={submit} className="space-y-4">
			<h1 className="text-2xl font-semibold">Start a run</h1>
			<p className="text-sm text-slate-600">
				repo: <code>{currentRepo}</code>
			</p>

			<section className="flex flex-wrap gap-2">
				<button type="button" disabled={busy} onClick={() => void preset("drain", 1)}>
					Drain ×1
				</button>
				<button type="button" disabled={busy} onClick={() => void preset("drain", 2)}>
					Drain ×2
				</button>
				<button type="button" disabled={busy} onClick={() => void preset("watch", 2)}>
					Watch ×2
				</button>
			</section>

			<details className="rounded border border-slate-200 p-3">
				<summary className="cursor-pointer text-sm font-medium">Advanced</summary>
				<div className="mt-3 space-y-3">
					<label className="block">
						<span className="mb-1 block text-sm font-medium">Mode</span>
						<select value={mode} onChange={(e) => setMode(e.target.value as StartFormState["mode"])}>
							<option value="off">off (item run)</option>
							<option value="drain">drain</option>
							<option value="watch">watch</option>
						</select>
					</label>
					{!continuous && (
						<label className="block">
							<span className="mb-1 block text-sm font-medium">Item</span>
							<select value={item} onChange={(e) => setItem(e.target.value)} required={!continuous}>
								{items?.map((i) => (
									<option key={i.id} value={i.id}>
										{i.id} — {i.title}
									</option>
								))}
							</select>
						</label>
					)}
					<label className="block">
						<span className="mb-1 block text-sm font-medium">Parallel (optional)</span>
						<input type="number" min="1" value={parallel} onChange={(e) => setParallel(e.target.value)} />
					</label>
					{mode === "watch" && (
						<label className="block">
							<span className="mb-1 block text-sm font-medium">Watch day budget USD (optional)</span>
							<input type="number" min="0" step="any" value={watchDailyBudget} onChange={(e) => setWatchDailyBudget(e.target.value)} placeholder="config default / unlimited" />
						</label>
					)}
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
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} />
						Verbose logs
					</label>
				</div>
			</details>

			{error && <p className="rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}
			<button type="submit" disabled={busy || (mode === "off" && !item)}>
				{busy ? "Starting…" : continuous ? `Start ${mode}` : "Start run"}
			</button>
		</form>
	);
}
