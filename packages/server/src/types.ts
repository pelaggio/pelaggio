import type { ShipTargetName, Stats } from "pelaggio";

export type RunStatus = "running" | "completed" | "failed" | "parked" | "paused" | "abandoned";

export type RunSource = "supervised" | "external";

export type ContinuousMode = "drain" | "watch";

/** Live activity orthogonal to terminal process `RunStatus` (issue #83). */
export type RunActivity = { kind: "active" } | { kind: "watch-idle"; probeAt: string } | { kind: "budget-idle"; resumeAt: string; budget: number; spent: number } | { kind: "parked"; resumeAt?: string; reason?: string };

export interface PersistedRun {
	id: string;
	repo: string;
	/** Required for ordinary runs; omitted for continuous (drain/watch). */
	item?: string;
	status: RunStatus;
	pid: number | null;
	startedAt: string;
	endedAt?: string;
	exitCode?: number;
	error?: string;
	shipTarget?: ShipTargetName;
	parallel?: number;
	cycles?: number;
	/** Continuous launch policy — resume reconstructs argv from these fields. */
	mode?: ContinuousMode;
	watchDailyBudget?: number;
	/** Opt-in; default non-verbose (omit `--verbose`). */
	verbose?: boolean;
	/** Live activity from flow-event tailing; cleared on terminal status. */
	activity?: RunActivity;
	logPath: string;
	cwd: string;
	resumedFrom?: string;
}

export interface RunSummary {
	id: string;
	repo: string;
	item?: string;
	itemTitle?: string;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	lastStep?: string;
	lastCost?: number;
	mode?: ContinuousMode;
	activity?: RunActivity;
	/** List-projection provenance. Not persisted on `PersistedRun`. */
	source: RunSource;
}

export type StatsResponse = Omit<Stats, "itemsDelivered" | "recentFailures"> & {
	itemsDelivered: Array<Stats["itemsDelivered"][number] & { itemTitle?: string }>;
	recentFailures: Array<Stats["recentFailures"][number] & { itemTitle?: string }>;
};

export interface RepoEntry {
	slug: string;
	path: string;
	exists: boolean;
}

export type { ShipTargetName };
