import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { REPO } from "../config.js";
import type { NotifyPayload } from "../notify.js";
import { runOrchestrator } from "../pipeline.js";
import { gateRecordsDir, readPrReviewGateRecord, writePrReviewGateRecord } from "../pr-review-gate-record.js";
import { enqueueReviewRequest, type NewReviewRequest, reviewRequestsDir } from "../review-request-queue.js";
import { reviseFindingsPath } from "../revise-sweep.js";
import type { GhRunner } from "../roadmap/github-issues.js";
import { LiveStatus, StatusBar } from "../tui.js";
import type { Flags } from "../types.js";
import { createMockRunPipeline } from "./mocks.js";

// runOrchestrator derives no-worktree (single-shot) mode from ambient env —
// CI=true or PELAGGIO_SINGLE_SHOT=1 (see pipeline.ts). These tests
// exercise the default worktree orchestration, so neutralize those vars for the
// duration of the file. Without this the suite fails under any CI runner, since
// GitHub Actions always sets CI=true, which flips the orchestrator onto the
// single-shot path and short-circuits before runPipeline is called.
const savedEnv: Record<string, string | undefined> = {};
before(() => {
	for (const key of ["CI", "PELAGGIO_SINGLE_SHOT"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});
after(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const baseFlags: Flags = {
	cycles: "1",
	parallel: "1",
	verbose: false,
	trace: false,
	budget: "10",
	"max-wait": "6h",
	"dry-run": false,
	"no-worktree": false,
};

const fakeResolveWorktree = (id: string): string => `/fake/wt-${id.toLowerCase()}`;
const fakeDetectResumeStep = () => "implement" as const;

describe("runOrchestrator — resume mode", () => {
	it("rejects --review-findings combined with a later --from (exit 2)", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({});
		const { exitCode } = await runOrchestrator({ ...baseFlags, resume: "tool-99", from: "ship", "review-findings": "f.md" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0, "no pipeline run may start past the rejected combination");
	});

	it("success: runPipeline called with startFrom and exitCode 0", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: { "TOOL-99": { completed: true, cost: 1 } },
		});
		const { exitCode, results } = await runOrchestrator({ ...baseFlags, resume: "tool-99" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.itemId, "TOOL-99");
		assert.equal(calls[0].opts.startFrom, "implement");
		assert.equal(calls[0].opts.worktree, "/fake/wt-tool-99");
		assert.equal(results.length, 1);
		assert.equal(results[0].completed, true);
	});

	it("failure: exitCode 1 when runPipeline returns completed false", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline } = createMockRunPipeline({
			byItem: { "TOOL-99": { completed: false, cost: 0, error: "plan failed" } },
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, resume: "tool-99" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
	});
});

describe("runOrchestrator — resume --from override", () => {
	it("override wins and short-circuits detectResumeStep", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: { "TOOL-99": { completed: true, cost: 1 } },
		});
		let detectCalled = 0;
		const detectResumeStep = () => {
			detectCalled++;
			return "ship" as const;
		};
		const { exitCode } = await runOrchestrator({ ...baseFlags, resume: "tool-99", from: "implement" }, { runPipeline, detectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.startFrom, "implement");
		assert.equal(detectCalled, 0, "detectResumeStep must not run when --from overrides");
	});

	it("invalid --from exits 2 without invoking runPipeline", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, resume: "X", from: "bogus" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
	});

	it("--from pick exits 2 without invoking runPipeline (pick never executes in resume mode)", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, resume: "X", from: "pick" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
	});

	it("--from without --resume exits 2 without invoking runPipeline", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1", from: "implement" }, { runPipeline });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
	});
});

describe("runOrchestrator — CI resume + review-findings (issue #60)", () => {
	it("--resume with no-worktree and no --item reaches runPipeline (guard relaxation)", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: { "TOOL-99": { completed: true, cost: 1 } },
		});
		const { exitCode, results } = await runOrchestrator({ ...baseFlags, resume: "tool-99", "no-worktree": true }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.itemId, "TOOL-99");
		assert.equal(results.length, 1);
	});

	it("--review-findings without --resume exits 2 without invoking runPipeline", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1", "review-findings": "p.md" }, { runPipeline });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
	});

	it("--acknowledge-escalation without --resume exits 2 without invoking runPipeline", async (t) => {
		const error = t.mock.method(console, "error", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1", "acknowledge-escalation": "a".repeat(64) }, { runPipeline });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
		assert.match(String(error.mock.calls[0]?.arguments[0]), /requires --resume/);
	});
});

describe("runOrchestrator — invalid target", () => {
	it("exits 2 without invoking runPipeline", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1", target: "bogus" }, { runPipeline });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
	});
});

describe("runOrchestrator — cycle auto-sizing", () => {
	it("runs one cycle per --item entry when --cycles < items.length", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 0.1 },
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3", cycles: "1" }, { runPipeline });
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 3);
		assert.deepEqual(
			calls.map((c) => c.opts.itemId),
			["A-1", "A-2", "A-3"],
		);
	});
});

describe("runOrchestrator — parallel workers share mutex", () => {
	it("every runPipeline call receives the same pickMutex reference", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 0.1 },
		});
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3", parallel: "2" }, { runPipeline });
		assert.equal(calls.length, 3);
		const mutex = calls[0].opts.pickMutex;
		assert.ok(mutex, "pickMutex should be defined when parallel > 1");
		for (const c of calls) assert.strictEqual(c.opts.pickMutex, mutex);
	});

	it("every worker cycle receives the same activeWorktrees registry, distinct from pickMutex", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 0.1 },
		});
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3", parallel: "2" }, { runPipeline });
		assert.equal(calls.length, 3);
		const registry = calls[0].opts.activeWorktrees;
		const pick = calls[0].opts.pickMutex;
		assert.ok(registry instanceof Set, "activeWorktrees should be a Set when parallel > 1");
		assert.ok(pick, "pickMutex should be defined when parallel > 1");
		for (const c of calls) {
			assert.strictEqual(c.opts.activeWorktrees, registry, "all workers share one registry");
			assert.strictEqual(c.opts.pickMutex, pick);
		}
	});

	it("serial orchestration does not manufacture pickMutex or activeWorktrees", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 0.1 },
		});
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2", parallel: "1" }, { runPipeline });
		assert.equal(calls.length, 2);
		for (const c of calls) {
			assert.equal(c.opts.pickMutex, undefined);
			assert.equal(c.opts.activeWorktrees, undefined);
		}
	});
});

describe("runOrchestrator — worker continuation", () => {
	it("bookkeeping warning exits zero, renders distinctly, and keeps pulling", async (t) => {
		const output: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => output.push(args.join(" ")));
		const warning = "mark-done failed (EACCES); rerun mark-done";
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: true, cost: 0.1, bookkeepingWarnings: [warning] },
				"A-2": { completed: true, cost: 0.1 },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2" }, { runPipeline });

		assert.equal(exitCode, 0);
		assert.equal(calls.length, 2);
		assert.match(output.join("\n"), /shipped — bookkeeping incomplete: mark-done failed/);
		assert.match(output.join("\n"), /⚠/);
	});

	it("recoverable error ('pick:queue-empty') keeps worker pulling subsequent cycles", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "pick:queue-empty" },
				"A-2": { completed: true, cost: 0.1 },
				"A-3": { completed: true, cost: 0.1 },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3" }, { runPipeline });
		assert.equal(calls.length, 3);
		assert.equal(exitCode, 1); // overall still non-zero because A-1 didn't complete
	});

	it("recoverable error ('transient sdk error') keeps worker pulling subsequent cycles", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "transient sdk error" },
				"A-2": { completed: true, cost: 0.1 },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2" }, { runPipeline });
		assert.equal(calls.length, 2);
		assert.equal(exitCode, 1); // overall still non-zero because A-1 didn't complete
	});

	it("fatal error stops the worker and skips remaining items", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "plan failed" },
				"A-2": { completed: true, cost: 0.1 },
				"A-3": { completed: true, cost: 0.1 },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3" }, { runPipeline });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.itemId, "A-1");
		assert.equal(exitCode, 1);
	});
});

describe("LiveStatus — bookkeeping warning", () => {
	it("renders and counts warning workers separately", (t) => {
		const statusBar = new StatusBar();
		const updates: string[][] = [];
		t.mock.method(statusBar, "update", (lines: string[]) => updates.push(lines));
		const live = new LiveStatus(statusBar);
		live.totalCycles = 2;
		live.multiline = true;
		live.cycles = [
			{ itemId: "A-1", status: "warning", cost: 0.1 },
			{ itemId: "A-2", status: "done", cost: 0.1 },
		];
		live.render();

		assert.match(updates.at(-1)?.join("\n") ?? "", /1⚠/);
		assert.match(updates.at(-1)?.join("\n") ?? "", /1✓/);
	});
});

