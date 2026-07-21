import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Per-seat detached checkouts for concurrent authoring-loop reviewers (#269).
 *
 * Concurrent seats used to share the artifact worktree, so independent agents
 * raced on `index.lock` / optional-lock status writeback and tripped each other
 * (and confinement audits) mid-pass. Each seat now gets its own throwaway
 * detached worktree pinned to the reviewed SHA under
 * `MAIN_REPO/.dev/authoring-review-seats/<sha>/<seatToken>-p<pass>`.
 *
 * Author revisions still run on the real artifact worktree (they must commit).
 * Seats are read-ish cold checkouts; session/temp writes stay inside the seat.
 */

export type AuthoringReviewSeatKey = { sha: string; seatId: string; pass: number };

/**
 * Git invoker seam. Callers pass an argument vector (no shell); production runs
 * `execFileSync("git", args, ...)`. Tests inject a fake to assert on the argv.
 */
export type GitExec = (args: string[], cwd: string) => string;

const defaultGitExec: GitExec = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf-8" });

const SEATS_DIR = "authoring-review-seats";

export function authoringReviewSeatsRoot(mainRepo: string): string {
	return resolve(mainRepo, ".dev", SEATS_DIR);
}

/**
 * Collision-resistant, path-safe seat token. base64url is injective over UTF-8
 * seat ids — unlike lossy character collapsing, which maps distinct ids
 * (`a/b` vs `a-b`) onto the same path segment.
 */
export function authoringReviewSeatToken(seatId: string): string {
	return Buffer.from(seatId, "utf8").toString("base64url");
}

export function authoringReviewSeatPath(mainRepo: string, key: AuthoringReviewSeatKey): string {
	return resolve(authoringReviewSeatsRoot(mainRepo), key.sha, `${authoringReviewSeatToken(key.seatId)}-p${key.pass}`);
}

/** True when `root` is a harness-managed authoring-review seat (or under one). */
export function isAuthoringReviewSeatPath(root: string, mainRepo: string): boolean {
	const seatsRoot = resolve(authoringReviewSeatsRoot(mainRepo));
	const abs = resolve(root);
	return abs === seatsRoot || abs.startsWith(`${seatsRoot}/`);
}

/**
 * True when `path` is a git worktree registered against `mainRepo` whose HEAD is
 * detached at exactly `sha` and whose working tree is clean. A crash / partial
 * create / failed cleanup can leave the seat dir present but unregistered, on a
 * wrong HEAD, or dirty — a reviewer would then inspect a wrong tree while
 * `git diff main...HEAD` reports only the committed SHA. Fail-closed: any doubt
 * (git error, unregistered, wrong HEAD, dirty) → not valid → recreate.
 */
function isValidPinnedSeat(mainRepo: string, path: string, sha: string, run: GitExec): boolean {
	const abs = resolve(path);
	try {
		// Must be a registered worktree (not just a leftover directory).
		const porcelain = run(["worktree", "list", "--porcelain"], mainRepo);
		const registered = porcelain
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => resolve(line.slice("worktree ".length).trim()))
			.some((wt) => wt === abs);
		if (!registered) return false;
		// HEAD must be pinned to the reviewed sha (detached at that commit).
		const head = run(["rev-parse", "HEAD"], abs).trim();
		if (head.toLowerCase() !== sha.toLowerCase()) return false;
		// Working tree must be clean — no stray edits from a peer/crashed pass.
		const status = run(["status", "--porcelain"], abs).trim();
		if (status.length > 0) return false;
		return true;
	} catch {
		return false;
	}
}

export function prepareAuthoringReviewSeat(mainRepo: string, key: AuthoringReviewSeatKey, exec?: GitExec): string {
	const run = exec ?? defaultGitExec;
	if (!/^[0-9a-f]{7,40}$/i.test(key.sha)) throw new Error(`authoring review seat: invalid reviewed sha ${key.sha}`);
	const path = authoringReviewSeatPath(mainRepo, key);
	mkdirSync(resolve(path, ".."), { recursive: true });
	if (existsSync(path)) {
		// A present dir is not proof of a valid seat after a crash/partial-create.
		// Reuse only a registered worktree pinned to key.sha with a clean tree;
		// otherwise force-remove and recreate (fail-closed to a correct seat).
		if (isValidPinnedSeat(mainRepo, path, key.sha, run)) return path;
		forceRemoveWorktree(path, mainRepo, run);
	}
	// Detached, throwaway, pinned to the reviewed commit — same shape as review-heads.
	// sha is hex-validated above; execFileSync passes argv with no shell.
	run(["worktree", "add", "--detach", path, key.sha], mainRepo);
	return path;
}

/** Force-remove a worktree registration + its tree; tolerate an unregistered leftover dir. */
function forceRemoveWorktree(path: string, mainRepo: string, run: GitExec): void {
	try {
		run(["worktree", "remove", "--force", path], mainRepo);
	} catch {
		// `git worktree remove` refuses an unregistered/corrupt dir; prune the
		// admin state and drop the stray directory so `add` can recreate cleanly.
		try {
			run(["worktree", "prune"], mainRepo);
		} catch {
			// best-effort
		}
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

/** Best-effort remove of one seat worktree. A leaked seat is inert (under gitignored `.dev/`). */
export function cleanupAuthoringReviewSeat(mainRepo: string, key: AuthoringReviewSeatKey, exec?: GitExec): void {
	const run = exec ?? defaultGitExec;
	const path = authoringReviewSeatPath(mainRepo, key);
	try {
		if (existsSync(path)) run(["worktree", "remove", "--force", path], mainRepo);
	} catch {
		// best-effort
	}
}

/** Remove every seat worktree under a reviewed SHA (all seats for one authoring-loop run). */
export function cleanupAuthoringReviewSeatsForSha(mainRepo: string, sha: string, exec?: GitExec): void {
	const run = exec ?? defaultGitExec;
	const dir = resolve(authoringReviewSeatsRoot(mainRepo), sha);
	if (!existsSync(dir)) return;
	try {
		// List registered worktrees and drop any whose path sits under this sha dir.
		const porcelain = run(["worktree", "list", "--porcelain"], mainRepo);
		const paths = porcelain
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.slice("worktree ".length).trim())
			.filter((path) => resolve(path).startsWith(`${resolve(dir)}/`));
		for (const path of paths) {
			try {
				run(["worktree", "remove", "--force", path], mainRepo);
			} catch {
				// continue remaining seats
			}
		}
	} catch {
		// best-effort
	}
}
