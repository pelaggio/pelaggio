import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOG_PATH, REPO, STEPS, WORKTREE_PREFIX } from "./config.js";
import { MarkdownRoadmap } from "./roadmap/markdown.js";
import type { Mutex, Step } from "./types.js";

// ── Skill loading ──────────────────────────────────────────────────────

export function expandSkill(name: string, skillArgs?: string): string {
	const upper = resolve(REPO, ".claude", "skills", name, "SKILL.md");
	const lower = resolve(REPO, ".claude", "skills", name, "skill.md");
	const body = readFileSync(existsSync(upper) ? upper : lower, "utf-8")
		.replace(/^---[\s\S]*?---\n*/, "")
		.trim();
	return skillArgs ? `${body}\n\nArguments: ${skillArgs}` : body;
}

// ── Worktree utilities ─────────────────────────────────────────────────

export function resolveWorktree(itemId: string): string {
	return resolve(REPO, "..", `${WORKTREE_PREFIX}${itemId.toLowerCase()}`);
}

export function listWorktrees(): string[] {
	return execSync("git worktree list --porcelain", { cwd: REPO, encoding: "utf-8" })
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice(9).trim());
}

// ── Verdict parsing ────────────────────────────────────────────────────

export function parseVerdict(text: string): "APPROVE" | "REVISE" | "RETHINK" {
	const match = text.match(/verdict[:\s*]+\*{0,2}(APPROVE|REVISE|RETHINK)\b/i);
	if (match) return match[1].toUpperCase() as "APPROVE" | "REVISE" | "RETHINK";
	if (/\bRETHINK\b/i.test(text)) return "RETHINK";
	if (/\bREVISE\b/i.test(text)) return "REVISE";
	return "APPROVE";
}

// ── Git checkpointing ──────────────────────────────────────────────────

export function checkpoint(cwd: string, label: string): boolean {
	try {
		execSync(`git add -A && git commit -m "wip: autopilot ${label}" --no-verify`, {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
		});
		return true;
	} catch (e: unknown) {
		const msg = ((e as Record<string, unknown>).stderr ?? (e as Record<string, unknown>).stdout ?? (e as Error).message ?? "").toString().slice(0, 300);
		if (/nothing to commit|clean/i.test(msg)) return false;
		process.stderr.write(`⚠ checkpoint commit failed: ${msg}\n`);
		return false;
	}
}

/** Verify worktree has no uncommitted changes; retry checkpoint once if dirty. */
export function ensureCheckpointed(cwd: string, label: string, log: (s: string) => void): void {
	const dirty = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
	if (!dirty) return;
	log(`⚠ worktree dirty after checkpoint — retrying (${dirty.split("\n").length} files)`);
	const ok = checkpoint(cwd, `${label} (retry)`);
	if (!ok) {
		const still = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
		if (still) log(`⚠ worktree still dirty after retry — ship may fail`);
	}
}

// ── Step-boundary diff ─────────────────────────────────────────────────