describe("runOrchestrator — sustained transient SDK outage (#128)", () => {
	function spySend() {
		const sent: Array<{ payload: { event: string; itemId: string | null; error?: string } }> = [];
		const sendNotification = async (_url: string, _format: "json" | "ntfy", payload: { event: string; itemId: string | null; error?: string }) => {
			sent.push({ payload });
			return true;
		};
		return { sent, sendNotification };
	}

	it("a lone transient sdk error stays non-paging (#127 single-blip behavior preserved)", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "transient sdk error" },
				"A-2": { completed: false, cost: 0, error: "pick:queue-empty" },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2" }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(calls.length, 2, "worker keeps pulling past a single transient blip");
		assert.equal(exitCode, 1); // overall still non-zero because neither cycle completed
		assert.equal(sent.length, 0, "a lone transient blip must not page");
	});

	it("N consecutive transient sdk errors park + page instead of burning the rest of --cycles", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "transient sdk error" },
				"A-2": { completed: false, cost: 0, error: "transient sdk error" },
				"A-3": { completed: false, cost: 0, error: "transient sdk error" },
				"A-4": { completed: true, cost: 0.1 },
				"A-5": { completed: true, cost: 0.1 },
			},
		});
		const { exitCode, results } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3,A-4,A-5" }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(calls.length, 3, "worker must stop after the 3rd consecutive transient error, never reaching A-4/A-5");
		assert.equal(exitCode, 1);
		assert.equal(results.at(-1)?.error, "parked", "the tripping cycle is relabeled parked so it flows through the park path");
		assert.equal(sent.length, 1, "the sustained outage must page exactly once");
		assert.equal(sent[0].payload.event, "parked");
		assert.equal(sent[0].payload.itemId, "A-3");
	});

	it("a success between blips resets the streak — 2 blips + success + 2 blips never trips", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "transient sdk error" },
				"A-2": { completed: false, cost: 0, error: "transient sdk error" },
				"A-3": { completed: true, cost: 0.1 },
				"A-4": { completed: false, cost: 0, error: "transient sdk error" },
				"A-5": { completed: false, cost: 0, error: "transient sdk error" },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3,A-4,A-5" }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(calls.length, 5, "streak reset by A-3's success — the run must reach every item");
		assert.equal(exitCode, 1);
		assert.equal(sent.length, 1, "only A-3's shipped cycle pages; no outage page fires");
		assert.equal(sent[0].payload.event, "shipped");
	});

	it("hands back with a clear resume hint (no known reset time for an SDK outage)", async (t) => {
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "transient sdk error" },
				"A-2": { completed: false, cost: 0, error: "transient sdk error" },
				"A-3": { completed: false, cost: 0, error: "transient sdk error" },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(calls.length, 3);
		assert.equal(exitCode, 1);
		assert.ok(
			logs.some((l) => l.includes("sdk-outage") && l.includes("cannot auto-resume")),
			`expected a "cannot auto-resume" hand-back for the sdk-outage park; got:\n${logs.join("\n")}`,
		);
		assert.ok(
			logs.some((l) => l.includes("Resume:") && l.includes("pnpm pelaggio --resume A-3")),
			`expected the --resume hint for the parked item; got:\n${logs.join("\n")}`,
		);
	});
});

describe("runOrchestrator — cycle disposition", () => {
	const quarantine = { completed: false, cost: 0, error: "implement blocked: x", disposition: "quarantine-and-continue" as const };
	function spySend() {
		const sent: Array<{ payload: { event: string; itemId: string | null } }> = [];
		const sendNotification = async (_url: string, _format: "json" | "ntfy", payload: { event: string; itemId: string | null }) => {
			sent.push({ payload });
			return true;
		};
		return { sent, sendNotification };
	}

	it("quarantine keeps pulling and pages the blocked item", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline, calls } = createMockRunPipeline({ byItem: { "A-1": quarantine, "A-2": { completed: true, cost: 0 } } });
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2" }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(calls.length, 2);
		assert.equal(sent.filter((entry) => entry.payload.itemId === "A-1" && entry.payload.event === "failed").length, 1);
	});

	it("unknown safety-class failures halt the queue tail", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ byItem: { "A-1": { completed: false, cost: 0, error: "implement failed: confinement violation" }, "A-2": { completed: true, cost: 0 } } });
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2" }, { runPipeline });
		assert.equal(calls.length, 1);
	});

	it("halts on the fifth consecutive quarantine without relabeling its diagnosis", async (t) => {
		t.mock.method(console, "log", () => {});
		const byItem = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`A-${n}`, { ...quarantine }]));
		const { runPipeline, calls } = createMockRunPipeline({ byItem: { ...byItem, "A-6": { completed: true, cost: 0 } } });
		const { results } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3,A-4,A-5,A-6" }, { runPipeline });
		assert.equal(calls.length, 5);
		assert.equal(results.at(-1)?.error, "implement blocked: x");
		assert.equal(results.at(-1)?.disposition, "halt-campaign");
	});

	it("a success resets the quarantine streak", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: { "A-1": { ...quarantine }, "A-2": { ...quarantine }, "A-3": { completed: true, cost: 0 }, "A-4": { ...quarantine }, "A-5": { ...quarantine } },
		});
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3,A-4,A-5" }, { runPipeline });
		assert.equal(calls.length, 5);
	});

	it("parallel campaign halt prevents a third allocation while an existing cycle finishes", async (t) => {
		t.mock.method(console, "log", () => {});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls: string[] = [];
		const runPipeline = async (opts: { itemId?: string }) => {
			calls.push(opts.itemId ?? "");
			if (opts.itemId === "A-1") {
				await held;
				return { itemId: "A-1", completed: true, cost: 0 };
			}
			return { itemId: opts.itemId ?? null, completed: false, cost: 0, error: "implement failed: confinement violation" };
		};
		const pending = runOrchestrator({ ...baseFlags, parallel: "2", item: "A-1,A-2,A-3" }, { runPipeline });
		while (calls.length < 2) await new Promise(setImmediate);
		await new Promise(setImmediate);
		release();
		await pending;
		assert.deepEqual(calls.sort(), ["A-1", "A-2"]);
	});
});

describe("runOrchestrator — park-and-resume", () => {
	it("success: resumes after wait, uses detectResumeStep startFrom, exitCode 0", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": [
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
					{ completed: true, cost: 0.5 },
				],
			},
		});

		let detectCalled = 0;
		const detectResumeStep = (id: string, _wt: string) => {
			detectCalled++;
			assert.equal(id, "X-1");
			return "ship" as const;
		};

		const promise = runOrchestrator({ ...baseFlags, item: "X-1" }, { runPipeline, detectResumeStep, resolveWorktree: fakeResolveWorktree });
		// Let the orchestrator run to its setTimeout wait, then tick past it and drain microtasks.
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		const { results } = await promise;

		// Two runPipeline calls: the parked one and the resume one.
		assert.equal(calls.length, 2);
		assert.equal(calls[1].opts.startFrom, "ship");
		assert.equal(calls[1].opts.itemId, "X-1");
		assert.ok(detectCalled >= 1, "detectResumeStep should be called for resume");
		// Results array holds both the parked cycle and the successful resume.
		assert.equal(results.length, 2);
		assert.equal(results[0].error, "parked");
		assert.equal(results[1].completed, true);
	});

	it("exceeds --max-wait: exitCode 1, runPipeline not re-invoked", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 3 * 3600_000, limitType: "5h" } },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1", "max-wait": "1h" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1);
		assert.ok(
			logs.some((l) => l.includes("Resume:") && l.includes("pnpm pelaggio --resume X-1")),
			`expected the --resume hint in logs; got:\n${logs.join("\n")}`,
		);
	});

	it("weekly limit: uses 'Weekly rate limit' wording when exceeding max-wait", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});

		const { runPipeline } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 2 * 3600_000, limitType: "weekly" } },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1", "max-wait": "1h" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		assert.ok(
			logs.some((l) => l.includes("Weekly rate limit")),
			`expected "Weekly rate limit" in logs; got:\n${logs.join("\n")}`,
		);
	});

	// resetsAt=0 no longer models a rate-limit park — those synthesize a conservative reset at the
	// source (#68). It now reaches the orchestrator only via manual pause (SIGUSR2) or a stale reset,
	// neither auto-resumable by time, so the run hands back with a resume hint.
	it("no reset time (resetsAt=0, e.g. manual pause): exitCode 1, runPipeline not re-invoked", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: 0, limitType: "paused" } },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1);
		assert.ok(
			logs.some((l) => l.includes("Resume:") && l.includes("pnpm pelaggio --resume X-1")),
			`expected the --resume hint in logs; got:\n${logs.join("\n")}`,
		);
	});
});

