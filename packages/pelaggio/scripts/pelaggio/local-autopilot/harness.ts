import type { UsageMeasurement } from "../usage-measurement.js";
import type { LocalConfig, WorkContract } from "./types.js";

export type HarnessAction = { kind: "write"; path: string; content: string } | { kind: "decision"; code: string; message: string } | { kind: "verify-fail"; message: string } | { kind: "crash"; message: string } | { kind: "complete" };

export interface HarnessContext {
	cwd: string;
	worktree: string;
	workContract: WorkContract;
	config: LocalConfig;
	nonInteractive: boolean;
	signal?: AbortSignal;
	verificationFailure?: string;
	/** Next unacknowledged fake-script index (0 on a fresh run). */
	cursor: number;
}

export interface HarnessAdapter {
	name: LocalConfig["harness"]["adapter"];
	next(ctx: HarnessContext): Promise<{ action: HarnessAction; cursor: number; usageMeasurement?: UsageMeasurement }>;
}
