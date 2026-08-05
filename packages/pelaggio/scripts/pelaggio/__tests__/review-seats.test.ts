import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { forbiddenRootsForConfinement } from "../confinement/roots.js";
import { authoringReviewSeatPath, authoringReviewSeatsRoot, authoringReviewSeatToken, cleanupAuthoringReviewSeat, cleanupAuthoringReviewSeatsForSha, isAuthoringReviewSeatPath, prepareAuthoringReviewSeat } from "../review/seats.js";
import { isReviewHeadPath } from "../review-sweep.js";

describe("authoring review seats (#269)", () => {
	it("derives a deterministic path under .dev/authoring-review-seats/<sha>/", () => {
		const repo = "/tmp/main-repo";
		assert.equal(authoringReviewSeatsRoot(repo), join(repo, ".dev", "authoring-review-seats"));
		const token = authoringReviewSeatToken("grok");
		assert.equal(authoringReviewSeatPath(repo, { sha: "abc1234", seatId: "grok", pass: 1 }), join(repo, ".dev", "authoring-review-seats", "abc1234", `${token}-p1`));
	});

	it("encodes seat ids collision-resistant (no lossy collapsing)", () => {
		const a = authoringReviewSeatPath("/r", { sha: "deadbeef", seatId: "a/b", pass: 2 });
		const b = authoringReviewSeatPath("/r", { sha: "deadbeef", seatId: "a-b", pass: 2 });
		assert.notEqual(a, b);
		assert.equal(a, join("/r", ".dev", "authoring-review-seats", "deadbeef", `${authoringReviewSeatToken("a/b")}-p2`));
		assert.equal(b, join("/r", ".dev", "authoring-review-seats", "deadbeef", `${authoringReviewSeatToken("a-b")}-p2`));
		// base64url is injective: same id always same token.
		assert.equal(authoringReviewSeatToken("grok"), authoringReviewSeatToken("grok"));
		assert.notEqual(authoringReviewSeatToken("grok"), authoringReviewSeatToken("codex"));
	});

	it("recognizes seat paths for confinement exemption", () => {
		const repo = "/tmp/main-repo";
		const seat = authoringReviewSeatPath(repo, { sha: "abc1234", seatId: "codex", pass: 1 });
		assert.equal(isAuthoringReviewSeatPath(seat, repo), true);
		assert.equal(isAuthoringReviewSeatPath(join(seat, "nested"), repo), true);
		assert.equal(isAuthoringReviewSeatPath(join(repo, "packages", "pelaggio"), repo), false);
		assert.equal(isAuthoringReviewSeatPath(join(repo, ".dev", "review-heads", "abc"), repo), false);
	});

	// #131 confinement interaction (grok's blocker): a peer seat's dirty cwd must
	// NOT enter the forbidden-root set, or a concurrent reviewer trips
	// error_confinement. A refactor of forbiddenRoots* that drops the
	// isAuthoringReviewSeatPath exemption must fail here.
	it("EXCLUDES peer authoring-review seats AND review-head worktrees from the confinement forbidden-root set (#269/#308)", () => {
		const repo = "/tmp/main-repo";
		const mySeat = authoringReviewSeatPath(repo, { sha: "abc1234", seatId: "grok", pass: 1 });
		const peerSeat = authoringReviewSeatPath(repo, { sha: "abc1234", seatId: "codex", pass: 1 });
		const reviewHead = join(repo, ".dev", "review-heads", "deadbeefcafe");
		const siblingWorktree = "/tmp/claude-autopilot-99";
		// Candidate roots the audit would enumerate: mainRepo, a real sibling worktree, both seats
		// (mine as cwd, the peer as a dirty concurrent seat), and a throwaway PR-head review worktree.
		const roots = forbiddenRootsForConfinement({
			cwd: mySeat,
			mainRepo: repo,
			worktrees: [repo, siblingWorktree, mySeat, peerSeat, reviewHead],
			isEphemeralReviewWorktree: (root) => isAuthoringReviewSeatPath(root, repo) || isReviewHeadPath(root, repo),
		});
		// The peer seat is NOT forbidden — a dirty peer seat cannot cause error_confinement.
		assert.ok(!roots.includes(peerSeat), "peer seat must be exempt from confinement");
		// My own seat (cwd) is also not forbidden (exempt as cwd).
		assert.ok(!roots.includes(mySeat), "own seat cwd must be exempt");
		// #308: a review-head worktree is a throwaway harness checkout — exempt like a seat.
		assert.ok(!roots.includes(reviewHead), "review-head worktree must be exempt from confinement");
		// A genuine sibling worktree IS still forbidden — the exemption is scoped to harness checkouts.
		assert.ok(roots.includes(siblingWorktree), "real sibling worktree stays forbidden");
	});

	// #369: record-derived exemptions are a separate input from activeWorktrees; main is
	// filtered from sessionWorktrees only (defense in depth); allowDirtyMain unchanged.
	it("sessionWorktrees exempt peers but never main; allowDirtyMain still independent (#369)", () => {
		const repo = "/tmp/main-repo";
		const peer = "/tmp/claude-autopilot-peer";
		const other = "/tmp/claude-autopilot-other";
		const roots = forbiddenRootsForConfinement({
			cwd: "/tmp/me",
			mainRepo: repo,
			worktrees: [repo, peer, other],
			isEphemeralReviewWorktree: () => false,
			sessionWorktrees: [peer, repo], // smuggle main
		});
		assert.ok(!roots.includes(peer), "session-derived peer exempt");
		assert.ok(roots.includes(repo), "main stays forbidden despite sessionWorktrees");
		assert.ok(roots.includes(other), "non-exempt sibling stays forbidden");

		const dirtyMain = forbiddenRootsForConfinement({
			cwd: "/tmp/me",
			mainRepo: repo,
			worktrees: [repo, other],
			allowDirtyMain: true,
			isEphemeralReviewWorktree: () => false,
			activeWorktrees: [],
			sessionWorktrees: [],
		});
		assert.ok(!dirtyMain.includes(repo), "allowDirtyMain still drops main");
		assert.ok(dirtyMain.includes(other));
	});

	it("isReviewHeadPath recognizes .dev/review-heads/ paths but not real worktrees (#308)", () => {
		const repo = "/tmp/main-repo";
		assert.equal(isReviewHeadPath(join(repo, ".dev", "review-heads", "abc123"), repo), true);
		assert.equal(isReviewHeadPath(join(repo, ".dev", "review-heads", "abc123", "src"), repo), true);
		assert.equal(isReviewHeadPath(join(repo, ".dev", "review-heads"), repo), true);
		assert.equal(isReviewHeadPath(join(repo, "packages", "pelaggio"), repo), false);
		assert.equal(isReviewHeadPath(authoringReviewSeatPath(repo, { sha: "abc", seatId: "x", pass: 1 }), repo), false);
	});

	it("prepare creates a detached worktree once and validates before reuse", () => {
		const repo = mkdtempSync(join(tmpdir(), "authoring-seat-"));
		const key = { sha: "abc1234def", seatId: "grok", pass: 1 };
		const path = authoringReviewSeatPath(repo, key);
		const cmds: string[][] = [];
		const out1 = prepareAuthoringReviewSeat(repo, key, (args) => {
			cmds.push(args);
			if (args[0] === "worktree" && args[1] === "add") mkdirSync(path, { recursive: true });
			return "";
		});
		assert.equal(out1, path);
		assert.deepEqual(cmds, [["worktree", "add", "--detach", path, "abc1234def"]]);

		// Second call: path exists → validate (worktree list + rev-parse + status)
		// and, when valid+clean+pinned, reuse without re-adding.
		const cmds2: string[][] = [];
		const out2 = prepareAuthoringReviewSeat(repo, key, (args, cwd) => {
			cmds2.push(args);
			if (args[0] === "worktree" && args[1] === "list") return [`worktree ${path}`, "HEAD abc1234def", "detached", ""].join("\n");
			if (args[0] === "rev-parse") {
				assert.equal(cwd, path);
				return "abc1234def\n";
			}
			if (args[0] === "status") return "";
			return "";
		});
		assert.equal(out2, path);
		// No `worktree add` on reuse.
		assert.ok(!cmds2.some((a) => a[0] === "worktree" && a[1] === "add"));
		rmSync(repo, { recursive: true, force: true });
	});

	it("prepare recreates a dirty/stale seat (crash-recovery: fail-closed to a correct seat)", () => {
		const repo = mkdtempSync(join(tmpdir(), "authoring-seat-stale-"));
		const key = { sha: "abc1234def", seatId: "grok", pass: 1 };
		const path = authoringReviewSeatPath(repo, key);
		// Simulate a leftover dir from a crashed pass.
		mkdirSync(path, { recursive: true });
		const cmds: string[][] = [];
		const out = prepareAuthoringReviewSeat(repo, key, (args) => {
			cmds.push(args);
			if (args[0] === "worktree" && args[1] === "list") return [`worktree ${path}`, "HEAD abc1234def", "detached", ""].join("\n");
			if (args[0] === "rev-parse") return "abc1234def\n";
			// Dirty tree — a stray edit from the crashed pass.
			if (args[0] === "status") return " M packages/x.ts\n";
			return "";
		});
		assert.equal(out, path);
		// Validation ran, found it dirty, removed, then re-added.
		assert.ok(
			cmds.some((a) => a[0] === "worktree" && a[1] === "list"),
			"should validate registration",
		);
		assert.ok(
			cmds.some((a) => a[0] === "status"),
			"should check working-tree status",
		);
		const removeIdx = cmds.findIndex((a) => a[0] === "worktree" && a[1] === "remove");
		const addIdx = cmds.findIndex((a) => a[0] === "worktree" && a[1] === "add");
		assert.ok(removeIdx !== -1, "dirty seat must be force-removed");
		assert.ok(addIdx !== -1, "seat must be re-added");
		assert.ok(removeIdx < addIdx, "remove precedes re-add");
		assert.deepEqual(cmds[removeIdx], ["worktree", "remove", "--force", path]);
		assert.deepEqual(cmds[addIdx], ["worktree", "add", "--detach", path, "abc1234def"]);
		rmSync(repo, { recursive: true, force: true });
	});

	it("prepare recreates an unregistered leftover dir (partial create)", () => {
		const repo = mkdtempSync(join(tmpdir(), "authoring-seat-unreg-"));
		const key = { sha: "abc1234def", seatId: "grok", pass: 1 };
		const path = authoringReviewSeatPath(repo, key);
		mkdirSync(path, { recursive: true });
		const cmds: string[][] = [];
		prepareAuthoringReviewSeat(repo, key, (args) => {
			cmds.push(args);
			// Not in the worktree list → unregistered leftover.
			if (args[0] === "worktree" && args[1] === "list") return [`worktree ${repo}`, "HEAD main", ""].join("\n");
			// `worktree remove` refuses an unregistered dir → prune + rmSync fallback.
			if (args[0] === "worktree" && args[1] === "remove") throw new Error("not a working tree");
			return "";
		});
		const seq = cmds.map((a) => `${a[0]}:${a[1] ?? ""}`);
		assert.ok(seq.includes("worktree:remove"), "attempts force-remove");
		assert.ok(seq.includes("worktree:prune"), "prunes stale admin state on remove failure");
		assert.ok(seq.includes("worktree:add"), "re-adds after cleanup");
		rmSync(repo, { recursive: true, force: true });
	});

	it("prepare recreates when HEAD drifts off the reviewed sha", () => {
		const repo = mkdtempSync(join(tmpdir(), "authoring-seat-drift-"));
		const key = { sha: "abc1234def", seatId: "grok", pass: 1 };
		const path = authoringReviewSeatPath(repo, key);
		mkdirSync(path, { recursive: true });
		const cmds: string[][] = [];
		prepareAuthoringReviewSeat(repo, key, (args) => {
			cmds.push(args);
			if (args[0] === "worktree" && args[1] === "list") return [`worktree ${path}`, "HEAD abc1234def", "detached", ""].join("\n");
			// HEAD points elsewhere → not pinned → recreate.
			if (args[0] === "rev-parse") return "0000000feedface\n";
			return "";
		});
		assert.ok(
			cmds.some((a) => a[0] === "worktree" && a[1] === "remove"),
			"wrong-HEAD seat force-removed",
		);
		assert.ok(
			cmds.some((a) => a[0] === "worktree" && a[1] === "add"),
			"re-added pinned to sha",
		);
		rmSync(repo, { recursive: true, force: true });
	});

	it("prepare rejects a non-hex sha fail-closed", () => {
		const repo = mkdtempSync(join(tmpdir(), "authoring-seat-bad-"));
		assert.throws(() => prepareAuthoringReviewSeat(repo, { sha: "not-a-sha", seatId: "x", pass: 1 }, () => ""), /invalid reviewed sha/);
		rmSync(repo, { recursive: true, force: true });
	});

	it("cleanup removes a seat worktree when present", () => {
		const repo = mkdtempSync(join(tmpdir(), "authoring-seat-clean-"));
		const key = { sha: "abc1234", seatId: "claude", pass: 1 };
		const path = authoringReviewSeatPath(repo, key);
		mkdirSync(path, { recursive: true });
		const cmds: string[][] = [];
		cleanupAuthoringReviewSeat(repo, key, (args) => {
			cmds.push(args);
			return "";
		});
		assert.deepEqual(cmds, [["worktree", "remove", "--force", path]]);
		rmSync(repo, { recursive: true, force: true });
	});

	it("cleanupAuthoringReviewSeatsForSha removes every registered seat under the sha", () => {
		const repo = mkdtempSync(join(tmpdir(), "authoring-seat-sha-"));
		const sha = "abcdef1";
		const a = authoringReviewSeatPath(repo, { sha, seatId: "a", pass: 1 });
		const b = authoringReviewSeatPath(repo, { sha, seatId: "b", pass: 1 });
		const other = authoringReviewSeatPath(repo, { sha: "other", seatId: "c", pass: 1 });
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });
		mkdirSync(other, { recursive: true });
		const cmds: string[][] = [];
		cleanupAuthoringReviewSeatsForSha(repo, sha, (args) => {
			cmds.push(args);
			if (args[0] === "worktree" && args[1] === "list") {
				return [`worktree ${a}`, "HEAD abc", "", `worktree ${b}`, "HEAD abc", "", `worktree ${other}`, "HEAD def", "", `worktree ${repo}`, "HEAD main", ""].join("\n");
			}
			return "";
		});
		assert.deepEqual(cmds[0], ["worktree", "list", "--porcelain"]);
		assert.ok(cmds.some((c) => c[0] === "worktree" && c[1] === "remove" && c[3] === a));
		assert.ok(cmds.some((c) => c[0] === "worktree" && c[1] === "remove" && c[3] === b));
		assert.ok(!cmds.some((c) => c[3] === other));
		rmSync(repo, { recursive: true, force: true });
	});

	it("cleanup is fail-soft when git throws", () => {
		const repo = mkdtempSync(join(tmpdir(), "authoring-seat-soft-"));
		const key = { sha: "abc1234", seatId: "x", pass: 1 };
		mkdirSync(authoringReviewSeatPath(repo, key), { recursive: true });
		assert.doesNotThrow(() =>
			cleanupAuthoringReviewSeat(repo, key, () => {
				throw new Error("locked");
			}),
		);
		assert.doesNotThrow(() =>
			cleanupAuthoringReviewSeatsForSha(repo, key.sha, () => {
				throw new Error("locked");
			}),
		);
		rmSync(repo, { recursive: true, force: true });
	});

	// Smoke: a marker file under the seat dir proves the path is a real directory the
	// harness can hand to a concurrent seat without touching the artifact worktree.
	it("seat path is independent of the artifact worktree path", () => {
		const main = "/home/chris/workspace/claude-autopilot";
		const artifact = "/home/chris/workspace/claude-autopilot-269";
		const seat = authoringReviewSeatPath(main, { sha: "deadbeef", seatId: "grok", pass: 1 });
		assert.notEqual(seat, artifact);
		assert.ok(seat.startsWith(join(main, ".dev", "authoring-review-seats")));
		// Touch a fake seat dir without git to confirm path layout.
		const repo = mkdtempSync(join(tmpdir(), "authoring-seat-layout-"));
		const local = authoringReviewSeatPath(repo, { sha: "deadbeef", seatId: "grok", pass: 1 });
		mkdirSync(local, { recursive: true });
		writeFileSync(join(local, "marker.txt"), "ok");
		assert.ok(isAuthoringReviewSeatPath(local, repo));
		assert.ok(existsSync(local));
		rmSync(repo, { recursive: true, force: true });
	});
});