describe("runOrchestrator — auto-resume config", () => {
	it("off-switch: park.auto-resume=false reports parked items and exits 1 without resuming", async (t) => {
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const baseNow = 1_700_000_000_000;
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1" }, { runPipeline, park: { autoResume: false }, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1, `expected no resume when auto-resume disabled; got ${calls.length} calls`);
		assert.ok(
			logs.some((l) => l.includes("auto-resume disabled")),
			`expected off-switch wording in logs; got:\n${logs.join("\n")}`,
		);
		assert.ok(
			logs.some((l) => l.includes("Resume:") && l.includes("pnpm pelaggio --resume X-1")),
			`expected the --resume hint (not --item, which pick's worktree-exists guard refuses) in logs; got:\n${logs.join("\n")}`,
		);
	});

	it("off-switch: multiple parked items each get their own --resume line (#56)", async (t) => {
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const baseNow = 1_700_000_000_000;
		const { runPipeline } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
				"X-2": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
			},
		});
		// parallel: "2" so both cycles are pulled by their own worker before either observes
		// parkSignal.parked — with the default parallel: "1" the single worker's `if
		// (parkSignal.parked) break;` (pipeline.ts) would stop after X-1 and X-2 would never run.
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1,X-2", parallel: "2" }, { runPipeline, park: { autoResume: false }, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		const resumeLine = logs.find((l) => l.includes("Resume:"));
		assert.ok(resumeLine, `expected a Resume: line in logs; got:\n${logs.join("\n")}`);
		assert.ok(resumeLine.includes("pnpm pelaggio --resume X-1") && resumeLine.includes("pnpm pelaggio --resume X-2"), `expected one --resume command per parked item; got:\n${resumeLine}`);
		assert.ok(!resumeLine.includes("--item"), `--item is refused by pick's worktree-exists guard on an already-claimed id; got:\n${resumeLine}`);
	});

	it("multi-window: park→park→success resumes across two windows (3 runPipeline calls)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": [
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
					{ completed: true, cost: 0.5 },
				],
			},
			// Trap: mocked Date.now() advances with tick(), so a static resetsAt would already
			// be in the past by round 2 (gate would read waitMs<=0 → exit parked). Re-anchor each
			// still-parked round's reset to now+60s so every reset is genuinely in the future.
			onCall: (_opts, ps) => {
				if (ps.parked) ps.resetsAt = Date.now() + 60_000;
			},
		});

		const promise = runOrchestrator({ ...baseFlags, item: "X-1" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		// Round 1: let it reach the wait, tick past resumeAt (reset + ≤30s jitter), drain.
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		// Round 2: same again — this time the resume succeeds.
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		const { results } = await promise;

		assert.equal(calls.length, 3, `expected 3 runPipeline calls (initial park + 2 resume rounds); got ${calls.length}`);
		assert.equal(results.at(-1)?.completed, true, "final resume should complete");
	});

	it("config park.max-wait caps the wait when --max-wait flag is unset (exits parked)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 3 * 3600_000, limitType: "5h" } },
			},
		});
		// Flags without --max-wait; inject config cap 1h. A 3h reset exceeds it → exit parked.
		const flagsNoMaxWait: Flags = { cycles: "1", parallel: "1", verbose: false, trace: false, budget: "10", "dry-run": false, "no-worktree": false };
		const { exitCode } = await runOrchestrator({ ...flagsNoMaxWait, item: "X-1" }, { runPipeline, park: { maxWait: "1h" }, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1, `expected no resume (config max-wait exceeded); got ${calls.length}`);
	});

	it("--max-wait CLI flag overrides config park.max-wait (resume proceeds)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": [
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 3 * 3600_000, limitType: "5h" } },
					{ completed: true, cost: 0.5 },
				],
			},
		});
		// Config cap 1h would block a 3h reset, but CLI --max-wait 5h overrides it → resume.
		const promise = runOrchestrator({ ...baseFlags, item: "X-1", "max-wait": "5h" }, { runPipeline, park: { maxWait: "1h" }, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(3 * 3600_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		const { results } = await promise;

		assert.equal(calls.length, 2, `expected resume to proceed (CLI cap 5h > 3h wait); got ${calls.length}`);
		assert.equal(results.at(-1)?.completed, true);
	});

	it("multi-window then exceeds max-wait: tears down the status bar before exiting (no leaked scroll region)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		// setup/teardown are no-ops in plain (non-TTY) mode, so the leak is invisible to
		// a real bar under test — spy the calls directly to assert they stay balanced.
		const bar = new StatusBar({ plain: true });
		const events: string[] = [];
		t.mock.method(bar, "setup", () => events.push("setup"));
		t.mock.method(bar, "teardown", () => events.push("teardown"));

		const { runPipeline } = createMockRunPipeline({
			byItem: {
				// Round 1 resumes within max-wait, then re-parks with a reset 3h out that
				// exceeds the 1h cap → the round-2 gate must break, not early-return.
				"X-1": [
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 3 * 3600_000, limitType: "5h" } },
				],
			},
		});

		const promise = runOrchestrator({ ...baseFlags, item: "X-1", verbose: true, "max-wait": "1h" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree }, bar);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		const { exitCode } = await promise;

		assert.equal(exitCode, 1);
		const setups = events.filter((e) => e === "setup").length;
		const teardowns = events.filter((e) => e === "teardown").length;
		assert.equal(setups, teardowns, `setup/teardown must stay balanced; got ${JSON.stringify(events)}`);
		assert.equal(events.at(-1), "teardown", `the run must end on a teardown, not a leaked setup; got ${JSON.stringify(events)}`);
	});
});

describe("runOrchestrator — notifications", () => {
	type Sent = { url: string; format: string; payload: NotifyPayload };
	function spySend() {
		const sent: Sent[] = [];
		const sendNotification = async (url: string, format: "json" | "ntfy", payload: NotifyPayload) => {
			sent.push({ url, format, payload });
			return true;
		};
		return { sent, sendNotification };
	}

	it("sends one classified notification per terminal cycle", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: true, cost: 0.1 },
				"A-2": { completed: false, cost: 0.1, error: "plan failed" },
			},
		});
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2" }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(sent.length, 2);
		assert.equal(sent[0].url, "https://hook.example");
		assert.equal(sent[0].payload.event, "shipped");
		assert.equal(sent[0].payload.itemId, "A-1");
		assert.equal(sent[1].payload.event, "failed");
		assert.equal(sent[1].payload.itemId, "A-2");
	});

	it("classifies a PR-opened cycle from awaitingMerge", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({
			byItem: { "A-1": { completed: true, cost: 0.1, awaitingMerge: true, prUrl: "https://github.com/x/y/pull/5" } },
		});
		await runOrchestrator({ ...baseFlags, item: "A-1" }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(sent.length, 1);
		assert.equal(sent[0].payload.event, "pr-opened");
	});

	it("does not call the transport when notify.url is unset (the default)", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({ byItem: { "A-1": { completed: true, cost: 0.1 } } });
		await runOrchestrator({ ...baseFlags, item: "A-1" }, { runPipeline, sendNotification });
		assert.equal(sent.length, 0);
	});

	it("does not notify in --dry-run even with a url configured", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({ byItem: { "A-1": { completed: true, cost: 0.1 } } });
		await runOrchestrator({ ...baseFlags, item: "A-1", "dry-run": true }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(sent.length, 0);
	});

	it("skips non-actionable outcomes (e.g. pick:queue-empty)", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "pick:queue-empty" },
				"A-2": { completed: true, cost: 0.1 },
			},
		});
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2" }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		// A-1 skipped (recoverable), A-2 shipped.
		assert.equal(sent.length, 1);
		assert.equal(sent[0].payload.event, "shipped");
		assert.equal(sent[0].payload.itemId, "A-2");
	});

	it("emits on the --resume path", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({ byItem: { "TOOL-99": { completed: true, cost: 1 } } });
		await runOrchestrator({ ...baseFlags, resume: "tool-99" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(sent.length, 1);
		assert.equal(sent[0].payload.event, "shipped");
		assert.equal(sent[0].payload.itemId, "TOOL-99");
	});

	it("emits for both the initial park and the resumed cycle", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({
			byItem: {
				"X-1": [
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
					{ completed: true, cost: 0.5 },
				],
			},
		});

		const promise = runOrchestrator({ ...baseFlags, item: "X-1" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree, notifyConfig: { url: "https://hook.example" }, sendNotification });
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		await promise;

		assert.equal(sent.length, 2);
		assert.equal(sent[0].payload.event, "parked");
		assert.equal(sent[1].payload.event, "shipped");
	});
});

