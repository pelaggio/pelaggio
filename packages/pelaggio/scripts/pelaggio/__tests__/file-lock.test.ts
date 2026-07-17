import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withFileLock } from "../file-lock.js";

const OPTS = { label: "test lock", staleMs: 2_000, acquireTimeoutMs: 8_000 };

function seedDir(): string {
	return mkdtempSync(join(tmpdir(), "pelaggio-file-lock-test-"));
}

const lockPath = (dir: string) => resolve(dir, "lock", "test.lock");
const counterPath = (dir: string) => resolve(dir, "counter.txt");

/** Unlocked read-modify-write with a deliberate yield in the window. */
async function bumpCounter(dir: string): Promise<void> {
	const n = Number.parseInt(readFileSync(counterPath(dir), "utf-8"), 10);
	await new Promise((r) => setTimeout(r, 5)); // widen the race window
	writeFileSync(counterPath(dir), String(n + 1));
}

test("serializes concurrent critical sections (in-process)", async () => {
	const dir = seedDir();
	writeFileSync(counterPath(dir), "0");
	await Promise.all(Array.from({ length: 25 }, () => withFileLock(lockPath(dir), () => bumpCounter(dir), OPTS)));
	assert.equal(readFileSync(counterPath(dir), "utf-8"), "25");
	assert.equal(existsSync(lockPath(dir)), false, "lock released after last holder");
});

test("releases on throw — next holder acquires immediately", async () => {
	const dir = seedDir();
	await assert.rejects(
		withFileLock(
			lockPath(dir),
			() => {
				throw new Error("boom");
			},
			OPTS,
		),
		/boom/,
	);
	const start = Date.now();
	await withFileLock(lockPath(dir), () => {}, OPTS);
	assert.ok(Date.now() - start < 1000, "second acquire should not wait on a leaked lock");
});

test("steals a stale lock (holder died without releasing)", async () => {
	const dir = seedDir();
	mkdirSync(resolve(dir, "lock"), { recursive: true });
	writeFileSync(lockPath(dir), `${Date.now() - 5_000}:dead-holder`); // expiry in the past
	const start = Date.now();
	await withFileLock(lockPath(dir), () => {}, OPTS);
	assert.ok(Date.now() - start < 4000, "stale lock must be stolen well before the acquire timeout");
});

test("does not steal a live lock — times out instead", async () => {
	const dir = seedDir();
	mkdirSync(resolve(dir, "lock"), { recursive: true });
	// Far-future expiry: past the waiter's hard cap, so it must give up (a lock
	// this fresh means a live holder, not an orphan).
	const foreign = `${Date.now() + 600_000}:live-holder`;
	writeFileSync(lockPath(dir), foreign);
	await assert.rejects(
		withFileLock(lockPath(dir), () => {}, OPTS),
		/timed out|held live/,
	);
	assert.equal(readFileSync(lockPath(dir), "utf-8"), foreign, "foreign lock untouched");
});

test("a waiter arriving early outlives the orphan's expiry and still steals (timeout < TTL case)", async () => {
	const dir = seedDir();
	mkdirSync(resolve(dir, "lock"), { recursive: true });
	// Expires 100ms past the 8s acquire timeout — the waiter must extend to the
	// hard cap instead of giving up at the soft deadline.
	writeFileSync(lockPath(dir), `${Date.now() + 8_100}:soon-stale-orphan`);
	const start = Date.now();
	await withFileLock(lockPath(dir), () => {}, OPTS);
	const waited = Date.now() - start;
	assert.ok(waited >= 8_000, `must have waited past the soft deadline (waited ${waited}ms)`);
	assert.ok(waited < 12_000, `must steal shortly after expiry, not at the hard cap (waited ${waited}ms)`);
});

test("release compares the token — never deletes a thief's lock", async () => {
	const dir = seedDir();
	await withFileLock(
		lockPath(dir),
		() => {
			// Simulate being stolen from mid-hold (TTL overrun): the lock now belongs
			// to someone else.
			writeFileSync(lockPath(dir), "thief-token");
		},
		OPTS,
	);
	assert.equal(existsSync(lockPath(dir)), true, "thief's lock must survive our release");
	assert.equal(readFileSync(lockPath(dir), "utf-8"), "thief-token");
});

test("serializes across real processes (multi-process race)", async () => {
	const dir = seedDir();
	writeFileSync(counterPath(dir), "0");
	const modPath = resolve(import.meta.dirname, "../file-lock.ts");
	const child = join(dir, "child.mjs");
	writeFileSync(
		child,
		[
			`const { withFileLock } = await import(${JSON.stringify(modPath)});`,
			`const { readFileSync, writeFileSync } = await import("node:fs");`,
			`const opts = { label: "test lock", staleMs: 2_000, acquireTimeoutMs: 8_000 };`,
			`for (let i = 0; i < 5; i++) {`,
			`  await withFileLock(${JSON.stringify(lockPath(dir))}, async () => {`,
			`    const n = Number.parseInt(readFileSync(${JSON.stringify(counterPath(dir))}, "utf-8"), 10);`,
			`    await new Promise((r) => setTimeout(r, 2));`,
			`    writeFileSync(${JSON.stringify(counterPath(dir))}, String(n + 1));`,
			`  }, opts);`,
			`}`,
		].join("\n"),
	);
	const procs = Array.from(
		{ length: 4 },
		() =>
			new Promise<number>((resolveExit) => {
				const p = spawn("npx", ["tsx", child], { cwd: import.meta.dirname, env: process.env, stdio: "ignore" });
				p.on("exit", (code) => resolveExit(code ?? 1));
			}),
	);
	const codes = await Promise.all(procs);
	assert.deepEqual(codes, [0, 0, 0, 0], "all contender processes must exit clean");
	assert.equal(readFileSync(counterPath(dir), "utf-8"), "20", "4 procs × 5 locked increments, none lost");
});
