import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { authoringReviewSeatPath, authoringReviewSeatsRoot, cleanupAuthoringReviewSeat, type GitExec, prepareAuthoringReviewSeat } from "../review/seats.js";
import { ensureWorktreeDeps } from "../worktree-deps.js";

const YAML_ID = "host-yaml-v1";

function plantYaml(nm: string, id: string): void {
	const pkgDir = join(nm, ".pnpm", "yaml@2.8.0", "node_modules", "yaml");
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "yaml", version: "2.8.0", main: "index.js" }));
	writeFileSync(join(pkgDir, "index.js"), `module.exports = { id: ${JSON.stringify(id)} };\n`);
	symlinkSync(pkgDir, join(nm, "yaml"), "dir");
}

function lockfile(): string {
	return "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages: {}\n";
}

function resolveYaml(checkout: string): string {
	return createRequire(join(checkout, "package.json")).resolve("yaml");
}

function snapshotLinkTargets(nm: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const p = join(dir, entry);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(p);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) {
				out.set(p, readlinkSync(p));
			} else if (stat.isDirectory() && (entry.startsWith("@") || entry === ".pnpm")) {
				walk(p);
			}
		}
	};
	walk(nm);
	return out;
}

function assertMapsEqual(before: Map<string, string>, after: Map<string, string>, label: string): void {
	assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(), label);
}

function symlinkTargetsUnder(root: string, forbidden: string): string[] {
	const hits: string[] = [];
	const prefix = resolve(forbidden) + sep;
	const forbiddenAbs = resolve(forbidden);
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const p = join(dir, entry);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(p);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) {
				const abs = resolve(dirname(p), readlinkSync(p));
				if (abs === forbiddenAbs || abs.startsWith(prefix)) hits.push(p);
			} else if (stat.isDirectory()) {
				walk(p);
			}
		}
	};
	walk(root);
	return hits;
}

interface Fixture {
	root: string;
	host: string;
	claim: string;
	key: { sha: string; seatId: string; pass: number };
	seat: string;
	hostYaml: string;
	hostLinks: Map<string, string>;
}

function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "authoring-review-seat-ac-"));
	const host = resolve(root, "host");
	const claim = resolve(root, "claim");
	mkdirSync(host, { recursive: true });
	mkdirSync(claim, { recursive: true });
	writeFileSync(join(host, "package.json"), JSON.stringify({ name: "host", private: true }));
	writeFileSync(join(claim, "package.json"), JSON.stringify({ name: "claim", private: true }));
	writeFileSync(join(host, "pnpm-lock.yaml"), lockfile());
	writeFileSync(join(claim, "pnpm-lock.yaml"), lockfile());
	const hostNm = join(host, "node_modules");
	mkdirSync(hostNm, { recursive: true });
	plantYaml(hostNm, YAML_ID);
	symlinkSync(hostNm, join(claim, "node_modules"), "dir");
	const key = { sha: "abc1234def", seatId: "grok", pass: 1 };
	return {
		root,
		host,
		claim,
		key,
		seat: authoringReviewSeatPath(host, key),
		hostYaml: resolveYaml(host),
		hostLinks: snapshotLinkTargets(hostNm),
	};
}

function fakeGit(fx: Fixture): GitExec {
	return (args) => {
		if (args[0] === "worktree" && args[1] === "add") {
			mkdirSync(fx.seat, { recursive: true });
			writeFileSync(join(fx.seat, "pnpm-lock.yaml"), lockfile());
			writeFileSync(join(fx.seat, "package.json"), JSON.stringify({ name: "seat", private: true }));
			return "";
		}
		if (args[0] === "worktree" && args[1] === "list") {
			return existsSync(fx.seat) ? [`worktree ${fx.seat}`, `HEAD ${fx.key.sha}`, "detached", ""].join("\n") : `worktree ${fx.host}\n`;
		}
		if (args[0] === "rev-parse") return `${fx.key.sha}\n`;
		if (args[0] === "status") return "";
		if (args[0] === "worktree" && args[1] === "remove") {
			const target = args[3] ?? fx.seat;
			rmSync(target, { recursive: true, force: true });
			return "";
		}
		return "";
	};
}

function plantSeatLayout(seat: string): void {
	const nm = join(seat, "node_modules");
	mkdirSync(nm, { recursive: true });
	plantYaml(nm, "seat-private-yaml");
}

