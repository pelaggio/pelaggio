import type { ContinuousMode, PersistedRun, RepoEntry, RunSummary, ShipTargetName, StatsResponse } from "@pelaggio/server/types";
import type { RoadmapItem } from "pelaggio";
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
	item?: string;
	mode?: ContinuousMode;
	parallel?: number;
	cycles?: number;
	shipTarget?: ShipTargetName;
	watchDailyBudget?: number;
	verbose?: boolean;
}

export interface StartRunResponse {
	id: string;
	repo: string;
	item?: string;
	mode?: ContinuousMode;
	startedAt: string;
	logPath: string;
}

export interface RoadmapResponse {
	source: string;
	items: RoadmapItem[];
}

export interface RepoConfigResponse {
	watchDailyBudget: number | null;
}

/** UI form state for building a StartRunBody (unit-tested). */
export interface StartFormState {
	repo: string;
	/** UI-only: `off` omits mode from the wire body. */
	mode: "off" | ContinuousMode;
	item: string;
	parallel: string;
	cycles: string;
	shipTarget: string;
	watchDailyBudget: string;
	verbose: boolean;
}

/**
 * Pure request builder for StartForm presets and advanced submit.
 * Omits inapplicable fields (no item when continuous; no budget when not watch; no verbose:false).
 */
export function buildStartBody(state: StartFormState): StartRunBody {
	const body: StartRunBody = { repo: state.repo };
	if (state.mode === "drain" || state.mode === "watch") {
		body.mode = state.mode;
	} else if (state.item) {
		body.item = state.item;
	}
	if (state.parallel) {
		const n = Number(state.parallel);
		if (Number.isInteger(n) && n >= 1) body.parallel = n;
	}
	if (state.cycles) {
		const n = Number(state.cycles);
		if (Number.isInteger(n) && n >= 1) body.cycles = n;
	}
	if (state.shipTarget) {
		body.shipTarget = state.shipTarget as ShipTargetName;
	}
	if (state.mode === "watch" && state.watchDailyBudget) {
		const n = Number(state.watchDailyBudget);
		if (Number.isFinite(n) && n > 0) body.watchDailyBudget = n;
	}
	if (state.verbose) body.verbose = true;
	return body;
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
export const getStats = (repo: string): Promise<StatsResponse> => fetchJson(`/repos/${encodeURIComponent(repo)}/stats`);
export const getRepoConfig = (repo: string): Promise<RepoConfigResponse> => fetchJson(`/repos/${encodeURIComponent(repo)}/config`);
