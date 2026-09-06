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

	if (reposState.status === "loading") return <p className="wrap pt-10 text-ink-soft">Loading…</p>;
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
	if (items === undefined && !error) return <p className="wrap pt-10 text-ink-soft">Loading roadmap…</p>;

	const continuous = mode === "drain" || mode === "watch";

	return (
		<form onSubmit={submit} className="wrap max-w-3xl pt-10 pb-20 md:pt-14">
			<p className="eyebrow">This repository · {currentRepo}</p>
			<h1 className="mt-3 font-display text-2xl font-medium tracking-tight text-ink md:text-[2.5rem] md:leading-[1.1]">Start a run</h1>
			<p className="mt-3 max-w-xl text-[17px] text-ink-soft">Pick a work item, or drain / watch the open list. Shipping uses this repository’s configured policy unless you choose a ship target under Advanced.</p>

			<section className="mt-8 flex flex-wrap gap-2">
				<button type="button" className="btn-ghost" disabled={busy} onClick={() => void preset("drain", 1)}>
					Drain ×1
				</button>
				<button type="button" className="btn-ghost" disabled={busy} onClick={() => void preset("drain", 2)}>
					Drain ×2
				</button>
				<button type="button" className="btn-ghost" disabled={busy} onClick={() => void preset("watch", 2)}>
					Watch ×2
				</button>
			</section>

			{!continuous ? (
				<label className="mt-10 block">
					<span className="mb-1.5 block font-mono text-2xs tracking-label text-ink-soft uppercase">Item</span>
					<select value={item} onChange={(e) => setItem(e.target.value)} required={!continuous}>
						{items?.map((i) => (
							<option key={i.id} value={i.id}>
								{i.id} — {i.title}
							</option>
						))}
					</select>
				</label>
			) : (
				<p className="mt-8 text-sm text-ink-soft">{mode === "drain" ? "Drain picks the next open item until the list is empty." : "Watch stays up and picks when something is open, under the day budget."}</p>
			)}

			<details className="mt-8 border border-foam-line px-4 py-3">
				<summary className="min-h-11 cursor-pointer text-sm font-semibold text-ink">Advanced</summary>
				<div className="mt-4 space-y-3">
					<label className="block">
						<span className="mb-1.5 block font-mono text-2xs tracking-label text-ink-soft uppercase">Mode</span>
						<select value={mode} onChange={(e) => setMode(e.target.value as StartFormState["mode"])}>
							<option value="off">off (item run)</option>
							<option value="drain">drain</option>
							<option value="watch">watch</option>
						</select>
					</label>
					<label className="block">
						<span className="mb-1.5 block font-mono text-2xs tracking-label text-ink-soft uppercase">Parallel (optional)</span>
						<input type="number" min="1" value={parallel} onChange={(e) => setParallel(e.target.value)} />
					</label>
					{mode === "watch" && (
						<label className="block">
							<span className="mb-1.5 block font-mono text-2xs tracking-label text-ink-soft uppercase">Watch day budget USD (optional)</span>
							<input type="number" min="0" step="any" value={watchDailyBudget} onChange={(e) => setWatchDailyBudget(e.target.value)} placeholder="config default / unlimited" />
						</label>
					)}
					<label className="block">
						<span className="mb-1.5 block font-mono text-2xs tracking-label text-ink-soft uppercase">Cycles (optional)</span>
						<input type="number" min="1" value={cycles} onChange={(e) => setCycles(e.target.value)} />
					</label>
					<label className="block">
						<span className="mb-1.5 block font-mono text-2xs tracking-label text-ink-soft uppercase">Ship target (optional)</span>
						<select value={shipTarget} onChange={(e) => setShipTarget(e.target.value)}>
							<option value="">(default)</option>
							{SHIP_TARGETS.map((t) => (
								<option key={t} value={t}>
									{t}
								</option>
							))}
						</select>
					</label>
					<label className="flex min-h-11 items-center gap-2 text-sm">
						<input type="checkbox" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} className="size-4" />
						Verbose logs
					</label>
				</div>
			</details>

			{error && <p className="mt-4 border border-fail/30 bg-fail/5 px-4 py-3 text-sm text-fail">{error}</p>}
			<button type="submit" className="btn-primary mt-8" disabled={busy || (mode === "off" && !item)}>
				{busy ? "Starting…" : continuous ? `Start ${mode}` : "Start run"}
			</button>
		</form>
	);
}
