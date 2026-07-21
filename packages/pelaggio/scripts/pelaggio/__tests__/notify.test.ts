import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRequest, classifyEvent, formatText, NOTIFY_EVENTS, type NotifyConfig, type NotifyFormat, type NotifyPayload, notifyCycle, notifyDecision, sendNotification } from "../notify.js";
import { type CycleResult, RECOVERABLE_ERRORS } from "../types.js";

function result(overrides: Partial<CycleResult> = {}): CycleResult {
	return { itemId: "34", completed: false, cost: 0, ...overrides };
}

function payload(overrides: Partial<NotifyPayload> = {}): NotifyPayload {
	const base: Omit<NotifyPayload, "text"> = {
		event: "shipped",
		itemId: "34",
		completed: true,
		cost: 1.23,
		shipwrecked: false,
		logPath: "/repo/.dev/pelaggio-log.jsonl",
		ts: "2026-07-06T12:34:56.000Z",
		...overrides,
	};
	return { ...base, text: overrides.text ?? formatText(base) };
}

describe("classifyEvent", () => {
	it("parked wins", () => {
		assert.equal(classifyEvent(result({ error: "parked" })), "parked");
	});

	it("completed + awaitingMerge ⇒ pr-opened", () => {
		assert.equal(classifyEvent(result({ completed: true, awaitingMerge: true })), "pr-opened");
	});

	it("completed (else) ⇒ shipped", () => {
		assert.equal(classifyEvent(result({ completed: true })), "shipped");
	});

	it("completed with bookkeeping warnings ⇒ shipped", () => {
		assert.equal(classifyEvent(result({ completed: true, bookkeepingWarnings: ["mark-done failed"] })), "shipped");
	});

	it("not completed + shipwrecked ⇒ shipwrecked", () => {
		assert.equal(classifyEvent(result({ shipwrecked: true, error: "ship failed (recovery also failed)" })), "shipwrecked");
	});

	it("completed + shipwrecked ⇒ shipped (it landed)", () => {
		assert.equal(classifyEvent(result({ completed: true, shipwrecked: true })), "shipped");
	});

	it("completed + awaitingMerge + shipwrecked ⇒ pr-opened", () => {
		assert.equal(classifyEvent(result({ completed: true, awaitingMerge: true, shipwrecked: true })), "pr-opened");
	});

	it("generic failure ⇒ failed", () => {
		assert.equal(classifyEvent(result({ error: "plan failed" })), "failed");
	});

	it("failure with no error string ⇒ failed", () => {
		assert.equal(classifyEvent(result({})), "failed");
	});

	it("null (skip) for every RECOVERABLE_ERRORS entry", () => {
		for (const err of RECOVERABLE_ERRORS) {
			// `parked` is classified before the skip-set; everything else skips.
			const expected = err === "parked" ? "parked" : null;
			assert.equal(classifyEvent(result({ error: err })), expected, `error=${err}`);
		}
	});

	it("null (skip) for a user-abort", () => {
		assert.equal(classifyEvent(result({ error: "aborted" })), null);
	});

	it("null (skip) for a user-abort even when the cycle routed through shipwreck", () => {
		// Ctrl-C during the shipwreck step: error is relabelled "aborted" AND
		// shipwrecked=true. The skip must outrank shipwrecked — an abort is always
		// attended, and "aborted never pages" is the documented contract.
		assert.equal(classifyEvent(result({ error: "aborted", shipwrecked: true })), null);
	});

	it("fatal pick errors still page (not in the skip-set)", () => {
		assert.equal(classifyEvent(result({ error: "pick blocked: waiting on X" })), "failed");
		assert.equal(classifyEvent(result({ error: "pick:unknown-id" })), "failed");
	});
});

