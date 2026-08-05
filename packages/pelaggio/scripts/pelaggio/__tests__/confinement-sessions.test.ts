import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { forbiddenRootsForConfinement } from "../confinement/roots.js";
import {
	captureEvaluatorContext,
	captureSessionInventory,
	claimBranchAttributesToItem,
	createSessionController,
	firstDiffPaths,
	identitiesEqual,
	parseProcStatStarttime,
	parseSessionRecord,
	porcelainPaths,
	readSessionRecordFromText,
	removeSessionRecord,
	resolveEligibleSessions,
	revalidateChangedRoot,
	SESSION_SCHEMA_VERSION,
	type SessionEvaluatorContext,
	type SessionProbes,
	type SessionRecord,
	sessionIdentityOf,
	sessionRecordPath,
	sessionsDir,
	sweepExpiredSessions,
	validateGitClaim,
	writeSessionRecord,
} from "../confinement/sessions.js";

function makeMain(): string {
	return mkdtempSync(join(tmpdir(), "sess-main-"));
}

function baseRecord(over: Partial<SessionRecord> = {}): SessionRecord {
	return {
		version: SESSION_SCHEMA_VERSION,
		sessionId: "s1",
		claimedItem: "369",
		claimBranch: "feat/issue-369-fix",
		worktreePath: "/tmp/wt-369",
		pid: 4242,
		expiresAt: Date.now() + 3_600_000,
		...over,
	};
}

function memoryProbes(init: {
	files?: Map<string, string>;
	links?: Map<string, string>;
	worktrees?: string[];
	branches?: Map<string, string>;
	alive?: Set<number>;
	platform?: string;
	now?: () => number;
}): SessionProbes & { files: Map<string, string> } {
	const files = init.files ?? new Map<string, string>();
	const links = init.links ?? new Map<string, string>();
	const worktrees = init.worktrees ?? [];
	const branches = init.branches ?? new Map<string, string>();
	const alive = init.alive ?? new Set<number>();
	const clock = 1_000_000;
	return {
		files,
		readFile: (path) => files.get(path),
		readlink: (path) => links.get(path),
		listSessionFiles: (dir) =>
			[...files.keys()]
				.filter((p) => p.startsWith(dir + "/") || p.startsWith(dir + "\\"))
				.map((p) => p.slice(dir.length + 1))
				.filter((f) => f.endsWith(".json") && !f.includes("/")),
		writeFile: (path, data) => {
			files.set(path, data);
		},
		rename: (from, to) => {
			const data = files.get(from);
			if (data === undefined) throw new Error(`rename missing ${from}`);
			files.delete(from);
			files.set(to, data);
		},
		unlink: (path) => {
			files.delete(path);
		},
		mkdir: () => {},
		exists: (path) => files.has(path),
		gitWorktreeList: () => worktrees.map((w) => `worktree ${w}`).join("\n") + "\n",
		gitBranch: (wt) => branches.get(resolve(wt)),
		isPidAlive: (pid) => alive.has(pid),
		platform: init.platform ?? "linux",
		now: init.now ?? (() => clock),
	};
}

describe("parseSessionRecord / schema", () => {
	it("accepts a valid record and resolves worktreePath", () => {
		const rec = parseSessionRecord(baseRecord({ worktreePath: "/tmp/a/../b" }));
		assert.ok(rec);
		assert.equal(rec.worktreePath, resolve("/tmp/b"));
		assert.equal(rec.version, 1);
	});

	it("rejects malformed JSON, wrong version, missing fields, non-integer pid", () => {
		assert.equal(readSessionRecordFromText("{"), undefined);
		assert.equal(parseSessionRecord({ ...baseRecord(), version: 99 }), undefined);
		assert.equal(parseSessionRecord({ ...baseRecord(), sessionId: "" }), undefined);
		assert.equal(parseSessionRecord({ ...baseRecord(), pid: 1.5 }), undefined);
		assert.equal(parseSessionRecord({ ...baseRecord(), expiresAt: "soon" }), undefined);
		assert.equal(parseSessionRecord(null), undefined);
	});
});

