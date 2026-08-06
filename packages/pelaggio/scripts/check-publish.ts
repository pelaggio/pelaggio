#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanSkillsOut, copySkillsIn } from "./pack-prepare.js";

export type PackedFile = { path: string; size: number };
export type Violation = { kind: "disallowed-path"; path: string } | { kind: "secret"; path: string; pattern: string; match: string } | { kind: "install-script"; name: string } | { kind: "missing-packaged-data"; path: string };

export const ALLOWED_PREFIXES = ["scripts/pelaggio/", ".claude/skills/", ".claude-templates/", "bin/"];

/**
 * The one runtime-data exception inside the otherwise-excluded test tree: the `review-bench` benchmark
 * fixtures are consumed by the installed `npx pelaggio review-bench --replay` command (#291), so they
 * must ship. The exception is narrow — only JSON under this exact prefix — so test TypeScript and every
 * other `__tests__` path (including non-JSON under this prefix) stays rejected.
 */
export const ALLOWED_TEST_DATA_PREFIX = "scripts/pelaggio/__tests__/fixtures/review-bench/";

export function isAllowedPackagedTestData(path: string): boolean {
	return path.startsWith(ALLOWED_TEST_DATA_PREFIX) && path.endsWith(".json");
}

/** The review-bench corpus files that MUST be present in the packed artifact or the installed CLI is broken. */
export const REQUIRED_PACKAGED_TEST_DATA: readonly string[] = [
	`${ALLOWED_TEST_DATA_PREFIX}manifest.json`,
	`${ALLOWED_TEST_DATA_PREFIX}review-bench.baseline.json`,
	...["clean", "single-blocker", "safety-blocker", "plausible-wrong"].flatMap((id) => [`${ALLOWED_TEST_DATA_PREFIX}${id}/fixture.json`, `${ALLOWED_TEST_DATA_PREFIX}${id}/golden.json`]),
];

export const ALLOWED_EXACT = [
	"package.json",
	"README.md",
	"LICENSE",
	// Top-level pipeline entry point; bin/pelaggio.js routes `run`/`stats`
	// to this file. The `scripts/pelaggio/` prefix does NOT cover it.
	"scripts/pelaggio.ts",
];

export const DISALLOWED_INSIDE_ALLOWED: RegExp[] = [/\/__tests__\//, /\.test\.ts$/];

export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
	{ name: "anthropic-api-key", re: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
	{ name: "github-token", re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
	{ name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
	{ name: "npm-token", re: /npm_[A-Za-z0-9]{30,}/ },
	{ name: "private-key-header", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
];

export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

export function checkAllowlist(files: PackedFile[]): Violation[] {
	const violations: Violation[] = [];
	for (const f of files) {
		const path = f.path;
		if (ALLOWED_EXACT.includes(path)) continue;
		const prefix = ALLOWED_PREFIXES.find((p) => path.startsWith(p));
		if (!prefix) {
			violations.push({ kind: "disallowed-path", path });
			continue;
		}
		if (DISALLOWED_INSIDE_ALLOWED.some((re) => re.test(path)) && !isAllowedPackagedTestData(path)) {
			violations.push({ kind: "disallowed-path", path });
		}
	}
	return violations;
}

/** Presence check: the installed CLI needs its default review-bench corpus, so require every corpus file. */
export function checkRequiredPackagedData(files: PackedFile[]): Violation[] {
	const present = new Set(files.map((f) => f.path));
	return REQUIRED_PACKAGED_TEST_DATA.filter((path) => !present.has(path)).map((path) => ({ kind: "missing-packaged-data", path }));
}

export function scanContentsForSecrets(entries: Array<{ path: string; contents: string }>): Violation[] {
	const violations: Violation[] = [];
	for (const entry of entries) {
		for (const { name, re } of SECRET_PATTERNS) {
			const m = re.exec(entry.contents);
			if (m) {
				violations.push({ kind: "secret", path: entry.path, pattern: name, match: m[0] });
			}
		}
	}
	return violations;
}

export function checkPackageScripts(pkg: { scripts?: Record<string, string> }): Violation[] {
	const violations: Violation[] = [];
	const scripts = pkg.scripts ?? {};
	for (const name of INSTALL_SCRIPTS) {
		if (name in scripts) {
			violations.push({ kind: "install-script", name });
		}
	}
	return violations;
}

type NpmPackEntry = { path: string; size: number };
type NpmPackResult = { files: NpmPackEntry[] };

type PackedWithContents = { files: PackedFile[]; entries: Array<{ path: string; contents: string }> };

function npmPackDryRun(repoRoot: string): PackedWithContents {
	// Synthesize what `prepack` does, then call `npm pack --dry-run --ignore-scripts`.
	// We can't let npm run the lifecycle because `postpack` would fire before this
	// function returns, deleting the skills/templates we still need to read for
	// the secret scan. Doing the copy ourselves and skipping the lifecycle gives
	// us a stable file tree from pack-time through content read.
	copySkillsIn(repoRoot);
	try {
		const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
		// npm still emits lines like "> pkg@x prepare" and "sync hooks: ..." to stdout
		// before the JSON, so locate the first `[` and parse from there.
		const jsonStart = raw.indexOf("[");
		if (jsonStart < 0) throw new Error("npm pack --dry-run --json produced no JSON array");
		const parsed = JSON.parse(raw.slice(jsonStart)) as NpmPackResult[];
		const first = parsed[0];
		if (!first || !Array.isArray(first.files)) {
			throw new Error("npm pack --dry-run --json returned unexpected shape");
		}
		const files = first.files.map((f) => ({ path: f.path, size: f.size }));
		const entries = files.map((f) => ({ path: f.path, contents: readFileSync(resolve(repoRoot, f.path), "utf8") }));
		return { files, entries };
	} finally {
		cleanSkillsOut(repoRoot);
	}
}

function formatViolation(v: Violation): string {
	switch (v.kind) {
		case "disallowed-path":
			return `  disallowed-path: ${v.path}`;
		case "secret":
			return `  secret (${v.pattern}): ${v.path} — matched ${JSON.stringify(v.match.slice(0, 40))}`;
		case "install-script":
			return `  install-script: package.json declares "${v.name}" (forbidden)`;
		case "missing-packaged-data":
			return `  missing-packaged-data: ${v.path} (installed review-bench CLI needs this fixture)`;
	}
}

function findRepoRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "..");
}

export function runCli(): number {
	const repoRoot = findRepoRoot();
	const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };

	const { files: packed, entries } = npmPackDryRun(repoRoot);
	const pathViolations = checkAllowlist(packed);
	const secretViolations = scanContentsForSecrets(entries);
	const missingDataViolations = checkRequiredPackagedData(packed);

	const scriptViolations = checkPackageScripts(pkg);

	const all = [...pathViolations, ...secretViolations, ...missingDataViolations, ...scriptViolations];

	if (all.length === 0) {
		console.log(`check-publish: OK (${packed.length} files)`);
		return 0;
	}

	console.error("check-publish: violations detected");
	for (const v of all) console.error(formatViolation(v));
	return 1;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
	process.exit(runCli());
}
