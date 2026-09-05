import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AuthoringReviewConfig } from "../config.js";
import { runReviewLoop, type SeatRequest } from "../review/loop.js";
import { BASELINE_TAXONOMY } from "../review/taxonomy.js";
import type { ParkSignal, ProviderName, StepResult } from "../types.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const clean = (): StepResult => ({
	ok: true,
	subtype: "success",
	text: "",
	fullText: "",
	assistantText: 'AUTHORING_REVIEW_FINDINGS\n{"schemaVersion":3,"summary":"Reviewed candidate; no findings","findings":[]}\nEND_AUTHORING_REVIEW_FINDINGS',
	cost: 2,
	turns: 1,
});
const judge = (): StepResult => ({ ...clean(), assistantText: 'AUTHORING_REVIEW_JUDGE\n{"schemaVersion":1,"decisions":[]}\nEND_AUTHORING_REVIEW_JUDGE' });
const signal = (): ParkSignal => ({ parked: false, resetsAt: 0, limitType: "", triggerWorker: "" });
function policy(providers: ProviderName[]): AuthoringReviewConfig {
	return {
		enabled: "local",
		blockingBar: "must-fix",
		maxRevisions: 0,
		maxPasses: 1,
		budgetCap: 100,
		providerDiversity: "prefer",
		reviewers: providers.map((provider) => ({ id: provider, provider })),
		judge: { id: "judge", provider: "opencode" },
	};
}
function run(providers: ProviderName[], runSeat: (request: SeatRequest) => Promise<StepResult>, parkSignal = signal()) {
	return runReviewLoop({ mode: "no-revise", policy: policy(providers), parkSignal, classificationContext: { changedFiles: [] }, taxonomy: BASELINE_TAXONOMY, prompts: { review: () => "review", judge: () => "judge" }, runSeat });
}