describe("claimBranchAttributesToItem", () => {
	it("accepts github-issues feat/issue-N-slug and markdown feat/id", () => {
		assert.equal(claimBranchAttributesToItem("feat/issue-369-fix-confinement", "369"), true);
		assert.equal(claimBranchAttributesToItem("feat/issue-369", "369"), true);
		assert.equal(claimBranchAttributesToItem("feat/tool-99", "TOOL-99"), true);
		assert.equal(claimBranchAttributesToItem("feat/tool-99-fix", "tool-99"), true);
	});

	it("rejects non-feat, non-attributing, and prefix-shadowing misses", () => {
		assert.equal(claimBranchAttributesToItem("main", "369"), false);
		assert.equal(claimBranchAttributesToItem("feat/issue-370", "369"), false);
		assert.equal(claimBranchAttributesToItem("feat/issue-36", "369"), false);
		assert.equal(claimBranchAttributesToItem("feat/tool-9", "tool-99"), false);
	});
});

describe("parseProcStatStarttime", () => {
	it("parses field 22 after the final ) even when comm has spaces and )", () => {
		// Minimal synthetic: pid (comm with) spaces) state ... starttime at field 22
		// fields after ): 3=state ... 22=starttime → rest[19]
		const after = ["S", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "99999", "0"];
		const stat = `12345 (my proc) name) ${after.join(" ")}`;
		assert.equal(parseProcStatStarttime(stat), 99999);
	});

	it("returns undefined on malformed input", () => {
		assert.equal(parseProcStatStarttime("no-paren"), undefined);
		assert.equal(parseProcStatStarttime("1 (x) S"), undefined);
	});
});

describe("eligibility legs", () => {
	const wt = resolve("/tmp/wt-peer");
	const main = resolve("/tmp/main-repo");
	const rec = baseRecord({
		sessionId: "peer-1",
		claimedItem: "369",
		claimBranch: "feat/issue-369-x",
		worktreePath: wt,
		pid: 77,
		expiresAt: 5_000_000,
	});

	function setup(over: { starttime?: number; childStart?: number; inInventory?: boolean; pid?: number; branch?: string; worktrees?: string[] } = {}) {
		const probes = memoryProbes({
			worktrees: over.worktrees ?? [main, wt],
			branches: new Map([[wt, over.branch ?? rec.claimBranch]]),
			alive: new Set([over.pid ?? rec.pid]),
			platform: "linux",
			now: () => 1_000_000,
		});
		const path = sessionRecordPath(main, rec.sessionId);
		const record = { ...rec, pid: over.pid ?? rec.pid };
		probes.files.set(path, JSON.stringify(record));
		const childStart = over.childStart ?? 100;
		probes.readlink = (p) => (p === `/proc/${record.pid}/cwd` ? wt : undefined);
		const after = ["S", ...Array(18).fill("0"), String(childStart), "0"];
		probes.readFile = (p) => {
			if (p === path) return probes.files.get(path);
			if (p === `/proc/${record.pid}/stat`) return `${record.pid} (claude) ${after.join(" ")}`;
			if (p === "/proc/self/stat") return `1 (node) ${["S", ...Array(18).fill("0"), String(over.starttime ?? 500), "0"].join(" ")}`;
			return probes.files.get(p);
		};
		const inventory = over.inInventory === false ? { identities: [] } : { identities: [sessionIdentityOf(record)] };
		const ctx: SessionEvaluatorContext = {
			inventory,
			starttimeJiffies: over.starttime ?? 500,
			mainRepo: main,
		};
		return { probes, ctx, record };
	}

	it("accepts valid Git claim + binding (cwd inside worktree, starttime before evaluator)", () => {
		const { probes, ctx } = setup({ inInventory: false, childStart: 100, starttime: 500 });
		const hits = resolveEligibleSessions(ctx, { probes });
		assert.equal(hits.length, 1);
		const hit = hits[0]!;
		assert.equal(hit.leg, "binding");
		assert.equal(hit.worktreePath, wt);
	});

	it("accepts inventory fallback without binding when identity matches exactly", () => {
		const { probes, ctx } = setup({ inInventory: true, childStart: 900, starttime: 500 }); // child after evaluator → binding fails
		// Force no binding by using non-linux
		const probes2 = { ...probes, platform: "darwin" };
		const hits = resolveEligibleSessions({ ...ctx, starttimeJiffies: undefined }, { probes: probes2 });
		assert.equal(hits.length, 1);
		assert.equal(hits[0]!.leg, "fallback");
	});

	it("rejects headline decoy: live PID in worktree but starttime after evaluator", () => {
		const { probes, ctx } = setup({ inInventory: false, childStart: 900, starttime: 500 });
		const hits = resolveEligibleSessions(ctx, { probes });
		assert.equal(hits.length, 0);
	});

	it("rejects when not in inventory and no valid binding (hard forgery)", () => {
		const { probes, ctx } = setup({ inInventory: false, childStart: 900, starttime: 500 });
		// Also break cwd
		const p2 = { ...probes, readlink: () => "/tmp/elsewhere" };
		assert.equal(resolveEligibleSessions(ctx, { probes: p2 }).length, 0);
	});

	it("rejects non-matching branch, unregistered worktree, expired content", () => {
		const a = setup({ branch: "feat/other", inInventory: true });
		assert.equal(resolveEligibleSessions(a.ctx, { probes: a.probes }).length, 0);

		const b = setup({ worktrees: [main], inInventory: true });
		assert.equal(resolveEligibleSessions(b.ctx, { probes: b.probes }).length, 0);

		const c = setup({ inInventory: true });
		const path = sessionRecordPath(main, rec.sessionId);
		c.probes.files.set(path, JSON.stringify({ ...rec, expiresAt: 1 })); // expired before now=1e6
		assert.equal(resolveEligibleSessions(c.ctx, { probes: c.probes }).length, 0);
	});

	it("fallback survives mid-run pid refresh; identity mutation rejects fallback", () => {
		const { probes, ctx, record } = setup({ inInventory: true, childStart: 900, starttime: 500 });
		const path = sessionRecordPath(main, rec.sessionId);
		// pid refresh only
		probes.files.set(path, JSON.stringify({ ...record, pid: 9999 }));
		const hits = resolveEligibleSessions({ ...ctx, starttimeJiffies: undefined }, { probes: { ...probes, platform: "darwin" } });
		assert.equal(hits.length, 1);
		// identity mutation (claimBranch)
		probes.files.set(path, JSON.stringify({ ...record, claimBranch: "feat/issue-369-mutated" }));
		// branch probe must match for Git validation
		const branches = new Map([[wt, "feat/issue-369-mutated"]]);
		const probesMut = { ...probes, gitBranch: (w: string) => branches.get(resolve(w)), platform: "darwin" as const };
		assert.equal(resolveEligibleSessions({ ...ctx, starttimeJiffies: undefined }, { probes: probesMut }).length, 0);
	});

	it("rejects a record naming mainRepo", () => {
		const mainWt = main;
		const probes = memoryProbes({
			worktrees: [main],
			branches: new Map([[main, "feat/issue-369-x"]]),
			now: () => 1_000_000,
		});
		const r = baseRecord({ worktreePath: main, claimBranch: "feat/issue-369-x", expiresAt: 5e6 });
		probes.files.set(sessionRecordPath(main, r.sessionId), JSON.stringify(r));
		const ctx: SessionEvaluatorContext = {
			inventory: { identities: [sessionIdentityOf(r)] },
			mainRepo: main,
		};
		assert.equal(resolveEligibleSessions(ctx, { probes }).length, 0);
		void mainWt;
	});

	it("later evaluator with starttime after producer child accepts via binding", () => {
		const { probes, ctx } = setup({ inInventory: false, childStart: 100, starttime: 500 });
		const hits = resolveEligibleSessions(ctx, { probes });
		assert.equal(hits[0]?.leg, "binding");
	});
});

