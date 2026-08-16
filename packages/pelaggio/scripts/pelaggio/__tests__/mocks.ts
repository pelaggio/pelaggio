import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mock } from "node:test";
import { REVIEW_CONFIG } from "../config.js";
import { __setProviderAvailableForTests, type PipelineDeps, type RunStepFn, type runPipeline } from "../pipeline.js";
import type { PrReviewGateResult } from "../pr-review-cli.js";
import type { RoadmapSource } from "../roadmap/index.js";
import { LiveStatus, StatusBar } from "../tui.js";
import type { CycleResult, Flags, ParkSignal, PipelineOpts, Step, StepResult } from "../types.js";

// Shared hermetic setup for test files that drive the real runPipeline (pipeline.test.ts,
// ship.test.ts). These flow tests exercise pick/plan/implement/ship control flow, not the
// driver-assignment or authoring-review internals (covered in driver-assignment.test.ts /
// review-loop.test.ts), so they must not flip with the runner's installed binaries or the
// repo's `.pelaggio.yml` (#304): mute the pipeline's high-volume console output (which floods
// node:test IPC on constrained CI runners), stub every configured provider as available (else
// reviewer-not-author fails closed on a claude-only host like CI and the cycle parks), and pin
// the authoring loop off (else the adversarial path parks on unmocked review steps). Call
// setupHermeticPipelineEnv from `before` and teardownHermeticPipelineEnv from `after`.
let savedAuthoringEnabled = false;
export function setupHermeticPipelineEnv(): void {
	mock.method(console, "log", () => {});
	mock.method(console, "error", () => {});
	savedAuthoringEnabled = REVIEW_CONFIG.authoring.enabled;
	REVIEW_CONFIG.authoring.enabled = false;
	__setProviderAvailableForTests(() => true);
}
export function teardownHermeticPipelineEnv(): void {
	mock.restoreAll();
	REVIEW_CONFIG.authoring.enabled = savedAuthoringEnabled;
	__setProviderAvailableForTests(undefined);
}

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
	/** Side effect explicitly bracketed as a mutating provider-tool invocation. */
	attributedSideEffect?: (cwd: string) => void;
	/** If true, the mock awaits `opts.signal`'s abort event before applying the rest of
	 * the outcome. Lets tests simulate a step that's in-flight when SIGINT fires. */
	awaitAbort?: boolean;
	/** Await a real timer of this many ms before applying the rest of the outcome. Lets
	 * tests give a concurrent mid-step confinement prober (#388) a chance to tick — and,
	 * unlike `awaitAbort`, still resolve naturally when nothing trips it. */
	delayMs?: number;
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
			return { ok: false, subtype: "error_abort", text: "aborted", fullText: "", assistantText: "aborted", cost: 0, turns: 0 };
		}
		if (outcome.awaitAbort && opts.signal) {
			await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve(), { once: true }));
		}
		if (outcome.delayMs) {
			await new Promise<void>((resolve) => setTimeout(resolve, outcome.delayMs));
		}
		const writes = name === "plan" && (outcome.ok ?? true) && !outcome.writes ? { [`docs/plans/${(opts.itemId ?? "plan").toLowerCase()}.md`]: "# Plan\nmock plan" } : outcome.writes;
		if (writes) {
			for (const [rel, content] of Object.entries(writes)) {
				const full = resolve(opts.cwd, rel);
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, content);
			}
		}
		if (outcome.attributedSideEffect) {
			opts.mainCheckoutObserver?.beforeTool(`mock-${name}-${attempt}`);
			outcome.attributedSideEffect(opts.cwd);
			opts.mainCheckoutObserver?.afterTool(`mock-${name}-${attempt}`);
		}
		outcome.sideEffect?.(opts.cwd);
		if (outcome.park) Object.assign(parkSignal, outcome.park);
		const result: StepResult = {
			ok: outcome.ok ?? true,
			subtype: outcome.subtype ?? "success",
			text: outcome.text ?? "",
			fullText: outcome.fullText ?? outcome.text ?? "",
			assistantText: outcome.assistantText ?? outcome.text ?? "",
			cost: outcome.cost ?? 0.01,
			turns: outcome.turns ?? 1,
			...(outcome.tokens ? { tokens: outcome.tokens } : {}),
			...(outcome.outputTail ? { outputTail: outcome.outputTail } : {}),
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
			...(outcome.disposition ? { disposition: outcome.disposition } : {}),
			...(outcome.awaitingMerge ? { awaitingMerge: outcome.awaitingMerge } : {}),
			...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}),
			...(outcome.shipwrecked ? { shipwrecked: outcome.shipwrecked } : {}),
			...(outcome.bookkeepingWarnings?.length ? { bookkeepingWarnings: outcome.bookkeepingWarnings } : {}),
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