describe("formatText", () => {
	it("includes itemId, title and cost", () => {
		const t = formatText({ event: "shipped", itemId: "34", title: "Run-outcome notifications", completed: true, cost: 1.23, shipwrecked: false, logPath: "/l", ts: "t" });
		assert.match(t, /shipped 34/);
		assert.match(t, /"Run-outcome notifications"/);
		assert.match(t, /\$1\.23/);
	});

	it("appends error for failure events but not for shipped", () => {
		const failed = formatText({ event: "failed", itemId: "34", completed: false, cost: 0.5, error: "plan failed", shipwrecked: false, logPath: "/l", ts: "t" });
		assert.match(failed, /plan failed/);
		const shipped = formatText({ event: "shipped", itemId: "34", completed: true, cost: 0.5, error: "leftover", shipwrecked: false, logPath: "/l", ts: "t" });
		assert.doesNotMatch(shipped, /leftover/);
	});

	it("includes webhook-safe bookkeeping warnings for shipped events", () => {
		const warning = "mark-done failed (EACCES); rerun npx pelaggio roadmap mark-done 34";
		const t = formatText({ event: "shipped", itemId: "34", completed: true, cost: 0.5, bookkeepingWarnings: [warning], shipwrecked: false, logPath: "/l", ts: "t" });
		assert.match(t, /bookkeeping incomplete/);
		assert.match(t, /mark-done failed/);
		assert.ok(!t.includes(`${String.fromCharCode(27)}[`));
	});

	it("appends prUrl when present", () => {
		const t = formatText({ event: "pr-opened", itemId: "34", completed: true, cost: 0.5, prUrl: "https://github.com/x/y/pull/5", shipwrecked: false, logPath: "/l", ts: "t" });
		assert.match(t, /pull\/5/);
	});

	it("suppresses an error that just restates the event (no 'parked · parked')", () => {
		const t = formatText({ event: "parked", itemId: "34", completed: false, cost: 0.12, error: "parked", shipwrecked: false, logPath: "/l", ts: "t" });
		assert.equal(t.match(/parked/g)?.length, 1);
	});

	it("falls back to ? when itemId is null", () => {
		const t = formatText({ event: "failed", itemId: null, completed: false, cost: 0, shipwrecked: false, logPath: "/l", ts: "t" });
		assert.match(t, /failed \?/);
	});

	it("contains no ANSI escape codes (webhook-safe)", () => {
		const t = formatText({ event: "failed", itemId: "34", completed: false, cost: 0.5, error: "plan failed", shipwrecked: false, logPath: "/l", ts: "t" });
		const CSI = `${String.fromCharCode(27)}[`; // ANSI Control Sequence Introducer
		assert.ok(!t.includes(CSI), "summary must be free of ANSI escape sequences");
	});
});

describe("buildRequest — json", () => {
	it("sets application/json and round-trips the payload with text", () => {
		const p = payload();
		const { body, headers } = buildRequest("json", p);
		assert.equal(headers["content-type"], "application/json");
		const parsed = JSON.parse(body);
		assert.equal(parsed.event, "shipped");
		assert.equal(parsed.itemId, "34");
		assert.equal(typeof parsed.text, "string");
		assert.ok(parsed.text.length > 0);
	});
});

describe("buildRequest — ntfy", () => {
	it("sends the text summary as text/plain with Title and Tags", () => {
		const p = payload({ event: "shipped" });
		const { body, headers } = buildRequest("ntfy", p);
		assert.equal(headers["content-type"], "text/plain");
		assert.equal(body, p.text);
		assert.equal(headers.Title, "pelaggio shipped");
		assert.equal(headers.Tags, "white_check_mark");
		assert.equal(headers.Priority, "default");
		assert.ok(!("Click" in headers), "no Click header without prUrl");
	});

	it("uses high Priority for failed and shipwrecked", () => {
		assert.equal(buildRequest("ntfy", payload({ event: "failed", completed: false })).headers.Priority, "high");
		assert.equal(buildRequest("ntfy", payload({ event: "shipwrecked", completed: false })).headers.Priority, "high");
	});

	it("sets Click iff prUrl is present", () => {
		const withPr = buildRequest("ntfy", payload({ event: "pr-opened", prUrl: "https://github.com/x/y/pull/5" }));
		assert.equal(withPr.headers.Click, "https://github.com/x/y/pull/5");
		const withoutPr = buildRequest("ntfy", payload({ event: "parked", completed: false }));
		assert.ok(!("Click" in withoutPr.headers));
	});
});

