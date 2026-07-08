import type { PersistedRun, RepoEntry, RunSummary, ShipTargetName } from "@pelaggio/server/types";
import type { RoadmapItem, Stats } from "pelaggio";
import { getToken, markTokenRejected, promptForToken } from "./token.js";

export type { RepoEntry };

export class ApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	constructor(status: number, message: string, code?: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

export interface StartRunBody {
	repo: string;
	item: string;
	parallel?: number;
	cycles?: number;
	shipTarget?: ShipTargetName;
}

export interface StartRunResponse {
	id: string;
	repo: string;
	item: string;
	startedAt: string;
	logPath: string;
}

export interface RoadmapResponse {
	source: string;
	items: RoadmapItem[];
}

async function doFetch(path: string, init: RequestInit | undefined): Promise<Response> {
	const token = getToken();
	return fetch(path, {
		...init,
		headers: {
			Accept: "application/json",
			...(init?.body ? { "content-type": "application/json" } : {}),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(init?.headers ?? {}),
		},
	});
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
	let res = await doFetch(path, init);
	if (res.status === 401) {
		markTokenRejected();
		await promptForToken();
		res = await doFetch(path, init);
	}
	if (!res.ok) {
		let code: string | undefined;
		let message = `${res.status} ${res.statusText}`;
		try {
			const body = (await res.json()) as { error?: string; code?: string };
			if (body.error) message = body.error;
			if (body.code) code = body.code;
		} catch {
			// non-JSON error body — keep status text
		}
		throw new ApiError(res.status, message, code);
	}
	return (await res.json()) as T;
}

export const listRepos = (): Promise<{ repos: RepoEntry[] }> => fetchJson("/repos");
export const listRuns = (opts?: { repo?: string }): Promise<{ runs: RunSummary[] }> => {
	const qs = opts?.repo ? `?repo=${encodeURIComponent(opts.repo)}` : "";
	return fetchJson(`/runs${qs}`);
};
export const getRun = (id: string): Promise<PersistedRun> => fetchJson(`/runs/${encodeURIComponent(id)}`);
export const startRun = (body: StartRunBody): Promise<StartRunResponse> => fetchJson("/runs", { method: "POST", body: JSON.stringify(body) });
export const pauseRun = (id: string): Promise<PersistedRun> => fetchJson(`/runs/${encodeURIComponent(id)}/pause`, { method: "POST" });
export const resumeRun = (id: string): Promise<PersistedRun> => fetchJson(`/runs/${encodeURIComponent(id)}/resume`, { method: "POST" });
export const stopRun = (id: string): Promise<PersistedRun> => fetchJson(`/runs/${encodeURIComponent(id)}/stop`, { method: "POST" });
export const getRoadmap = (repo: string): Promise<RoadmapResponse> => fetchJson(`/repos/${encodeURIComponent(repo)}/roadmap`);
export const getStats = (repo: string): Promise<Stats> => fetchJson(`/repos/${encodeURIComponent(repo)}/stats`);
