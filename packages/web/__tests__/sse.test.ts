import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { subscribeSse } from "../src/lib/sse.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
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