// #435: `pick` runs with cwd === mainRepo but has a read-only main-tree contract. The
// pure helper carries the opt-in (auditCwd) that audits the step's own cwd instead of
// exempting it; the pipeline pairs it with a forced allowDirtyMain:false for pick.
describe("cwd-audit opt-in for a main-cwd read-only step (#435)", () => {
	const repo = "/tmp/main-repo";

	it("keeps cwd exempt by default (unchanged contract for every existing caller)", () => {
		const roots = forbiddenRootsForConfinement({
			cwd: repo,
			mainRepo: repo,
			worktrees: [repo],
			isEphemeralReviewWorktree: () => false,
		});
		assert.ok(!roots.includes(repo), "cwd (main) stays exempt when auditCwd is unset");
	});

	it("audits cwd (main) when opted in, even though it is the step cwd", () => {
		const roots = forbiddenRootsForConfinement({
			cwd: repo,
			mainRepo: repo,
			worktrees: [repo],
			auditCwd: true,
			allowDirtyMain: false,
			isEphemeralReviewWorktree: () => false,
		});
		assert.ok(roots.includes(repo), "opted-in cwd (main) is audited");
	});

	it("main cannot be dropped by allowDirtyMain under the pipeline's forced-off value", () => {
		// The allowDirtyMain branch is orthogonal to auditCwd, so a caller that left
		// allowDirtyMain:true would reopen the #435 hole. The pipeline prevents this by
		// pairing auditCwd:true with a forced allowDirtyMain:false (see forbiddenRootsForStep).
		const hole = forbiddenRootsForConfinement({ cwd: repo, mainRepo: repo, worktrees: [repo], auditCwd: true, allowDirtyMain: true, isEphemeralReviewWorktree: () => false });
		assert.ok(!hole.includes(repo), "raw allowDirtyMain:true still drops main — hence the pipeline forces it off");
		const gated = forbiddenRootsForConfinement({ cwd: repo, mainRepo: repo, worktrees: [repo], auditCwd: true, allowDirtyMain: false, isEphemeralReviewWorktree: () => false });
		assert.ok(gated.includes(repo), "the pipeline's forced allowDirtyMain:false keeps main audited");
	});

	it("still exempts ownWorktree and active peers while auditing cwd (independent filters intact)", () => {
		const own = "/tmp/claude-autopilot-435";
		const peer = "/tmp/claude-autopilot-peer";
		const roots = forbiddenRootsForConfinement({
			cwd: repo,
			mainRepo: repo,
			worktrees: [repo, own, peer],
			auditCwd: true,
			allowDirtyMain: false,
			ownWorktree: own,
			activeWorktrees: [peer],
			isEphemeralReviewWorktree: () => false,
		});
		assert.ok(roots.includes(repo), "main is audited");
		assert.ok(!roots.includes(own), "ownWorktree stays exempt");
		assert.ok(!roots.includes(peer), "active peer stays exempt");
	});
});