describe("sendNotification — best-effort transport", () => {
	function capturingFetch(res: { ok: boolean } | Error) {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchFn = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			if (res instanceof Error) throw res;
			return res as Response;
		}) as typeof fetch;
		return { fetchFn, calls };
	}

	it("ok response ⇒ true; posts to url with correct method/body/headers", async () => {
		const { fetchFn, calls } = capturingFetch({ ok: true });
		const p = payload();
		const ok = await sendNotification("https://hook.example/x", "json", p, { fetch: fetchFn });
		assert.equal(ok, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "https://hook.example/x");
		assert.equal(calls[0].init.method, "POST");
		assert.equal(calls[0].init.body, JSON.stringify(p));
		assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
		assert.ok(calls[0].init.signal, "an abort signal is attached");
	});

	it("non-ok response ⇒ false", async () => {
		const { fetchFn } = capturingFetch({ ok: false });
		assert.equal(await sendNotification("https://hook.example/x", "json", payload(), { fetch: fetchFn }), false);
	});

	it("network throw ⇒ false (never throws)", async () => {
		const { fetchFn } = capturingFetch(new Error("ECONNREFUSED"));
		assert.equal(await sendNotification("https://hook.example/x", "json", payload(), { fetch: fetchFn }), false);
	});

	it("AbortError (timeout) ⇒ false", async () => {
		const abort = new DOMException("The operation was aborted", "AbortError");
		const { fetchFn } = capturingFetch(abort);
		assert.equal(await sendNotification("https://hook.example/x", "json", payload(), { fetch: fetchFn }), false);
	});
});

