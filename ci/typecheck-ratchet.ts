/**
 * Strict-diagnostic ratchet for non-web packages.
 *
 * Measures `tsc --noEmit` under each package's shadow strict config (no
 * `noUncheckedIndexedAccess` relaxation) and fails if any package exceeds its
 * committed baseline. Baseline increases are allowed only when the root
 * lockfile TypeScript resolution changes AND the PR body contains the exact
 * machine-readable delta line.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_KEYS = ["pelaggio", "server"] as const;
export type PackageKey = (typeof PACKAGE_KEYS)[number];

export interface TypecheckBaseline {
	typescript: string;
	packages: Record<PackageKey, number>;
}

export type CompilerResult = { ok: true; exitCode: number; stdout: string; stderr: string } | { ok: false; reason: string };

export type BaseBaselineResult = { kind: "present"; baseline: TypecheckBaseline } | { kind: "missing" } | { kind: "error"; reason: string };

export interface RatchetDeps {
	runCompiler: (packageKey: PackageKey) => CompilerResult;
	readBaseline: () => TypecheckBaseline;
	readRootTypescript: () => string;
	/** When set, load the baseline at baseRef for increase/decrease policy. */
	readBaseBaseline?: (baseRef: string) => BaseBaselineResult;
	/** When set, return the PR body text for delta-marker authorization. */
	readPrBody?: () => string | null;
	/** Root lockfile TypeScript resolution at baseRef (only consulted on increase). */
	readBaseRootTypescript?: (baseRef: string) => string | null;
}

export type RatchetResult = { ok: true; actual: Record<PackageKey, number>; baseline: TypecheckBaseline } | { ok: false; message: string };

const DIAGNOSTIC_HEADER = /\berror TS\d+:/;

export function repoRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Count only TypeScript diagnostic headers (not continuation/related lines). */
export function countDiagnostics(stdout: string, stderr: string): number {
	let count = 0;
	for (const stream of [stdout, stderr]) {
		for (const line of stream.split("\n")) {
			if (DIAGNOSTIC_HEADER.test(line)) count += 1;
		}
	}
	return count;
}

export function formatDeltaMarker(actual: Record<PackageKey, number>, prior: Record<PackageKey, number>): string {
	const parts = PACKAGE_KEYS.map((key) => {
		const delta = actual[key] - prior[key];
		const sign = delta >= 0 ? "+" : "";
		return `${key} ${sign}${delta}`;
	});
	return `typecheck-baseline-delta: ${parts.join(", ")}`;
}