describe("atomic lifecycle + sweep", () => {
	it("write/read/remove with compare-before-remove", () => {
		const main = makeMain();
		try {
			const rec = baseRecord({ sessionId: "life-1", worktreePath: join(main, "wt") });
			writeSessionRecord(main, rec);
			const path = sessionRecordPath(main, "life-1");
			assert.ok(readFileSync(path, "utf-8").includes("life-1"));
			const id = sessionIdentityOf(rec);
			assert.equal(removeSessionRecord(main, id), true);
			assert.equal(removeSessionRecord(main, id), false);
		} finally {
			rmSync(main, { recursive: true, force: true });
		}
	});

	it("remove refuses when identity no longer matches (replacement protected)", () => {
		const main = makeMain();
		try {
			const rec = baseRecord({ sessionId: "rep-1", claimedItem: "1", worktreePath: join(main, "a") });
			writeSessionRecord(main, rec);
			const replacement = { ...rec, claimedItem: "2", claimBranch: "feat/issue-2" };
			writeSessionRecord(main, replacement);
			assert.equal(removeSessionRecord(main, sessionIdentityOf(rec)), false);
			assert.ok(readFileSync(sessionRecordPath(main, "rep-1"), "utf-8").includes('"claimedItem": "2"') || readFileSync(sessionRecordPath(main, "rep-1"), "utf-8").includes('"claimedItem":"2"'));
		} finally {
			rmSync(main, { recursive: true, force: true });
		}
	});

	it("controller heartbeats refresh expiry and dispose removes record", () => {
		const main = makeMain();
		let now = 1_000_000;
		const timers: Array<() => void> = [];
		try {
			const ctrl = createSessionController({
				mainRepo: main,
				sessionId: "hb-1",
				claimedItem: "1",
				claimBranch: "feat/1",
				worktreePath: join(main, "wt"),
				expiryMs: 1000,
				heartbeatMs: 50,
				probes: { now: () => now },
				setIntervalFn: ((fn: () => void) => {
					timers.push(fn);
					return 1 as unknown as NodeJS.Timeout;
				}) as typeof setInterval,
				clearIntervalFn: (() => {}) as typeof clearInterval,
			});
			const path = sessionRecordPath(main, "hb-1");
			const exp1 = parseSessionRecord(JSON.parse(readFileSync(path, "utf-8")))!.expiresAt;
			now = 1_000_500;
			for (const t of timers) t();
			const exp2 = parseSessionRecord(JSON.parse(readFileSync(path, "utf-8")))!.expiresAt;
			assert.ok(exp2 > exp1);
			ctrl.updateChild(12345);
			const afterPid = parseSessionRecord(JSON.parse(readFileSync(path, "utf-8")))!;
			assert.equal(afterPid.pid, 12345);
			assert.equal(afterPid.sessionId, "hb-1"); // identity stable
			ctrl.dispose();
			ctrl.dispose(); // idempotent
			assert.throws(() => readFileSync(path));
		} finally {
			rmSync(main, { recursive: true, force: true });
		}
	});

	it("sweep removes expired, retains live and malformed, protects refreshed", () => {
		const main = makeMain();
		try {
			const dir = sessionsDir(main);
			mkdirSync(dir, { recursive: true });
			writeSessionRecord(main, baseRecord({ sessionId: "dead", expiresAt: 1 }));
			writeSessionRecord(main, baseRecord({ sessionId: "live", expiresAt: Date.now() + 99_000 }));
			writeFileSync(join(dir, "bad.json"), "{not json");
			const result = sweepExpiredSessions(main, { now: () => 1000 });
			assert.ok(result.removed.includes("dead.json"));
			assert.ok(result.retained.some((r) => r.file === "live.json" && r.reason === "live"));
			assert.ok(result.retained.some((r) => r.file === "bad.json" && r.reason === "malformed"));
		} finally {
			rmSync(main, { recursive: true, force: true });
		}
	});

	it("inventory capture keeps only immutable identities of valid records", () => {
		const main = makeMain();
		try {
			writeSessionRecord(main, baseRecord({ sessionId: "inv-1", worktreePath: "/tmp/w1" }));
			writeFileSync(join(sessionsDir(main), "junk.json"), "nope");
			const inv = captureSessionInventory(main);
			assert.equal(inv.identities.length, 1);
			const id0 = inv.identities[0]!;
			assert.equal(id0.sessionId, "inv-1");
			assert.equal(id0.worktreePath, resolve("/tmp/w1"));
		} finally {
			rmSync(main, { recursive: true, force: true });
		}
	});
});

