import { chmodSync, type Dirent, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Shared temp-fixture seam (#579). Suites hand-rolling `mkdtempSync(join(tmpdir(), ...))`
 * leaked ~25k inodes per full run because per-suite cleanup discipline failed across
 * 50+ files. This helper fixes it by construction:
 *
 * - every fixture dir lives under one recognizable root, `<tmpdir>/pelaggio-test-fixtures-<uid>/`
 *   (honors `$TMPDIR` via `os.tmpdir()`; per-uid so a shared /tmp never forces one user's
 *   0700 root onto another), so survivors are attributable without pattern-matching
 *   against the rest of the tmp dir;
 * - the root is created mode 0700, owned by the current user, and stamped with a
 *   `.pelaggio-test-fixture` marker; we refuse to adopt a symlink or a foreign-owned dir
 *   planted at that predictable, world-known path (arbitrary-delete guard, mirrored by the
 *   reaper's own root guard), and re-verify after creating it to close a create-then-adopt
 *   symlink race;
 * - each fixture records its creating process's PID in a `.owners/<basename>` sidecar so
 *   the reaper reconciles against liveness (never deletes a fixture whose owner still runs)
 *   rather than on age alone;
 * - a single process-exit hook removes everything this process created — including on test
 *   failure and uncaught exceptions, not just a happy-path `after` — recovering from a
 *   `chmod 0000` descendant that would otherwise wedge `rmSync`;
 * - anything that survives a hard kill (SIGKILL, OOM) is swept by `ci/reap-test-tmp.ts`,
 *   which requires the root marker and each fixture's durable owner sidecar before reaping.
 *
 * The marker/PID sidecar live on the ROOT (and in `.owners/`), not inside each fixture dir:
 * many suites use the returned dir *as* a git repo and assert on a clean `git status
 * --porcelain` / a `git add -A` tree, so a per-dir sentinel would pollute those fixtures.
 * The root marker proves the containment boundary; the sidecar proves fixture ownership
 * and provides the liveness evidence required for destructive reaping.
 *
 * New tests must use this instead of raw `mkdtemp`. Migration of existing suites is
 * incremental — see the follow-up sweep item chartered from #579 for the remaining files.
 */

/** Kept in sync with FIXTURE_ROOT_BASENAME/FIXTURE_MARKER/OWNERS_DIRNAME in `ci/reap-test-tmp.ts` (no cross-package import). */
export const FIXTURE_ROOT_BASENAME = "pelaggio-test-fixtures";
export const FIXTURE_MARKER = ".pelaggio-test-fixture";
export const FIXTURE_MARKER_TOOL = "pelaggio-test-fixture";
export const OWNERS_DIRNAME = ".owners";

/** Per-uid root basename so a shared /tmp never forces one user's 0700 root onto another. */
export function fixtureRootBasename(): string {
	const uid = process.getuid?.();
	return uid === undefined ? FIXTURE_ROOT_BASENAME : `${FIXTURE_ROOT_BASENAME}-${uid}`;
}

export function fixtureRoot(): string {
	return join(tmpdir(), fixtureRootBasename());
}

interface Fixture {
	dir: string;
	sidecar: string;
}

const created: Fixture[] = [];
let exitHookInstalled = false;

/** Best-effort recursive chmod so a `chmod 0000` descendant can't wedge `rmSync`. */
function chmodTreeWritable(path: string): void {
	try {
		chmodSync(path, 0o700);
	} catch {
		// best effort
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const child = join(path, entry.name);
		if (entry.isDirectory()) chmodTreeWritable(child);
		else {
			try {
				chmodSync(child, 0o700);
			} catch {
				// best effort
			}
		}
	}
}

/** Remove a fixture tree, recovering once from a mode-000 descendant. Never throws. */
function forceRemoveDir(path: string): boolean {
	try {
		rmSync(path, { recursive: true, force: true });
		return true;
	} catch {
		chmodTreeWritable(path);
		try {
			rmSync(path, { recursive: true, force: true, maxRetries: 1 });
			return true;
		} catch {
			// Fail-open: cleanup must never turn a green suite red or mask the real exit
			// code. The standalone reaper (with the same chmod-recovery) picks up the rest.
			return false;
		}
	}
}

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const { dir, sidecar } of created) {
			if (!forceRemoveDir(dir)) continue; // keep owner evidence for the standalone reaper
			try {
				rmSync(sidecar, { force: true });
			} catch {
				// orphan sidecar is harmless
			}
		}
	});
}

