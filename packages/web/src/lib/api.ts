import type { RoadmapItem, Stats } from "@cdhorne/claude-autopilot";
import type { PersistedRun, RunSummary, ShipTargetName } from "@cdhorne/claude-autopilot-server/types";

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
	item: string;
	parallel?: number;
	cycles?: number;
	shipTarget?: ShipTargetName;
}

export interface StartRunResponse {
	id: string;
	item: string;
	startedAt: string;
	logPath: string;
}

export interface RoadmapResponse {
	source: string;
	items: RoadmapItem[];
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		...init,
		headers: {
			Accept: "application/json",
			...(init?.body ? { "content-type": "application/json" } : {}),
			...(init?.headers ?? {}),
		},
	});
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

export const listRuns = (): Promise<{ runs: RunSummary[] }> => fetchJson("/runs");
export const getRun = (id: string): Promise<PersistedRun> => fetchJson(`/runs/${encodeURIComponent(id)}`);
export const startRun = (body: StartRunBody): Promise<StartRunResponse> => fetchJson("/runs", { method: "POST", body: JSON.stringify(body) });
export const pauseRun = (id: string): Promise<PersistedRun> => fetchJson(`/runs/${encodeURIComponent(id)}/pause`, { method: "POST" });
export const resumeRun = (id: string): Promise<PersistedRun> => fetchJson(`/runs/${encodeURIComponent(id)}/resume`, { method: "POST" });
export const stopRun = (id: string): Promise<PersistedRun> => fetchJson(`/runs/${encodeURIComponent(id)}/stop`, { method: "POST" });
export const getRoadmap = (): Promise<RoadmapResponse> => fetchJson("/roadmap");
export const getStats = (): Promise<Stats> => fetchJson("/stats");