export function getHeadSha(cwd: string): string | null {
	try {
		return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch {
		return null;
	}
}

export function filesChangedSince(cwd: string, preSha: string | null): string[] {
	if (!preSha) return [];
	try {
		const out = execSync(`git diff --name-only ${preSha}..HEAD`, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (!out) return [];
		return out.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

// ── Ship pre-condition ─────────────────────────────────────────────────

/**
 * True iff the feat branch has at least one commit beyond main that touches
 * a file outside `docs/plans/`. Plan artifacts live at `docs/plans/<slug>.md`
 * and are produced by `/plan` — a branch that only touches those is the
 * ghost-ship case (plan-only, no implementation). Doc-only work like rubric
 * or skill-body edits is still deliverable. Returns false on any git error.
 */
export function hasDeliverableCommits(worktree: string): boolean {
	try {
		// Three-dot diff: compare merge-base(main, HEAD) to HEAD. This restricts
		// the file list to changes introduced on the feat branch. Two-dot
		// (main..HEAD) would also include files main advanced past while the
		// feat branch was dormant, which falsely credits the branch for work
		// it didn't do.
		const files = execSync("git diff --name-only main...HEAD", {
			cwd: worktree,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (!files) return false;
		return files.split("\n").some((f) => !f.startsWith("docs/plans/"));
	} catch {
		return false;
	}
}

// ── Ghost-ship verification ────────────────────────────────────────────

/**
 * Capture the state needed to verify a direct-push ship landed. Returns null
 * if either git command fails (e.g. no main branch in test env — skip check).
 */
export function captureShipState(mainRepo: string, worktree: string): { mainSha: string; featSha: string } | null {
	try {
		const mainSha = execSync("git rev-parse main", { cwd: mainRepo, encoding: "utf-8" }).trim();
		const featSha = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		return { mainSha, featSha };
	} catch {
		return null;
	}
}

/**
 * Returns true if main advanced after a direct-push ship: either the sha
 * changed or the pre-ship feat tip is now reachable from main (fast-forward).
 * Returns true on unexpected git errors so unknown environments don't block cycles.
 */
export function verifyShipLanded(mainRepo: string, mainShaBefore: string, featShaBefore: string): boolean {
	try {
		const mainShaAfter = execSync("git rev-parse main", { cwd: mainRepo, encoding: "utf-8" }).trim();
		if (mainShaAfter !== mainShaBefore) return true;
		try {
			execSync(`git merge-base --is-ancestor ${featShaBefore} main`, { cwd: mainRepo, stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	} catch {
		return true;
	}
}

// ── Resume detection ───────────────────────────────────────────────────

export function detectResumeStep(itemId: string, worktree: string): Step {
	const roadmap = new MarkdownRoadmap({ repo: REPO });

	if (existsSync(LOG_PATH)) {
		try {
			const lines = readFileSync(LOG_PATH, "utf-8").trim().split("\n").filter(Boolean);
			const entries = lines
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.filter((e): e is Record<string, unknown> => e != null && typeof e.item === "string" && (e.item as string).toUpperCase() === itemId.toUpperCase());
			if (entries.length > 0) {
				const last = entries[entries.length - 1];
				const steps = last.steps as Array<{ name: string; ok: boolean }> | undefined;
				if (steps && steps.length > 0) {
					let lastOk = -1;
					for (let i = steps.length - 1; i >= 0; i--) {
						if (steps[i].ok) {
							lastOk = i;
							break;
						}
					}
					if (typeof last.error === "string" && (last.error as string).toLowerCase().includes("ship failed")) return "ship";
					const lastStep = steps[steps.length - 1];
					if (!lastStep.ok && lastStep.name === "implement") return "implement";
					if (lastOk >= 0) {
						const okStepName = steps[lastOk].name as Step;
						const idx = STEPS.indexOf(okStepName);
						if (idx >= 0 && idx < STEPS.length - 1) return STEPS[idx + 1];
						return "ship";
					}
				}
			}
		} catch {
			/* log parse failed — fall through to git heuristics */
		}
	}

	const branches = execSync("git branch --list 'feat/*'", { cwd: REPO, encoding: "utf-8" });
	const line = branches.split("\n").find((l) => l.toLowerCase().includes(itemId.toLowerCase()));
	const slug = (line?.replace(/^[*+]?\s*/, "").trim() ?? "").replace("feat/", "");

	if (!roadmap.findPlanFile(slug)) return "plan";

	try {
		const log = execSync("git log main..HEAD --oneline", { cwd: worktree, encoding: "utf-8" });
		if (
			log
				.trim()
				.split("\n")
				.filter((l) => l.trim()).length === 0
		)
			return "shakedown-plan";
	} catch {
		/* empty */
	}

	return "shakedown-code";
}

// ── Logging ────────────────────────────────────────────────────────────

export function appendLog(entry: Record<string, unknown>): void {
	mkdirSync(resolve(REPO, ".dev"), { recursive: true });
	appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
}

// ── Step index ─────────────────────────────────────────────────────────

export function stepIndex(s: Step): number {
	return STEPS.indexOf(s);
}

// ── Reset time parsing ────────────────────────────────────────────────

/** Parse "resets 4pm (America/Edmonton)" from an error message into a Unix-ms timestamp. */
export function parseResetTime(msg: string): number {
	const m = msg.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
	if (!m) return 0;

	let hours = parseInt(m[1], 10);
	const minutes = parseInt(m[2] ?? "0", 10);
	const period = m[3].toLowerCase();
	const tz = m[4];

	if (period === "pm" && hours !== 12) hours += 12;
	if (period === "am" && hours === 12) hours = 0;

	try {
		const now = new Date();
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(now);

		const y = parseInt(parts.find((p) => p.type === "year")!.value, 10);
		const mo = parseInt(parts.find((p) => p.type === "month")!.value, 10) - 1;
		const d = parseInt(parts.find((p) => p.type === "day")!.value, 10);

		// Compute tz offset via reference-point comparison
		const utcRef = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
		const tzRef = new Date(now.toLocaleString("en-US", { timeZone: tz }));
		const offsetMs = tzRef.getTime() - utcRef.getTime();

		const resetMs = Date.UTC(y, mo, d, hours, minutes) - offsetMs;
		return resetMs > Date.now() ? resetMs : resetMs + 86_400_000;
	} catch {
		return 0;
	}
}

// ── Wait-flag parsing & formatting ────────────────────────────────────

/** Parse "6h", "90m", "1h30m", "360" (bare number = minutes) → milliseconds. */
export function parseWaitFlag(value: string): number {
	const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
	if (match && (match[1] || match[2])) {
		const hours = parseInt(match[1] ?? "0", 10);
		const minutes = parseInt(match[2] ?? "0", 10);
		return (hours * 3600 + minutes * 60) * 1000;
	}
	const bare = parseInt(value, 10);
	if (!isNaN(bare)) return bare * 60_000; // bare number = minutes
	return 6 * 3600_000; // fallback
}

/** Format milliseconds as human-readable wait time: "4h 32m", "12m", "<1m". */
export function fmtWait(ms: number): string {
	const totalMin = Math.ceil(ms / 60_000);
	if (totalMin < 1) return "<1m";
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h === 0) return `${m}m`;
	if (m === 0) return `${h}h`;
	return `${h}h ${m}m`;
}

// ── Mutex ──────────────────────────────────────────────────────────────

export function createMutex(): Mutex {
	const queue: (() => void)[] = [];
	let locked = false;
	return {
		acquire(): Promise<void> {
			if (!locked) {
				locked = true;
				return Promise.resolve();
			}
			return new Promise<void>((r) => queue.push(r));
		},
		release() {
			const next = queue.shift();
			if (next) next();
			else locked = false;
		},
	};
}
