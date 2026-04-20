import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApiError, getRoadmap, getRun, getStats, listRuns, pauseRun, startRun, stopRun } from "../src/lib/api.js";
import { __setStorageForTests, registerPromptHandler, setToken } from "../src/lib/token.js";

class FakeStorage {
	private map = new Map<string, string>();
	getItem(key: string): string | null {
		return this.map.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
	removeItem(key: string): void {
		this.map.delete(key);
	}
}

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

beforeEach(() => {
	__setStorageForTests(new FakeStorage());
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

	it("injects Authorization: Bearer <token> when a token is stored", async () => {
		setToken("secret-abc");
		const calls = installFetch(() => jsonResponse({ runs: [] }));
		await listRuns();
		const headers = new Headers(calls[0]?.init?.headers);
		assert.equal(headers.get("authorization"), "Bearer secret-abc");
	});

	it("omits Authorization when no token is stored", async () => {
		const calls = installFetch(() => jsonResponse({ runs: [] }));
		await listRuns();
		const headers = new Headers(calls[0]?.init?.headers);
		assert.equal(headers.get("authorization"), null);
	});

	it("on 401, awaits promptForToken() and retries once with the new token", async () => {
		let attempt = 0;
		const calls = installFetch(() => {
			attempt++;
			if (attempt === 1) return new Response("", { status: 401 });
			return jsonResponse({ runs: [] });
		});
		registerPromptHandler(() => {
			setTimeout(() => setToken("fresh-tok"), 0);
		});
		await listRuns();
		assert.equal(calls.length, 2);
		const retryHeaders = new Headers(calls[1]?.init?.headers);
		assert.equal(retryHeaders.get("authorization"), "Bearer fresh-tok");
	});

	it("two consecutive 401s throw ApiError(401)", async () => {
		installFetch(() => new Response(JSON.stringify({ error: "unauthorized", code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }));
		registerPromptHandler(() => {
			setTimeout(() => setToken("still-bad"), 0);
		});
		await assert.rejects(
			() => listRuns(),
			(err: unknown) => err instanceof ApiError && err.status === 401,
		);
	});
});