describe("runOrchestrator — revise sweep (issue #76)", () => {
	// One revisable PR: open, non-draft, feat/issue-76 head, unlabeled, review=FAILURE.
	const ONE_REVISABLE = [{ number: 101, isDraft: false, headRefName: "feat/issue-76-x", labels: [], statusCheckRollup: [{ __typename: "CheckRun", name: "review", conclusion: "FAILURE" }] }];

	// A gh stub that satisfies the whole sweep for `ONE_REVISABLE`: pr list → the fixture, issue
	// view → the roadmap label, pr view → a findings comment, everything else (label create, pr
	// edit, pr comment) → exit 0.
	function makeGhStub(prList: unknown): GhRunner {
		return (args) => {
			if (args[0] === "pr" && args[1] === "list") return { stdout: JSON.stringify(prList), stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ comments: [{ body: "<!-- pelaggio-pr-review -->\nfix the bug", createdAt: "2026-01-01T00:00:00Z" }] }), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
	}
	const throwingGh: GhRunner = () => {
		throw new Error("gh unavailable");
	};

	// resolveWorktree → an existing real dir so ensureReviseWorktree short-circuits (no git).
	let wtDir: string;
	before(() => {
		wtDir = mkdtempSync(join(tmpdir(), "revise-sweep-orch-"));
	});
	after(() => {
		rmSync(wtDir, { recursive: true, force: true });
		// The sweep writes findings to <REPO>/.dev/ (gitignored scratch) — clean it up.
		rmSync(reviseFindingsPath(REPO, "76"), { force: true });
	});
	const resolveWt = (): string => wtDir;

	it("runs local review before revise so a local failure is immediately revisable", async (t) => {
		t.mock.method(console, "log", () => {});
		let prListCalls = 0;
		const ghCalls: string[][] = [];
		const gh: GhRunner = (args) => {
			ghCalls.push(args);
			if (args[0] === "pr" && args[1] === "list") {
				prListCalls++;
				if (prListCalls === 1) {
					return {
						stdout: JSON.stringify([
							{
								number: 201,
								isDraft: false,
								headRefName: "feat/issue-84-local-review",
								headRefOid: "abc123a",
								headRepository: { nameWithOwner: "o/r" },
								updatedAt: "2026-07-08T12:00:00Z",
								statusCheckRollup: [],
							},
						]),
						stderr: "",
						status: 0,
					};
				}
				return {
					stdout: JSON.stringify([{ number: 201, isDraft: false, headRefName: "feat/issue-84-local-review", labels: [], statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: "FAILURE" }] }]),
					stderr: "",
					status: 0,
				};
			}
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1]?.includes("/comments")) return { stdout: JSON.stringify([{ id: 42, body: "<!-- pelaggio-pr-review -->\nfix local blocker", created_at: "2026-07-08T12:01:00Z" }]), stderr: "", status: 0 };
			if (args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ comments: [{ body: "<!-- pelaggio-pr-review -->\nfix local blocker", createdAt: "2026-07-08T12:01:00Z" }] }), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: { "84": { completed: true, cost: 0.5 } },
			default: { completed: false, cost: 0, error: "pick:queue-empty" },
		});

		await runOrchestrator(
			{ ...baseFlags, target: "pull-request", cycles: "1" },
			{
				runPipeline,
				resolveWorktree: resolveWt,
				review: {
					runner: "local",
					ghRepo: "o/r",
					gh,
					// Isolated queue/lock root: without this the drain hits the REAL
					// REPO/.dev/review-requests/.drain.lock, which mocked timers cannot
					// steal (#387 gate finding).
					queueRoot: mkdtempSync(join(tmpdir(), "review-queue-")),
					gateRecordsRoot: mkdtempSync(join(tmpdir(), "review-gate-records-")),
					statuslessAfter: "2h",
					now: () => Date.parse("2026-07-08T12:05:00Z"),
					prepareReviewHead: () => ({ diffCwd: "/tmp/pr-head", baseRef: "origin/main", headRef: "refs/pelaggio-review/pr-201" }),
					cleanupReviewHead: () => {},
					runReviewGate: async () => ({ gate: "block", body: "<!-- pelaggio-pr-review -->\nblocker\n\nVerdict: BLOCK", cost: 0.25, costEstimated: true, turns: 3, ok: true, subtype: "success" }),
				},
				revise: { local: true, ghRepo: "o/r", gh },
			},
		);

		assert.equal(calls[0].opts.itemId, "84");
		assert.equal(calls[0].opts.startFrom, "implement");
		const statuses = ghCalls.filter((args) => args[0] === "api" && args[1] === "repos/o/r/statuses/abc123a");
		assert.deepEqual(
			statuses.map((args) => args.find((arg) => arg.startsWith("state="))),
			["state=pending", "state=failure"],
		);
		// campaign-start review drain lists (1) → revise sweep lists (2) → the #387 post-cycle drain
		// re-lists (3), sees the now-red PR as terminal, and no-ops. The pending→failure status posted
		// by the campaign-start drain (above) precedes the revise run of item 84, which is the invariant.
		assert.ok(prListCalls >= 2, `review sweep must list before revise sweep lists; got ${prListCalls}`);
	});

	it("a halt-campaign-classed revise failure stops the pick pool (revise outcomes gate the campaign like cycle outcomes)", async (t) => {
		t.mock.method(console, "log", () => {});
		const gh: GhRunner = (args) => {
			if (args[0] === "pr" && args[1] === "list") {
				return {
					stdout: JSON.stringify([{ number: 201, isDraft: false, headRefName: "feat/issue-84-local-review", labels: [], statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: "FAILURE" }] }]),
					stderr: "",
					status: 0,
				};
			}
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ comments: [{ body: "<!-- pelaggio-pr-review -->\nfix local blocker", createdAt: "2026-07-08T12:01:00Z" }] }), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: { "84": { completed: false, cost: 0.5, error: "implement failed: confinement violation", disposition: "halt-campaign" } },
			default: { completed: true, cost: 0.5 },
		});

		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, target: "pull-request", cycles: "2" },
			{
				runPipeline,
				resolveWorktree: resolveWt,
				// runner:"ci" disables the local review sweep — WITHOUT this, the sweep falls
				// through to production defaults and spawns REAL provider agents (#420).
				review: { runner: "ci", ghRepo: "o/r", gh },
				revise: { local: true, ghRepo: "o/r", gh },
			},
		);

		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1, `only the revise run may execute — a halt-campaign revise must not launch pick cycles; got ${calls.map((c) => c.opts.itemId ?? "auto").join(",")}`);
		assert.equal(calls[0].opts.itemId, "84");
	});

	// A pending PR fixture whose `review` status is PENDING → always a candidate (never "done",
	// never "stranded"), so it stays eligible for the local review sweep across retry rounds (#134).
	function pendingReviewPr(): unknown {
		return [
			{
				number: 201,
				isDraft: false,
				headRefName: "feat/issue-84-local-review",
				headRefOid: "abc123a",
				headRepository: { nameWithOwner: "o/r" },
				updatedAt: "2026-07-08T12:00:00Z",
				statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: "PENDING", startedAt: "2026-07-08T12:00:00Z" }],
			},
		];
	}

	it("local review rate-limit leaves the status pending — never failure, never a findings comment (#134)", async (t) => {
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		const ghCalls: string[][] = [];
		const gh: GhRunner = (args) => {
			ghCalls.push(args);
			if (args[0] === "pr" && args[1] === "list") return { stdout: JSON.stringify(pendingReviewPr()), stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1]?.includes("/comments")) return { stdout: JSON.stringify([]), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: false, cost: 0, error: "pick:queue-empty" } });

		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, target: "pull-request", cycles: "1" },
			{
				runPipeline,
				resolveWorktree: resolveWt,
				park: { autoResume: false }, // hand back immediately — no wait needed for the "never red" assertion
				review: {
					runner: "local",
					ghRepo: "o/r",
					gh,
					// Isolated queue/lock root: without this the drain hits the REAL
					// REPO/.dev/review-requests/.drain.lock, which mocked timers cannot
					// steal (#387 gate finding).
					queueRoot: mkdtempSync(join(tmpdir(), "review-queue-")),
					gateRecordsRoot: mkdtempSync(join(tmpdir(), "review-gate-records-")),
					statuslessAfter: "2h",
					now: () => Date.parse("2026-07-08T12:05:00Z"),
					prepareReviewHead: () => ({ diffCwd: "/tmp/pr-head", baseRef: "origin/main", headRef: "refs/pelaggio-review/pr-201" }),
					cleanupReviewHead: () => {},
					runReviewGate: async (opts) => {
						if (opts.parkSignal) {
							opts.parkSignal.parked = true;
							opts.parkSignal.resetsAt = baseNow + 60_000;
							opts.parkSignal.limitType = "5h";
						}
						return { gate: "park", body: "should-not-be-posted", cost: 0.1, costEstimated: false, turns: 0, ok: false, subtype: "error_rate_limit", park: { resetsAt: baseNow + 60_000, limitType: "5h" } };
					},
				},
				revise: { local: true, ghRepo: "o/r", gh },
			},
		);

		assert.equal(exitCode, 1);
		const statusStates = ghCalls.filter((a) => a[0] === "api" && a[1] === "repos/o/r/statuses/abc123a").map((a) => a.find((arg) => arg.startsWith("state=")));
		assert.deepEqual(statusStates, ["state=pending"], "only a pending status — never failure — on a rate-limit park");
		const commentUpserts = ghCalls.filter((a) => a.some((arg) => arg.startsWith("body=")));
		assert.equal(commentUpserts.length, 0, "no findings (or any) comment upserted on a park");
		assert.equal(calls.length, 0, "revise sweep and the pick pool are skipped while parked (revise never claimed)");
	});

	it("local review rate-limit waits, retries the sweep, and posts success on the second pass (#134)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const ghCalls: string[][] = [];
		// Stateful stub: once the retry posts a terminal `review` status on abc123a, the forge's rollup
		// reflects it so the #387 post-cycle drain drops the PR (done) instead of re-reviewing it.
		let reviewState = "PENDING";
		const gh: GhRunner = (args) => {
			ghCalls.push(args);
			if (args[0] === "pr" && args[1] === "list") {
				return {
					stdout: JSON.stringify([
						{
							number: 201,
							isDraft: false,
							headRefName: "feat/issue-84-local-review",
							headRefOid: "abc123a",
							headRepository: { nameWithOwner: "o/r" },
							updatedAt: "2026-07-08T12:00:00Z",
							statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: reviewState, startedAt: "2026-07-08T12:00:00Z" }],
						},
					]),
					stderr: "",
					status: 0,
				};
			}
			if (args[0] === "api" && args[1] === "repos/o/r/statuses/abc123a") {
				const posted = args.find((a) => a.startsWith("state="))?.slice("state=".length);
				if (posted === "success" || posted === "failure") reviewState = posted.toUpperCase();
				return { stdout: "", stderr: "", status: 0 };
			}
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1]?.includes("/comments")) return { stdout: JSON.stringify([]), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline } = createMockRunPipeline({ default: { completed: false, cost: 0, error: "pick:queue-empty" } });

		let gateCall = 0;
		const promise = runOrchestrator(
			{ ...baseFlags, target: "pull-request", cycles: "1" },
			{
				runPipeline,
				resolveWorktree: resolveWt,
				review: {
					runner: "local",
					ghRepo: "o/r",
					gh,
					// Isolated queue/lock root: without this the drain hits the REAL
					// REPO/.dev/review-requests/.drain.lock, which mocked timers cannot
					// steal (#387 gate finding).
					queueRoot: mkdtempSync(join(tmpdir(), "review-queue-")),
					gateRecordsRoot: mkdtempSync(join(tmpdir(), "review-gate-records-")),
					statuslessAfter: "2h",
					now: () => Date.now(),
					prepareReviewHead: () => ({ diffCwd: "/tmp/pr-head", baseRef: "origin/main", headRef: "refs/pelaggio-review/pr-201" }),
					cleanupReviewHead: () => {},
					runReviewGate: async (opts) => {
						gateCall++;
						if (gateCall === 1) {
							if (opts.parkSignal) {
								opts.parkSignal.parked = true;
								opts.parkSignal.resetsAt = Date.now() + 60_000;
								opts.parkSignal.limitType = "5h";
							}
							return { gate: "park", body: "parked", cost: 0.1, costEstimated: false, turns: 0, ok: false, subtype: "error_rate_limit", park: { resetsAt: Date.now() + 60_000, limitType: "5h" } };
						}
						return { gate: "pass", body: "<!-- pelaggio-pr-review -->\nclean\n\nVerdict: PASS", cost: 0.2, costEstimated: false, turns: 3, ok: true, subtype: "success" };
					},
				},
				revise: { local: true, ghRepo: "o/r", gh },
			},
		);

		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 10; i++) await new Promise(setImmediate);
		await promise;

		assert.equal(gateCall, 2, "the review sweep retried after the wait window");
		const statusStates = ghCalls.filter((a) => a[0] === "api" && a[1] === "repos/o/r/statuses/abc123a").map((a) => a.find((arg) => arg.startsWith("state=")));
		assert.ok(statusStates.includes("state=success"), `expected a success status after retry; got ${statusStates.join(", ")}`);
		assert.ok(!statusStates.includes("state=failure"), "never posts failure on a rate-limit park");
	});

	it("revises a red-review PR before picking new work, with startFrom=implement + findings flag", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: { "76": { completed: true, cost: 0.5 } },
			default: { completed: false, cost: 0, error: "pick:queue-empty" },
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, target: "pull-request", cycles: "1" }, { runPipeline, resolveWorktree: resolveWt, revise: { local: true, ghRepo: "o/r", gh: makeGhStub(ONE_REVISABLE) } });
		assert.equal(exitCode, 1); // the auto-pick cycle hit an empty queue (recoverable)
		// The revision runs first, then the auto-pick worker.
		assert.equal(calls[0].opts.itemId, "76");
		assert.equal(calls[0].opts.startFrom, "implement");
		assert.ok(calls[0].flags["review-findings"]?.endsWith("review-findings-76.md"), `expected the findings flag on the revision call; got ${calls[0].flags["review-findings"]}`);
		assert.equal(calls[1].opts.itemId, undefined, "second call is the auto-pick cycle (no explicit id)");
	});

	it("off-switch: revise.local:false skips the sweep and goes straight to picking", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: false, cost: 0, error: "pick:queue-empty" },
		});
		await runOrchestrator({ ...baseFlags, target: "pull-request", cycles: "1" }, { runPipeline, resolveWorktree: resolveWt, revise: { local: false, ghRepo: "o/r", gh: makeGhStub(ONE_REVISABLE) } });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.itemId, undefined, "no revision call — straight to auto-pick");
		assert.notEqual(calls[0].opts.startFrom, "implement");
	});

	it("fail-soft: a gh error in the sweep skips revision and lets picking proceed (no crash)", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: false, cost: 0, error: "pick:queue-empty" },
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, target: "pull-request", cycles: "1" }, { runPipeline, resolveWorktree: resolveWt, revise: { local: true, ghRepo: "o/r", gh: throwingGh } });
		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1, "only the auto-pick cycle — the sweep found nothing");
		assert.equal(calls[0].opts.itemId, undefined);
	});

	it("parked revision flows into results and the worker pool is skipped", async (t) => {
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: { "76": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } } },
			default: { completed: false, cost: 0, error: "pick:queue-empty" },
		});
		const { exitCode, results } = await runOrchestrator(
			{ ...baseFlags, target: "pull-request", cycles: "1" },
			{ runPipeline, resolveWorktree: resolveWt, park: { autoResume: false }, revise: { local: true, ghRepo: "o/r", gh: makeGhStub(ONE_REVISABLE) } },
		);
		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1, "the park after the revision skips the pick worker pool");
		assert.equal(results[0].error, "parked");
		assert.equal(results[0].itemId, "76");
	});
});

