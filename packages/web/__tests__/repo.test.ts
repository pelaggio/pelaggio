import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { RepoEntry } from "@cdhorne/claude-autopilot-server/types";
import { __setFetcherForTests, __setStorageForTests, getSnapshot, init, retryInit, STORAGE_KEY, setCurrentRepo, subscribe } from "../src/lib/repo.js";

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

const a: RepoEntry = { slug: "a", path: "/repos/a", exists: true };
const b: RepoEntry = { slug: "b", path: "/repos/b", exists: true };

describe("repo store", () => {
	let storage: FakeStorage;
	beforeEach(() => {
		storage = new FakeStorage();
		__setStorageForTests(storage);
	});

	it("default selection: empty localStorage → first repo, written to storage", async () => {
		__setFetcherForTests(async () => ({ repos: [a, b] }));
		const s = await init();
		assert.equal(s.status, "ready");
		if (s.status === "ready") assert.equal(s.current, "a");
		assert.equal(storage.getItem(STORAGE_KEY), "a");
	});

	it("default selection: valid stored slug → uses stored, leaves storage alone", async () => {
		storage.setItem(STORAGE_KEY, "b");
		__setFetcherForTests(async () => ({ repos: [a, b] }));
		const s = await init();
		assert.equal(s.status, "ready");
		if (s.status === "ready") assert.equal(s.current, "b");
		assert.equal(storage.getItem(STORAGE_KEY), "b");
	});

	it("default selection: stale stored slug → first repo, storage rewritten", async () => {
		storage.setItem(STORAGE_KEY, "gone");
		__setFetcherForTests(async () => ({ repos: [a, b] }));
		const s = await init();
		assert.equal(s.status, "ready");
		if (s.status === "ready") assert.equal(s.current, "a");
		assert.equal(storage.getItem(STORAGE_KEY), "a");
	});

	it("empty registry → status: empty, storage untouched", async () => {
		storage.setItem(STORAGE_KEY, "anything");
		__setFetcherForTests(async () => ({ repos: [] }));
		const s = await init();
		assert.equal(s.status, "empty");
		assert.equal(storage.getItem(STORAGE_KEY), "anything");
	});

	it("setCurrentRepo persists, advances state, notifies subscribers", async () => {
		__setFetcherForTests(async () => ({ repos: [a, b] }));
		await init();
		let calls = 0;
		const unsubscribe = subscribe(() => {
			calls++;
		});
		setCurrentRepo("b");
		const s = getSnapshot();
		assert.equal(s.status, "ready");
		if (s.status === "ready") assert.equal(s.current, "b");
		assert.equal(storage.getItem(STORAGE_KEY), "b");
		assert.equal(calls, 1);
		unsubscribe();
	});

	it("setCurrentRepo rejects unknown slug; state and storage unchanged", async () => {
		__setFetcherForTests(async () => ({ repos: [a, b] }));
		await init();
		assert.throws(
			() => setCurrentRepo("missing"),
			(err: unknown) => err instanceof Error && err.message.includes("missing"),
		);
		const s = getSnapshot();
		if (s.status === "ready") assert.equal(s.current, "a");
		assert.equal(storage.getItem(STORAGE_KEY), "a");
	});

	it("subscribe returns a working unsubscribe", async () => {
		__setFetcherForTests(async () => ({ repos: [a, b] }));
		await init();
		let calls = 0;
		const unsubscribe = subscribe(() => {
			calls++;
		});
		unsubscribe();
		setCurrentRepo("b");
		assert.equal(calls, 0);
	});

	it("init dedupes concurrent calls (single fetch)", async () => {
		let fetches = 0;
		__setFetcherForTests(async () => {
			fetches++;
			await new Promise((r) => setTimeout(r, 10));
			return { repos: [a, b] };
		});
		const [s1, s2] = await Promise.all([init(), init()]);
		assert.equal(fetches, 1);
		assert.equal(s1, s2);
	});

	it("init surfaces fetch failure as error state and notifies subscribers", async () => {
		__setFetcherForTests(async () => {
			throw new Error("boom");
		});
		let calls = 0;
		const unsubscribe = subscribe(() => {
			calls++;
		});
		const s = await init();
		assert.equal(s.status, "error");
		if (s.status === "error") assert.equal(s.error, "boom");
		assert.equal(calls, 1);
		unsubscribe();
	});

	it("init does not reject when fetcher throws", async () => {
		__setFetcherForTests(async () => {
			throw new Error("nope");
		});
		await assert.doesNotReject(init());
	});

	it("retryInit re-fetches and recovers on success", async () => {
		let attempts = 0;
		__setFetcherForTests(async () => {
			attempts++;
			if (attempts === 1) throw new Error("first failure");
			return { repos: [a, b] };
		});
		const first = await init();
		assert.equal(first.status, "error");
		let calls = 0;
		const unsubscribe = subscribe(() => {
			calls++;
		});
		const recovered = await retryInit();
		assert.equal(recovered.status, "ready");
		if (recovered.status === "ready") assert.equal(recovered.current, "a");
		assert.equal(storage.getItem(STORAGE_KEY), "a");
		assert.equal(attempts, 2);
		assert.equal(calls, 2);
		unsubscribe();
	});

	it("retryInit is a no-op outside error state", async () => {
		let fetches = 0;
		__setFetcherForTests(async () => {
			fetches++;
			return { repos: [a, b] };
		});
		const ready = await init();
		assert.equal(ready.status, "ready");
		const after = await retryInit();
		assert.equal(after, ready);
		assert.equal(fetches, 1);
	});
});
