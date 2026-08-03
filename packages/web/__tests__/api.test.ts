import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ApiError, buildStartBody, getRepoConfig, getRoadmap, getRun, getStats, listRepos, listRuns, pauseRun, startRun, stopRun } from "../src/lib/api.js";
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
		const calls = installFetch(() => jsonResponse({ id: "1", repo: "main", item: "TOOL-1", startedAt: "x", logPath: "/x" }));
		await startRun({ repo: "main", item: "TOOL-1", parallel: 2 });
		assert.equal(calls[0]?.url, "/runs");
		assert.equal(calls[0]?.init?.method, "POST");
		const headers = new Headers(calls[0]?.init?.headers);
		assert.equal(headers.get("content-type"), "application/json");
		assert.equal(calls[0]?.init?.body, JSON.stringify({ repo: "main", item: "TOOL-1", parallel: 2 }));
	});

	it("getRepoConfig hits GET /repos/:slug/config", async () => {
		const calls = installFetch(() => jsonResponse({ watchDailyBudget: 25 }));
		const res = await getRepoConfig("main");
		assert.deepEqual(res, { watchDailyBudget: 25 });
		assert.equal(calls[0]?.url, "/repos/main/config");
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

	it("listRepos hits GET /repos and returns parsed body", async () => {
		const calls = installFetch(() => jsonResponse({ repos: [] }));
		const res = await listRepos();
		assert.deepEqual(res, { repos: [] });
		assert.equal(calls[0]?.url, "/repos");
	});

	it("listRuns hits /runs?repo=<slug> when repo passed", async () => {
		const calls = installFetch(() => jsonResponse({ runs: [] }));
		await listRuns({ repo: "main" });
		assert.equal(calls[0]?.url, "/runs?repo=main");
	});

	it("getRoadmap hits per-repo path with encoded slug", async () => {
		const calls = installFetch(() => jsonResponse({ source: "markdown", items: [] }));
		const r = await getRoadmap("foo");
		assert.equal(calls[0]?.url, "/repos/foo/roadmap");
		assert.equal(r.source, "markdown");
	});

	it("getRoadmap encodes slug segment", async () => {
		const calls = installFetch(() => jsonResponse({ source: "markdown", items: [] }));
		await getRoadmap("ns/with-slash");
		assert.equal(calls[0]?.url, "/repos/ns%2Fwith-slash/roadmap");
	});

	it("getStats hits per-repo path", async () => {
		const calls = installFetch(() => jsonResponse({ totalCycles: 0 }));
		const s = await getStats("foo");
		assert.equal(calls[0]?.url, "/repos/foo/stats");
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
			() => startRun({ repo: "main", item: "" }),
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

describe("buildStartBody", () => {
	const base = {
		repo: "main",
		mode: "off" as const,
		item: "TOOL-1",
		parallel: "",
		cycles: "",
		shipTarget: "",
		watchDailyBudget: "",
		verbose: false,
	};

	it("Drain ×1 preset", () => {
		assert.deepEqual(buildStartBody({ ...base, mode: "drain", parallel: "1", item: "" }), {
			repo: "main",
			mode: "drain",
			parallel: 1,
		});
	});

	it("Drain ×2 preset", () => {
		assert.deepEqual(buildStartBody({ ...base, mode: "drain", parallel: "2", item: "" }), {
			repo: "main",
			mode: "drain",
			parallel: 2,
		});
	});

	it("Watch ×2 omits budget when empty", () => {
		assert.deepEqual(buildStartBody({ ...base, mode: "watch", parallel: "2", item: "", watchDailyBudget: "" }), {
			repo: "main",
			mode: "watch",
			parallel: 2,
		});
	});

	it("Watch with advanced budget includes watchDailyBudget", () => {
		assert.deepEqual(buildStartBody({ ...base, mode: "watch", parallel: "2", watchDailyBudget: "25" }), {
			repo: "main",
			mode: "watch",
			parallel: 2,
			watchDailyBudget: 25,
		});
	});

	it("ordinary item run requires item; omits mode and verbose:false", () => {
		assert.deepEqual(buildStartBody({ ...base, mode: "off", item: "TOOL-1", verbose: false }), {
			repo: "main",
			item: "TOOL-1",
		});
	});

	it("verbose true is included; false is omitted", () => {
		assert.equal(buildStartBody({ ...base, verbose: true }).verbose, true);
		assert.equal(buildStartBody({ ...base, verbose: false }).verbose, undefined);
	});

	it("budget omitted when mode is not watch", () => {
		const body = buildStartBody({ ...base, mode: "drain", watchDailyBudget: "10" });
		assert.equal(body.watchDailyBudget, undefined);
	});
});
