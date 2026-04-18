import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RunStepFn } from "../pipeline.js";
import { LiveStatus, StatusBar } from "../tui.js";
import type { ParkSignal, Step, StepResult } from "../types.js";

export interface StepOutcome extends Partial<StepResult> {
	/** If set, merged into parkSignal before the mock returns. */
	park?: Partial<ParkSignal>;
	/**
	 * Files to write into `opts.cwd` before returning. Keys are paths relative to the worktree.
	 * Needed so subsequent `checkpoint()` calls have something to commit — `git add -A && git commit`
	 * fails with "nothing to commit" on a clean tree and no commit lands.
	 */
	writes?: Record<string, string>;
}

/** Per-step behavior. Array = sequential attempts; single = every call. */
export type MockBehavior = Partial<Record<Step, StepOutcome | StepOutcome[]>>;

export interface MockRunStep {
	runStep: RunStepFn;
	calls: Array<{ step: Step; attempt: number; prompt: string }>;
}

export function createMockRunStep(behavior: MockBehavior, parkSignal: ParkSignal): MockRunStep {
	const calls: MockRunStep["calls"] = [];
	const attempts: Partial<Record<Step, number>> = {};
	const runStep: RunStepFn = async (name, prompt, opts, emit) => {
		const attempt = (attempts[name] ?? 0) + 1;
		attempts[name] = attempt;
		calls.push({ step: name, attempt, prompt });
		const spec = behavior[name];
		const outcome: StepOutcome = Array.isArray(spec) ? (spec[Math.min(attempt - 1, spec.length - 1)] ?? {}) : (spec ?? {});
		if (outcome.writes) {
			for (const [rel, content] of Object.entries(outcome.writes)) {
				const full = resolve(opts.cwd, rel);
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, content);
			}
		}
		if (outcome.park) Object.assign(parkSignal, outcome.park);
		const result: StepResult = {
			ok: outcome.ok ?? true,
			subtype: outcome.subtype ?? "success",
			text: outcome.text ?? "",
			fullText: outcome.fullText ?? outcome.text ?? "",
			cost: outcome.cost ?? 0.01,
			turns: outcome.turns ?? 1,
			...(outcome.tokens ? { tokens: outcome.tokens } : {}),
		};
		emit({ type: "done", ok: result.ok, subtype: result.subtype, cost: result.cost, turns: result.turns, elapsed: 0 });
		return result;
	};
	return { runStep, calls };
}

export function makeLiveStatus(): LiveStatus {
	return new LiveStatus(new StatusBar());
}

export function makeParkSignal(): ParkSignal {
	return { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
}

export function makeTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "autopilot-pipeline-test-"));
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	execSync("git commit --allow-empty -q -m init", { cwd: dir });
	execSync("git checkout -q -b feat/tool-99", { cwd: dir });
	return dir;
}

export function allCommitMessages(dir: string): string[] {
	return execSync("git log --format=%s", { cwd: dir, encoding: "utf-8" }).trim().split("\n").filter(Boolean);
}