describe("porcelain first-diff paths", () => {
	it("extracts paths including rename/copy", () => {
		assert.deepEqual(porcelainPaths(" M src/a.ts\n?? new.txt\n"), ["new.txt", "src/a.ts"]);
		assert.deepEqual(porcelainPaths("R  old.ts -> new.ts\n"), ["new.ts", "old.ts"]);
		assert.deepEqual(porcelainPaths("\0head abc\n\0ref refs/heads/main\n\0reflog abc\tcommit: init"), [], "snapshot identity metadata is not a path");
	});

	it("reports checkout identity when clean snapshots differ only by HEAD/ref metadata (#435)", () => {
		assert.deepEqual(firstDiffPaths("\0head aaa\n\0ref refs/heads/main", "\0head bbb\n\0ref refs/heads/main"), ["HEAD/ref state"]);
	});

	it("firstDiffPaths prefers newly appeared paths and bounds output", () => {
		const before = " M keep.ts\n";
		const after = " M keep.ts\n?? leaked.txt\nR  a.ts -> b.ts\n";
		const paths = firstDiffPaths(before, after, 10);
		assert.ok(paths.includes("leaked.txt"));
		assert.ok(paths.includes("b.ts") || paths.includes("a.ts"));
	});
});

describe("roots double main filter + allowDirtyMain unchanged", () => {
	it("sessionWorktrees cannot exempt main; allowDirtyMain still drops main independently", () => {
		const main = "/tmp/main-repo";
		const sibling = "/tmp/sib";
		const rootsWithSessionMain = forbiddenRootsForConfinement({
			cwd: sibling,
			mainRepo: main,
			worktrees: [main, sibling, "/tmp/other"],
			isEphemeralReviewWorktree: () => false,
			sessionWorktrees: [main, "/tmp/other"], // try to smuggle main
		});
		assert.ok(rootsWithSessionMain.includes(main) || rootsWithSessionMain.some((r) => resolve(r) === resolve(main)), "main stays forbidden despite sessionWorktrees");
		assert.ok(!rootsWithSessionMain.includes("/tmp/other"), "non-main session exemption works");

		const withAllow = forbiddenRootsForConfinement({
			cwd: sibling,
			mainRepo: main,
			worktrees: [main, sibling],
			allowDirtyMain: true,
			isEphemeralReviewWorktree: () => false,
			sessionWorktrees: [],
		});
		assert.ok(!withAllow.includes(main) && !withAllow.some((r) => resolve(r) === resolve(main)));
	});

	it("activeWorktrees exemption is independent of sessionWorktrees", () => {
		const main = "/tmp/main";
		const peer = "/tmp/peer";
		const roots = forbiddenRootsForConfinement({
			cwd: "/tmp/me",
			mainRepo: main,
			worktrees: [main, peer, "/tmp/me"],
			isEphemeralReviewWorktree: () => false,
			activeWorktrees: [peer],
		});
		assert.ok(!roots.includes(peer));
		assert.ok(roots.includes(main) || roots.some((r) => resolve(r) === resolve(main)));
	});
});

