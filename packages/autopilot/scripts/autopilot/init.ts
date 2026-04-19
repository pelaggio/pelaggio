#!/usr/bin/env tsx
/**
 * `claude-autopilot init` — scaffold .claude/skills/, .autopilot.yml, and
 * starter docs into a consuming project.
 *
 * Self-contained: imports nothing from the pipeline. Safe to run before any
 * pipeline configuration exists in the consumer repo.
 */

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveArtifactRoot } from "./artifact-root.js";

const PKG_ROOT = resolveArtifactRoot(import.meta.url);

interface Plan {
	src: string;
	dest: string;
	exists: boolean;
}

interface InitOptions {
	pkgRoot: string;
	consumerRoot: string;
	force: boolean;
	dryRun: boolean;
}

interface InitResult {
	created: number;
	skipped: number;
	overwritten: number;
	pkgJsonChanged: boolean;
}

export function resolveConsumerRoot(cwd: string = process.cwd()): string {
	try {
		return execSync("git rev-parse --show-toplevel", { encoding: "utf-8", cwd }).trim();
	} catch {
		throw new Error("claude-autopilot init must run inside a git repository");
	}
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

export function planCopies(pkgRoot: string, consumerRoot: string): Plan[] {
	const plans: Plan[] = [];

	// 1. .claude/skills/ — every file except the package's own _rubric.md
	//    (the consumer gets the template version below).
	const skillsSrc = resolve(pkgRoot, ".claude/skills");
	for (const file of walk(skillsSrc)) {
		const rel = relative(skillsSrc, file);
		if (rel === "_rubric.md") continue;
		const dest = resolve(consumerRoot, ".claude/skills", rel);
		plans.push({ src: file, dest, exists: existsSync(dest) });
	}

	// 2. _rubric.md — copied from the template (project-blank), not the package's own.
	const rubricSrc = resolve(pkgRoot, ".claude-templates/_rubric.md");
	const rubricDest = resolve(consumerRoot, ".claude/skills/_rubric.md");
	plans.push({ src: rubricSrc, dest: rubricDest, exists: existsSync(rubricDest) });

	// 3. docs starter pair.
	for (const name of ["task-index.md", "roadmap-example.md"]) {
		const src = resolve(pkgRoot, ".claude-templates/docs", name);
		const dest = resolve(consumerRoot, "docs", name);
		plans.push({ src, dest, exists: existsSync(dest) });
	}

	// 4. .autopilot.yml stub.
	const ymlSrc = resolve(pkgRoot, ".autopilot.example.yml");
	const ymlDest = resolve(consumerRoot, ".autopilot.yml");
	plans.push({ src: ymlSrc, dest: ymlDest, exists: existsSync(ymlDest) });

	return plans;
}

function executeCopy(plan: Plan): void {
	mkdirSync(dirname(plan.dest), { recursive: true });
	copyFileSync(plan.src, plan.dest);
}

export function updatePackageJson(consumerRoot: string, dryRun: boolean): boolean {
	const pkgPath = resolve(consumerRoot, "package.json");
	if (!existsSync(pkgPath)) return false;
	const raw = readFileSync(pkgPath, "utf-8");
	const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
	const scripts = pkg.scripts ?? {};
	if (scripts.autopilot) return false;
	if (dryRun) return true;
	pkg.scripts = { ...scripts, autopilot: "claude-autopilot run" };
	const trailing = raw.endsWith("\n") ? "\n" : "";
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}${trailing}`);
	return true;
}

export function runInit(opts: InitOptions): InitResult {
	const { consumerRoot, force, dryRun } = opts;
	const plans = planCopies(opts.pkgRoot, consumerRoot);

	let created = 0;
	let skipped = 0;
	let overwritten = 0;

	for (const plan of plans) {
		const rel = relative(consumerRoot, plan.dest);
		if (plan.exists && !force) {
			skipped++;
			console.log(`  skip   ${rel} (exists)`);
			continue;
		}
		if (plan.exists) {
			overwritten++;
			console.log(`  ${dryRun ? "would " : ""}overwrite  ${rel}`);
		} else {
			created++;
			console.log(`  ${dryRun ? "would " : ""}create     ${rel}`);
		}
		if (!dryRun) executeCopy(plan);
	}

	const pkgJsonChanged = updatePackageJson(consumerRoot, dryRun);
	if (pkgJsonChanged) {
		console.log(`  ${dryRun ? "would " : ""}update     package.json (scripts.autopilot)`);
	}

	return { created, skipped, overwritten, pkgJsonChanged };
}

function printSummary(result: InitResult, dryRun: boolean): void {
	const verb = dryRun ? "Would " : "";
	console.log("");
	console.log(`${verb}create: ${result.created}, ${verb.toLowerCase()}skip: ${result.skipped}, ${verb.toLowerCase()}overwrite: ${result.overwritten}`);
	if (dryRun) {
		console.log("\n(dry run — no files were modified)");
		return;
	}
	console.log("");
	console.log("Next steps:");
	console.log("  1. Author your project rubric:   .claude/skills/_rubric.md");
	console.log("  2. Add a roadmap + items:        docs/roadmap-example.md  →  docs/task-index.md");
	console.log("  3. Run a smoke cycle:            pnpm autopilot --dry-run --cycles 1");
}

function main(): void {
	const { values } = parseArgs({
		options: {
			force: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
		},
	});

	const consumerRoot = resolveConsumerRoot();
	console.log(`Scaffolding into ${consumerRoot}\n`);

	const result = runInit({
		pkgRoot: PKG_ROOT,
		consumerRoot,
		force: !!values.force,
		dryRun: !!values["dry-run"],
	});
	printSummary(result, !!values["dry-run"]);
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) main();
