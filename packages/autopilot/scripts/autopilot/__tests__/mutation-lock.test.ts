import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Shrink the timing constants BEFORE the module under test is loaded — they are
// read once at import. 2s stale / 8s acquire keeps the suite fast without
// letting a busy CI runner trip the stale-steal during legitimate holds.
process.env.AUTOPILOT_LOCK_STALE_MS = "2000";
process.env.AUTOPILOT_LOCK_TIMEOUT_MS = "8000";
const { withMutationLock } = await import("../roadmap/mutation-lock.js");

function seedDir(): string {
	return mkdtempSync(join(tmpdir(), "autopilot-lock-test-"));
}

const lockPath = (repo: string) => resolve(repo, ".dev", "roadmap-mutation.lock");
const counterPath = (repo: string) => resolve(repo, "counter.txt");

/** Unlocked read-modify-write with a deliberate yield in the window. */
async function bumpCounter(repo: string): Promise<void> {
	const n = Number.parseInt(readFileSync(counterPath(repo), "utf-8"), 10);
	await new Promise((r) => setTimeout(r, 5)); // widen the race window
	writeFileSync(counterPath(repo), String(n + 1));
}

test("serializes concurrent read-modify-write sections (in-process)", async () => {
	const repo = seedDir();
	writeFileSync(counterPath(repo), "0");
	await Promise.all(Array.from({ length: 25 }, () => withMutationLock(repo, () => bumpCounter(repo))));
	assert.equal(readFileSync(counterPath(repo), "utf-8"), "25");
	assert.equal(existsSync(lockPath(repo)), false, "lock released after last holder");
});

test("releases on throw — next holder acquires immediately", async () => {
	const repo = seedDir();
	await assert.rejects(
		withMutationLock(repo, () => {
			throw new Error("boom");
		}),
		/boom/,
	);
	const start = Date.now();
	await withMutationLock(repo, () => {});
	assert.ok(Date.now() - start < 1000, "second acquire should not wait on a leaked lock");
});

test("steals a stale lock (holder died without releasing)", async () => {
	const repo = seedDir();
	mkdirSync(resolve(repo, ".dev"), { recursive: true });
	writeFileSync(lockPath(repo), `${Date.now() - 5_000}:dead-holder`); // expiry in the past
	const start = Date.now();
	await withMutationLock(repo, () => {});
	assert.ok(Date.now() - start < 4000, "stale lock must be stolen well before the acquire timeout");
});

test("does not steal a live lock — times out instead", async () => {
	const repo = seedDir();
	mkdirSync(resolve(repo, ".dev"), { recursive: true });
	// Far-future expiry: past the waiter's hard cap, so it must give up (a lock
	// this fresh means a live holder, not an orphan).
	const foreign = `${Date.now() + 600_000}:live-holder`;
	writeFileSync(lockPath(repo), foreign);
	await assert.rejects(
		withMutationLock(repo, () => {}),
		/timed out|held live/,
	);
	assert.equal(readFileSync(lockPath(repo), "utf-8"), foreign, "foreign lock untouched");
});

test("a waiter arriving early outlives the orphan's expiry and still steals (timeout < TTL case)", async () => {
	const repo = seedDir();
	mkdirSync(resolve(repo, ".dev"), { recursive: true });
	// Expires 100ms past the 8s acquire timeout — the waiter must extend to the
	// hard cap instead of giving up at the soft deadline.
	writeFileSync(lockPath(repo), `${Date.now() + 8_100}:soon-stale-orphan`);
	const start = Date.now();
	await withMutationLock(repo, () => {});
	const waited = Date.now() - start;
	assert.ok(waited >= 8_000, `must have waited past the soft deadline (waited ${waited}ms)`);
	assert.ok(waited < 12_000, `must steal shortly after expiry, not at the hard cap (waited ${waited}ms)`);
});

test("release compares the token — never deletes a thief's lock (the #13 cascade)", async () => {
	const repo = seedDir();
	await withMutationLock(repo, () => {
		// Simulate being stolen from mid-hold (TTL overrun): the lock now belongs
		// to someone else.
		writeFileSync(lockPath(repo), "thief-token");
	});
	assert.equal(existsSync(lockPath(repo)), true, "thief's lock must survive our release");
	assert.equal(readFileSync(lockPath(repo), "utf-8"), "thief-token");
});

test("serializes across real processes (multi-process race)", async () => {
	const repo = seedDir();
	writeFileSync(counterPath(repo), "0");
	const modPath = resolve(import.meta.dirname, "../roadmap/mutation-lock.ts");
	const child = join(repo, "child.mjs");
	writeFileSync(
		child,
		[
			`const { withMutationLock } = await import(${JSON.stringify(modPath)});`,
			`const { readFileSync, writeFileSync } = await import("node:fs");`,
			`for (let i = 0; i < 5; i++) {`,
			`  await withMutationLock(${JSON.stringify(repo)}, async () => {`,
			`    const n = Number.parseInt(readFileSync(${JSON.stringify(counterPath(repo))}, "utf-8"), 10);`,
			`    await new Promise((r) => setTimeout(r, 2));`,
			`    writeFileSync(${JSON.stringify(counterPath(repo))}, String(n + 1));`,
			`  });`,
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
	assert.equal(readFileSync(counterPath(repo), "utf-8"), "20", "4 procs × 5 locked increments, none lost");
});
