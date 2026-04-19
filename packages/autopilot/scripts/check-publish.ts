#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanSkillsOut, copySkillsIn } from "./pack-prepare.js";

export type PackedFile = { path: string; size: number };
export type Violation = { kind: "disallowed-path"; path: string } | { kind: "secret"; path: string; pattern: string; match: string } | { kind: "install-script"; name: string };

export const ALLOWED_PREFIXES = ["scripts/autopilot/", ".claude/skills/", ".claude-templates/", "bin/"];

export const ALLOWED_EXACT = [
	"package.json",
	"README.md",
	"LICENSE",
	// Top-level pipeline entry point; bin/claude-autopilot.js routes `run`/`stats`
	// to this file. The `scripts/autopilot/` prefix does NOT cover it.
	"scripts/autopilot.ts",
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
		if (DISALLOWED_INSIDE_ALLOWED.some((re) => re.test(path))) {
			violations.push({ kind: "disallowed-path", path });
		}
	}
	return violations;
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

	const scriptViolations = checkPackageScripts(pkg);

	const all = [...pathViolations, ...secretViolations, ...scriptViolations];

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