/** True only for a real marker written by this helper, not merely a planted filename. */
function hasValidMarker(root: string, uid: number | undefined): boolean {
	const marker = join(root, FIXTURE_MARKER);
	try {
		const stat = lstatSync(marker);
		if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return false;
		const payload = JSON.parse(readFileSync(marker, "utf8")) as { tool?: unknown; pid?: unknown };
		return payload.tool === FIXTURE_MARKER_TOOL && typeof payload.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0;
	} catch {
		return false;
	}
}

/** Allow a concurrent creator a brief window to publish the marker after `mkdir`. */
function waitForValidMarker(root: string, uid: number | undefined): boolean {
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (hasValidMarker(root, uid)) return true;
		Atomics.wait(sleeper, 0, 0, 5);
	}
	return hasValidMarker(root, uid);
}

/** Stamp a newly created root. Failure is fatal because the reaper requires this proof. */
function stampMarker(root: string): void {
	writeFileSync(join(root, FIXTURE_MARKER), `${JSON.stringify({ tool: FIXTURE_MARKER_TOOL, pid: process.pid, cwd: process.cwd(), created: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
}

/**
 * Create or adopt our fixture root, refusing anything we do not exclusively own. A
 * recursively deleting reaper reads from this root, so a symlink or foreign-owned dir
 * planted at this predictable path must never be adopted (arbitrary-delete guard).
 */
function ensureFixtureRoot(): string {
	const root = fixtureRoot();
	const uid = process.getuid?.();
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(root);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			try {
				mkdirSync(root, { mode: 0o700 });
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code === "EEXIST") return ensureFixtureRoot();
				throw mkdirError;
			}
			// Re-verify after creating so a replacement race cannot make us adopt a symlink
			// or a directory we do not own before returning it.
			const fresh = lstatSync(root);
			if (!fresh.isDirectory()) {
				throw new Error(`tmp-fixture: refusing fixture root ${root}: not a directory after create (symlink race)`);
			}
			if (uid !== undefined && fresh.uid !== uid) {
				throw new Error(`tmp-fixture: refusing foreign-owned fixture root ${root} after create (uid ${fresh.uid} != ${uid})`);
			}
			try {
				stampMarker(root);
			} catch (markerError) {
				// We created this still-empty root, so rolling it back cannot remove another
				// process's fixtures. Never publish an unmarked containment boundary.
				try {
					rmSync(root, { recursive: true });
				} catch {
					// Preserve the marker failure as the actionable error.
				}
				throw markerError;
			}
			return root;
		}
		throw err;
	}
	if (!stat.isDirectory()) {
		throw new Error(`tmp-fixture: refusing fixture root ${root}: not a directory (symlink or file) — remove it and retry`);
	}
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`tmp-fixture: refusing foreign-owned fixture root ${root} (uid ${stat.uid} != ${uid})`);
	}
	if (!waitForValidMarker(root, uid)) {
		throw new Error(`tmp-fixture: refusing unmarked or invalid fixture root ${root} — remove it and retry`);
	}
	// Tighten a legacy 0755 root created before this guard existed.
	if ((stat.mode & 0o077) !== 0) {
		try {
			chmodSync(root, 0o700);
		} catch {
			// Non-fatal: ownership is already verified above.
		}
	}
	return root;
}

/** Create or validate the metadata directory without ever traversing a planted symlink. */
function ensureOwnersDir(root: string): string {
	const dir = join(root, OWNERS_DIRNAME);
	const uid = process.getuid?.();
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	const stat = lstatSync(dir);
	if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
		throw new Error(`tmp-fixture: refusing untrustworthy owners directory ${dir}`);
	}
	return dir;
}

/** Reject a prefix that could escape the guarded root (path separators, `..`, NUL). */
function assertSafePrefix(prefix: string): void {
	if (prefix.length === 0 || prefix.includes("/") || prefix.includes("\\") || prefix.includes("\0") || prefix.includes("..")) {
		throw new Error(`tmp-fixture: unsafe prefix ${JSON.stringify(prefix)} (no path separators, NUL, or "..")`);
	}
}

/**
 * Create a self-reaping fixture dir. Keep the per-suite `prefix` (e.g.
 * "pelaggio-roadmap-test-") so leaked survivors under the fixture root stay attributable.
 */
export function makeTestTmpDir(prefix: string): string {
	assertSafePrefix(prefix);
	const root = ensureFixtureRoot();
	installExitHook();
	const dir = mkdtempSync(join(root, prefix));
	const sidecar = join(root, OWNERS_DIRNAME, basename(dir));
	try {
		ensureOwnersDir(root);
		writeFileSync(sidecar, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, { flag: "wx", mode: 0o600 });
	} catch (err) {
		forceRemoveDir(dir);
		throw new Error(`tmp-fixture: could not record owner for ${dir}`, { cause: err });
	}
	created.push({ dir, sidecar });
	return dir;
}
