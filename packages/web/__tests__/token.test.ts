import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { __setStorageForTests, clearToken, getToken, markTokenRejected, promptForToken, registerPromptHandler, STORAGE_KEY, setToken, wasLastRejected } from "../src/lib/token.js";

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

describe("token module", () => {
	let storage: FakeStorage;
	beforeEach(() => {
		storage = new FakeStorage();
		__setStorageForTests(storage);
	});

	it("getToken returns null when storage empty", () => {
		assert.equal(getToken(), null);
	});

	it("setToken persists and getToken reads it back", () => {
		setToken("abc");
		assert.equal(getToken(), "abc");
		assert.equal(storage.getItem(STORAGE_KEY), "abc");
	});

	it("getToken reads an existing stored value lazily", () => {
		storage.setItem(STORAGE_KEY, "preexisting");
		assert.equal(getToken(), "preexisting");
	});

	it("clearToken removes from storage and cache", () => {
		setToken("abc");
		clearToken();
		assert.equal(getToken(), null);
		assert.equal(storage.getItem(STORAGE_KEY), null);
	});

	it("promptForToken is single-flight: concurrent callers share one promise and resolve together", async () => {
		const handler = () => {};
		registerPromptHandler(handler);
		const p1 = promptForToken();
		const p2 = promptForToken();
		assert.equal(p1, p2);
		setToken("tok");
		const [a, b] = await Promise.all([p1, p2]);
		assert.equal(a, "tok");
		assert.equal(b, "tok");
	});

	it("registered handler is called when prompt opens", () => {
		let called = 0;
		registerPromptHandler(() => {
			called++;
		});
		void promptForToken();
		assert.equal(called, 1);
	});

	it("handler registered AFTER prompt fires immediately if a prompt is pending", async () => {
		const p = promptForToken();
		let called = 0;
		registerPromptHandler(() => {
			called++;
		});
		assert.equal(called, 1);
		setToken("late");
		assert.equal(await p, "late");
	});

	it("markTokenRejected flags state and clears storage", () => {
		setToken("bad");
		markTokenRejected();
		assert.equal(wasLastRejected(), true);
		assert.equal(getToken(), null);
	});

	it("setToken clears the rejected flag", () => {
		markTokenRejected();
		assert.equal(wasLastRejected(), true);
		setToken("good");
		assert.equal(wasLastRejected(), false);
	});

	it("after rejection, a fresh prompt can be reopened and resolved", async () => {
		markTokenRejected();
		const p = promptForToken();
		setToken("retry");
		assert.equal(await p, "retry");
	});
});
