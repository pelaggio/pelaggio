import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { subscribeSse } from "../src/lib/sse.js";
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

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

beforeEach(() => {
	__setStorageForTests(new FakeStorage());
});

function streamResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const c of chunks) {
				controller.enqueue(encoder.encode(c));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function installFetch(make: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
	(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		return make(url, init);
	}) as typeof fetch;
}

describe("subscribeSse", () => {
	it("parses single events from one chunk", async () => {
		installFetch(() => streamResponse(["data: hello\n\ndata: world\n\n"]));
		const lines: string[] = [];
		await subscribeSse("/log", { onLine: (l) => lines.push(l) });
		assert.deepEqual(lines, ["hello", "world"]);
	});

	it("handles split across chunk boundaries", async () => {
		installFetch(() => streamResponse(["data: hel", "lo\n", "\ndata: wor", "ld\n\n"]));
		const lines: string[] = [];
		await subscribeSse("/log", { onLine: (l) => lines.push(l) });
		assert.deepEqual(lines, ["hello", "world"]);
	});

	it("emits exitCode from event:end", async () => {
		installFetch(() => streamResponse(['data: a\n\nevent: end\ndata: {"exitCode":7}\n\n']));
		const lines: string[] = [];
		let exit: number | undefined;
		await subscribeSse("/log", {
			onLine: (l) => lines.push(l),
			onEnd: (c) => {
				exit = c;
			},
		});
		assert.deepEqual(lines, ["a"]);
		assert.equal(exit, 7);
	});

	it("non-2xx surfaces an error and ends with undefined exitCode", async () => {
		installFetch(() => new Response("nope", { status: 500 }));
		let err: unknown;
		let ended = false;
		let exit: number | undefined = -1;
		await subscribeSse("/log", {
			onLine: () => {},
			onError: (e) => {
				err = e;
			},
			onEnd: (c) => {
				ended = true;
				exit = c;
			},
		});
		assert.ok(err);
		assert.equal(ended, true);
		assert.equal(exit, undefined);
	});

	it("injects Authorization: Bearer <token> when stored", async () => {
		setToken("sse-tok");
		let seenAuth: string | null = null;
		installFetch((_url, init) => {
			seenAuth = new Headers(init?.headers).get("authorization");
			return streamResponse(["data: hi\n\n"]);
		});
		await subscribeSse("/log", { onLine: () => {} });
		assert.equal(seenAuth, "Bearer sse-tok");
	});

	it("retries once on 401: prompt resolves, second fetch streams normally", async () => {
		let attempt = 0;
		const auths: (string | null)[] = [];
		installFetch((_url, init) => {
			attempt++;
			auths.push(new Headers(init?.headers).get("authorization"));
			if (attempt === 1) return new Response("", { status: 401 });
			return streamResponse(["data: ok\n\n"]);
		});
		registerPromptHandler(() => {
			setTimeout(() => setToken("good-tok"), 0);
		});
		const lines: string[] = [];
		await subscribeSse("/log", { onLine: (l) => lines.push(l) });
		assert.equal(attempt, 2);
		assert.deepEqual(lines, ["ok"]);
		assert.equal(auths[1], "Bearer good-tok");
	});

	it("two consecutive 401s surface as error", async () => {
		installFetch(() => new Response("", { status: 401 }));
		registerPromptHandler(() => {
			setTimeout(() => setToken("still-bad"), 0);
		});
		let err: unknown;
		await subscribeSse("/log", {
			onLine: () => {},
			onError: (e) => {
				err = e;
			},
		});
		assert.ok(err);
	});

	it("aborted via signal completes cleanly without surfacing as error", async () => {
		const ctrl = new AbortController();
		installFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const err = new Error("aborted") as Error & { name: string };
						err.name = "AbortError";
						reject(err);
					});
				}),
		);
		let errSeen = false;
		const p = subscribeSse("/log", {
			signal: ctrl.signal,
			onLine: () => {},
			onError: () => {
				errSeen = true;
			},
		});
		ctrl.abort();
		await p;
		assert.equal(errSeen, false);
	});
});
