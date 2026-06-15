import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { activeClaim, activeClaims, type Claim, canonicalId, isAlive, ownerPid, readClaims, reapStale, recordClaim, releaseClaim, withClaimLock, writeClaims } from "../claim-ledger.js";

function makeRepo(): string {
	return mkdtempSync(join(tmpdir(), "autopilot-ledger-test-"));
}

const DEAD_PID = 2_147_483_646; // implausibly high → ESRCH

function claim(over: Partial<Claim> = {}): Claim {
	return { id: "TOOL-1", branch: "feat/tool-1", worktree: process.cwd(), claimedAt: 1, pid: process.pid, ...over };
}

describe("claim-ledger CRUD", () => {
	let repo: string;
	before(() => {
		repo = makeRepo();
	});

	it("recordClaim → activeClaim → releaseClaim round-trip with the documented JSON shape", () => {
		recordClaim(repo, claim());
		const got = activeClaim(repo, "TOOL-1");
		assert.ok(got);
		assert.deepEqual(got, { id: "TOOL-1", branch: "feat/tool-1", worktree: process.cwd(), claimedAt: 1, pid: process.pid });
		releaseClaim(repo, "TOOL-1");
		assert.equal(activeClaim(repo, "TOOL-1"), null);
	});

	it("normalizes ids to a canonical (lowercase) key for record/lookup/release", () => {
		recordClaim(repo, claim({ id: "TOOL-2" }));
		// Looked up case-insensitively.
		assert.ok(activeClaim(repo, "tool-2"));
		// Stored under the canonical key.
		assert.ok(canonicalId("TOOL-2") in readClaims(repo));
		// Released with a different casing than recorded.
		releaseClaim(repo, "tool-2");
		assert.equal(activeClaim(repo, "TOOL-2"), null);
	});
});

describe("withClaimLock mutual exclusion", () => {
	let repo: string;
	before(() => {
		repo = makeRepo();
	});

	it("does not interleave overlapping critical sections", async () => {
		const order: string[] = [];
		const a = withClaimLock(repo, async () => {
			order.push("a-start");
			await new Promise((r) => setTimeout(r, 50));
			order.push("a-end");
		});
		const b = withClaimLock(repo, async () => {
			order.push("b-start");
			order.push("b-end");
		});
		await Promise.all([a, b]);
		// a acquired first (synchronously); b must wait until a releases.
		assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
	});

	it("removes the lock dir after the critical section", async () => {
		await withClaimLock(repo, () => {});
		assert.equal(existsSync(resolve(repo, ".dev", "autopilot-claims.lock")), false);
	});
});

describe("withClaimLock stale-break", () => {
	it("steals a lock whose owner.json pid is dead", async () => {
		const repo = makeRepo();
		const lockDir = resolve(repo, ".dev", "autopilot-claims.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(resolve(lockDir, "owner.json"), JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
		let ran = false;
		await withClaimLock(repo, () => {
			ran = true;
		});
		assert.equal(ran, true);
	});

	it("steals a lock dir older than the TTL when owner.json is missing", async () => {
		const repo = makeRepo();
		const lockDir = resolve(repo, ".dev", "autopilot-claims.lock");
		mkdirSync(lockDir, { recursive: true });
		// Backdate the lock dir well past the 60s TTL; no owner.json present.
		const old = (Date.now() - 5 * 60_000) / 1000;
		utimesSync(lockDir, old, old);
		let ran = false;
		await withClaimLock(repo, () => {
			ran = true;
		});
		assert.equal(ran, true);
	});
});

describe("reapStale", () => {
	let repo: string;
	before(() => {
		repo = makeRepo();
	});

	it("drops dead-pid and missing-worktree claims but keeps live ones", () => {
		writeClaims(repo, {
			live: claim({ id: "LIVE-1", pid: process.pid, worktree: process.cwd() }),
			dead: claim({ id: "DEAD-1", pid: DEAD_PID, worktree: process.cwd() }),
			gone: claim({ id: "GONE-1", pid: process.pid, worktree: resolve(repo, "no-such-worktree") }),
		});
		const live = reapStale(repo);
		assert.deepEqual(Object.keys(live), ["live"]);
		// Persisted, not just returned.
		assert.deepEqual(Object.keys(readClaims(repo)), ["live"]);
	});
});

describe("activeClaims overlay filter", () => {
	it("returns only live claims without rewriting the file", () => {
		const repo = makeRepo();
		writeClaims(repo, {
			a: claim({ id: "A-1", pid: process.pid, worktree: process.cwd() }),
			b: claim({ id: "B-1", pid: DEAD_PID, worktree: process.cwd() }),
		});
		const live = activeClaims(repo);
		assert.deepEqual(Object.keys(live), ["a"]);
		// Read path must not mutate the file.
		assert.deepEqual(Object.keys(readClaims(repo)), ["a", "b"]);
	});
});

describe("ownerPid", () => {
	const prev = process.env.AUTOPILOT_OWNER_PID;
	after(() => {
		if (prev === undefined) delete process.env.AUTOPILOT_OWNER_PID;
		else process.env.AUTOPILOT_OWNER_PID = prev;
	});

	it("honors AUTOPILOT_OWNER_PID when set", () => {
		process.env.AUTOPILOT_OWNER_PID = "12345";
		assert.equal(ownerPid(), 12345);
	});

	it("falls back to process.ppid when unset", () => {
		delete process.env.AUTOPILOT_OWNER_PID;
		assert.equal(ownerPid(), process.ppid);
	});
});

describe("isAlive", () => {
	it("reports the current process as alive", () => {
		assert.equal(isAlive(process.pid), true);
	});

	it("reports an implausible pid as dead", () => {
		assert.equal(isAlive(DEAD_PID), false);
	});

	it("reports non-positive / non-integer pids as dead", () => {
		assert.equal(isAlive(0), false);
		assert.equal(isAlive(-1), false);
		assert.equal(isAlive(1.5), false);
	});
});
