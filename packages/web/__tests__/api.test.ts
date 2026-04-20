import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApiError, getRoadmap, getRun, getStats, listRuns, pauseRun, startRun, stopRun } from "../src/lib/api.js";

interface Call {
	url: string;
	init: RequestInit | undefined;
}

function installFetch(fn: (req: Call) => Response | Promise<Response>): Call[] {
	const calls: Call[] = [];
	(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const call = { url, init };
		calls.push(call);
		return fn(call);
	}) as typeof fetch;
	return calls;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

describe("api client", () => {
	it("listRuns hits GET /runs and returns parsed body", async () => {
		const calls = installFetch(() => jsonResponse({ runs: [] }));
		const res = await listRuns();
		assert.deepEqual(res, { runs: [] });
		assert.equal(calls[0]?.url, "/runs");
	});

	it("getRun encodes id segment", async () => {
		const calls = installFetch(() => jsonResponse({ id: "01H#XYZ" }));
		await getRun("01H#XYZ");
		assert.equal(calls[0]?.url, "/runs/01H%23XYZ");
	});

	it("startRun sends JSON body and POST", async () => {
		const calls = installFetch(() => jsonResponse({ id: "1", item: "TOOL-1", startedAt: "x", logPath: "/x" }));
		await startRun({ item: "TOOL-1", parallel: 2 });
		assert.equal(calls[0]?.url, "/runs");
		assert.equal(calls[0]?.init?.method, "POST");
		const headers = new Headers(calls[0]?.init?.headers);
		assert.equal(headers.get("content-type"), "application/json");
		assert.equal(calls[0]?.init?.body, JSON.stringify({ item: "TOOL-1", parallel: 2 }));
	});

	it("pauseRun POSTs to /runs/:id/pause", async () => {
		const calls = installFetch(() => jsonResponse({ id: "1", status: "paused" }));
		await pauseRun("1");
		assert.equal(calls[0]?.url, "/runs/1/pause");
		assert.equal(calls[0]?.init?.method, "POST");
	});

	it("stopRun POSTs to /runs/:id/stop", async () => {
		const calls = installFetch(() => jsonResponse({ id: "1", status: "abandoned" }));
		await stopRun("1");
		assert.equal(calls[0]?.url, "/runs/1/stop");
		assert.equal(calls[0]?.init?.method, "POST");
	});

	it("getRoadmap and getStats hit unprefixed paths", async () => {
		installFetch((req) => {
			if (req.url === "/roadmap") return jsonResponse({ source: "markdown", items: [] });
			if (req.url === "/stats") return jsonResponse({ totalCycles: 0 });
			return new Response("nope", { status: 404 });
		});
		const r = await getRoadmap();
		assert.equal(r.source, "markdown");
		const s = await getStats();
		assert.equal((s as { totalCycles: number }).totalCycles, 0);
	});

	it("non-2xx with JSON body throws ApiError carrying code+message", async () => {
		installFetch(
			() =>
				new Response(JSON.stringify({ error: "bad item", code: "bad-request" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);
		await assert.rejects(
			() => startRun({ item: "" }),
			(err: unknown) => err instanceof ApiError && err.status === 400 && err.code === "bad-request" && err.message === "bad item",
		);
	});

	it("non-2xx with non-JSON body still throws ApiError", async () => {
		installFetch(() => new Response("oops", { status: 500 }));
		await assert.rejects(
			() => listRuns(),
			(err: unknown) => err instanceof ApiError && err.status === 500,
		);
	});
});