describe("runOrchestrator — budget warning", () => {
	it("warns once threshold exceeded but keeps running all cycles", async (t) => {
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 1 },
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2", budget: "0.01" }, { runPipeline });
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 2);
		assert.ok(
			logs.some((l) => l.includes("exceeds --budget threshold")),
			`expected budget warning in logs; got:\n${logs.join("\n")}`,
		);
	});
});

describe("runOrchestrator — continuous mode (issue #82)", () => {
	it("rejects --continuous with --item", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, continuous: true, item: "82" }, { runPipeline });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
	});

	it("drain ×2: empty free probe stops without pick agent", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		let probes = 0;
		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "drain", parallel: "2" },
			{
				runPipeline,
				queueProbe: async () => {
					probes++;
					return { empty: true, readyCount: 0 };
				},
			},
		);
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 0);
		// Continuous gate serializes probe: exactly one empty probe, not one per worker.
		assert.equal(probes, 1);
	});

	it("drain: free probe empty → stop without pick agent", async (t) => {
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 1 },
		});
		let probes = 0;
		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "drain" },
			{
				runPipeline,
				queueProbe: async () => {
					probes++;
					return { empty: true, readyCount: 0 };
				},
			},
		);
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 0, "empty free probe must not spawn a pick cycle");
		assert.equal(probes, 1);
		assert.ok(
			logs.some((l) => l.includes("drain complete")),
			`expected drain-complete log; got:\n${logs.join("\n")}`,
		);
	});

	it("drain: empty queue still runs the per-iteration revise sweep", async (t) => {
		t.mock.method(console, "log", () => {});
		const continuousWt = mkdtempSync(join(tmpdir(), "continuous-revise-orch-"));
		t.after(() => {
			rmSync(continuousWt, { recursive: true, force: true });
			rmSync(reviseFindingsPath(REPO, "76"), { force: true });
		});
		const revisable = [{ number: 101, isDraft: false, headRefName: "feat/issue-76-x", labels: [], statusCheckRollup: [{ __typename: "CheckRun", name: "review", conclusion: "FAILURE" }] }];
		const gh: GhRunner = (args) => {
			if (args[0] === "pr" && args[1] === "list") return { stdout: JSON.stringify(revisable), stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ comments: [{ body: "<!-- pelaggio-pr-review -->\nfix the bug", createdAt: "2026-01-01T00:00:00Z" }] }), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline, calls } = createMockRunPipeline({ byItem: { "76": { completed: true, cost: 0.5 } } });
		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "drain", target: "pull-request" },
			{ runPipeline, queueProbe: async () => ({ empty: true, readyCount: 0 }), resolveWorktree: () => continuousWt, revise: { local: true, ghRepo: "o/r", gh } },
		);
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.itemId, "76");
		assert.equal(calls[0].opts.startFrom, "implement");
	});

	it("watch: probe failure sleeps and retries without starting a paid pick", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true, cost: 0.2 } });
		let probes = 0;
		const sleeps: number[] = [];
		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "watch", "probe-interval": "1m", cycles: "2" },
			{
				runPipeline,
				queueProbe: async () => {
					probes++;
					if (probes === 1) throw new Error("roadmap unavailable");
					return { empty: false, readyCount: 1 };
				},
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			},
		);
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 2);
		assert.deepEqual(sleeps, [60_000]);
	});

	it("drain: probe ready → one cycle then empty stops", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 0.5 },
		});
		let probes = 0;
		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "drain" },
			{
				runPipeline,
				queueProbe: async () => {
					probes++;
					// first probe: work available; second: drained
					return probes === 1 ? { empty: false, readyCount: 1 } : { empty: true, readyCount: 0 };
				},
			},
		);
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(probes, 2);
	});

	it("watch: empty free probe sleeps then picks when work appears", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 0.2 },
		});
		let probes = 0;
		const sleeps: number[] = [];
		const { exitCode } = await runOrchestrator(
			// cycles: "2" is a safety max (continuous treats cycles>1 as a ceiling)
			{ ...baseFlags, continuous: true, preset: "watch", "probe-interval": "1m", cycles: "2" },
			{
				runPipeline,
				queueProbe: async () => {
					probes++;
					// 1st: empty → sleep; 2nd: work → pick; 3rd: empty → sleep; then cycle cap ends after 2 picks
					if (probes === 1) return { empty: true, readyCount: 0 };
					if (probes === 2) return { empty: false, readyCount: 1 };
					if (probes === 3) return { empty: false, readyCount: 1 };
					return { empty: true, readyCount: 0 };
				},
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			},
		);
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 2, "two work cycles under --cycles 2 ceiling");
		assert.ok(sleeps.length >= 1, "watch must sleep on empty free probe");
		assert.equal(sleeps[0], 60_000);
	});

	it("watch: day-budget idles to local midnight then probes again", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 3 },
		});
		// Start mid-day so nextLocalMidnightMs is in the future.
		let nowMs = new Date(2026, 7, 2, 12, 0, 0).getTime();
		const sleeps: number[] = [];
		let probes = 0;
		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "watch", "day-budget": "5", "probe-interval": "1m", cycles: "3" },
			{
				runPipeline,
				queueProbe: async () => {
					probes++;
					return { empty: false, readyCount: 1 };
				},
				sleep: async (ms) => {
					sleeps.push(ms);
					// Advance clock past the sleep so DayBudgetTracker rolls.
					nowMs += ms + 1;
				},
				now: () => nowMs,
			},
		);
		// After cycle 1: spent=3 < 5 → continue. Cycle 2: spent=6 ≥ 5 → budget-idle sleep.
		// After wake, cycle 3 runs under --cycles 3 ceiling.
		assert.equal(calls.length, 3);
		assert.equal(exitCode, 0);
		assert.ok(
			sleeps.some((ms) => ms > 60_000),
			`expected a long budget-idle sleep, got ${JSON.stringify(sleeps)}`,
		);
		assert.ok(probes >= 3);
	});

	it("drain: day-budget exhaustion stops (no rollover)", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 3 },
		});
		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "drain", "day-budget": "5" },
			{
				runPipeline,
				queueProbe: async () => ({ empty: false, readyCount: 1 }),
				sleep: async () => {},
			},
		);
		// Cycle 1 + 2 then budget stop (drain does not rollover-idle).
		assert.equal(calls.length, 2);
		assert.equal(exitCode, 0);
	});

	// #397: local-review park path charged totalSpent but skipped DayBudgetTracker.add
	// (the post-try success/failure path is skipped on break). After auto-resume the
	// retry's cost was counted, but the partial park spend leaked — continuous drain
	// could still pick under a day-budget that should already be exhausted.
	it("day-budget accounts for local review park cost (#397)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const reviewMain = mkdtempSync(join(tmpdir(), "review-budget-397-"));
		t.after(() => rmSync(reviewMain, { recursive: true, force: true }));
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const pendingPr = [
			{
				number: 201,
				isDraft: false,
				headRefName: "feat/issue-397-day-budget",
				headRefOid: "abc123a",
				headRepository: { nameWithOwner: "o/r" },
				updatedAt: "2026-07-08T12:00:00Z",
				statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: "PENDING", startedAt: "2026-07-08T12:00:00Z" }],
			},
		];
		const gh: GhRunner = (args) => {
			if (args[0] === "pr" && args[1] === "list") return { stdout: JSON.stringify(pendingPr), stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1]?.includes("/comments")) return { stdout: JSON.stringify([]), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 0.1 },
		});

		let gateCall = 0;
		const promise = runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "drain", "day-budget": "5", target: "pull-request" },
			{
				runPipeline,
				queueProbe: async () => ({ empty: false, readyCount: 1 }),
				sleep: async () => {},
				review: {
					runner: "local",
					ghRepo: "o/r",
					gh,
					queueRoot: reviewRequestsDir(reviewMain),
					gateRecordsRoot: gateRecordsDir(reviewMain),
					statuslessAfter: "2h",
					now: () => Date.now(),
					prepareReviewHead: () => ({ diffCwd: "/tmp/pr-head", baseRef: "origin/main", headRef: "refs/pelaggio-review/pr-201" }),
					cleanupReviewHead: () => {},
					runReviewGate: async (opts) => {
						gateCall++;
						if (gateCall === 1) {
							if (opts.parkSignal) {
								opts.parkSignal.parked = true;
								opts.parkSignal.resetsAt = Date.now() + 60_000;
								opts.parkSignal.limitType = "5h";
							}
							// Partial park spend. Without the #397 fix this is omitted from the day budget.
							return {
								gate: "park",
								body: "parked",
								cost: 4,
								costEstimated: false,
								turns: 0,
								ok: false,
								subtype: "error_rate_limit",
								park: { resetsAt: Date.now() + 60_000, limitType: "5h" },
							};
						}
						// Retry completes with $1.5 → day total $5.5 ≥ $5 → drain must not pick.
						return {
							gate: "pass",
							body: "<!-- pelaggio-pr-review -->\nclean\n\nVerdict: PASS",
							cost: 1.5,
							costEstimated: false,
							turns: 3,
							ok: true,
							subtype: "success",
						};
					},
				},
				// Keep revise off so only local-review spend hits the day budget.
				revise: { local: false, ghRepo: "o/r", gh },
			},
		);

		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 10; i++) await new Promise(setImmediate);
		const { exitCode } = await promise;

		assert.equal(gateCall, 2, "review sweep retried after park wait");
		assert.equal(calls.length, 0, "day budget must include park cost so drain does not start paid picks");
		assert.equal(exitCode, 0);
	});

	it("day-budget accounts for a completed review when gate-record persistence fails", async (t) => {
		t.mock.method(console, "log", () => {});
		t.mock.method(console, "warn", () => {});
		const reviewMain = mkdtempSync(join(tmpdir(), "review-budget-record-failure-"));
		t.after(() => rmSync(reviewMain, { recursive: true, force: true }));
		const pendingPr = [
			{
				number: 201,
				isDraft: false,
				headRefName: "feat/issue-328-gate-record-budget",
				headRefOid: "abc123a",
				headRepository: { nameWithOwner: "o/r" },
				updatedAt: "2026-07-08T12:00:00Z",
				statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: "PENDING", startedAt: "2026-07-08T12:00:00Z" }],
			},
		];
		const gh: GhRunner = (args) => {
			if (args[0] === "pr" && args[1] === "list") return { stdout: JSON.stringify(pendingPr), stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true, cost: 0.1 } });
		let gateCalls = 0;
		let probes = 0;

		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "drain", "day-budget": "5", target: "pull-request" },
			{
				runPipeline,
				queueProbe: async () => {
					probes++;
					return { empty: false, readyCount: 1 };
				},
				review: {
					runner: "local",
					ghRepo: "o/r",
					gh,
					queueRoot: reviewRequestsDir(reviewMain),
					gateRecordsRoot: gateRecordsDir(reviewMain),
					statuslessAfter: "2h",
					now: () => Date.parse("2026-08-05T12:00:00Z"),
					prepareReviewHead: () => ({ diffCwd: "/tmp/pr-head", baseRef: "origin/main", headRef: "refs/pelaggio-review/pr-201" }),
					cleanupReviewHead: () => {},
					runReviewGate: async () => {
						gateCalls++;
						return { gate: "pass", body: "clean", cost: 5, costEstimated: false, turns: 3, ok: true, subtype: "success", agreement: "consensus-pass" };
					},
					writeGateRecord: () => {
						throw new Error("disk full");
					},
				},
				revise: { local: false, ghRepo: "o/r", gh },
			},
		);

		assert.equal(gateCalls, 1, "the failed persistence attempt must not trigger another unmetered review");
		assert.equal(probes, 0, "the exhausted day budget stops before the free queue probe");
		assert.equal(calls.length, 0, "the exhausted day budget stops before paid pick work");
		assert.equal(exitCode, 0);
	});

	it("drain ×2: two concurrent paid cycles when probe has work", async (t) => {
		t.mock.method(console, "log", () => {});
		let inFlight = 0;
		let maxInFlight = 0;
		let calls = 0;
		const runPipeline = async () => {
			calls++;
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((r) => setTimeout(r, 30));
			inFlight--;
			return { itemId: `item-${calls}`, completed: true, cost: 0.1 };
		};
		let probes = 0;
		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "drain", parallel: "2", cycles: "2" },
			{
				runPipeline: runPipeline as never,
				queueProbe: async () => {
					probes++;
					// Keep reporting work until both cycles claimed.
					return probes <= 2 ? { empty: false, readyCount: 2 } : { empty: true, readyCount: 0 };
				},
			},
		);
		assert.equal(exitCode, 0);
		assert.equal(calls, 2);
		assert.ok(maxInFlight >= 2, `expected concurrent pipelines, maxInFlight=${maxInFlight}`);
	});

	it("a gate waiter observes a campaign halt that occurs while it waits", async (t) => {
		t.mock.method(console, "log", () => {});
		let enterSecondProbe!: () => void;
		const secondProbeEntered = new Promise<void>((resolve) => {
			enterSecondProbe = resolve;
		});
		let releaseSecondProbe!: () => void;
		const holdSecondProbe = new Promise<void>((resolve) => {
			releaseSecondProbe = resolve;
		});
		let probes = 0;
		let calls = 0;
		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "drain", parallel: "3", cycles: "3" },
			{
				runPipeline: async () => {
					calls++;
					await secondProbeEntered;
					setImmediate(releaseSecondProbe);
					return { itemId: "A-1", completed: false, cost: 0, error: "implement failed: confinement violation", disposition: "halt-campaign" };
				},
				queueProbe: async () => {
					probes++;
					if (probes === 2) {
						enterSecondProbe();
						await holdSecondProbe;
					}
					return { empty: false, readyCount: 1 };
				},
			},
		);
		assert.equal(exitCode, 1);
		assert.equal(calls, 1);
		assert.equal(probes, 2, "the waiter must take the halt path before probing after it acquires the gate");
	});

	it("drain: pick:queue-empty race also stops", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: false, cost: 0.1, error: "pick:queue-empty" },
		});
		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, continuous: true, preset: "drain" },
			{
				runPipeline,
				// Probe always says work exists — pick discovers empty (race).
				queueProbe: async () => ({ empty: false, readyCount: 1 }),
			},
		);
		assert.equal(calls.length, 1);
		assert.equal(exitCode, 1);
	});
});

