import { retryInit, setCurrentRepo, useRepos } from "../lib/repo.js";

function basename(p: string): string {
	const trimmed = p.replace(/\/+$/, "");
	const i = trimmed.lastIndexOf("/");
	return i === -1 ? trimmed : trimmed.slice(i + 1);
}

export function RepoNav() {
	const state = useRepos();

	if (state.status === "loading") {
		return <span className="font-mono text-2xs tracking-label text-ink-soft uppercase">loading repos…</span>;
	}
	if (state.status === "error") {
		return (
			<span className="text-2xs text-fail">
				failed to load repos: {state.error}
				<button type="button" onClick={() => void retryInit()} className="btn-inline ml-2">
					retry
				</button>
			</span>
		);
	}
	if (state.status === "empty") {
		return <span className="font-mono text-2xs tracking-label text-ink-soft uppercase">no repos configured</span>;
	}

	return (
		<label className="flex items-center gap-2 font-mono text-2xs tracking-label text-ink-soft uppercase">
			<span>Repo</span>
			<select value={state.current} onChange={(e) => setCurrentRepo(e.target.value)} className="min-h-11 w-auto rounded-btn border border-foam-line bg-foam-2 px-2.5 font-sans text-sm font-normal tracking-normal text-ink normal-case">
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