describe("revalidateChangedRoot", () => {
	it("returns undefined for main; returns accepted session when still eligible", () => {
		const wt = resolve("/tmp/rv-wt");
		const main = resolve("/tmp/rv-main");
		const rec = baseRecord({ sessionId: "rv", worktreePath: wt, claimBranch: "feat/issue-369-x", claimedItem: "369", expiresAt: 9e12, pid: 0 });
		const probes = memoryProbes({
			worktrees: [main, wt],
			branches: new Map([[wt, rec.claimBranch]]),
			now: () => 1,
			platform: "darwin",
		});
		probes.files.set(sessionRecordPath(main, "rv"), JSON.stringify(rec));
		const ctx: SessionEvaluatorContext = {
			inventory: { identities: [sessionIdentityOf(rec)] },
			mainRepo: main,
		};
		assert.equal(revalidateChangedRoot(ctx, main, probes), undefined);
		const hit = revalidateChangedRoot(ctx, wt, probes);
		assert.ok(hit);
		assert.equal(hit.leg, "fallback");
	});
});

describe("identitiesEqual / captureEvaluatorContext non-linux", () => {
	it("compares resolved paths", () => {
		assert.equal(identitiesEqual({ sessionId: "a", claimedItem: "1", claimBranch: "feat/1", worktreePath: "/tmp/x" }, { sessionId: "a", claimedItem: "1", claimBranch: "feat/1", worktreePath: "/tmp/x/../x" }), true);
	});

	it("non-linux capture leaves starttime unset", () => {
		const main = makeMain();
		try {
			const ctx = captureEvaluatorContext(main, { platform: "darwin" });
			assert.equal(ctx.starttimeJiffies, undefined);
			assert.equal(ctx.mainRepo, resolve(main));
		} finally {
			rmSync(main, { recursive: true, force: true });
		}
	});
});

describe("validateGitClaim", () => {
	it("requires registered worktree, exact branch, and attribution", () => {
		const wt = resolve("/tmp/gc-wt");
		const main = "/tmp/gc-main";
		const rec = baseRecord({ worktreePath: wt, claimBranch: "feat/issue-369-a", claimedItem: "369" });
		const probes = memoryProbes({
			worktrees: [wt],
			branches: new Map([[wt, "feat/issue-369-a"]]),
		});
		assert.equal(validateGitClaim(rec, main, probes), true);
		assert.equal(validateGitClaim(rec, main, { ...probes, gitBranch: () => "feat/other" }), false);
		assert.equal(validateGitClaim(rec, main, { ...probes, gitWorktreeList: () => "" }), false);
	});
});
