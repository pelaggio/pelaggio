import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mustNotDestroy, SESSION_SCHEMA_VERSION, type SessionProbes, type SessionRecord, sessionLiveness } from "../confinement/sessions.js";

const MAIN = "/repo";
const WT = "/wt/item-9";
const NOW = 1_000_000;

function rec(over: Partial<SessionRecord> = {}): SessionRecord {
	return { version: SESSION_SCHEMA_VERSION, sessionId: "s1", claimedItem: "ITEM-9", claimBranch: "feat/item-9", worktreePath: WT, pid: 4242, expiresAt: NOW + 60_000, ...over };
}

/** Linux host with one readable session file, and a /proc view the test controls. */
function probes(opts: { records?: Array<SessionRecord | string>; procCwd?: string | undefined; pidAlive?: boolean; platform?: string; unreadable?: boolean }): SessionProbes {
	const records = opts.records ?? [rec()];
	const files = records.map((_, i) => `s${i}.json`);
	return {
		platform: opts.platform ?? "linux",
		now: () => NOW,
		listSessionFiles: () => files,
		readFile: (path) => {
			const m = path.match(/s(\d+)\.json$/);
			if (m?.[1] !== undefined) {
				if (opts.unreadable) return undefined;
				const r = records[Number(m[1])];
				return typeof r === "string" ? r : JSON.stringify(r);
			}
			if (path.endsWith("/stat")) return opts.procCwd === undefined ? undefined : "1234 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 987 0 0";
			return undefined;
		},
		readlink: (path) => (path.endsWith("/cwd") ? opts.procCwd : undefined),
		isPidAlive: () => opts.pidAlive ?? false,
	};
}

describe("sessionLiveness — destructive-reconciler contract (#461)", () => {
	it("is live when the pid's /proc cwd is inside the claimed worktree", () => {
		const v = sessionLiveness(MAIN, WT, probes({ procCwd: WT, pidAlive: true }));
		assert.equal(v.state, "live");
		assert.ok(mustNotDestroy(v));
		assert.match(v.reason, /s1 is running/);
	});

	it("is live when cwd is nested below the worktree", () => {
		assert.equal(sessionLiveness(MAIN, WT, probes({ procCwd: `${WT}/packages/x`, pidAlive: true })).state, "live");
	});

	it("is dead when the pid is gone and /proc has no entry", () => {
		const v = sessionLiveness(MAIN, WT, probes({ procCwd: undefined, pidAlive: false }));
		assert.equal(v.state, "dead");
		assert.equal(mustNotDestroy(v), false);
	});

	it("resists pid reuse: an alive pid working elsewhere is never live", () => {
		// The whole reason kill(pid,0) is insufficient — a recycled pid reads as alive.
		const v = sessionLiveness(MAIN, WT, probes({ procCwd: "/somewhere/else", pidAlive: true }));
		assert.notEqual(v.state, "live");
		assert.ok(mustNotDestroy(v), "an uncorroborated alive pid must still block destruction");
	});

	it("is dead once an uncorroborated record has passed its own deadline", () => {
		const v = sessionLiveness(MAIN, WT, probes({ records: [rec({ expiresAt: NOW - 1 })], procCwd: "/elsewhere", pidAlive: true }));
		assert.equal(v.state, "dead");
	});

	it("is unknown — not dead — when the pid is alive but /proc is unreadable", () => {
		const v = sessionLiveness(MAIN, WT, probes({ procCwd: undefined, pidAlive: true }));
		assert.equal(v.state, "unknown");
		assert.ok(mustNotDestroy(v));
	});

	it("is unknown on a host with no /proc to corroborate with", () => {
		const v = sessionLiveness(MAIN, WT, probes({ platform: "darwin", pidAlive: true }));
		assert.equal(v.state, "unknown");
		assert.match(v.reason, /treating as live/);
	});

	it("is unknown when a record exists but carries no binding pid", () => {
		assert.equal(sessionLiveness(MAIN, WT, probes({ records: [rec({ pid: 0 })] })).state, "unknown");
	});

	it("is unknown when a session file is present but unreadable or malformed", () => {
		assert.equal(sessionLiveness(MAIN, WT, probes({ unreadable: true })).state, "unknown");
		assert.equal(sessionLiveness(MAIN, WT, probes({ records: ["{not json"] })).state, "unknown");
	});

	it("ignores records for other worktrees", () => {
		const v = sessionLiveness(MAIN, WT, probes({ records: [rec({ worktreePath: "/wt/other", pid: 1 })], procCwd: "/wt/other", pidAlive: true }));
		assert.equal(v.state, "dead");
		assert.match(v.reason, /no session record claims/);
	});

	it("is dead when nothing claims the worktree", () => {
		const v = sessionLiveness(MAIN, WT, { platform: "linux", now: () => NOW, listSessionFiles: () => [] });
		assert.equal(v.state, "dead");
		assert.equal(mustNotDestroy(v), false);
	});

	it("least-safe-wins: one live record outvotes any number of dead ones", () => {
		const records = [rec({ sessionId: "dead-1", pid: 7 }), rec({ sessionId: "live-1", pid: 4242 })];
		// Only pid 4242 has a corroborating /proc cwd; pid 7 resolves to nothing.
		const p: SessionProbes = {
			...probes({ records, procCwd: WT, pidAlive: false }),
			readlink: (path) => (path === "/proc/4242/cwd" ? WT : undefined),
			readFile: (path) => {
				const m = path.match(/s(\d+)\.json$/);
				if (m?.[1] !== undefined) return JSON.stringify(records[Number(m[1])]);
				return path === "/proc/4242/stat" ? "1234 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 987 0 0" : undefined;
			},
		};
		const v = sessionLiveness(MAIN, WT, p);
		assert.equal(v.state, "live");
		assert.deepEqual(v.sessions, ["live-1"]);
	});

	it("unknown outranks dead when both are present", () => {
		const records = [rec({ sessionId: "dead-1", pid: 7 }), rec({ sessionId: "nopid", pid: 0 })];
		const v = sessionLiveness(MAIN, WT, probes({ records, procCwd: undefined, pidAlive: false }));
		assert.equal(v.state, "unknown");
		assert.deepEqual(v.sessions, ["nopid"]);
	});
});
