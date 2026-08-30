/** Cycle-scoped helpers used only by the orchestration layer (L4). Shrinks as steps become modules. */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, LOG_PATH, REPO, resolveProviderBin } from "./config.js";
import { MarkdownRoadmap } from "./roadmap/markdown.js";
import { isPipelineStep, type PipelineStep, STEPS } from "./step-names.js";
import type { CycleDriverProvenance, CycleVersionProvenance, Mutex, ProviderName, Step, StepLog } from "./types.js";

function extractFilesSection(body: string): string | null {
	const headingRe = /^#{1,6}[ \t]+.*\bfiles\b.*$/im;
	const match = body.match(headingRe);
	if (!match) return null;
	const start = (match.index ?? 0) + match[0].length;
	const rest = body.slice(start);
	const nextHeading = rest.search(/^#{1,6}[ \t]+/m);
	return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
}

function parseTableFirstColumn(section: string): Set<string> {
	const files = new Set<string>();
	const lines = section.split("\n");
	let inTable = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith("|")) {
			inTable = false;
			continue;
		}
		if (!inTable) {
			const next = (lines[i + 1] ?? "").trim();
			if (/^\|[\s\-:|]+\|$/.test(next)) {
				inTable = true;
				i++;
				continue;
			}
			continue;
		}
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		if (cells.length === 0) continue;
		const first = cells[0].replace(/`/g, "").trim();
		if (first) files.add(first);
	}
	return files;
}

const PATH_EXT = /\b[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|md|yml|yaml|json|sh|py)\b/g;

/**
 * Count distinct file paths in a plan body. Prefers the first-column values of
 * a markdown table under a heading containing "Files" (case-insensitive).
 * Falls back to path-shaped tokens in the prose, ignoring fenced code blocks
 * and plan self-references under `docs/plans/`.
 */
export function countPlanFiles(body: string): number {
	const section = extractFilesSection(body);
	if (section) {
		const fromTable = parseTableFirstColumn(section);
		if (fromTable.size > 0) return fromTable.size;
	}
	const stripped = body.replace(/```[\s\S]*?```/g, "");
	const files = new Set<string>();
	for (const m of stripped.match(PATH_EXT) ?? []) {
		if (m.startsWith("docs/plans/")) continue;
		files.add(m);
	}
	return files.size;
}

/**
 * Derive a per-cycle implement turn budget from the plan's file count:
 *   `clamp(2 × files + 100, 150, 400)`.
 * Falls back to the static `fallback` when the plan is absent or parses to zero
 * files (e.g. a `--resume` that starts at `implement` with no plan on disk).
 *
 * The ceiling (400) and floor (150) are the escape hatch for a genuinely-large
 * ATOMIC item a single implement cycle must carry. Decomposition into deferred
 * sub-items (emitted at plan time) is the preferred path, but not every large
 * change decomposes cleanly — sized after repeated 100-turn-wall failures on
 * complex-but-few-files items (e.g. #294's taxonomy engine hit the old 100 floor).
 */
export function computeImplementTurns(planBody: string | null, fallback: number): number {
	if (!planBody) return fallback;
	const files = countPlanFiles(planBody);
	if (files === 0) return fallback;
	return Math.max(150, Math.min(400, 2 * files + 100));
}

export interface SecurityDiffSignal {
	triggered: boolean;
	reasons: string[];
}

const SECURITY_REASON_LIMIT = 8;

const SECURITY_PATHS: readonly RegExp[] = [
	/^\.github\/workflows\//,
	/^infra\//,
	/^packages\/server\/src\/(?:auth|config|app)\.ts$/,
	/^packages\/server\/scripts\//,
	/^packages\/pelaggio\/scripts\/pelaggio\/(?:step-runner|config|pr-review-cli|revise-sweep|notify|worktree-deps|pr-review-gate|git|outcome-classify|cycle-outcome|skills|pick-parse|cycle-support|text)\.ts$/,
	/^packages\/pelaggio\/scripts\/pelaggio\/providers\/(?:claude|codex|index|types)\.ts$/,
	/^packages\/pelaggio\/scripts\/pelaggio\/review\/findings\.ts$/,
	// Guard config: the files whose contents decide what other guards refuse. Touching them is a
	// security-lens change even when no keyword fires; `GUARD_CONFIG` below names what changed.
	/^packages\/pelaggio\/scripts\/pelaggio\/__tests__\/module-layering\.test\.ts$/,
	/^packages\/pelaggio\/scripts\/pelaggio\/registers\.ts$/,
	/^lefthook\.yml$/,
	/^packages\/pelaggio\/scripts\/pelaggio\/(?:ship|roadmap|confinement)\//,
	/^\.claude\/skills\/(?:pr-review|pr-verify|shakedown|ship|implement)\/SKILL\.md$/,
	/^\.agents\/skills\/(?:pr-review|pr-verify|shakedown|ship|implement)\/SKILL\.md$/,
];

const SECURITY_KEYWORDS: readonly [string, RegExp][] = [
	["CONTROL_PLANE_TOKEN", /\bCONTROL_PLANE_TOKEN\b/],
	["ANTHROPIC_API_KEY", /\bANTHROPIC_API_KEY\b/],
	["GH_TOKEN", /\bGH_TOKEN\b/],
	["prompt injection", /\bprompt\s+injection\b/i],
	["ignore instructions", /\bignore\s+instructions\b/i],
	["0.0.0.0", /0\.0\.0\.0/],
	["127.", /127\./],
	["::1", /::1/],
	["auth", /\bauth(?:entication|orization)?\b/i],
	["token", /\btoken\b/i],
	["secret", /\bsecret\b/i],
	["permission", /\bpermissions?\b/i],
	["host", /\bhost(?:name)?\b/i],
	["loopback", /\bloopback\b/i],
	["localhost", /\blocalhost\b/i],
	["fetch", /\bfetch\b/i],
	["network", /\bnetwork\b/i],
	["exec", /\bexec(?:FileSync|Sync)?\b/i],
	["spawn", /\bspawn(?:Sync)?\b/i],
	["shell", /\bshell\b/i],
	["bash", /\bbash\b/i],
	// Generic tool and identifier tokens (`git`, `gh`, `url`) are too common to
	// signal security sensitivity; specific credentials and operations remain.
	["workflow", /\bworkflow\b/i],
];

/**
 * Guard config whose *entries* the review must see changed, not merely touched — the layer table
 * (what may import what) and the register table (what seats may write). A loosening is a
 * 3-line diff in a 100-line table; rendering it as `guard:layer text.ts L0→L4` makes it salient
 * to reviewers and to the red-team pass. Under autonomous cycles the harness's author is the
 * guarded party (CON-0027 applied to construction), so review — not a fence — owns these files;
 * this is what makes that review honest. Keys and values are matched by closed regexes, so no
 * free diff text reaches a prompt.
 */
const GUARD_CONFIG: readonly { label: string; path: RegExp; entry: RegExp; value: (m: RegExpMatchArray) => string }[] = [
	{
		label: "layer",
		path: /^packages\/pelaggio\/scripts\/pelaggio\/__tests__\/module-layering\.test\.ts$/,
		entry: /^"([\w./-]+\.ts)":\s*([0-5]),?$/,
		value: (m) => `L${m[2]}`,
	},
	{
		label: "register",
		path: /^packages\/pelaggio\/scripts\/pelaggio\/registers\.ts$/,
		entry: /^\{\s*name:\s*"([\w.-]+)",\s*kind:\s*"(harness|agent|seat-tree)"(?:,\s*shape:\s*"[\w-]+")?(?:,\s*agentReads:\s*(true|false))?\s*\},?/,
		value: (m) => (m[3] === "true" ? `${m[2]}+agentReads` : (m[2] as string)),
	},
];

/** `guard:<label> <key> <before>→<after>` / `added <after>` / `removed` for every changed guard-config entry. */
export function guardConfigDelta(diff: string): string[] {
	const out: string[] = [];
	let spec: (typeof GUARD_CONFIG)[number] | undefined;
	let inHunk = false;
	let removed = new Map<string, string>();
	let added = new Map<string, string>();
	const flush = (): void => {
		if (!spec) return;
		for (const key of new Set([...removed.keys(), ...added.keys()]).values()) {
			const before = removed.get(key);
			const after = added.get(key);
			if (before !== undefined && after !== undefined) {
				if (before !== after) out.push(`guard:${spec.label} ${key} ${before}→${after}`);
			} else if (after !== undefined) out.push(`guard:${spec.label} ${key} added ${after}`);
			else out.push(`guard:${spec.label} ${key} removed`);
		}
		removed = new Map();
		added = new Map();
	};
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			flush();
			const file = line.slice("diff --git ".length).split(" ")[0]?.replace(/^a\//, "") ?? "";
			spec = GUARD_CONFIG.find((g) => g.path.test(file));
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!spec || !inHunk || !(line.startsWith("+") || line.startsWith("-"))) continue;
		const m = line.slice(1).trim().match(spec.entry);
		if (!m) continue;
		(line.startsWith("-") ? removed : added).set(m[1] as string, spec.value(m));
	}
	flush();
	return out.sort();
}

/**
 * Deterministic switch for the extra adversarial PR-review pass. This is not a
 * scanner; it only decides whether the diff is security-sensitive enough to
 * spend a second model session.
 */
export function classifySecurityReviewDiff(files: readonly string[], diff: string): SecurityDiffSignal {
	const reasons: string[] = [];
	const seen = new Set<string>();
	const addReason = (reason: string): void => {
		if (seen.has(reason) || reasons.length >= SECURITY_REASON_LIMIT) return;
		seen.add(reason);
		reasons.push(reason);
	};

	// Guard-config deltas first: they are the reasons most worth keeping under the limit.
	for (const reason of guardConfigDelta(diff)) addReason(reason);
	for (const file of files) {
		if (SECURITY_PATHS.some((re) => re.test(file))) addReason(`path:${file}`);
	}

	const changedLines: string[] = [];
	let inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (inHunk && (line.startsWith("+") || line.startsWith("-"))) changedLines.push(line);
	}
	const keywordInput = changedLines.join("\n");

	for (const [keyword, re] of SECURITY_KEYWORDS) {
		if (re.test(keywordInput)) addReason(`keyword:${keyword}`);
	}

	return { triggered: reasons.length > 0, reasons };
}

/**
 * One-line, machine-readable marker appended to the gate comment so the durable
 * PR-comment stream can be aggregated into a precision dataset (see
 * docs/pr-review.md § Evidence gate). Records `ok`/`subtype` because `gh run list`
 * conclusion alone conflates a real `must-fix` report with a fail-closed transient —
 * only clean (`ok=true subtype=success`) BLOCKs are precision-relevant.
 */
export function formatReviewMetrics(gate: "pass" | "block", ok: boolean, subtype: string, cost: number, turns: number): string {
	return `<!-- pr-review-metrics gate=${gate} ok=${ok} subtype=${subtype} cost=${cost.toFixed(2)} turns=${turns} -->`;
}

export function uniqueDriverProvenance(steps: StepLog[]): CycleDriverProvenance[] {
	const seen = new Set<string>();
	const drivers: CycleDriverProvenance[] = [];
	for (const step of steps) {
		if (!step.provider) continue;
		const key = `${step.provider}\0${step.model}`;
		if (seen.has(key)) continue;
		seen.add(key);
		drivers.push({ provider: step.provider, model: step.model });
	}
	return drivers;
}

export interface RuntimeVersionResult {
	versions: CycleVersionProvenance;
	unavailable: string[];
}

export interface RuntimeVersionDeps {
	run?: (executable: string, args: string[]) => string;
	readManifest?: (path: string) => string;
	/** Override Claude SDK manifest discovery (tests). Default uses Node module resolution. */
	resolveClaudeSdkManifest?: () => string;
}

/**
 * Locate the installed `@anthropic-ai/claude-agent-sdk` package.json via Node module
 * resolution from this module. Hard-coded `../../node_modules/...` paths break under
 * hoisted / published installs (#333); `exports` also hides `./package.json`, so resolve
 * the package entry and walk up for a manifest whose `name` matches.
 */
export function resolveClaudeSdkManifestPath(fromModuleUrl: string = import.meta.url): string {
	const require = createRequire(fromModuleUrl);
	let dir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
	for (let i = 0; i < 12; i++) {
		const pkgPath = resolve(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: unknown };
				if (pkg.name === "@anthropic-ai/claude-agent-sdk") return pkgPath;
			} catch {
				// keep walking past unreadable / non-JSON parents
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("claude-agent-sdk package.json not found via module resolution");
}

export function readRuntimeVersions(providers: ProviderName[], deps: RuntimeVersionDeps = {}): RuntimeVersionResult {
	const readManifest = deps.readManifest ?? ((path: string) => readFileSync(path, "utf-8"));
	const packagePath = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../package.json");
	const pelaggio = (JSON.parse(readManifest(packagePath)) as { version: string }).version;
	const versions: CycleVersionProvenance = { pelaggio, node: process.version, drivers: {} };
	const unavailable: string[] = [];
	const run = deps.run ?? ((executable: string, args: string[]) => execFileSync(executable, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }));
	const resolveClaudeSdk = deps.resolveClaudeSdkManifest ?? (() => resolveClaudeSdkManifestPath());
	for (const provider of new Set(providers)) {
		try {
			if (provider === "claude") {
				const sdkPath = resolveClaudeSdk();
				const version = (JSON.parse(readManifest(sdkPath)) as { version?: unknown }).version;
				if (typeof version !== "string" || !version) throw new Error("missing version");
				versions.drivers.claude = version;
			} else {
				const output = run(resolveProviderBin(CONFIG, provider, provider), ["--version"])
					.replace(/[\r\n]+/g, " ")
					.trim()
					.slice(0, 160);
				if (!output) throw new Error("empty version");
				versions.drivers[provider] = output;
			}
		} catch {
			unavailable.push(`version.${provider}`);
		}
	}
	return { versions, unavailable };
}

/** ~256 KiB cap on the injected diff; a huge diff would blow the seat's context, and the seat can
 * always run `git diff main...HEAD` itself for the remainder. */
export const REVIEW_DIFF_MAX_BYTES = 256 * 1024;

/** Format the CHANGES UNDER REVIEW block. Pure/testable: no git access. Empty diff or a failed read
 * yields a note (never crashes the loop); a truncated diff appends the run-it-yourself pointer. */
export function formatChangesUnderReview(diff: string, state: "ok" | "empty" | "unavailable" | "truncated"): string {
	const header = "## CHANGES UNDER REVIEW (git diff main...HEAD)";
	if (state === "empty") return `${header}\n\nThe branch diff against \`main\` is empty. Confirm with \`git diff main...HEAD\` and review accordingly.`;
	if (state === "unavailable") return `${header}\n\nThe harness could not compute the branch diff. Run \`git diff main...HEAD\` yourself to obtain the changes under review.`;
	const trailer = state === "truncated" ? "\n\n[diff truncated at the injection cap — run `git diff main...HEAD` for the remainder]" : "";
	return `${header}\n\nThis is the authoritative diff. Inspect it in full; explore further (\`git show\`, read files, run tests) as needed.\n\n\`\`\`diff\n${diff}\n\`\`\`${trailer}`;
}

/** Read the branch diff from a worktree and format it for injection. Fail-graceful: any git error
 * returns the "unavailable" note rather than throwing. Byte-bounded to REVIEW_DIFF_MAX_BYTES. */
export function buildReviewDiffBlock(worktree: string): string {
	let raw: string;
	try {
		raw = execSync("git diff main...HEAD", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
	} catch {
		return formatChangesUnderReview("", "unavailable");
	}
	if (raw.trim() === "") return formatChangesUnderReview("", "empty");
	const bytes = Buffer.from(raw, "utf-8");
	if (bytes.byteLength <= REVIEW_DIFF_MAX_BYTES) return formatChangesUnderReview(raw, "ok");
	// Truncate on a byte boundary, then trim any partial trailing line so the fenced block stays clean.
	const sliced = bytes.subarray(0, REVIEW_DIFF_MAX_BYTES).toString("utf-8");
	const trimmed = sliced.slice(0, Math.max(0, sliced.lastIndexOf("\n")));
	return formatChangesUnderReview(trimmed, "truncated");
}

/**
 * Plan-polish backstop (#80). During `implement`, `docs/plans/` is execute-only. The Claude
 * provider enforces this with a PreToolUse hook that blocks Writes there, but a sandboxed provider
 * (Codex) can't express path-exclusion — so this deterministic, provider-agnostic backstop fully
 * reverts the `docs/plans/` subtree to its pre-step (`sinceSha`) state, INCLUDING committed edits:
 * `checkout` restores modified/deleted files that existed at `sinceSha`, and files ADDED during the
 * step (not in `sinceSha`) are removed — matching the hook's coverage (which also prevents new plan
 * files). Note: `sinceSha` is the pre-`implement` HEAD, so it only covers the CURRENT session's
 * edits; polish committed by an earlier parked-then-resumed implement session is already in the
 * baseline. Returns the reverted paths (empty when nothing changed — the normal case, and always so
 * for the hook-guarded Claude path). Failures are surfaced loudly but never crash the pipeline.
 */
export function revertPlanPolish(cwd: string, sinceSha: string | null): string[] {
	if (!sinceSha) return [];
	let changed: string[];
	let added: string[];
	try {
		const out = execSync(`git diff --name-only ${sinceSha} -- docs/plans`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		changed = out ? out.split("\n").filter(Boolean) : [];
		const addedOut = execSync(`git diff --diff-filter=A --name-only ${sinceSha} -- docs/plans`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		added = addedOut ? addedOut.split("\n").filter(Boolean) : [];
	} catch {
		return [];
	}
	if (changed.length === 0) return [];
	try {
		// Restore modified/deleted files to their sinceSha content, then delete files added during
		// the step (checkout can't remove those — they aren't in sinceSha). Commit is path-scoped to
		// docs/plans so it never sweeps in unrelated staged changes.
		execSync(`git checkout ${sinceSha} -- docs/plans 2>/dev/null || true`, { cwd, encoding: "utf-8", stdio: "pipe" });
		if (added.length > 0) {
			const paths = added.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");
			execSync(`git rm -f --ignore-unmatch -- ${paths}`, { cwd, encoding: "utf-8", stdio: "pipe" });
		}
		execSync(`git commit -m "revert: plan-polish edits during implement (docs/plans is execute-only)" --no-verify -- docs/plans`, { cwd, encoding: "utf-8", stdio: "pipe" });
	} catch (e: unknown) {
		const err = e as Record<string, unknown>;
		const msg = `${err.stderr ?? ""}${err.stdout ?? ""}` || String((e as Error).message ?? "");
		// A revert that finds nothing to commit is fine; anything else is a loud warning.
		if (!/nothing to commit|clean/i.test(msg)) process.stderr.write(`⚠ plan-polish backstop failed: ${msg.slice(0, 200)}\n`);
	}
	return changed;
}

// ── Ship pre-condition ─────────────────────────────────────────────────

export function detectResumeStep(itemId: string, worktree: string): Step {
	// Plan files live on the feature branch, so scan the worktree's tree — not main.
	const roadmap = new MarkdownRoadmap({ repo: worktree });

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
				const steps = last.steps as Array<{ name: string; ok: boolean; verdict?: string }> | undefined;
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
					if (lastStep.name === "shakedown-plan" && lastStep.verdict === "RETHINK") return "plan";
					if (lastOk >= 0) {
						const okStepName = steps[lastOk].name;
						if (typeof okStepName === "string" && isPipelineStep(okStepName)) {
							const idx = STEPS.indexOf(okStepName);
							if (idx >= 0 && idx < STEPS.length - 1) return STEPS[idx + 1];
							return "ship";
						}
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

export function stepIndex(s: PipelineStep): number {
	return STEPS.indexOf(s);
}

// ── Reset time parsing ────────────────────────────────────────────────

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
