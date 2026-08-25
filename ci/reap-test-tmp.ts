import { chmodSync, type Dirent, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reap this repo's leaked test-fixture temp dirs (#579).
 *
 * A full test run used to leak ~25k tmpfs inodes; on the affected host that exhausts
 * /tmp in ~40 runs while `df -h` still looks healthy.
 *
 * This is a *recursively deleting* reaper, so its recognition rule is security-sensitive:
 * a wrong "is this ours?" answer deletes someone else's data. It recognizes a dir to
 * delete by an invariant it *carries* — a marker, an owner-record sidecar, or containment
 * in our guarded, owned root — never by an incidental name shape alone (the
 * recognize-by-construction principle; see `guarded-actions.md`):
 *
 * 1. **Fixture roots** — `<tmpdir>/pelaggio-test-fixtures[-<uid>]/`, created 0700 and
 *    stamped by `__tests__/tmp-fixture.ts`. The predictable basename is only a pre-filter:
 *    the root must be a real same-UID directory carrying a valid helper marker before it is
 *    traversed. A symlink, non-directory, or unmarked/invalid root is refused (loud), and a
 *    foreign-owned root (another user on a shared /tmp) is skipped silently. A contained
 *    fixture is deletable only with its own valid `.owners/<basename>` PID record.
 * 2. **Marker-carrying dirs** — any owned, mkdtemp-shaped dir that carries the
 *    `.pelaggio-test-fixture` marker is ours by that invariant, wherever it sits. Its
 *    marker records the owner PID, so it is liveness-checkable and default-reapable.
 * Unmarked directories are never eligible, even when their names use a prefix minted by
 * this repo. Names are collision-prone and carry neither provenance nor liveness evidence.
 *
 * **Liveness, not staleness (reconcile).** A fixture is never destroyed on age alone: the
 * helper records the creating process's PID (in the marker for a marked dir; in a
 * `.owners/<basename>` sidecar for a contained fixture), and the reaper SKIPS any fixture
 * whose owner PID is still alive (`process.kill(pid, 0)`), regardless of age — a
 * concurrent suite's >60-min working dir is in-use, not a leak. Missing, malformed,
 * unreadable, symlinked, or foreign-owned owner evidence is unverifiable and therefore
 * preserved; it never falls through to age-based deletion. Only a valid dead PID allows
 * the age+ownership+provenance rules to run. This is the
 * reconcile-against-liveness discipline from `guarded-actions.md`'s reconciled primitive /
 * session-liveness (#461): reclaim on evidence the owner is gone, never on staleness.
 *
 * Every deletion additionally requires: a real directory (not a symlink), owned by the
 * current uid, older than the age threshold (default 60 minutes).
 *
 * A `chmod 0000` descendant (e.g. a SIGKILL'd suite that left one behind) would block
 * `rmSync` forever and strand the inodes this feature reclaims; on a removal failure the
 * reaper best-effort chmods the tree writable and retries once, then reports if it still
 * cannot delete.
 *
 * Fail-open (reap mode): reaping is hygiene, and a filesystem error must never fail a test
 * run — every such error is caught and reap mode exits 0. CLI validation is separate: a
 * malformed value flag exits 2. A value flag (`--base`/`--max-age-minutes`/`--max-leaked`) present with a missing,
 * flag-shaped, or non-numeric value is rejected rather than silently defaulted — so a
 * typo'd `--base` can never fall back to a real /tmp-root sweep. The flagless pre-test hook
 * never hits that path. `--check` is the opt-in CI guard from #579's required outcome 3,
 * and it fails *closed*: a bad threshold, an untrustworthy/unreadable fixture root, or a
 * base it cannot scan is a non-zero exit, never a silent green. `--check` counts only the
 * default-reap set (containment + marked) and ignores fixtures younger than the threshold
 * (and in-use live-PID ones), so it does not false-fire while suites are running.
 *
 * NOTE — not wired into CI. `.github/workflows/ci.yml` runs `pnpm -r test` and
 * `pnpm test:ci` directly, not the root `pnpm test` that chains this reaper, so the pre-test
 * sweep and `--check` do not run in CI; CI relies on each test process's own exit-hook
 * cleanup. Flipping `--check` on in CI is deferred to the follow-up migration sweep (see
 * the #579 follow-up), after which unmigrated suites stop leaking by design.
 *
 * Usage:
 *   pnpm test:reap                       # reap, 60-minute threshold, honors $TMPDIR
 *   pnpm test:reap --max-age-minutes 0   # operator full reclaim
 *   pnpm test:reap --dry-run
 *   pnpm test:reap --check [--max-leaked 0]
 */

/** Kept in sync with `packages/pelaggio/scripts/pelaggio/__tests__/tmp-fixture.ts`. */
export const FIXTURE_ROOT_BASENAME = "pelaggio-test-fixtures";

/** Sentinel a helper-created dir carries so we recognize it by invariant, not by name. */
export const FIXTURE_MARKER = ".pelaggio-test-fixture";

/** Marker payload discriminator written by the fixture helper. */
export const FIXTURE_MARKER_TOOL = "pelaggio-test-fixture";

/** Per-fixture owner records (`{pid,startedAt}`) live here, keyed by fixture basename. */
export const OWNERS_DIRNAME = ".owners";

/** Fixture-root name pre-filter: the bare basename, or a per-uid suffix (`...-1000`). */
const FIXTURE_ROOT_RE = /^pelaggio-test-fixtures(-\d+)?$/;

/** mkdtemp suffix: exactly six [A-Za-z0-9] characters. */
const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;

export interface ReapOptions {
	/** Tmp base to scan. Defaults to `os.tmpdir()`, which honors `$TMPDIR`. */
	base?: string;
	/** Only entries whose mtime is older than this are removed. Default 60 minutes. */
	maxAgeMs?: number;
	dryRun?: boolean;
	/** Clock seam for tests. */
	now?: number;
	log?: (line: string) => void;
}

export interface ReapResult {
	/** Absolute paths removed (or that would be removed under dryRun). */
	removed: string[];
	/** Matching entries left alone (too young). */
	kept: number;
	/** Filesystem errors swallowed (fail-open). */
	errors: number;
	/** Paths refused as unsafe or unverifiable. */
	refused: string[];
	/** Fixtures left alone because their owner process is still alive (liveness reconcile). */
	skippedLive: number;
}

/** Cheap pre-filter: a candidate must at least look mkdtemp-shaped (ends in six alnum). */
function mkdtempShaped(basename: string): boolean {
	return basename.length >= 6 && MKDTEMP_SUFFIX.test(basename.slice(-6));
}

function ownedRealDir(stat: { isDirectory(): boolean; uid: number }, uid: number | undefined): boolean {
	if (!stat.isDirectory()) return false; // symlink or file: never recurse-delete through it
	if (uid !== undefined && stat.uid !== uid) return false; // not ours
	return true;
}

function isENOENT(err: unknown): boolean {
	return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Read a trustworthy owner PID from a real, same-UID payload file. */
function readOwnerPid(payloadPath: string, uid: number | undefined): number | undefined {
	try {
		const stat = lstatSync(payloadPath);
		if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return undefined;
		const parsed = JSON.parse(readFileSync(payloadPath, "utf8")) as { pid?: unknown };
		const pid = parsed?.pid;
		return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** Validate the marker discriminator as well as its owner PID. */
function readFixtureMarkerPid(dir: string, uid: number | undefined): number | undefined {
	const marker = join(dir, FIXTURE_MARKER);
	try {
		const stat = lstatSync(marker);
		if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return undefined;
		const parsed = JSON.parse(readFileSync(marker, "utf8")) as { tool?: unknown; pid?: unknown };
		const pid = parsed.pid;
		return parsed.tool === FIXTURE_MARKER_TOOL && typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** Liveness probe: signal 0 throws ESRCH when the process is gone, EPERM when it lives. */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Reconcile against liveness: a fixture whose recorded owner PID is still running is
 * in-use and must never be reaped, regardless of age. Only a valid dead PID is reclaimable;
 * missing or invalid evidence is preserved.
 */
/** Best-effort recursive chmod so a `chmod 0000` descendant can't wedge `rmSync`. */
function chmodTreeWritable(path: string): void {
	try {
		chmodSync(path, 0o700); // a dir must be +x before we can read it
	} catch {
		// ignore; the retry rmSync will report if this was load-bearing
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue; // never chmod through a symlink to its target
		const child = join(path, entry.name);
		if (entry.isDirectory()) chmodTreeWritable(child);
		else {
			try {
				chmodSync(child, 0o700);
			} catch {
				// ignore; best effort
			}
		}
	}
}

/** Remove a tree, recovering from a `chmod 0000` descendant with a chmod-then-retry pass. */
function forceRemove(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
		return;
	} catch {
		chmodTreeWritable(path);
		rmSync(path, { recursive: true, force: true, maxRetries: 1 }); // may throw → caller records it
	}
}

export function reapTestTmp(options: ReapOptions = {}): ReapResult {
	const base = options.base ?? tmpdir();
	const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000;
	const now = options.now ?? Date.now();
	const cutoff = now - maxAgeMs;
	const uid = process.getuid?.();
	const result: ReapResult = { removed: [], kept: 0, errors: 0, refused: [], skippedLive: 0 };

	/** Remove one path (with chmod-recovery); returns whether it is gone. */
	const reap = (path: string): boolean => {
		if (options.dryRun) {
			result.removed.push(path);
			return true;
		}
		try {
			forceRemove(path);
			result.removed.push(path);
			return true;
		} catch (err) {
			result.errors += 1;
			options.log?.(`failed to remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	};

	let baseEntries: string[];
	try {
		baseEntries = readdirSync(base);
	} catch {
		// Unreadable base: nothing we can scan. Fail-open in reap mode.
		result.errors += 1;
		return result;
	}

	for (const name of baseEntries) {
		const path = join(base, name);

		// Layer 1: our fixture roots. The predictable name is only a pre-filter; a valid
		// helper-written marker is the provenance proof required before traversal.
		if (FIXTURE_ROOT_RE.test(name)) {
			let rootStat: ReturnType<typeof lstatSync>;
			try {
				rootStat = lstatSync(path);
			} catch {
				result.errors += 1;
				continue;
			}
			if (!rootStat.isDirectory()) {
				// A symlink or file planted at our predictable, world-known root path. Refuse
				// loudly and do NOT traverse it — otherwise a symlink would redirect the
				// recursive delete at its target.
				result.refused.push(path);
				options.log?.(`refusing fixture root ${path}: not a real directory (symlink or file)`);
				continue;
			}
			if (uid !== undefined && rootStat.uid !== uid) continue; // another user's root
			if (readFixtureMarkerPid(path, uid) === undefined) {
				result.refused.push(path);
				options.log?.(`refusing fixture root ${path}: missing or invalid marker`);
				continue;
			}
			const ownersDir = join(path, OWNERS_DIRNAME);
			let children: string[];
			try {
				children = readdirSync(path);
			} catch {
				result.errors += 1;
				continue;
			}
			for (const child of children) {
				if (child.startsWith(".")) continue; // .owners, .pelaggio-test-fixture, other metadata
				const childPath = join(path, child);
				try {
					const childStat = lstatSync(childPath);
					if (!ownedRealDir(childStat, uid)) continue;
					const sidecar = join(ownersDir, child);
					const pid = readOwnerPid(sidecar, uid);
					if (pid === undefined) {
						result.refused.push(childPath);
						options.log?.(`refusing contained dir ${childPath}: missing or invalid owner record`);
						continue;
					}
					if (isPidAlive(pid)) {
						result.skippedLive += 1;
						options.log?.(`skipping live fixture ${childPath}: owner process still running`);
						continue;
					}
					if (childStat.mtimeMs > cutoff) {
						result.kept += 1;
						continue;
					}
					if (reap(childPath) && !options.dryRun) {
						try {
							rmSync(sidecar, { force: true });
						} catch {
							// orphan sidecar is harmless
						}
					}
				} catch {
					result.errors += 1;
				}
			}
			// Orphan sidecar sweep: a suite that rmSync'd its own fixture then died (SIGKILL, no
			// exit hook) leaves a permanent `.owners/<name>` with no dir. Reclaim it when the dir
			// is gone (absent from this scan) and the recorded owner is dead.
			if (!options.dryRun) {
				const present = new Set(children);
				let sidecars: string[];
				try {
					sidecars = readdirSync(ownersDir);
				} catch {
					sidecars = [];
				}
				for (const sidecarName of sidecars) {
					if (present.has(sidecarName)) continue; // fixture dir still there
					const pid = readOwnerPid(join(ownersDir, sidecarName), uid);
					if (pid === undefined || isPidAlive(pid)) continue; // invalid or live evidence is preserved
					try {
						rmSync(join(ownersDir, sidecarName), { force: true });
					} catch {
						// best effort
					}
				}
			}
			continue;
		}

		// Layer 2: top-level dirs. Cheap shape pre-filter before the marker/ownership check.
		if (!mkdtempShaped(name)) continue;
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(path);
		} catch {
			continue; // vanished or unreadable foreign entry: not ours to account for
		}
		if (!ownedRealDir(stat, uid)) continue;
		// Only a marker-bearing top-level dir is default-eligible: its marker records the owner
		// PID, so we can reconcile against liveness. Unmarked dirs have no provenance or
		// liveness evidence, regardless of their name, and are never eligible.
		const markerPid = readFixtureMarkerPid(path, uid);
		if (markerPid === undefined) continue;
		// A marked dir records its owner PID in the marker; skip it while that owner lives.
		if (isPidAlive(markerPid)) {
			result.skippedLive += 1;
			options.log?.(`skipping live fixture ${path}: owner process still running`);
			continue;
		}
		if (stat.mtimeMs > cutoff) {
			result.kept += 1;
			continue;
		}
		reap(path);
	}

	return result;
}

export interface LeakScan {
	count: number;
	sample: string[];
	/**
	 * False when something that should have been scannable was not — the base is
	 * unreadable, or a recognized fixture root is untrustworthy (missing/invalid marker,
	 * symlink/non-dir at our path) or unreadable. `--check` then fails *closed* rather than
	 * reporting a false green.
	 */
	scanned: boolean;
	error?: string;
}

/**
 * `--check` support: count exactly the fixtures the DEFAULT reap would remove — old enough
 * (past the age threshold), owner PID gone, recognized by containment in the owned root or
 * a liveness-checkable marker. Younger, live-PID, and unmarked top-level dirs are excluded.
 * Sets `scanned: false` (→ `--check`
 * fails closed) when the base is unreadable, or a recognized fixture root is a symlink/
 * non-dir at our path or cannot be read — the exact situations the root guard surfaces.
 */
export function countLeaked(base = tmpdir(), maxAgeMs = 60 * 60 * 1000, now = Date.now()): LeakScan {
	const paths: string[] = [];
	const uid = process.getuid?.();
	const cutoff = now - maxAgeMs;
	let scanned = true;
	let firstError: string | undefined;
	const fail = (message: string) => {
		scanned = false;
		firstError ??= message;
	};

	let baseEntries: string[];
	try {
		baseEntries = readdirSync(base);
	} catch (err) {
		return { count: 0, sample: [], scanned: false, error: `cannot read base ${base}: ${err instanceof Error ? err.message : String(err)}` };
	}
	for (const name of baseEntries) {
		const path = join(base, name);
		if (FIXTURE_ROOT_RE.test(name)) {
			let rootStat: ReturnType<typeof lstatSync>;
			try {
				rootStat = lstatSync(path);
			} catch (err) {
				if (!isENOENT(err)) fail(`cannot stat fixture root ${path}: ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			if (!rootStat.isDirectory()) {
				// Symlink or non-dir at our predictable root path: untrustworthy. Surface it.
				fail(`untrustworthy fixture root ${path}: not a real directory (symlink or file)`);
				continue;
			}
			if (uid !== undefined && rootStat.uid !== uid) continue; // another user's root
			if (readFixtureMarkerPid(path, uid) === undefined) {
				fail(`untrustworthy fixture root ${path}: missing or invalid marker`);
				continue;
			}
			const ownersDir = join(path, OWNERS_DIRNAME);
			let children: string[];
			try {
				children = readdirSync(path);
			} catch (err) {
				if (!isENOENT(err)) fail(`cannot read fixture root ${path}: ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			for (const child of children) {
				if (child.startsWith(".")) continue;
				const childPath = join(path, child);
				try {
					const childStat = lstatSync(childPath);
					if (!ownedRealDir(childStat, uid)) continue;
					const pid = readOwnerPid(join(ownersDir, child), uid);
					if (pid === undefined || isPidAlive(pid)) continue; // unverifiable or in-use
					if (childStat.mtimeMs > cutoff) continue; // fresh, not a leak
					paths.push(childPath);
				} catch {
					// Entry vanished mid-scan; not a leak.
				}
			}
			continue;
		}
		// Top-level: only marker-bearing dirs are default-reapable, so only they are counted.
		if (!mkdtempShaped(name)) continue;
		try {
			const stat = lstatSync(path);
			if (!ownedRealDir(stat, uid)) continue;
			const markerPid = readFixtureMarkerPid(path, uid);
			if (markerPid === undefined || isPidAlive(markerPid)) continue; // unverifiable or in-use
			if (stat.mtimeMs > cutoff) continue; // fresh
			paths.push(path);
		} catch {
			// Entry vanished mid-scan; not a leak.
		}
	}
	return { count: paths.length, sample: paths.slice(0, 10), scanned, error: firstError };
}

/** Parse a non-negative number; reject blank/whitespace and NaN/∞ so a bad flag fails loud. */
function parseNonNegative(raw: string): number | undefined {
	if (raw.trim() === "") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

type FlagRead = { kind: "absent" } | { kind: "missing" } | { kind: "value"; value: string };

/**
 * A value flag's argument is the next token — but never another flag or the end of argv,
 * so `--base --legacy` or a trailing `--base` is `missing`, not silently swallowed into a
 * real /tmp sweep. Callers reject `missing` with a non-zero exit.
 */
function readFlag(argv: string[], flag: string): FlagRead {
	const inlinePrefix = `${flag}=`;
	const i = argv.findIndex((token) => token === flag || token.startsWith(inlinePrefix));
	if (i < 0) return { kind: "absent" };
	const token = argv[i];
	if (token?.startsWith(inlinePrefix)) {
		const value = token.slice(inlinePrefix.length);
		return value === "" ? { kind: "missing" } : { kind: "value", value };
	}
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("--")) return { kind: "missing" };
	return { kind: "value", value };
}

export function main(argv = process.argv.slice(2)): number {
	const baseFlag = readFlag(argv, "--base");
	if (baseFlag.kind === "missing") {
		// A missing/flag-shaped --base must never fall back to a real /tmp-root sweep.
		console.error(`reap-test-tmp: --base requires a path value (got a missing or flag-shaped value)`);
		return 2;
	}
	const base = baseFlag.kind === "value" ? baseFlag.value : tmpdir();
	if (argv.includes("--legacy")) {
		console.error("reap-test-tmp: --legacy is unsupported because unmarked names do not prove ownership");
		return 2;
	}

	const ageFlag = readFlag(argv, "--max-age-minutes");
	if (ageFlag.kind === "missing") {
		console.error(`reap-test-tmp: --max-age-minutes requires a value`);
		return 2;
	}
	const minutes = ageFlag.kind === "value" ? parseNonNegative(ageFlag.value) : 60;
	if (minutes === undefined) {
		console.error(`reap-test-tmp: invalid --max-age-minutes ${JSON.stringify(ageFlag.kind === "value" ? ageFlag.value : "")} (want a non-negative number)`);
		return 2;
	}

	if (argv.includes("--check")) {
		const maxLeakedFlag = readFlag(argv, "--max-leaked");
		if (maxLeakedFlag.kind === "missing") {
			console.error(`reap-test-tmp --check: --max-leaked requires a value`);
			return 2;
		}
		const maxLeaked = maxLeakedFlag.kind === "value" ? parseNonNegative(maxLeakedFlag.value) : 0;
		if (maxLeaked === undefined) {
			// Fail closed: a NaN threshold would make `count > NaN` always false — a silent pass.
			console.error(`reap-test-tmp --check: invalid --max-leaked ${JSON.stringify(maxLeakedFlag.kind === "value" ? maxLeakedFlag.value : "")} (want a non-negative number)`);
			return 2;
		}
		const scan = countLeaked(base, minutes * 60 * 1000);
		if (!scan.scanned) {
			// Fail closed: an untrustworthy/unreadable target must not report green.
			console.error(`reap-test-tmp --check: could not scan ${base}: ${scan.error} — failing closed`);
			return 2;
		}
		if (scan.count > maxLeaked) {
			console.error(`reap-test-tmp --check: ${scan.count} leaked test fixture dir(s) in ${base} (threshold ${maxLeaked}). First: ${scan.sample.join(", ")}`);
			return 1;
		}
		console.log(`reap-test-tmp --check: ${scan.count} leaked test fixture dir(s) in ${base} (threshold ${maxLeaked}).`);
		return 0;
	}

	const result = reapTestTmp({
		base,
		maxAgeMs: minutes * 60 * 1000,
		dryRun: argv.includes("--dry-run"),
		log: (line) => console.error(`reap-test-tmp: ${line}`),
	});
	const verb = argv.includes("--dry-run") ? "would reap" : "reaped";
	const refused = result.refused.length ? `; refused ${result.refused.length} unsafe or unverifiable path(s)` : "";
	const live = result.skippedLive ? `; skipped ${result.skippedLive} live fixture(s)` : "";
	console.log(`reap-test-tmp: ${verb} ${result.removed.length} dir(s) in ${base}; kept ${result.kept} younger than threshold${live}; ${result.errors} error(s) ignored${refused}.`);
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const isCheck = process.argv.slice(2).includes("--check");
	try {
		process.exitCode = main();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (isCheck) {
			// `--check` fails closed: an unexpected error must not pass green.
			console.error(`reap-test-tmp --check: ${message} — failing closed`);
			process.exitCode = 2;
		} else {
			// Fail-open: a broken reaper must never fail a test run.
			console.error(`reap-test-tmp: ignored error: ${message}`);
			process.exitCode = 0;
		}
	}
}
