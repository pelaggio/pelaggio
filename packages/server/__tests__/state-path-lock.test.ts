import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { acquireStatePathLock } from "../src/state-path-lock.js";

function tmpStatePath(): string {
	return join(mkdtempSync(join(tmpdir(), "state-path-lock-")), "nested", "state.json");
}

/** Ensure the parent directory of a state path exists for seeded lock files. */
function ensureParent(statePath: string): void {
	mkdirSync(join(statePath, ".."), { recursive: true });
}

/** Spawn a short-lived sleeper; resolve with its live PID. Caller must kill it. */
function spawnLiveChild(): Promise<{ pid: number; kill: () => void }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
		});
		child.on("error", reject);
		if (child.pid === undefined) {
			reject(new Error("child has no pid"));
			return;
		}
		// Give the child a tick to start so kill(pid, 0) is reliable.
		setImmediate(() => {
			resolve({
				pid: child.pid as number,
				kill: () => {
					try {
						child.kill("SIGKILL");
					} catch {
						// already dead
					}
				},
			});
		});
	});
}

/** Spawn a process that exits immediately; resolve with its dead PID. */
function spawnDeadPid(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		child.on("error", reject);
		child.on("exit", () => {
			if (child.pid === undefined) {
				reject(new Error("child has no pid"));
				return;
			}
			resolve(child.pid);
		});
	});
}

describe("acquireStatePathLock", () => {
	it("acquire + release: creates parent, writes pid:token, removes on release; second release is no-op", () => {
		const statePath = tmpStatePath();
		const lock = acquireStatePathLock(statePath);
		assert.equal(lock.lockPath, `${statePath}.lock`);
		assert.ok(existsSync(lock.lockPath));
		const content = readFileSync(lock.lockPath, "utf-8");
		assert.match(content, new RegExp(`^${process.pid}:[0-9a-f]{16}$`));
		lock.release();
		assert.equal(existsSync(lock.lockPath), false);
		lock.release(); // no-op
		assert.equal(existsSync(lock.lockPath), false);
	});

	it("foreign live holder: throws naming PID and state path; original content unchanged", async () => {
		const statePath = tmpStatePath();
		const lockPath = `${statePath}.lock`;
		const live = await spawnLiveChild();
		try {
			const original = `${live.pid}:foreigntoken01`;
			ensureParent(statePath);
			writeFileSync(lockPath, original);
			assert.throws(
				() => acquireStatePathLock(statePath),
				(err: unknown) => {
					assert.ok(err instanceof Error);
					assert.match(err.message, new RegExp(`pid ${live.pid}`));
					assert.match(err.message, new RegExp(statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
					return true;
				},
			);
			assert.equal(readFileSync(lockPath, "utf-8"), original);
		} finally {
			live.kill();
		}
	});

	it("self-PID residue: reclaims and writes a new token for this process", () => {
		const statePath = tmpStatePath();
		const lockPath = `${statePath}.lock`;
		ensureParent(statePath);
		const oldClaim = `${process.pid}:oldtoken0123456`;
		writeFileSync(lockPath, oldClaim);
		const lock = acquireStatePathLock(statePath);
		const content = readFileSync(lock.lockPath, "utf-8");
		assert.notEqual(content, oldClaim);
		assert.match(content, new RegExp(`^${process.pid}:[0-9a-f]{16}$`));
		lock.release();
	});

	it("dead owner: reclaims and writes current PID", async () => {
		const statePath = tmpStatePath();
		const lockPath = `${statePath}.lock`;
		const deadPid = await spawnDeadPid();
		ensureParent(statePath);
		writeFileSync(lockPath, `${deadPid}:deadtoken012345`);
		const lock = acquireStatePathLock(statePath);
		const content = readFileSync(lock.lockPath, "utf-8");
		assert.match(content, new RegExp(`^${process.pid}:[0-9a-f]{16}$`));
		lock.release();
	});

	it("malformed content: throws and leaves file unmodified", () => {
		const statePath = tmpStatePath();
		const lockPath = `${statePath}.lock`;
		ensureParent(statePath);

		for (const bad of ["not-a-lock", "", "0:token", "-1:token", ":notoken", "abc:token"]) {
			writeFileSync(lockPath, bad);
			assert.throws(
				() => acquireStatePathLock(statePath),
				(err: unknown) => {
					assert.ok(err instanceof Error);
					assert.match(err.message, /malformed|unreadable/i);
					assert.match(err.message, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
					return true;
				},
			);
			assert.equal(readFileSync(lockPath, "utf-8"), bad);
		}
	});

	it("ownership-safe release: does not remove a foreign claim written after acquire", () => {
		const statePath = tmpStatePath();
		const lock = acquireStatePathLock(statePath);
		const foreign = "999999:foreigntokenabc";
		writeFileSync(lock.lockPath, foreign);
		lock.release();
		assert.ok(existsSync(lock.lockPath));
		assert.equal(readFileSync(lock.lockPath, "utf-8"), foreign);
	});
});