function provisionViaChokepoint(fx: Fixture): (seatPath: string) => void {
	return (seatPath) => {
		ensureWorktreeDeps(seatPath, fx.host, {
			runner: {
				run: (cmd, cwd, options) => {
					assert.equal(cmd, "corepack");
					assert.equal(cwd, seatPath);
					assert.match(options?.args?.[0] ?? "", /^pnpm@11\.18\.0\+sha512\./);
					assert.deepEqual(options?.args?.slice(1, 4), ["--dir", realpathSync(seatPath), "install"]);
					assert.ok(options?.args?.includes("--frozen-lockfile"));
					assert.ok(options?.args?.includes("--ignore-scripts"));
					assert.equal(options?.env?.COREPACK_ENV_FILE, "0");
					plantSeatLayout(cwd);
				},
			},
		});
	};
}

function assertHostUntouched(fx: Fixture, phase: string): void {
	assert.equal(resolveYaml(fx.host), fx.hostYaml, `${phase}: host yaml resolve`);
	assert.equal(resolveYaml(fx.claim), fx.hostYaml, `${phase}: claim yaml resolve`);
	assertMapsEqual(fx.hostLinks, snapshotLinkTargets(join(fx.host, "node_modules")), `${phase}: host link targets`);
	assert.equal(createRequire(join(fx.host, "package.json"))("yaml").id, YAML_ID, `${phase}: host yaml identity`);
}

describe("authoring review seat private dependencies (#647)", () => {
	it("restores the host checkout's dependency links on teardown", () => {
		const fx = makeFixture();
		try {
			assertHostUntouched(fx, "before prepare");
			prepareAuthoringReviewSeat(fx.host, fx.key, { gitExec: fakeGit(fx), provisionDeps: provisionViaChokepoint(fx) });
			assertHostUntouched(fx, "after successful provision");
			assert.ok(existsSync(join(fx.seat, "node_modules", ".pnpm")));
			assert.equal(lstatSync(join(fx.seat, "node_modules")).isSymbolicLink(), false);

			const seatYaml = join(fx.seat, "node_modules", "yaml");
			rmSync(seatYaml, { force: true });
			symlinkSync(join(fx.seat, "node_modules", ".pnpm", "rewritten"), seatYaml, "dir");
			assertHostUntouched(fx, "after mutating only seat links");

			cleanupAuthoringReviewSeat(fx.host, fx.key, fakeGit(fx));
			assertHostUntouched(fx, "after successful cleanup");
			assert.equal(existsSync(fx.seat), false);

			assert.throws(
				() =>
					prepareAuthoringReviewSeat(fx.host, fx.key, {
						gitExec: fakeGit(fx),
						provisionDeps: () => {
							throw new Error("provision boom");
						},
					}),
				/provision boom/,
			);
			assertHostUntouched(fx, "after thrown-seat path");
			assert.equal(existsSync(fx.seat), false);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("a pruned seat directory does not dangle a host checkout", () => {
		const fx = makeFixture();
		try {
			prepareAuthoringReviewSeat(fx.host, fx.key, { gitExec: fakeGit(fx), provisionDeps: provisionViaChokepoint(fx) });
			const seatYaml = join(fx.seat, "node_modules", "yaml");
			rmSync(seatYaml, { force: true });
			symlinkSync(join(fx.seat, "node_modules", ".pnpm", "rewritten"), seatYaml, "dir");
			assertHostUntouched(fx, "before prune");

			const seatRoot = resolve(authoringReviewSeatsRoot(fx.host), fx.key.sha);
			rmSync(seatRoot, { recursive: true, force: true });
			assert.equal(existsSync(fx.seat), false);

			assert.equal(resolveYaml(fx.host), fx.hostYaml);
			assert.equal(resolveYaml(fx.claim), fx.hostYaml);
			assert.equal(createRequire(join(fx.host, "package.json"))("yaml").id, YAML_ID);
			assert.equal(createRequire(join(fx.claim, "package.json"))("yaml").id, YAML_ID);
			assert.deepEqual(symlinkTargetsUnder(fx.host, seatRoot), []);
			assert.deepEqual(symlinkTargetsUnder(fx.claim, seatRoot), []);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});
});
