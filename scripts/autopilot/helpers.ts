import { basename, resolve } from "node:path";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { REPO, LOG_PATH, STEPS } from "./config.js";
import type { Step, Mutex } from "./types.js";

/** Worktree prefix derived from the repo's directory name (e.g. `claude-autopilot-`). Override via CLAUDE_AUTOPILOT_WORKTREE_PREFIX env var if needed. */
const WORKTREE_PREFIX = process.env.CLAUDE_AUTOPILOT_WORKTREE_PREFIX ?? `${basename(REPO)}-`;

// ── Skill loading ──────────────────────────────────────────────────────

export function expandSkill(name: string, skillArgs?: string): string {
	const upper = resolve(REPO, ".claude", "skills", name, "SKILL.md");
	const lower = resolve(REPO, ".claude", "skills", name, "skill.md");
	const body = readFileSync(existsSync(upper) ? upper : lower, "utf-8")
		.replace(/^---[\s\S]*?---\n*/, "").trim();
	return skillArgs ? `${body}\n\nArguments: ${skillArgs}` : body;
}

// ── Item ID parsing ────────────────────────────────────────────────────

export function parseItemId(text: string): string | null {
	const branchMatch = text.match(/feat\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/i);
	if (branchMatch) {
		const slug = branchMatch[1];
		// Match mixed alpha-digit IDs like a11y4, mcy2b, comp13, fore-2
		const idMatch = slug.match(/^([a-z][\da-z]*(?:-\d+)?)/i);
		if (idMatch) return idMatch[1].toUpperCase();
	}
	// Explicit uppercase IDs: A11Y4, MCY2B, COMP13, FORE-2
	const explicit = text.match(/\b([A-Z]{1,4}-?\d[\dA-Z]*)\b/);
	return explicit?.[1] ?? null;
}

// ── Worktree utilities ─────────────────────────────────────────────────

export function resolveWorktree(itemId: string): string {
	return resolve(REPO, "..", `${WORKTREE_PREFIX}${itemId.toLowerCase()}`);
}

/** Exported so pipeline.ts can match newly-created worktrees by prefix. */
export { WORKTREE_PREFIX };

export function listWorktrees(): string[] {
	return execSync("git worktree list --porcelain", { cwd: REPO, encoding: "utf-8" })
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice(9).trim());
}

// ── Plan file discovery ────────────────────────────────────────────────

/** Search docs/plans/ (primary) and .dev/plans/ (legacy) for a plan file matching the slug or item ID prefix. */
export function findPlanFile(slug: string): string | null {
	const dirs = [resolve(REPO, "docs", "plans"), resolve(REPO, ".dev", "plans")];

	for (const dir of dirs) {
		const exact = resolve(dir, `${slug}.md`);
		if (existsSync(exact)) return exact;
	}

	const idMatch = slug.match(/^([a-z]+-?\d+)/i);
	if (idMatch) {
		const prefix = `${idMatch[1].toLowerCase()}-`;
		for (const dir of dirs) {
			if (!existsSync(dir)) continue;
			const hit = readdirSync(dir).find((f) => f.toLowerCase().startsWith(prefix) && f.endsWith(".md"));
			if (hit) return resolve(dir, hit);
		}
	}

	return null;
}

export function findPlanPath(worktree: string): string | null {
	try {
		const branch = execSync("git branch --show-current", { cwd: worktree, encoding: "utf-8" }).trim();
		const slug = branch.replace(/^feat\//, "");
		return findPlanFile(slug);
	} catch { return null; }
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
			cwd, encoding: "utf-8", stdio: "pipe",
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

// ── Scope detection ────────────────────────────────────────────────────

export function isQuickScope(text: string): boolean {
	return /scope:\s*x?s\b/i.test(text) || /\bbug\b|\bfix:/i.test(text);
}

// ── Resume detection ───────────────────────────────────────────────────

export function detectResumeStep(itemId: string, worktree: string): Step {
	if (existsSync(LOG_PATH)) {
		try {
			const lines = readFileSync(LOG_PATH, "utf-8").trim().split("\n").filter(Boolean);
			const entries = lines
				.map((l) => { try { return JSON.parse(l); } catch { return null; } })
				.filter((e): e is Record<string, unknown> => e != null && typeof e.item === "string" && (e.item as string).toUpperCase() === itemId.toUpperCase());
			if (entries.length > 0) {
				const last = entries[entries.length - 1];
				const steps = last.steps as Array<{ name: string; ok: boolean }> | undefined;
				if (steps && steps.length > 0) {
					let lastOk = -1;
					for (let i = steps.length - 1; i >= 0; i--) {
						if (steps[i].ok) { lastOk = i; break; }
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
		} catch { /* log parse failed — fall through to git heuristics */ }
	}

	const branches = execSync("git branch --list 'feat/*'", { cwd: REPO, encoding: "utf-8" });
	const line = branches.split("\n").find((l) => l.toLowerCase().includes(itemId.toLowerCase()));
	const slug = (line?.replace(/^[*+]?\s*/, "").trim() ?? "").replace("feat/", "");

	if (!findPlanFile(slug)) return "plan";

	try {
		const log = execSync("git log main..HEAD --oneline", { cwd: worktree, encoding: "utf-8" });
		if (log.trim().split("\n").filter((l) => l.trim()).length === 0) return "shakedown-plan";
	} catch { /* empty */ }

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
			year: "numeric", month: "2-digit", day: "2-digit",
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
			if (!locked) { locked = true; return Promise.resolve(); }
			return new Promise<void>((r) => queue.push(r));
		},
		release() {
			const next = queue.shift();
			if (next) next();
			else locked = false;
		},
	};
}