export function parseBaseline(raw: unknown, label = "baseline"): TypecheckBaseline {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label}: must be an object`);
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["typescript", "packages"]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) throw new Error(`${label}: unknown key ${JSON.stringify(key)}`);
	}
	if (typeof obj.typescript !== "string" || obj.typescript.trim() === "") {
		throw new Error(`${label}: typescript must be a non-empty string`);
	}
	if (!obj.packages || typeof obj.packages !== "object" || Array.isArray(obj.packages)) {
		throw new Error(`${label}: packages must be an object`);
	}
	const packages = obj.packages as Record<string, unknown>;
	const packageKeys = Object.keys(packages);
	if (packageKeys.length !== PACKAGE_KEYS.length || !PACKAGE_KEYS.every((k) => packageKeys.includes(k))) {
		throw new Error(`${label}: packages must have exactly keys ${PACKAGE_KEYS.join(", ")}`);
	}
	const out = {} as Record<PackageKey, number>;
	for (const key of PACKAGE_KEYS) {
		const n = packages[key];
		if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
			throw new Error(`${label}: packages.${key} must be a non-negative integer`);
		}
		out[key] = n;
	}
	return { typescript: obj.typescript, packages: out };
}

export function loadBaselineFile(path: string): TypecheckBaseline {
	return parseBaseline(JSON.parse(readFileSync(path, "utf8")), path);
}

export function resolveRootTypescript(root = repoRoot()): string {
	const requireFromPelaggio = createRequire(resolve(root, "packages/pelaggio/package.json"));
	const { parse } = requireFromPelaggio("yaml") as { parse: (input: string) => unknown };
	const lock = parse(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"));
	if (!lock || typeof lock !== "object") throw new Error("pnpm-lock.yaml: root parse failed");
	const importers = (lock as { importers?: unknown }).importers;
	if (!importers || typeof importers !== "object") throw new Error("pnpm-lock.yaml: missing importers");
	const rootImporter = (importers as Record<string, unknown>)["."];
	if (!rootImporter || typeof rootImporter !== "object") throw new Error('pnpm-lock.yaml: missing importers["."]');
	const devDependencies = (rootImporter as { devDependencies?: unknown }).devDependencies;
	if (!devDependencies || typeof devDependencies !== "object") throw new Error('pnpm-lock.yaml: missing importers["."].devDependencies');
	const typescript = (devDependencies as { typescript?: unknown }).typescript;
	if (!typescript || typeof typescript !== "object") throw new Error('pnpm-lock.yaml: missing importers["."].devDependencies.typescript');
	const version = (typescript as { version?: unknown }).version;
	if (typeof version !== "string" || version.trim() === "") {
		throw new Error('pnpm-lock.yaml: importers["."].devDependencies.typescript.version must be a string');
	}
	return version;
}

const SHADOW_CONFIG: Record<PackageKey, string> = {
	pelaggio: "packages/pelaggio/tsconfig.strict.json",
	server: "packages/server/tsconfig.strict.json",
};

/**
 * TypeScript diagnostic exits: historically 1; under TypeScript 6.0.x with
 * `noEmit`, diagnostics present exit as 2 (`DiagnosticsPresent_OutputsGenerated`).
 * Accept 0/1/2 when the stream is parseable; any other code is a tool failure.
 */
const DIAGNOSTIC_EXIT_CODES = new Set([0, 1, 2]);

export function defaultRunCompiler(packageKey: PackageKey, root = repoRoot()): CompilerResult {
	const result = spawnSync("pnpm", ["-w", "exec", "tsc", "--noEmit", "--pretty", "false", "-p", SHADOW_CONFIG[packageKey]], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error) return { ok: false, reason: `spawn failed for ${packageKey}: ${result.error.message}` };
	const exitCode = result.status;
	if (exitCode === null) return { ok: false, reason: `compiler killed by signal for ${packageKey}: ${result.signal ?? "unknown"}` };
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	if (!DIAGNOSTIC_EXIT_CODES.has(exitCode)) {
		return { ok: false, reason: `compiler exit ${exitCode} for ${packageKey} (tool failure)` };
	}
	// Non-zero without any diagnostic headers is unparseable (config error, crash text, etc.).
	if (exitCode !== 0 && countDiagnostics(stdout, stderr) === 0) {
		return {
			ok: false,
			reason: `compiler exit ${exitCode} for ${packageKey} with no parseable diagnostics (stdout/stderr unparseable)`,
		};
	}
	return { ok: true, exitCode, stdout, stderr };
}

const MISSING_PATH_RE = /(?:exists on disk, but not in|Path ['`].*['`] does not exist in|does not exist in ['`])/i;

export function defaultReadBaseBaseline(baseRef: string, root = repoRoot()): BaseBaselineResult {
	const result = spawnSync("git", ["show", `${baseRef}:ci/typecheck-baseline.json`], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	if (result.error) return { kind: "error", reason: `git show failed: ${result.error.message}` };
	if (result.status === 0) {
		try {
			return { kind: "present", baseline: parseBaseline(JSON.parse(result.stdout), `${baseRef}:ci/typecheck-baseline.json`) };
		} catch (e) {
			return { kind: "error", reason: e instanceof Error ? e.message : String(e) };
		}
	}
	const stderr = result.stderr ?? "";
	if (MISSING_PATH_RE.test(stderr) || MISSING_PATH_RE.test(result.stdout ?? "")) {
		return { kind: "missing" };
	}
	return { kind: "error", reason: `git show ${baseRef}:ci/typecheck-baseline.json failed (exit ${result.status}): ${stderr.trim() || "unknown error"}` };
}

export function defaultReadBaseRootTypescript(baseRef: string, root = repoRoot()): string | null {
	const result = spawnSync("git", ["show", `${baseRef}:pnpm-lock.yaml`], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) return null;
	const requireFromPelaggio = createRequire(resolve(root, "packages/pelaggio/package.json"));
	const { parse } = requireFromPelaggio("yaml") as { parse: (input: string) => unknown };
	try {
		const lock = parse(result.stdout);
		if (!lock || typeof lock !== "object") return null;
		const importers = (lock as { importers?: unknown }).importers;
		if (!importers || typeof importers !== "object") return null;
		const rootImporter = (importers as Record<string, unknown>)["."];
		if (!rootImporter || typeof rootImporter !== "object") return null;
		const devDependencies = (rootImporter as { devDependencies?: unknown }).devDependencies;
		if (!devDependencies || typeof devDependencies !== "object") return null;
		const typescript = (devDependencies as { typescript?: unknown }).typescript;
		if (!typescript || typeof typescript !== "object") return null;
		const version = (typescript as { version?: unknown }).version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

export function defaultReadPrBody(): string | null {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) return null;
	try {
		const event = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { body?: string | null } };
		const body = event.pull_request?.body;
		return typeof body === "string" ? body : null;
	} catch {
		return null;
	}
}

export function runRatchet(deps: RatchetDeps, opts: { baseRef?: string } = {}): RatchetResult {
	let baseline: TypecheckBaseline;
	try {
		baseline = deps.readBaseline();
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}

	let rootTs: string;
	try {
		rootTs = deps.readRootTypescript();
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
	if (baseline.typescript !== rootTs) {
		return {
			ok: false,
			message: `baseline.typescript ${JSON.stringify(baseline.typescript)} does not match root lockfile resolution ${JSON.stringify(rootTs)}`,
		};
	}

	const actual = {} as Record<PackageKey, number>;
	for (const key of PACKAGE_KEYS) {
		const result = deps.runCompiler(key);
		if (!result.ok) return { ok: false, message: result.reason };
		actual[key] = countDiagnostics(result.stdout, result.stderr);
	}

	const exceeded: string[] = [];
	for (const key of PACKAGE_KEYS) {
		if (actual[key] > baseline.packages[key]) {
			exceeded.push(`${key}: actual ${actual[key]} > baseline ${baseline.packages[key]}`);
		}
	}
	if (exceeded.length > 0) {
		return {
			ok: false,
			message: `strict diagnostic count exceeded baseline:\n  ${exceeded.join("\n  ")}\n  (actual: pelaggio=${actual.pelaggio}, server=${actual.server})`,
		};
	}

	if (opts.baseRef) {
		if (!deps.readBaseBaseline) {
			return { ok: false, message: "base-ref comparison requested but no base-baseline reader configured" };
		}
		const prior = deps.readBaseBaseline(opts.baseRef);
		if (prior.kind === "error") {
			return { ok: false, message: prior.reason };
		}
		if (prior.kind === "present") {
			const increases: PackageKey[] = [];
			for (const key of PACKAGE_KEYS) {
				if (baseline.packages[key] > prior.baseline.packages[key]) increases.push(key);
			}
			if (increases.length > 0) {
				const baseTs = deps.readBaseRootTypescript?.(opts.baseRef) ?? null;
				const tsChanged = baseTs !== null && baseTs !== rootTs;
				const marker = formatDeltaMarker(baseline.packages, prior.baseline.packages);
				const prBody = deps.readPrBody?.() ?? null;
				const markerPresent = typeof prBody === "string" && prBody.includes(marker);
				if (!tsChanged || !markerPresent) {
					const reasons: string[] = [];
					if (!tsChanged) {
						reasons.push(baseTs === null ? "could not resolve base-ref root TypeScript version" : `root TypeScript resolution unchanged (${rootTs})`);
					}
					if (!markerPresent) {
						reasons.push(prBody === null ? "PR body unavailable (set GITHUB_EVENT_PATH on pull_request)" : `PR body missing exact delta marker`);
					}
					return {
						ok: false,
						message: [
							`baseline increase not authorized for: ${increases.join(", ")}`,
							`  prior: pelaggio=${prior.baseline.packages.pelaggio}, server=${prior.baseline.packages.server}`,
							`  head:  pelaggio=${baseline.packages.pelaggio}, server=${baseline.packages.server}`,
							`  required marker: ${marker}`,
							`  reason: ${reasons.join("; ")}`,
						].join("\n"),
					};
				}
			}
		}
		// prior.kind === "missing": first introduction — skip increase policy.
	}

	return { ok: true, actual, baseline };
}

export function parseArgs(argv: string[]): { baseRef?: string; help?: boolean } {
	const out: { baseRef?: string; help?: boolean } = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		// pnpm forwards the literal `--` separator (`pnpm typecheck:ratchet -- --base-ref ...`).
		if (arg === "--") continue;
		if (arg === "--help" || arg === "-h") {
			out.help = true;
			continue;
		}
		if (arg === "--base-ref") {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) throw new Error("--base-ref requires a ref argument");
			out.baseRef = value;
			i += 1;
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return out;
}

export function main(argv = process.argv.slice(2), root = repoRoot()): number {
	let opts: { baseRef?: string; help?: boolean };
	try {
		opts = parseArgs(argv);
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		return 1;
	}
	if (opts.help) {
		console.log("Usage: typecheck-ratchet [--base-ref <ref>]");
		return 0;
	}

	const deps: RatchetDeps = {
		runCompiler: (key) => defaultRunCompiler(key, root),
		readBaseline: () => loadBaselineFile(resolve(root, "ci/typecheck-baseline.json")),
		readRootTypescript: () => resolveRootTypescript(root),
		readBaseBaseline: (ref) => defaultReadBaseBaseline(ref, root),
		readBaseRootTypescript: (ref) => defaultReadBaseRootTypescript(ref, root),
		readPrBody: defaultReadPrBody,
	};

	const result = runRatchet(deps, { baseRef: opts.baseRef });
	if (!result.ok) {
		console.error(`typecheck-ratchet FAILED\n${result.message}`);
		return 1;
	}
	console.log(
		`typecheck-ratchet OK\n  pelaggio: ${result.actual.pelaggio} (baseline ${result.baseline.packages.pelaggio})\n  server:   ${result.actual.server} (baseline ${result.baseline.packages.server})\n  typescript: ${result.baseline.typescript}`,
	);
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exit(main());
}