describe("bounded shared reviewer launch", () => {
	it("overlaps independent providers, preserves order and cost, and settles before Judge", async () => {
		const a = deferred<StepResult>();
		const b = deferred<StepResult>();
		const trace: string[] = [];
		const active = new Map<ProviderName, number>();
		const pending = run(["codex", "grok"], async (request) => {
			trace.push(request.role === "judge" ? "judge" : request.slot.provider);
			if (request.role === "judge") {
				assert.equal(active.size, 0);
				return judge();
			}
			assert.equal(active.has(request.slot.provider), false);
			active.set(request.slot.provider, 1);
			const value = await (request.slot.provider === "codex" ? a.promise : b.promise);
			active.delete(request.slot.provider);
			return value;
		});
		await tick();
		assert.deepEqual(trace, ["codex", "grok"]);
		assert.equal(active.size, 2);
		b.resolve(clean());
		await tick();
		assert.equal(trace.includes("judge"), false);
		a.resolve(clean());
		const result = await pending;
		assert.deepEqual(trace, ["codex", "grok", "judge"]);
		assert.deepEqual(
			result.passes[0]?.reviewers.map((r) => r.identity.provider),
			["codex", "grok"],
		);
		assert.equal(result.cost, 6);
	});

	it("keeps Grok behind Claude even when Grok is configured first", async () => {
		const claude = deferred<StepResult>();
		const trace: string[] = [];
		const pending = run(["grok", "claude", "codex"], async (request) => {
			trace.push(request.role === "judge" ? "judge" : request.slot.provider);
			if (request.role === "judge") return judge();
			return request.slot.provider === "claude" ? claude.promise : clean();
		});
		await tick();
		assert.deepEqual(trace, ["claude", "codex"]);
		claude.resolve(clean());
		const result = await pending;
		assert.deepEqual(trace, ["claude", "codex", "grok", "judge"]);
		assert.deepEqual(
			result.passes[0]?.reviewers.map((r) => r.identity.provider),
			["grok", "claude", "codex"],
		);
	});

	it("observes parking before a slow peer settles, stops pending Grok, and retains started results", async () => {
		const claude = deferred<StepResult>();
		const codex = deferred<StepResult>();
		const parent = signal();
		const trace: string[] = [];
		const pending = run(
			["claude", "grok", "codex"],
			async (request) => {
				trace.push(request.role === "judge" ? "judge" : request.slot.provider);
				if (request.role === "judge") return judge();
				if (request.slot.provider === "claude") {
					const result = await claude.promise;
					Object.assign(request.parkSignal, { parked: true, resetsAt: 12345, limitType: "requests", triggerWorker: "claude" });
					return result;
				}
				return request.slot.provider === "codex" ? codex.promise : clean();
			},
			parent,
		);
		await tick();
		claude.resolve({ ...clean(), ok: false, subtype: "error_rate_limit" });
		await tick();
		assert.equal(parent.parked, true);
		assert.equal(trace.includes("grok"), false);
		assert.equal(trace.includes("judge"), false);
		codex.resolve(clean());
		const result = await pending;
		assert.equal(result.outcome, "budget");
		assert.equal(result.passes[0]?.reviewers[2]?.cost, 2);
		assert.equal(result.passes[0]?.reviewers[1]?.ok, false);
		assert.equal(trace.includes("grok"), false);
	});

	it("retains valid peers and required order after a reviewer rejection", async () => {
		const claude = deferred<StepResult>();
		const codex = deferred<StepResult>();
		const trace: string[] = [];
		const pending = run(["claude", "grok", "codex"], async (request) => {
			trace.push(request.role === "judge" ? "judge" : request.slot.provider);
			if (request.role === "judge") return judge();
			if (request.slot.provider === "claude") return claude.promise;
			return request.slot.provider === "codex" ? codex.promise : clean();
		});
		await tick();
		claude.reject(new Error("provider rejected"));
		await tick();
		assert.deepEqual(trace, ["claude", "codex", "grok"]);
		codex.resolve(clean());
		const result = await pending;
		assert.equal(result.passes[0]?.reviewers[0]?.ok, false);
		assert.deepEqual(
			result.passes[0]?.reviewers.slice(1).map((r) => r.ok),
			[true, true],
		);
		assert.equal(result.cost, 6);
	});

	it("retains duplicate-provider invalid-seat admission before any provider starts", async () => {
		let launches = 0;
		const result = await run(["codex", "codex"], async () => {
			launches++;
			return clean();
		});
		assert.equal(result.outcome, "hard-block");
		assert.equal(launches, 0);
	});

	it("retains a started incomplete seat's must-fix when parking prevents every remaining reviewer", async () => {
		const parent = signal();
		const trace: string[] = [];
		const result = await run(
			["claude", "grok"],
			async (request) => {
				trace.push(request.slot.provider);
				return {
					...clean(),
					ok: false,
					subtype: "error_rate_limit",
					assistantText:
						'AUTHORING_REVIEW_FINDINGS\n{"schemaVersion":3,"summary":"Review interrupted","findings":[{"severity":"must-fix","message":"Confirmed credential leak","ruleId":"pelaggio/security/secret-leak"}]}\nEND_AUTHORING_REVIEW_FINDINGS',
				};
			},
			parent,
		);
		assert.deepEqual(trace, ["claude"]);
		assert.equal(parent.parked, true);
		assert.equal(parent.resetsAt, 0);
		assert.deepEqual(parent.rateLimit, { provider: "claude", window: null });
		assert.equal(result.outcome, "budget");
		assert.equal(result.cost, 2);
		assert.equal(result.survivors.length, 1);
		assert.equal(result.survivors[0]?.finding.message, "Confirmed credential leak");
		assert.deepEqual(
			result.passes[0]?.carriedAfter,
			result.survivors.map((c) => c.fingerprint),
		);
	});

	it("selects one complete park signal in configured order despite reversed completion", async () => {
		for (const reversed of [false, true]) {
			const claude = deferred<StepResult>();
			const codex = deferred<StepResult>();
			const parent = signal();
			const pending = run(
				["claude", "codex"],
				async (request) => {
					if (request.role === "judge") return judge();
					const result = await (request.slot.provider === "claude" ? claude.promise : codex.promise);
					Object.assign(
						request.parkSignal,
						request.slot.provider === "claude"
							? { parked: true, resetsAt: 100, limitType: "rate_limit", triggerWorker: "claude", rateLimit: { provider: "claude", window: "five-hour" } }
							: { parked: true, resetsAt: 200, limitType: "sdk-outage", triggerWorker: "codex" },
					);
					return result;
				},
				parent,
			);
			await tick();
			(reversed ? codex : claude).resolve(clean());
			await tick();
			assert.equal(parent.parked, true);
			(reversed ? claude : codex).resolve(clean());
			await pending;
			assert.deepEqual(parent, { parked: true, resetsAt: 200, limitType: "sdk-outage", triggerWorker: "codex" });
		}
	});

	it("uses the same bounded launcher in authoring revise mode", async () => {
		const claude = deferred<StepResult>();
		const trace: string[] = [];
		const pending = runReviewLoop({
			policy: policy(["grok", "claude"]),
			author: { provider: "codex" },
			parkSignal: signal(),
			classificationContext: { changedFiles: [] },
			taxonomy: BASELINE_TAXONOMY,
			prompts: { review: () => "review", judge: () => "judge", revise: () => "revise" },
			runSeat: async (request) => {
				trace.push(request.role === "judge" ? "judge" : request.slot.provider);
				return request.role === "judge" ? judge() : request.slot.provider === "claude" ? claude.promise : clean();
			},
		});
		await tick();
		assert.deepEqual(trace, ["claude"]);
		claude.resolve(clean());
		const result = await pending;
		assert.deepEqual(trace, ["claude", "grok", "judge"]);
		assert.equal(result.outcome, "converged-clean");
	});

	it("routes authoring and doc-review through the sole bounded reviewer call", () => {
		for (const file of ["steps/shakedown-code.ts", "doc-review-cli.ts", "review/bench.ts"]) {
			const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
			assert.match(source, /runReviewLoop\(/, file);
		}
		const source = readFileSync(new URL("../review/loop.ts", import.meta.url), "utf8");
		assert.equal((source.match(/role: "reviewer", slot/g) ?? []).length, 1);
		assert.match(source, /executeDiscoveryFleet\(/);
		assert.doesNotMatch(source, /Promise\.allSettled/);
	});
});
