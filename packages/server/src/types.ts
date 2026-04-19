import type { ShipTargetName } from "@cdhorne/claude-autopilot";

export type RunStatus = "running" | "completed" | "failed" | "parked" | "paused" | "abandoned";

export interface PersistedRun {
	id: string;
	item: string;
	status: RunStatus;
	pid: number | null;
	startedAt: string;
	endedAt?: string;
	exitCode?: number;
	error?: string;
	shipTarget?: ShipTargetName;
	parallel?: number;
	cycles?: number;
	logPath: string;
	cwd: string;
	resumedFrom?: string;
}

export interface RunSummary {
	id: string;
	item: string;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	lastStep?: string;
	lastCost?: number;
}

export type { ShipTargetName };
