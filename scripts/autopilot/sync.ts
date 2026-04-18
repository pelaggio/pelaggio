#!/usr/bin/env tsx

/**
 * `claude-autopilot sync` — upgrade installed skills by diffing the package's
 * current `.claude/skills/<name>/SKILL.md` bodies against the consumer's
 * copies and prompting per-file: overwrite / skip / merge (sidecar).
 *
 * Self-contained: imports nothing from the pipeline. Safe to run with no
 * `.autopilot.yml`.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createTwoFilesPatch } from "diff";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export type Action = "overwrite" | "skip" | "merge" | "quit";

export type SyncPlan =
	| { kind: "create"; rel: string; src: string; dest: string }
	| { kind: "identical"; rel: string; src: string; dest: string }
	| { kind: "conflict"; rel: string; src: string; dest: string; consumerBody: string; packageBody: string };

export type Prompter = (plan: Extract<SyncPlan, { kind: "conflict" }>) => Promise<Action>;

export interface SyncOptions {
	pkgRoot: string;
	consumerRoot: string;
	force: boolean;
	dryRun: boolean;
	prompter?: Prompter;
	isTTY?: boolean;
}

export interface SyncResult {
	created: number;
	overwritten: number;
	skipped: number;
	merged: number;
	conflicts: number;
	sidecars: string[];
}

export function resolveConsumerRoot(cwd: string = process.cwd()): string {
	try {
		return execSync("git rev-parse --show-toplevel", { encoding: "utf-8", cwd }).trim();
	} catch {
		throw new Error("claude-autopilot sync must run inside a git repository");
	}
}

/**
 * Walk the package's `.claude/skills/` and return a plan per `<name>/SKILL.md`
 * where `<name>` is a directory entry that does not start with `_`.
 */
export function planSync(pkgRoot: string, consumerRoot: string): SyncPlan[] {
	const plans: SyncPlan[] = [];
	const pkgSkillsRoot = resolve(pkgRoot, ".claude/skills");
	if (!existsSync(pkgSkillsRoot)) return plans;

	for (const entry of readdirSync(pkgSkillsRoot).sort()) {
		if (entry.startsWith("_")) continue;
		const skillDir = resolve(pkgSkillsRoot, entry);
		if (!statSync(skillDir).isDirectory()) continue;
		const src = resolve(skillDir, "SKILL.md");
		if (!existsSync(src)) continue;

		const rel = `.claude/skills/${entry}/SKILL.md`;
		const dest = resolve(consumerRoot, rel);

		if (!existsSync(dest)) {
			plans.push({ kind: "create", rel, src, dest });
			continue;
		}

		const packageBody = readFileSync(src, "utf-8");
		const consumerBody = readFileSync(dest, "utf-8");
		if (packageBody === consumerBody) {
			plans.push({ kind: "identical", rel, src, dest });
		} else {
			plans.push({ kind: "conflict", rel, src, dest, consumerBody, packageBody });
		}
	}

	return plans;
}

const ALLOWED_DEST = /\/\.claude\/skills\/([^/_][^/]*)\/SKILL\.md(\.upstream)?$/;

function assertAllowed(dest: string): void {
	if (!ALLOWED_DEST.test(dest)) {
		throw new Error(`sync refuses to write outside .claude/skills/<name>/SKILL.md: ${dest}`);
	}
}

export function applyAction(plan: SyncPlan, action: Action): { wrote: string | null } {
	if (action === "quit" || action === "skip") return { wrote: null };

	if (plan.kind === "identical") return { wrote: null };

	if (plan.kind === "create" || action === "overwrite") {
		assertAllowed(plan.dest);
		mkdirSync(dirname(plan.dest), { recursive: true });
		const body = plan.kind === "conflict" ? plan.packageBody : readFileSync(plan.src, "utf-8");
		writeFileSync(plan.dest, body);
		return { wrote: plan.dest };
	}

	if (action === "merge") {
		if (plan.kind !== "conflict") return { wrote: null };
		const sidecar = `${plan.dest}.upstream`;
		assertAllowed(sidecar);
		mkdirSync(dirname(sidecar), { recursive: true });
		writeFileSync(sidecar, plan.packageBody);
		return { wrote: sidecar };
	}

	return { wrote: null };
}

