import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { countLeaked, FIXTURE_MARKER, FIXTURE_MARKER_TOOL, FIXTURE_ROOT_BASENAME, main, OWNERS_DIRNAME, reapTestTmp } from "../reap-test-tmp.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const isRoot = process.getuid?.() === 0;

const bases: string[] = [];
after(() => {
	for (const base of bases.splice(0)) {
		try {
			rmSync(base, { recursive: true, force: true });
		} catch {
			// a mode-000 test dir may need a chmod pass; best effort
		}
	}
});

/**
 * A fake tmp base so the tests never touch the host's real /tmp population. Exempt from
 * the `makeTestTmpDir` rule (this ci reaper test cannot import the pelaggio-package helper
 * until the deferred cross-package shared-location decision from #579 lands); cleaned via
 * `after`, and `reap-test-tmp-` is a generic prefix the default reaper never sweeps, so a
 * hard kill leak here is not swept as collateral either.
 */
function makeBase(): string {
	const base = mkdtempSync(join(tmpdir(), "reap-test-tmp-"));
	bases.push(base);
	return base;
}

const OLD = new Date(Date.now() - 24 * 60 * 60 * 1000);

function setOld(path: string): void {
	utimesSync(path, OLD, OLD);
}

function makeOldDir(path: string): string {
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "payload"), "x");
	setOld(path);
	return path;
}

/** A top-level old dir carrying the fixture marker (optionally recording an owner PID). */
function makeOldMarkedDir(path: string, pid?: number): string {
	makeOldDir(path);
	writeFileSync(join(path, FIXTURE_MARKER), JSON.stringify(pid === undefined ? { tool: FIXTURE_MARKER_TOOL } : { tool: FIXTURE_MARKER_TOOL, pid }));
	setOld(path);
	return path;
}

function stampRoot(base: string): string {
	const root = join(base, FIXTURE_ROOT_BASENAME);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, FIXTURE_MARKER), JSON.stringify({ tool: FIXTURE_MARKER_TOOL, pid: process.pid }));
	return root;
}

/** An old contained fixture under the root, optionally with an `.owners/` PID sidecar. */
function makeOldContained(base: string, name: string, pid?: number): string {
	const root = stampRoot(base);
	const dir = makeOldDir(join(root, name));
	if (pid !== undefined) writeSidecar(base, name, pid);
	return dir;
}

function ownersDir(base: string): string {
	return join(base, FIXTURE_ROOT_BASENAME, OWNERS_DIRNAME);
}

function writeSidecar(base: string, name: string, pid: number): string {
	const dir = ownersDir(base);
	mkdirSync(dir, { recursive: true });
	const sidecar = join(dir, name);
	writeFileSync(sidecar, JSON.stringify({ pid }));
	return sidecar;
}

/** A PID that is reliably dead: a child that has already exited by the time spawnSync returns. */
function deadPid(): number {
	return spawnSync(process.execPath, ["-e", ""]).pid ?? 2147483646;
}

