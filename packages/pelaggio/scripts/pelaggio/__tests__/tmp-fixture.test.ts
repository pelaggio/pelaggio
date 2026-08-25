import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureRoot, fixtureRootBasename, makeTestTmpDir } from "./tmp-fixture.js";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsDir, "..", "..", "..", "..", "..");
const helperPath = join(testsDir, "tmp-fixture.ts");

/** Child that mints a fixture dir and exits; `crash` exercises the uncaught-throw path. */
function runChild(args: { crash?: boolean; env?: Record<string, string> } = {}) {
	const scriptDir = makeTestTmpDir("tmp-fixture-child-");
	const script = join(scriptDir, "child.mjs");
	writeFileSync(
		script,
		[
			`import { makeTestTmpDir } from ${JSON.stringify(helperPath)};`,
			`const dir = makeTestTmpDir("exit-hook-check-");`,
			`import { existsSync } from "node:fs";`,
			`console.log((existsSync(dir) ? "EXISTS " : "MISSING ") + dir);`,
			args.crash ? `throw new Error("boom");` : "",
		].join("\n"),
	);
	return spawnSync(process.execPath, ["--import", "tsx", script], {
		cwd: repoRoot,
		encoding: "utf8",
		env: { ...process.env, ...args.env },
	});
}

function createdDir(stdout: string): string {
	const line = stdout.split("\n").find((l) => l.startsWith("EXISTS "));
	assert.ok(line, `child did not report its fixture dir: ${stdout}`);
	return line.slice("EXISTS ".length).trim();
}

describe("tmp-fixture", () => {
	it("creates attributable dirs under the shared fixture root", () => {
		const a = makeTestTmpDir("tmp-fixture-unit-");
		const b = makeTestTmpDir("tmp-fixture-unit-");
		assert.notEqual(a, b);
		assert.equal(dirname(a), fixtureRoot());
		assert.ok(basename(a).startsWith("tmp-fixture-unit-"));
		assert.equal(existsSync(a), true);
	});

	it("removes created dirs when the process exits normally", () => {
		const child = runChild();
		assert.equal(child.status, 0, child.stderr);
		const dir = createdDir(child.stdout);
		assert.equal(existsSync(dir), false, `leaked: ${dir}`);
	});

	it("removes created dirs even when the process dies on an uncaught throw", () => {
		const child = runChild({ crash: true });
		assert.notEqual(child.status, 0);
		const dir = createdDir(child.stdout);
		assert.equal(existsSync(dir), false, `leaked: ${dir}`);
	});

	it("honors a TMPDIR override", () => {
		const override = makeTestTmpDir("tmp-fixture-tmpdir-");
		const child = runChild({ env: { TMPDIR: override } });
		assert.equal(child.status, 0, child.stderr);
		const dir = createdDir(child.stdout);
		assert.equal(dirname(dirname(dir)), override);
		assert.equal(existsSync(dir), false, `leaked: ${dir}`);
	});

	/** Run `fn` with `os.tmpdir()` pointed at a sandbox we control, then restore `$TMPDIR`. */
	function withTmpdir(sandbox: string, fn: () => void): void {
		const prev = process.env.TMPDIR;
		process.env.TMPDIR = sandbox;
		try {
			fn();
		} finally {
			if (prev === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = prev;
		}
	}

	// MUST-FIX 1: makeTestTmpDir must never adopt a symlink planted at its predictable,
	// world-known root path — a recursively deleting reaper reads from that root.
	it("refuses a symlinked fixture root and never touches the target", () => {
		const sandbox = makeTestTmpDir("tmp-fixture-guard-");
		const target = join(sandbox, "target");
		const canary = join(target, "canary");
		mkdirSync(target, { recursive: true });
		writeFileSync(canary, "precious");
		symlinkSync(target, join(sandbox, fixtureRootBasename()));

		withTmpdir(sandbox, () => {
			assert.throws(() => makeTestTmpDir("x-"), /refusing fixture root/);
		});
		assert.equal(existsSync(canary), true, "symlink target must be untouched");
	});

	it("refuses a non-directory planted at the fixture root path", () => {
		const sandbox = makeTestTmpDir("tmp-fixture-guard-");
		writeFileSync(join(sandbox, fixtureRootBasename()), "not a dir");
		withTmpdir(sandbox, () => {
			assert.throws(() => makeTestTmpDir("x-"), /not a directory/);
		});
	});

	it("refuses an existing unmarked directory at the fixture root path", () => {
		const sandbox = makeTestTmpDir("tmp-fixture-guard-");
		mkdirSync(join(sandbox, fixtureRootBasename()));
		withTmpdir(sandbox, () => {
			assert.throws(() => makeTestTmpDir("x-"), /unmarked or invalid fixture root/);
		});
	});

	it("creates the fixture root mode 0700", () => {
		const sandbox = makeTestTmpDir("tmp-fixture-guard-");
		withTmpdir(sandbox, () => {
			const dir = makeTestTmpDir("tmp-fixture-mode-");
			const root = fixtureRoot();
			assert.equal(dirname(dir), root);
			assert.equal(statSync(root).mode & 0o777, 0o700);
		});
	});

	it("records the owner PID in an .owners/ sidecar", () => {
		const dir = makeTestTmpDir("tmp-fixture-owner-");
		const sidecar = join(fixtureRoot(), ".owners", basename(dir));
		assert.equal(existsSync(sidecar), true);
		assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).pid, process.pid);
	});

	it("rolls back the fixture and throws when its owner sidecar cannot be written", () => {
		const sandbox = makeTestTmpDir("tmp-fixture-sidecar-");
		withTmpdir(sandbox, () => {
			const existing = makeTestTmpDir("seed-");
			const root = fixtureRoot();
			rmSync(join(root, ".owners"), { recursive: true });
			writeFileSync(join(root, ".owners"), "blocks directory creation");
			assert.throws(() => makeTestTmpDir("must-rollback-"), /could not record owner/);
			assert.deepEqual(
				readdirSync(root).filter((name) => !name.startsWith(".")),
				[basename(existing)],
			);
		});
	});

	// A prefix that could escape the guarded root must be rejected before any mkdtemp.
	it("rejects a prefix that escapes the root", () => {
		assert.throws(() => makeTestTmpDir("../escape-"), /unsafe prefix/);
		assert.throws(() => makeTestTmpDir("a/b-"), /unsafe prefix/);
		assert.throws(() => makeTestTmpDir(""), /unsafe prefix/);
	});
});
