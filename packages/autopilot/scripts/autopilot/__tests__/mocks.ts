import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RunStepFn, runPipeline } from "../pipeline.js";
import type { RoadmapSource } from "../roadmap/index.js";
import { LiveStatus, StatusBar } from "../tui.js";
import type { CycleResult, Flags, ParkSignal, PipelineOpts, Step, StepResult } from "../types.js";

export interface StepOutcome extends Partial<StepResult> {
	/** If set, merged into parkSignal before the mock returns. */
	park?: Partial<ParkSignal>;
	/**
	 * Files to write into `opts.cwd` before returning. Keys are paths relative to the worktree.
	 * Needed so subsequent `checkpoint()` calls have something to commit — `git add -A && git commit`
	 * fails with "nothing to commit" on a clean tree and no commit lands.
	 */
	writes?: Record<string, string>;
	/** Called after writes — use to simulate git side-effects (e.g. advancing main). */
	sideEffect?: (cwd: string) => void;
	/** If true, the mock awaits `opts.signal`'s abort event before applying the rest of
	 * the outcome. Lets tests simulate a step that's in-flight when SIGINT fires. */
	awaitAbort?: boolean;
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
		if (opts.signal?.aborted) {
			emit({ type: "done", ok: false, subtype: "error_abort", cost: 0, turns: 0, elapsed: 0 });
			return { ok: false, subtype: "error_abort", text: "aborted", fullText: "", cost: 0, turns: 0 };
		}
		if (outcome.awaitAbort && opts.signal) {
			await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve(), { once: true }));
		}
		if (outcome.writes) {
			for (const [rel, content] of Object.entries(outcome.writes)) {
				const full = resolve(opts.cwd, rel);
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, content);
			}
		}
		outcome.sideEffect?.(opts.cwd);
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

export interface PipelineOutcome extends Partial<CycleResult> {
	/** If set, merged into parkSignal before the mock returns. */
	park?: Partial<ParkSignal>;
}

export type PipelineBehavior = {
	/** Per-itemId outcome queue — array is consumed by successive calls for that item. */
	byItem?: Record<string, PipelineOutcome | PipelineOutcome[]>;
	/** Fallback outcome when no itemId match (or queue exhausted). */
	default?: PipelineOutcome;
	/** Invoked for every call — inspect/mutate parkSignal after the outcome is applied. */
	onCall?: (opts: PipelineOpts, parkSignal: ParkSignal) => void;
};

export interface MockRunPipeline {
	runPipeline: typeof runPipeline;
	calls: Array<{ itemId: string | undefined; opts: PipelineOpts; flags: Flags }>;
}

export function createMockRunPipeline(behavior: PipelineBehavior): MockRunPipeline {
	const calls: MockRunPipeline["calls"] = [];
	const perItemIdx: Record<string, number> = {};
	const fn: typeof runPipeline = async (opts, parkSignal, flags) => {
		calls.push({ itemId: opts.itemId, opts, flags });
		const key = opts.itemId ?? "";
		const spec = behavior.byItem?.[key];
		let outcome: PipelineOutcome;
		if (Array.isArray(spec)) {
			const idx = perItemIdx[key] ?? 0;
			outcome = spec[Math.min(idx, spec.length - 1)] ?? {};
			perItemIdx[key] = idx + 1;
		} else if (spec) {
			outcome = spec;
		} else {
			outcome = behavior.default ?? { completed: false, cost: 0, error: "nothing to pick" };
		}
		if (outcome.park) Object.assign(parkSignal, outcome.park);
		behavior.onCall?.(opts, parkSignal);
		return {
			itemId: outcome.itemId ?? opts.itemId ?? null,
			completed: outcome.completed ?? false,
			cost: outcome.cost ?? 0,
			...(outcome.verdict ? { verdict: outcome.verdict } : {}),
			...(outcome.error ? { error: outcome.error } : {}),
			...(outcome.awaitingMerge ? { awaitingMerge: outcome.awaitingMerge } : {}),
			...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}),
			...(outcome.shipwrecked ? { shipwrecked: outcome.shipwrecked } : {}),
		};
	};
	return { runPipeline: fn, calls };
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

/** Plain tmp dir with no git repo — `git rev-parse` fails inside it, so passing it as
 *  `mainRepo` makes `captureShipState` return null (simulates an unreadable main repo). */
export function makeNonGitDir(): string {
	return mkdtempSync(join(tmpdir(), "autopilot-nongit-"));
}

/**
 * Creates a tmp parent dir containing a git repo, so tests can inject a `mainRepo`
 * and also derive a sibling worktree path under the same parent (mirroring the
 * production layout where `resolveWorktree` returns `resolve(REPO, "..", ...)`).
 */
export function makeTempRepoWithParent(): { parent: string; repo: string } {
	const parent = mkdtempSync(join(tmpdir(), "autopilot-parent-"));
	const repo = join(parent, "repo");
	mkdirSync(repo);
	execSync("git init -q -b main", { cwd: repo });
	execSync("git config user.name t", { cwd: repo });
	execSync("git config user.email t@t", { cwd: repo });
	execSync("git config commit.gpgsign false", { cwd: repo });
	execSync("git commit --allow-empty -q -m init", { cwd: repo });
	// Leave repo on main so tests can `git worktree add -b feat/tool-99 <path>` for the sibling worktree.
	return { parent, repo };
}

export function makeMockRoadmap(overrides: Partial<RoadmapSource> = {}): RoadmapSource {
	const base: RoadmapSource = {
		name: "markdown",
		async listOpenItems() {
			return [];
		},
		async listItems() {
			return [];
		},
		async getItem() {
			return null;
		},
		async claimItem() {
			throw new Error("mock: claimItem not wired");
		},
		async markDone() {
			/* noop */
		},
		async getItemPlan() {
			return null;
		},
		resolvePlanPath({ id, worktree }) {
			return `${worktree}/docs/plans/${id.toLowerCase()}.md`;
		},
		async publishPlan() {
			/* noop */
		},
		async createItem({ title, deps }) {
			return { id: "MOCK-1", title, deps: (deps ?? []).join(", "), sourceRef: "mock" };
		},
		async archivePlan() {
			/* noop */
		},
		isCharterPickRace() {
			return false;
		},
		async parseItemId(text) {
			const m = text.match(/\b([A-Z]{1,4}-?\d[\dA-Z]*)\b/);
			return m?.[1] ?? null;
		},
		isQuickScope() {
			return false;
		},
	};
	return { ...base, ...overrides };
}

export function allCommitMessages(dir: string): string[] {
	return execSync("git log --format=%s", { cwd: dir, encoding: "utf-8" }).trim().split("\n").filter(Boolean);
}