/** Default PR-mode freshness + pre-flight stubs. `setupShipRepo` / `makeTempGitRepo` have no
 *  `origin` and are not the pelaggio monorepo — unstubbed production defaults would fetch a
 *  missing remote, run `pnpm typecheck:ratchet` in an empty tree, verify against a missing
 *  `origin/main`, and (the gate-record store, #424) read/write the HOST repo's `.dev/`. */
export function defaultPrPreflightStubs(): Pick<PipelineDeps, "preparePrShipFreshness" | "runPrReviewGate" | "runTypecheckRatchet" | "verifyPrShipFreshness" | "readFreshnessGateRecord" | "writeFreshnessGateRecord"> {
	return {
		preparePrShipFreshness: () => ({ kind: "up-to-date" }),
		verifyPrShipFreshness: () => ({ ok: true }),
		readFreshnessGateRecord: () => null,
		writeFreshnessGateRecord: () => "",
		runPrReviewGate: async (): Promise<PrReviewGateResult> => ({
			gate: "pass",
			body: "preflight pass",
			cost: 0,
			costEstimated: false,
			turns: 0,
			ok: true,
			subtype: "success",
			agreement: "consensus-pass",
			survivorCount: 0,
		}),
		runTypecheckRatchet: async () => ({ ok: true }),
	};
}

export function makeTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-pipeline-test-"));
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	// Mirror production: harness artifacts under `.dev/` (effects manifests, execution
	// receipts, review records) must not enter the branch and defeat phantom-ship.
	writeFileSync(join(dir, ".gitignore"), ".dev/\n");
	execSync("git add -A && git commit -q -m init", { cwd: dir });
	execSync("git checkout -q -b feat/tool-99", { cwd: dir });
	return dir;
}

/** Git repo checked out on a non-`main` branch with no `main` ref: `git status` succeeds
 *  (the worktree-confinement audit can snapshot it as a forbidden root) but `git rev-parse main`
 *  fails, so passing it as `mainRepo` makes `captureShipState` return null (simulates a main repo
 *  that can't answer the pre-ship rev-parse). A plain non-git dir can't be used here — the audit
 *  fails closed on the unsnapshot-able root and aborts the first step before ship is reached. */
export function makeGitDirWithoutMain(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-nomain-"));
	execSync("git init -q -b work", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	execSync("git commit --allow-empty -q -m init", { cwd: dir });
	return dir;
}

/**
 * Creates a tmp parent dir containing a git repo, so tests can inject a `mainRepo`
 * and also derive a sibling worktree path under the same parent (mirroring the
 * production layout where `resolveWorktree` returns `resolve(REPO, "..", ...)`).
 */
export function makeTempRepoWithParent(): { parent: string; repo: string } {
	const parent = mkdtempSync(join(tmpdir(), "pelaggio-parent-"));
	const repo = join(parent, "repo");
	mkdirSync(repo);
	execSync("git init -q -b main", { cwd: repo });
	execSync("git config user.name t", { cwd: repo });
	execSync("git config user.email t@t", { cwd: repo });
	execSync("git config commit.gpgsign false", { cwd: repo });
	// Mirror production (and makeTempGitRepo): harness artifacts under `.dev/` — effects
	// manifests, execution receipts, review records, attempt records (#467) — are gitignored
	// in every real consumer, so a fixture that tracks them makes "the cycle left the repo
	// clean" assertions fail on harness-owned state rather than on real tree mutation.
	writeFileSync(join(repo, ".gitignore"), ".dev/\n");
	execSync("git add .gitignore", { cwd: repo });
	execSync("git commit -q -m init", { cwd: repo });
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
	};
	return { ...base, ...overrides };
}

export function allCommitMessages(dir: string): string[] {
	return execSync("git log --format=%s", { cwd: dir, encoding: "utf-8" }).trim().split("\n").filter(Boolean);
}