function colorizeDiff(patch: string, useColor: boolean): string {
	if (!useColor) return patch;
	const green = "\x1b[32m";
	const red = "\x1b[31m";
	const reset = "\x1b[0m";
	return patch
		.split("\n")
		.map((line) => {
			if (line.startsWith("+++") || line.startsWith("---")) return line;
			if (line.startsWith("+")) return `${green}${line}${reset}`;
			if (line.startsWith("-")) return `${red}${line}${reset}`;
			return line;
		})
		.join("\n");
}

async function defaultPrompter(plan: Extract<SyncPlan, { kind: "conflict" }>): Promise<Action> {
	const patch = createTwoFilesPatch(`a/${plan.rel}`, `b/${plan.rel}`, plan.consumerBody, plan.packageBody, "consumer", "package");
	console.log("");
	console.log(colorizeDiff(patch, !!process.stdout.isTTY));

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question("[o]verwrite, [s]kip, [m]erge (write .upstream sidecar), [q]uit?  (default: s) ")).trim().toLowerCase();
		if (answer === "o" || answer === "overwrite") return "overwrite";
		if (answer === "m" || answer === "merge") return "merge";
		if (answer === "q" || answer === "quit") return "quit";
		return "skip";
	} finally {
		rl.close();
	}
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
	const { pkgRoot, consumerRoot, force, dryRun } = opts;
	const isTTY = opts.isTTY ?? !!process.stdin.isTTY;

	if (!dryRun && !force && !isTTY && !opts.prompter) {
		throw new Error("claude-autopilot sync: --force or --dry-run required when not running interactively");
	}

	const plans = planSync(pkgRoot, consumerRoot);
	const prompter = opts.prompter ?? defaultPrompter;

	const result: SyncResult = {
		created: 0,
		overwritten: 0,
		skipped: 0,
		merged: 0,
		conflicts: 0,
		sidecars: [],
	};

	for (const plan of plans) {
		const rel = relative(consumerRoot, plan.dest);
		if (plan.kind === "identical") {
			result.skipped++;
			continue;
		}

		if (plan.kind === "create") {
			result.created++;
			console.log(`  ${dryRun ? "would " : ""}create     ${rel}`);
			if (!dryRun) applyAction(plan, "overwrite");
			continue;
		}

		// conflict
		result.conflicts++;

		if (dryRun) {
			console.log(`  conflict   ${rel}`);
			continue;
		}

		const action: Action = force ? "overwrite" : await prompter(plan);

		if (action === "overwrite") {
			applyAction(plan, "overwrite");
			result.overwritten++;
			console.log(`  overwrite  ${rel}`);
		} else if (action === "merge") {
			const { wrote } = applyAction(plan, "merge");
			result.merged++;
			if (wrote) result.sidecars.push(wrote);
			console.log(`  merge      ${rel}  (wrote ${relative(consumerRoot, `${plan.dest}.upstream`)})`);
		} else if (action === "quit") {
			console.log(`  quit       (stopped before ${rel})`);
			break;
		} else {
			result.skipped++;
			console.log(`  skip       ${rel}`);
		}
	}

	return result;
}

function printSummary(result: SyncResult, dryRun: boolean): void {
	console.log("");
	if (dryRun) {
		console.log(`Would create: ${result.created}, identical: ${result.skipped}, conflicts: ${result.conflicts}`);
		console.log("\n(dry run — no files were modified)");
		return;
	}
	console.log(`create: ${result.created}, overwrite: ${result.overwritten}, skip: ${result.skipped}, merge: ${result.merged}`);
	if (result.sidecars.length > 0) {
		console.log("");
		console.log("Sidecars written (resolve manually):");
		for (const s of result.sidecars) console.log(`  ${s}`);
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			force: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
		},
	});

	const consumerRoot = resolveConsumerRoot();
	console.log(`Syncing into ${consumerRoot}\n`);

	const result = await runSync({
		pkgRoot: PKG_ROOT,
		consumerRoot,
		force: !!values.force,
		dryRun: !!values["dry-run"],
	});
	printSummary(result, !!values["dry-run"]);
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
	main().catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