describe("reap-test-tmp", () => {
	it("reaps contained fixtures by default; leaves unmarked top-level prefixes", () => {
		const base = makeBase();
		const fixtureRoot = stampRoot(base);
		const oldFixture = makeOldContained(base, "pelaggio-roadmap-test-abc123", deadPid());
		const freshFixture = join(fixtureRoot, "pelaggio-roadmap-test-def456");
		mkdirSync(freshFixture, { recursive: true });
		writeSidecar(base, "pelaggio-roadmap-test-def456", process.pid);
		// Unmarked top-level prefixes (namespaced + generic) are NOT default-eligible.
		const namespacedTop = makeOldDir(join(base, "pelaggio-config-test-AbC123"));
		const notOurs = makeOldDir(join(base, "someone-elses-app-XYZ123"));
		const badSuffix = makeOldDir(join(base, "pelaggio-config-test-toolong1"));
		const fileNotDir = join(base, "pelaggio-config-test-QqQqQq");
		writeFileSync(fileNotDir, "not a dir");
		setOld(fileNotDir);

		const result = reapTestTmp({ base });

		assert.deepEqual(result.removed, [oldFixture]);
		assert.equal(result.errors, 0);
		assert.equal(result.refused.length, 0);
		assert.equal(existsSync(oldFixture), false);
		assert.equal(existsSync(freshFixture), true);
		assert.equal(existsSync(namespacedTop), true, "unmarked namespaced top-level is never eligible");
		assert.equal(existsSync(notOurs), true);
		assert.equal(existsSync(badSuffix), true);
		assert.equal(existsSync(fileNotDir), true);
	});

	it("refuses an unmarked predictable fixture root and leaves its contents untouched", () => {
		const base = makeBase();
		const root = join(base, FIXTURE_ROOT_BASENAME);
		const child = makeOldDir(join(root, "pelaggio-roadmap-test-abc123"));
		writeSidecar(base, "pelaggio-roadmap-test-abc123", deadPid());

		const result = reapTestTmp({ base });

		assert.deepEqual(result.removed, []);
		assert.deepEqual(result.refused, [root]);
		assert.equal(existsSync(child), true);
		const scan = countLeaked(base);
		assert.equal(scan.scanned, false, "--check must not report green for an untrusted root");
	});

	it("reaps a marker-carrying dir regardless of its name", () => {
		const base = makeBase();
		const marked = makeOldMarkedDir(join(base, "some-unknown-tool-AbC123"), deadPid());
		const result = reapTestTmp({ base });
		assert.deepEqual(result.removed, [marked]);
		assert.equal(existsSync(marked), false);
	});

	it("never reaps unmarked namespaced or generic dirs", () => {
		const base = makeBase();
		const hermetic = makeOldDir(join(base, "pelaggio-hermetic-XxXxXx")); // namespaced, unmarked
		const generic = makeOldDir(join(base, "app-test-YyYyYy")); // generic, unmarked
		const marked = makeOldMarkedDir(join(base, "pelaggio-hermetic-Mark11"), deadPid());

		const result = reapTestTmp({ base });
		assert.deepEqual(result.removed, [marked], "reaps only the marked dir");
		assert.equal(existsSync(hermetic), true, "live-capable unmarked namespaced dir must survive the default hook");
		assert.equal(existsSync(generic), true);
	});

	it("skips a live-PID marked dir regardless of age, reaps a dead-PID one", () => {
		const base = makeBase();
		const live = makeOldMarkedDir(join(base, "some-tool-LiVe11"), process.pid);
		const dead = makeOldMarkedDir(join(base, "some-tool-DeAd22"), deadPid());

		const result = reapTestTmp({ base });

		assert.equal(result.skippedLive, 1);
		assert.deepEqual(result.removed, [dead]);
		assert.equal(existsSync(live), true, "live-owner fixture must be kept");
		assert.equal(existsSync(dead), false);
	});

	it("skips a live-PID contained fixture, reaps a dead-PID one", () => {
		const base = makeBase();
		const liveDir = makeOldContained(base, "pelaggio-roadmap-test-LiVe11", process.pid);
		const deadDir = makeOldContained(base, "pelaggio-roadmap-test-DeAd22", deadPid());

		const result = reapTestTmp({ base });

		assert.deepEqual(result.removed, [deadDir]);
		assert.equal(existsSync(liveDir), true, "live-owner contained fixture must be kept");
		assert.equal(existsSync(deadDir), false);
	});

	it("preserves a contained dir with no trustworthy owner record", () => {
		const base = makeBase();
		const legacyDir = makeOldContained(base, "pelaggio-roadmap-test-Leg333");
		const result = reapTestTmp({ base });
		assert.deepEqual(result.removed, []);
		assert.deepEqual(result.refused, [legacyDir]);
		assert.equal(existsSync(legacyDir), true);
	});

	it("preserves an unreadable or malformed owner record", () => {
		const base = makeBase();
		const fixture = makeOldContained(base, "pelaggio-roadmap-test-Bad111", deadPid());
		writeFileSync(join(ownersDir(base), "pelaggio-roadmap-test-Bad111"), "not json");

		const result = reapTestTmp({ base });

		assert.deepEqual(result.removed, []);
		assert.deepEqual(result.refused, [fixture]);
		assert.equal(existsSync(fixture), true);
	});

	// MUST-FIX 3 (round 2): a mode-000 descendant must not wedge rmSync forever.
	it("recovers from a mode-000 descendant (chmod + retry) and removes the fixture", () => {
		if (isRoot) return; // root ignores mode bits
		const base = makeBase();
		const fixture = makeOldContained(base, "pelaggio-daylog-noaccess-Md0000", deadPid());
		const locked = join(fixture, "locked");
		mkdirSync(locked);
		writeFileSync(join(locked, "inner"), "x");
		chmodSync(locked, 0o000);
		setOld(fixture);

		const result = reapTestTmp({ base });

		assert.equal(result.errors, 0, "chmod-recovery should delete cleanly");
		assert.deepEqual(result.removed, [fixture]);
		assert.equal(existsSync(fixture), false);
	});

	it("respects the age threshold", () => {
		const base = makeBase();
		const dir = makeOldContained(base, "pelaggio-helpers-test-aaa111", deadPid());
		const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
		const kept = reapTestTmp({ base, maxAgeMs: twoDaysMs });
		assert.deepEqual(kept.removed, []);
		assert.equal(kept.kept, 1);
		assert.equal(existsSync(dir), true);
		const reaped = reapTestTmp({ base, maxAgeMs: 60 * 60 * 1000 });
		assert.deepEqual(reaped.removed, [dir]);
		assert.equal(existsSync(dir), false);
	});

	// FOLD-IN: --dry-run must not mutate anything, including the owner sidecar.
	it("dry-run reports without removing the fixture or its sidecar", () => {
		const base = makeBase();
		const dir = makeOldContained(base, "pelaggio-sync-test-bbb222", deadPid());
		const sidecar = join(ownersDir(base), "pelaggio-sync-test-bbb222");
		const result = reapTestTmp({ base, dryRun: true });
		assert.deepEqual(result.removed, [dir]);
		assert.equal(existsSync(dir), true);
		assert.equal(existsSync(sidecar), true, "dry-run must not remove the sidecar");
	});

	// FOLD-IN: sweep an orphan sidecar (fixture gone) whose owner PID is dead; keep a live one.
	it("sweeps an orphan sidecar with a dead owner, keeps one with a live owner", () => {
		const base = makeBase();
		stampRoot(base);
		const deadSidecar = writeSidecar(base, "pelaggio-roadmap-test-Gone11", deadPid()); // no dir
		const liveSidecar = writeSidecar(base, "pelaggio-roadmap-test-Live11", process.pid); // no dir
		reapTestTmp({ base });
		assert.equal(existsSync(deadSidecar), false, "dead-owner orphan sidecar should be reclaimed");
		assert.equal(existsSync(liveSidecar), true, "live-owner sidecar must be kept");
	});

	it("is fail-open on an unreadable base (reap mode)", () => {
		const result = reapTestTmp({ base: join(makeBase(), "does-not-exist") });
		assert.deepEqual(result.removed, []);
		assert.equal(result.errors, 1);
	});

	it("refuses a symlinked fixture root and leaves the target untouched", () => {
		const base = makeBase();
		const victim = join(base, "victim");
		const victimOld = makeOldDir(join(victim, "pelaggio-roadmap-test-vic111"));
		symlinkSync(victim, join(base, FIXTURE_ROOT_BASENAME));

		const result = reapTestTmp({ base });

		assert.deepEqual(result.removed, []);
		assert.deepEqual(result.refused, [join(base, FIXTURE_ROOT_BASENAME)]);
		assert.equal(existsSync(victimOld), true, "symlink target must be untouched");
	});

	it("CLI exits 0 even when the base is unreadable (reap mode)", () => {
		const out = execFileSync(process.execPath, ["--import", "tsx", join("ci", "reap-test-tmp.ts"), "--base", join(makeBase(), "does-not-exist")], { cwd: repoRoot, encoding: "utf8" });
		assert.match(out, /reaped 0 dir\(s\)/);
	});

	it("countLeaked counts only the default-reap set (containment + marked, old)", () => {
		const base = makeBase();
		makeOldContained(base, "pelaggio-flow-events-old111", deadPid()); // old contained → counted
		mkdirSync(join(base, FIXTURE_ROOT_BASENAME, "pelaggio-flow-events-fresh1"), { recursive: true }); // fresh → not
		writeSidecar(base, "pelaggio-flow-events-fresh1", process.pid);
		makeOldMarkedDir(join(base, "unknown-marked-AbC123"), deadPid()); // old marked → counted
		makeOldDir(join(base, "pelaggio-config-test-cCcC33")); // old unmarked namespaced top-level → not counted
		makeOldDir(join(base, "worktree-deps-test-XyZ999")); // old generic → not counted
		writeFileSync(join(base, "unrelated.txt"), "x");
		const scan = countLeaked(base);
		assert.equal(scan.scanned, true);
		assert.equal(scan.count, 2);
		assert.equal(scan.sample.length, 2);
	});

	it("countLeaked ignores a live-PID contained fixture", () => {
		const base = makeBase();
		makeOldContained(base, "pelaggio-roadmap-test-LiVe11", process.pid);
		const scan = countLeaked(base);
		assert.equal(scan.scanned, true);
		assert.equal(scan.count, 0);
	});

	it("countLeaked fails closed on an unreadable fixture root", () => {
		if (isRoot) return;
		const base = makeBase();
		const root = join(base, FIXTURE_ROOT_BASENAME);
		makeOldContained(base, "pelaggio-roadmap-test-hidden1", deadPid());
		chmodSync(root, 0o000);
		try {
			const scan = countLeaked(base);
			assert.equal(scan.scanned, false);
			assert.ok(scan.error);
		} finally {
			chmodSync(root, 0o700);
		}
	});

	it("countLeaked fails closed on a symlinked fixture root", () => {
		const base = makeBase();
		const victim = join(base, "victim");
		makeOldDir(victim);
		symlinkSync(victim, join(base, FIXTURE_ROOT_BASENAME));
		const scan = countLeaked(base);
		assert.equal(scan.scanned, false);
		assert.ok(scan.error);
	});

	it("countLeaked reports scanned:false on an unreadable base", () => {
		const scan = countLeaked(join(makeBase(), "does-not-exist"));
		assert.equal(scan.scanned, false);
		assert.equal(scan.count, 0);
		assert.ok(scan.error);
	});

	function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
		try {
			const stdout = execFileSync(process.execPath, ["--import", "tsx", join("ci", "reap-test-tmp.ts"), ...args], { cwd: repoRoot, encoding: "utf8" });
			return { status: 0, stdout, stderr: "" };
		} catch (err) {
			const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
			return { status: e.status ?? -1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
		}
	}

	it("--check passes green on a clean base", () => {
		const res = runCli(["--check", "--base", makeBase()]);
		assert.equal(res.status, 0);
		assert.match(res.stdout, /0 leaked test fixture dir\(s\)/);
	});

	it("--check rejects a non-numeric --max-leaked", () => {
		const res = runCli(["--check", "--max-leaked", "not-a-number", "--base", makeBase()]);
		assert.equal(res.status, 2);
		assert.match(res.stderr, /invalid --max-leaked/);
	});

	it("--check rejects a blank --max-leaked", () => {
		const res = runCli(["--check", "--max-leaked", "  ", "--base", makeBase()]);
		assert.equal(res.status, 2);
		assert.match(res.stderr, /invalid --max-leaked/);
	});

	it("--check fails closed on an unreadable base", () => {
		const res = runCli(["--check", "--base", join(makeBase(), "does-not-exist")]);
		assert.equal(res.status, 2);
		assert.match(res.stderr, /could not scan/);
	});

	it("--check fails closed on a symlinked fixture root", () => {
		const base = makeBase();
		const victim = join(base, "victim");
		makeOldDir(victim);
		symlinkSync(victim, join(base, FIXTURE_ROOT_BASENAME));
		const res = runCli(["--check", "--base", base]);
		assert.equal(res.status, 2);
		assert.match(res.stderr, /could not scan/);
	});

	it("--check exits 1 when leaks exceed the threshold", () => {
		const base = makeBase();
		makeOldMarkedDir(join(base, "leak-one-AaAaAa"), deadPid());
		const res = runCli(["--check", "--base", base]);
		assert.equal(res.status, 1);
		assert.match(res.stderr, /1 leaked test fixture dir\(s\)/);
	});

	// MUST-FIX 2: a missing/flag-shaped --base must never fall back to a real /tmp sweep.
	it("rejects a missing --base value with exit 2", () => {
		const res = runCli(["--base"]);
		assert.equal(res.status, 2);
		assert.match(res.stderr, /--base requires a path value/);
	});

	it("rejects a flag-shaped --base value with exit 2", () => {
		const res = runCli(["--base", "--legacy"]);
		assert.equal(res.status, 2);
		assert.match(res.stderr, /--base requires a path value/);
	});

	it("accepts a valid --base path", () => {
		const res = runCli(["--base", makeBase()]);
		assert.equal(res.status, 0);
		assert.match(res.stdout, /reaped 0 dir\(s\)/);
	});

	it("accepts --base=/path without falling back to os.tmpdir()", () => {
		const base = makeBase();
		const res = runCli([`--base=${base}`]);
		assert.equal(res.status, 0);
		assert.match(res.stdout, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	// A following flag must not be swallowed as a value — it is rejected, not defaulted.
	it("rejects a flag-shaped --max-leaked value with exit 2", () => {
		const res = runCli(["--check", "--base", makeBase(), "--max-leaked", "--dry-run"]);
		assert.equal(res.status, 2);
		assert.match(res.stderr, /--max-leaked requires a value/);
	});

	it("rejects --legacy instead of deleting unmarked prefix matches", (t) => {
		const base = makeBase();
		const unmarked = makeOldDir(join(base, "pelaggio-hermetic-XxXxXx"));
		let stderr = "";
		t.mock.method(console, "error", (message) => {
			stderr += String(message);
		});
		assert.equal(main(["--legacy", "--base", base]), 2);
		assert.match(stderr, /--legacy is unsupported/);
		assert.equal(existsSync(unmarked), true);
	});
});