describe("runOrchestrator — mid-run review drain (#387)", () => {
	const HEAD = "abc123abc123abc123abc123abc123abc123abcd";
	const dirs: string[] = [];
	// A temp "main tree": the ship enqueues via `enqueueReviewRequest(main, …)` (→ main/.dev/review-requests),
	// and the drain reads `reviewRequestsDir(main)` — the same split the pipeline uses in production.
	function mainDir(): string {
		const d = mkdtempSync(join(tmpdir(), "review-queue-387-"));
		dirs.push(d);
		return d;
	}
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	const pending = (main: string): string[] => {
		try {
			return readdirSync(reviewRequestsDir(main)).filter((n) => n.endsWith(".json"));
		} catch {
			return [];
		}
	};
	const passGate = async () => ({ gate: "pass" as const, body: "<!-- pelaggio-pr-review -->\nclean\n\nVerdict: PASS", cost: 0.2, costEstimated: false, turns: 3, ok: true, subtype: "success", agreement: "consensus-pass" as const });
	type GateResult = {
		gate: "pass" | "block" | "park";
		body: string;
		cost: number;
		costEstimated: boolean;
		turns: number;
		ok: boolean;
		subtype: string;
		agreement?: "consensus-pass" | "consensus-block" | "disagreement" | "invalid";
		park?: { resetsAt: number; limitType: string };
	};
	type GateFn = (opts: { parkSignal?: { parked: boolean; resetsAt: number; limitType: string } }) => Promise<GateResult>;

	function reviewDeps(over: { gh: GhRunner; main: string; runReviewGate?: GateFn; writeGateRecord?: typeof writePrReviewGateRecord }) {
		return {
			runner: "local" as const,
			ghRepo: "o/r",
			gh: over.gh,
			queueRoot: reviewRequestsDir(over.main),
			gateRecordsRoot: gateRecordsDir(over.main),
			statuslessAfter: "2h",
			now: () => Date.parse("2026-08-03T12:05:00Z"),
			prepareReviewHead: () => ({ diffCwd: "/tmp/pr-head", baseRef: "origin/main", headRef: "refs/pelaggio-review/pr-201" }),
			cleanupReviewHead: () => {},
			runReviewGate: over.runReviewGate ?? passGate,
			writeGateRecord: over.writeGateRecord ?? writePrReviewGateRecord,
		};
	}

	function record(over: Partial<NewReviewRequest> = {}): NewReviewRequest {
		return { prNumber: 201, headSha: HEAD, itemId: "387", headBranch: "feat/issue-387", enqueuedAt: "2026-08-03T12:00:00.000Z", ...over };
	}

	it("post-cycle drain reviews a PR enqueued mid-cycle, then completes the record (the mid-run symptom fix)", async (t) => {
		t.mock.method(console, "log", () => {});
		const main = mainDir();
		const ghCalls: string[][] = [];
		const gh: GhRunner = (args) => {
			ghCalls.push(args);
			if (args[0] === "pr" && args[1] === "list") return { stdout: "[]", stderr: "", status: 0 }; // no live candidates — the record is the only work
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1] === `repos/o/r/commits/${HEAD}/status`) return { stdout: JSON.stringify({ statuses: [] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1]?.includes("/comments")) return { stdout: "[]", stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		let gateCalls = 0;
		const { runPipeline } = createMockRunPipeline({
			byItem: { "387": { completed: true, cost: 0.5 } },
			// The ship-tail enqueue lands the record in the main-tree queue as the cycle ships.
			onCall: (opts) => {
				if (opts.itemId === "387") enqueueReviewRequest(main, record());
			},
		});

		await runOrchestrator(
			{ ...baseFlags, item: "387", target: "pull-request", cycles: "1" },
			{
				runPipeline,
				review: reviewDeps({
					gh,
					main,
					runReviewGate: async () => {
						gateCalls++;
						return passGate();
					},
				}),
			},
		);

		assert.equal(gateCalls, 1, "the enqueued PR is reviewed once by the post-cycle drain");
		const statuses = ghCalls.filter((a) => a[0] === "api" && a[1] === `repos/o/r/statuses/${HEAD}`).map((a) => a.find((x) => x.startsWith("state=")));
		assert.deepEqual(statuses, ["state=pending", "state=success"]);
		assert.deepEqual(pending(main), [], "record completed (deleted) after the terminal status");
		assert.deepEqual(readPrReviewGateRecord(gateRecordsDir(main), 201, HEAD), {
			schemaVersion: 1,
			prNumber: 201,
			headSha: HEAD,
			itemId: "387",
			gate: "pass",
			ok: true,
			subtype: "success",
			agreement: "consensus-pass",
			cost: 0.2,
			costEstimated: false,
			turns: 3,
			runner: "local",
			reviewedAt: "2026-08-03T12:05:00.000Z",
		});
	});

	it("persists block and crash outcomes fail-closed", async (t) => {
		t.mock.method(console, "log", () => {});
		const gh: GhRunner = (args) => {
			if (args[0] === "pr" && args[1] === "list") return { stdout: "[]", stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1]?.includes("/commits/") && args[1]?.endsWith("/status")) return { stdout: JSON.stringify({ statuses: [] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1]?.includes("/comments")) return { stdout: "[]", stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};

		for (const [subtype, runReviewGate, expected] of [
			[
				"findings",
				async () => ({ gate: "block" as const, body: "blocked", cost: 0.4, costEstimated: true, turns: 5, ok: false, subtype: "findings", agreement: "consensus-block" as const }),
				{ gate: "block", subtype: "findings", agreement: "consensus-block", cost: 0.4, turns: 5 },
			],
			["error_crash", async () => Promise.reject(new Error("boom")), { gate: "block", subtype: "error_crash", agreement: "invalid", cost: 0, turns: 0 }],
		] as const) {
			const main = mainDir();
			enqueueReviewRequest(main, record());
			const { runPipeline } = createMockRunPipeline({ default: { completed: false, cost: 0, error: "pick:queue-empty" } });
			await runOrchestrator({ ...baseFlags, target: "pull-request", cycles: "1" }, { runPipeline, resolveWorktree: () => "/fake/wt", review: reviewDeps({ gh, main, runReviewGate }) });
			const stored = readPrReviewGateRecord(gateRecordsDir(main), 201, HEAD);
			assert.ok(stored, `${subtype} record exists`);
			assert.deepEqual({ gate: stored.gate, subtype: stored.subtype, agreement: stored.agreement, cost: stored.cost, turns: stored.turns }, expected);
		}
	});

	it("retains and unclaims the request without posting terminal status when record persistence fails", async (t) => {
		t.mock.method(console, "log", () => {});
		t.mock.method(console, "warn", () => {});
		const main = mainDir();
		enqueueReviewRequest(main, record());
		const ghCalls: string[][] = [];
		const gh: GhRunner = (args) => {
			ghCalls.push(args);
			if (args[0] === "pr" && args[1] === "list") return { stdout: "[]", stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1] === `repos/o/r/commits/${HEAD}/status`) return { stdout: JSON.stringify({ statuses: [] }), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline } = createMockRunPipeline({ default: { completed: false, cost: 0, error: "pick:queue-empty" } });
		await runOrchestrator(
			{ ...baseFlags, target: "pull-request", cycles: "1" },
			{
				runPipeline,
				resolveWorktree: () => "/fake/wt",
				review: reviewDeps({
					gh,
					main,
					writeGateRecord: () => {
						throw new Error("disk full");
					},
				}),
			},
		);
		const states = ghCalls.filter((args) => args[0] === "api" && args[1] === `repos/o/r/statuses/${HEAD}`).map((args) => args.find((arg) => arg.startsWith("state=")));
		assert.ok(states.length > 0);
		assert.ok(
			states.every((state) => state === "state=pending"),
			"no terminal status is posted on any retry",
		);
		assert.deepEqual(pending(main), [`201-${HEAD}.json`]);
	});

	it("keeps the persisted outcome and request when terminal status delivery fails", async (t) => {
		t.mock.method(console, "log", () => {});
		const main = mainDir();
		enqueueReviewRequest(main, record());
		const gh: GhRunner = (args) => {
			if (args[0] === "pr" && args[1] === "list") return { stdout: "[]", stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1] === `repos/o/r/commits/${HEAD}/status`) return { stdout: JSON.stringify({ statuses: [] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1] === `repos/o/r/statuses/${HEAD}`) {
				return { stdout: "", stderr: "delivery failed", status: args.some((arg) => arg === "state=pending") ? 0 : 1 };
			}
			if (args[0] === "api" && args[1]?.includes("/comments")) return { stdout: "[]", stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline } = createMockRunPipeline({ default: { completed: false, cost: 0, error: "pick:queue-empty" } });
		await runOrchestrator({ ...baseFlags, target: "pull-request", cycles: "1" }, { runPipeline, resolveWorktree: () => "/fake/wt", review: reviewDeps({ gh, main }) });
		assert.equal(readPrReviewGateRecord(gateRecordsDir(main), 201, HEAD)?.gate, "pass");
		assert.deepEqual(pending(main), [`201-${HEAD}.json`]);
	});

	it("a lock loser re-lists after the holder releases and drains a record enqueued after the holder listed", async (t) => {
		t.mock.method(console, "log", () => {});
		const main = mainDir();
		const secondHead = "def456def456def456def456def456def456defa";
		const gh: GhRunner = (args) => {
			if (args[0] === "pr" && args[1] === "list") return { stdout: "[]", stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1]?.includes("/commits/") && args[1]?.endsWith("/status")) return { stdout: JSON.stringify({ statuses: [] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1]?.includes("/comments")) return { stdout: "[]", stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		let releaseFirstGate!: () => void;
		const firstGateReleased = new Promise<void>((resolve) => {
			releaseFirstGate = resolve;
		});
		let signalFirstGate!: () => void;
		const firstGateStarted = new Promise<void>((resolve) => {
			signalFirstGate = resolve;
		});
		let gateCalls = 0;
		const runReviewGate = async () => {
			gateCalls++;
			if (gateCalls === 1) {
				signalFirstGate();
				await firstGateReleased;
			}
			return passGate();
		};
		const firstPipeline = createMockRunPipeline({
			byItem: { "387": { completed: true, cost: 0.5 } },
			onCall: () => enqueueReviewRequest(main, record()),
		}).runPipeline;
		let signalSecondEnqueue!: () => void;
		const secondEnqueued = new Promise<void>((resolve) => {
			signalSecondEnqueue = resolve;
		});
		const secondPipeline = createMockRunPipeline({
			byItem: { "388": { completed: true, cost: 0.5 } },
			onCall: () => {
				enqueueReviewRequest(main, record({ prNumber: 202, headSha: secondHead, itemId: "388", headBranch: "feat/issue-388", enqueuedAt: "2026-08-03T12:01:00.000Z" }));
				signalSecondEnqueue();
			},
		}).runPipeline;

		const first = runOrchestrator({ ...baseFlags, item: "387", target: "pull-request", cycles: "1" }, { runPipeline: firstPipeline, review: reviewDeps({ gh, main, runReviewGate }) });
		await firstGateStarted; // holder has already listed and is processing its snapshot
		const second = runOrchestrator({ ...baseFlags, item: "388", target: "pull-request", cycles: "1" }, { runPipeline: secondPipeline, review: reviewDeps({ gh, main, runReviewGate }) });
		await secondEnqueued;
		releaseFirstGate();
		await Promise.all([first, second]);

		assert.equal(gateCalls, 2, "the lock loser performs a fresh drain after the holder releases");
		assert.deepEqual(pending(main), [], "the late record is drained in the same cycle");
	});

	it("completes an already-terminal record without re-running the agent (crash-after-post idempotency)", async (t) => {
		t.mock.method(console, "log", () => {});
		const main = mainDir();
		enqueueReviewRequest(main, record());
		let gateCalls = 0;
		const ghCalls: string[][] = [];
		const gh: GhRunner = (args) => {
			ghCalls.push(args);
			if (args[0] === "pr" && args[1] === "list") return { stdout: "[]", stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			// The forge already has a terminal `review` status for this exact SHA (posted before a crash).
			if (args[0] === "api" && args[1] === `repos/o/r/commits/${HEAD}/status`) return { stdout: JSON.stringify({ statuses: [{ context: "review", state: "success" }] }), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline } = createMockRunPipeline({ default: { completed: false, cost: 0, error: "pick:queue-empty" } });

		await runOrchestrator(
			{ ...baseFlags, target: "pull-request", cycles: "1" },
			{
				runPipeline,
				resolveWorktree: () => "/fake/wt",
				review: reviewDeps({
					gh,
					main,
					runReviewGate: async () => {
						gateCalls++;
						return passGate();
					},
				}),
			},
		);

		assert.equal(gateCalls, 0, "a positively-terminal SHA is not re-reviewed");
		assert.ok(!ghCalls.some((a) => a[0] === "api" && a[1] === `repos/o/r/statuses/${HEAD}`), "no status re-posted");
		assert.deepEqual(pending(main), [], "the orphaned record is deleted without a second gate call");
	});

	it("a rate-limit park leaves the status pending and hands the record back for the next drain", async (t) => {
		t.mock.method(console, "log", () => {});
		const main = mainDir();
		enqueueReviewRequest(main, record());
		let gateCalls = 0;
		const ghCalls: string[][] = [];
		const gh: GhRunner = (args) => {
			ghCalls.push(args);
			if (args[0] === "pr" && args[1] === "list") return { stdout: "[]", stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1] === `repos/o/r/commits/${HEAD}/status`) return { stdout: JSON.stringify({ statuses: [] }), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: false, cost: 0, error: "pick:queue-empty" } });

		await runOrchestrator(
			{ ...baseFlags, target: "pull-request", cycles: "1" },
			{
				runPipeline,
				resolveWorktree: () => "/fake/wt",
				park: { autoResume: false }, // hand back immediately
				review: reviewDeps({
					gh,
					main,
					runReviewGate: async (opts) => {
						gateCalls++;
						if (opts.parkSignal) {
							opts.parkSignal.parked = true;
							opts.parkSignal.resetsAt = 0;
							opts.parkSignal.limitType = "5h";
						}
						return { gate: "park" as const, body: "should-not-post", cost: 0.1, costEstimated: false, turns: 0, ok: false, subtype: "error_rate_limit", park: { resetsAt: 0, limitType: "5h" } };
					},
				}),
			},
		);

		assert.equal(gateCalls, 1);
		const statuses = ghCalls.filter((a) => a[0] === "api" && a[1] === `repos/o/r/statuses/${HEAD}`).map((a) => a.find((x) => x.startsWith("state=")));
		assert.deepEqual(statuses, ["state=pending"], "only pending — never a failure on a park");
		assert.ok(!ghCalls.some((a) => a.some((x) => x.startsWith("body="))), "no findings comment upserted on a park");
		assert.deepEqual(pending(main), [`201-${HEAD}.json`], "record handed back to pending for the next drain");
		assert.equal(readPrReviewGateRecord(gateRecordsDir(main), 201, HEAD), null, "transient parks are not persisted");
		assert.equal(calls.length, 0, "the pick pool is skipped while parked");
	});

	it("resume: a drain park exits 1 even when the resumed cycle completed", async (t) => {
		t.mock.method(console, "log", () => {});
		const main = mainDir();
		enqueueReviewRequest(main, record());
		const gh: GhRunner = (args) => {
			if (args[0] === "pr" && args[1] === "list") return { stdout: "[]", stderr: "", status: 0 };
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1] === `repos/o/r/commits/${HEAD}/status`) return { stdout: JSON.stringify({ statuses: [] }), stderr: "", status: 0 };
			return { stdout: "", stderr: "", status: 0 };
		};
		const { runPipeline } = createMockRunPipeline({ byItem: { "TOOL-99": { completed: true, cost: 1 } } });

		const { exitCode } = await runOrchestrator(
			{ ...baseFlags, resume: "tool-99", target: "pull-request" },
			{
				runPipeline,
				detectResumeStep: () => "implement" as const,
				resolveWorktree: () => "/fake/wt",
				park: { autoResume: false },
				review: reviewDeps({
					gh,
					main,
					runReviewGate: async (opts) => {
						if (opts.parkSignal) {
							opts.parkSignal.parked = true;
							opts.parkSignal.resetsAt = 0;
							opts.parkSignal.limitType = "5h";
						}
						return { gate: "park" as const, body: "parked", cost: 0.1, costEstimated: false, turns: 0, ok: false, subtype: "error_rate_limit", park: { resetsAt: 0, limitType: "5h" } };
					},
				}),
			},
		);

		assert.equal(exitCode, 1, "a parked post-resume drain must not report delivery-complete");
	});

	it("an --item run drains review (candidate) but excludes revise (the DECISION fork)", async (t) => {
		t.mock.method(console, "log", () => {});
		const main = mainDir();
		let reviewState = "";
		let editCalls = 0;
		const gh: GhRunner = (args) => {
			if (args[0] === "pr" && args[1] === "list") {
				return {
					stdout: JSON.stringify([
						// PR 201 statusless → review reviews it; PR 202 red + unlabeled → revisable, but excluded under --item.
						{
							number: 201,
							isDraft: false,
							headRefName: "feat/issue-201-x",
							headRefOid: HEAD,
							headRepository: { nameWithOwner: "o/r" },
							updatedAt: "2026-08-03T12:00:00Z",
							statusCheckRollup: reviewState ? [{ __typename: "StatusContext", context: "review", state: reviewState }] : [],
						},
						{ number: 202, isDraft: false, headRefName: "feat/issue-202-y", labels: [], statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: "FAILURE" }] },
					]),
					stderr: "",
					status: 0,
				};
			}
			if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ labels: [{ name: "autopilot" }] }), stderr: "", status: 0 };
			if (args[0] === "api" && args[1] === `repos/o/r/statuses/${HEAD}`) {
				const posted = args.find((a) => a.startsWith("state="))?.slice("state=".length);
				if (posted === "success" || posted === "failure") reviewState = posted.toUpperCase();
				return { stdout: "", stderr: "", status: 0 };
			}
			if (args[0] === "api" && args[1]?.includes("/comments")) return { stdout: "[]", stderr: "", status: 0 };
			if (args[0] === "pr" && args[1] === "edit") editCalls++;
			return { stdout: "", stderr: "", status: 0 };
		};
		let gateCalls = 0;
		const { runPipeline, calls } = createMockRunPipeline({ byItem: { "387": { completed: true, cost: 0.5 } } });

		await runOrchestrator(
			{ ...baseFlags, item: "387", target: "pull-request", cycles: "1" },
			{
				runPipeline,
				review: reviewDeps({
					gh,
					main,
					runReviewGate: async () => {
						gateCalls++;
						return passGate();
					},
				}),
				revise: { local: true, ghRepo: "o/r", gh },
			},
		);

		assert.equal(gateCalls, 1, "review drains the statusless PR under --item");
		assert.equal(editCalls, 0, "revise never claims (pr edit) under --item — the exclusion is preserved");
		assert.deepEqual(
			calls.map((c) => c.opts.itemId),
			["387"],
			"only the --item cycle ran; no revise cycle",
		);
	});
});