describe("notifyCycle", () => {
	const baseCfg: NotifyConfig = { url: "https://hook.example/x", format: "json", events: [...NOTIFY_EVENTS] };

	function spySend() {
		const sent: Array<{ url: string; format: NotifyFormat; payload: NotifyPayload }> = [];
		const send = async (url: string, format: NotifyFormat, p: NotifyPayload) => {
			sent.push({ url, format, payload: p });
			return true;
		};
		return { send, sent };
	}

	it("skips when url is empty", async () => {
		const { send, sent } = spySend();
		const ev = await notifyCycle({ ...baseCfg, url: "" }, result({ completed: true }), "/l", { send });
		assert.equal(ev, null);
		assert.equal(sent.length, 0);
	});

	it("threads shipped bookkeeping warnings into structured payload and text", async () => {
		const { send, sent } = spySend();
		const warning = "mark-done failed (EACCES); rerun mark-done";
		const ev = await notifyCycle(baseCfg, result({ completed: true, bookkeepingWarnings: [warning] }), "/l", { send });

		assert.equal(ev, "shipped");
		assert.deepEqual(sent[0].payload.bookkeepingWarnings, [warning]);
		assert.match(sent[0].payload.text, /bookkeeping incomplete.*mark-done failed/);
	});

	it("never throws even when the injected send throws (contract holds at the seam)", async () => {
		const send = async () => {
			throw new Error("transport exploded");
		};
		const ev = await notifyCycle(baseCfg, result({ completed: true }), "/l", { send });
		assert.equal(ev, "shipped");
	});

	it("never throws when resolveTitle rejects after losing the race", async () => {
		const { send } = spySend();
		let rejectLate: (e: Error) => void = () => {};
		const resolveTitle = () => new Promise<string | undefined>((_, rej) => (rejectLate = rej));
		const ev = await notifyCycle(baseCfg, result({ completed: true }), "/l", { send, resolveTitle, titleTimeoutMs: 5 });
		assert.equal(ev, "shipped");
		rejectLate(new Error("late tracker failure")); // must be observed, not an unhandled rejection
		await new Promise((r) => setTimeout(r, 5));
	});

	it("skips when the classified event is not subscribed", async () => {
		const { send, sent } = spySend();
		const ev = await notifyCycle({ ...baseCfg, events: ["parked"] }, result({ completed: true }), "/l", { send });
		assert.equal(ev, null);
		assert.equal(sent.length, 0);
	});

	it("skips when the event is null (non-actionable error)", async () => {
		const { send, sent } = spySend();
		const ev = await notifyCycle(baseCfg, result({ error: "aborted" }), "/l", { send });
		assert.equal(ev, null);
		assert.equal(sent.length, 0);
	});

	it("sends once for a subscribed event with a well-formed payload", async () => {
		const { send, sent } = spySend();
		const ev = await notifyCycle(baseCfg, result({ completed: true, cost: 1.23 }), "/repo/.dev/log.jsonl", { send, resolveTitle: async () => "Some title" });
		assert.equal(ev, "shipped");
		assert.equal(sent.length, 1);
		assert.equal(sent[0].url, baseCfg.url);
		assert.equal(sent[0].format, "json");
		assert.equal(sent[0].payload.event, "shipped");
		assert.equal(sent[0].payload.itemId, "34");
		assert.equal(sent[0].payload.title, "Some title");
		assert.equal(sent[0].payload.completed, true);
		assert.equal(sent[0].payload.logPath, "/repo/.dev/log.jsonl");
		assert.ok(sent[0].payload.text.includes("Some title"));
	});

	it("carries shipwrecked:true in the payload even for a happy-path event", async () => {
		const { send, sent } = spySend();
		await notifyCycle(baseCfg, result({ completed: true, shipwrecked: true }), "/l", { send });
		assert.equal(sent[0].payload.event, "shipped");
		assert.equal(sent[0].payload.shipwrecked, true);
	});

	it("tolerates resolveTitle throwing (sends without title)", async () => {
		const { send, sent } = spySend();
		const ev = await notifyCycle(baseCfg, result({ error: "plan failed" }), "/l", {
			send,
			resolveTitle: async () => {
				throw new Error("gh exploded");
			},
		});
		assert.equal(ev, "failed");
		assert.equal(sent.length, 1);
		assert.equal(sent[0].payload.title, undefined);
	});

	it("empty events list sends nothing", async () => {
		const { send, sent } = spySend();
		await notifyCycle({ ...baseCfg, events: [] }, result({ completed: true }), "/l", { send });
		assert.equal(sent.length, 0);
	});
});

describe("notifyDecision", () => {
	const cfg: NotifyConfig = { url: "https://hook.example/x", format: "json", events: ["decision"] };

	it("delivers one structured event and respects event gating", async () => {
		const sent: NotifyPayload[] = [];
		const send = async (_url: string, _format: NotifyFormat, payload: NotifyPayload) => {
			sent.push(payload);
			return true;
		};
		const input = { itemId: "85", decision: { fork: "storage", chosen: "markdown", alternatives: "sqlite" }, step: "implement" as const, source: "85", logPath: "/l" };

		assert.equal(await notifyDecision(cfg, input, { send, now: new Date("2026-07-19T12:00:00Z") }), true);
		assert.deepEqual(sent[0], {
			event: "decision",
			itemId: "85",
			decision: input.decision,
			step: "implement",
			source: "85",
			logPath: "/l",
			ts: "2026-07-19T12:00:00.000Z",
			text: "pelaggio: decision 85 implement — storage",
		});
		assert.equal(await notifyDecision({ ...cfg, events: [] }, input, { send }), false);
		assert.equal(sent.length, 1);
	});

	it("is fail-soft when delivery throws", async () => {
		const send = async () => {
			throw new Error("transport exploded");
		};
		assert.equal(await notifyDecision(cfg, { itemId: null, decision: { fork: "fork" }, step: "plan", source: "unclaimed:r", logPath: "/l" }, { send }), false);
	});
});
