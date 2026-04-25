import { setCurrentRepo, useRepos } from "../lib/repo.js";

function basename(p: string): string {
	const trimmed = p.replace(/\/+$/, "");
	const i = trimmed.lastIndexOf("/");
	return i === -1 ? trimmed : trimmed.slice(i + 1);
}

export function RepoNav() {
	const state = useRepos();

	if (state.status === "loading") {
		return <span className="text-xs text-slate-500">loading repos…</span>;
	}
	if (state.status === "empty") {
		return <span className="text-xs text-slate-500">no repos configured</span>;
	}

	return (
		<label className="flex items-center gap-1 text-xs text-slate-600">
			<span>repo</span>
			<select value={state.current} onChange={(e) => setCurrentRepo(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1 text-sm">
				{state.repos.map((r) => (
					<option key={r.slug} value={r.slug}>
						{r.slug} — {basename(r.path)}
						{r.exists ? "" : " (missing)"}
					</option>
				))}
			</select>
		</label>
	);
}
