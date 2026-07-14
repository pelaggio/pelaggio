#!/usr/bin/env tsx

/**
 * `pelaggio roadmap <subcommand>` — dispatcher that bridges skill
 * bodies (running inside SDK sessions with `Bash(npx:*)`) to the configured
 * `RoadmapSource` adapter. Skills call this instead of reading
 * docs/task-index.md / docs/roadmap-*.md directly, so a single CLI works
 * across markdown / github-issues / linear adapters.
 *
 * Exit codes: 0 success, 2 "not found" (callers distinguish from crashes),
 * 3 "already claimed" (claim lost the race — the feat/<id> branch exists).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_FLOW_POLICY, type FlowSnapshot } from "./flow-policy.js";
import { AlreadyClaimedError, isMarkdownRoadmapFormat, type RoadmapSource } from "./roadmap/index.js";
import type { RoadmapItemStatus } from "./roadmap/types.js";

type Args = {
	flags: Record<string, string | boolean>;
	positional: string[];
};

function parseArgs(argv: string[]): Args {
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				flags[key] = true;
			} else {
				flags[key] = next;
				i++;
			}
		} else {
			positional.push(a);
		}
	}
	return { flags, positional };
}

let roadmapFactory: () => RoadmapSource = () => {
	throw new Error("roadmap factory not initialized — call main() from the CLI entry");
};

export function setRoadmapFactory(factory: () => RoadmapSource): void {
	roadmapFactory = factory;
}

function makeRoadmap(): RoadmapSource {
	return roadmapFactory();
}

async function defaultFactory(): Promise<() => RoadmapSource> {
	const { REPO, ROADMAP_GITHUB, ROADMAP_LINEAR, ROADMAP_SOURCE } = await import("./config.js");
	const { getRoadmapSource } = await import("./roadmap/index.js");
	return () => getRoadmapSource(ROADMAP_SOURCE, { repo: REPO, github: ROADMAP_GITHUB, linear: ROADMAP_LINEAR });
}

function publishRoot(): string {
	// Only markdown's publishPlan uses this (as a no-op cwd). Remote adapters
	// resolve the issue from id directly. Safe to use CWD.
	return process.cwd();
}

function printJson(v: unknown): void {
	process.stdout.write(`${JSON.stringify(v)}\n`);
}

async function cmdList(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const includeDone = args.flags["include-done"] === true;
	const items = await roadmap.listItems({ includeDone });
	if (args.flags.json) {
		printJson(items);
		return 0;
	}
	for (const it of items) {
		process.stdout.write(`${it.id}\t${it.status}\t${it.title}\t${it.deps}\n`);
	}
	return 0;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildFlowSnapshot(items: readonly RoadmapItemStatus[], topic?: string): FlowSnapshot {
	const known = [...items].sort((a, b) => b.id.length - a.id.length);
	const candidates = items.map((item, fifoOrdinal) => {
		let remainder = item.deps.trim();
		const dependencies: Array<{ reference: string; satisfied: boolean }> = [];
		for (const dependency of known) {
			const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(dependency.id)}(?![A-Za-z0-9])`, "gi");
			if (!pattern.test(remainder)) continue;
			dependencies.push({ reference: dependency.id, satisfied: dependency.status === "done" });
			remainder = remainder.replace(pattern, " ");
		}
		const unresolved = remainder.replace(/[\s,;|()[\]]+/g, " ").trim();
		const unresolvedDependencies = unresolved === "" || unresolved === "—" || /^(?:none|n\/a|-)$/.test(unresolved.toLowerCase()) ? [] : [unresolved];
		const priority = (item as RoadmapItemStatus & { priority?: unknown }).priority;
		return {
			item,
			dependencies,
			unresolvedDependencies,
			fifoOrdinal,
			...(typeof priority === "number" && Number.isFinite(priority) ? { priority } : {}),
		};
	});
	return { candidates, readiness: { kind: "derived" }, ...(topic ? { topic } : {}) };
}

async function cmdNext(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const items = await roadmap.listItems({ includeDone: true });
	const topic = typeof args.flags.topic === "string" ? args.flags.topic : undefined;
	const result = DEFAULT_FLOW_POLICY.evaluate(buildFlowSnapshot(items, topic));
	if (args.flags.json) {
		printJson(result);
	} else if (result.candidates[0]) {
		const { item } = result.candidates[0];
		process.stdout.write(`${item.id}\t${item.status}\t${item.title}\t${item.deps}\n`);
	}
	return 0;
}

async function cmdGet(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const id = args.positional[0];
	if (!id) {
		process.stderr.write("usage: roadmap get <id> [--json]\n");
		return 1;
	}
	const item = await roadmap.getItem(id);
	if (!item) {
		if (args.flags.json) printJson({ id, status: "unknown" });
		else process.stderr.write(`not found: ${id}\n`);
		return 2;
	}
	if (args.flags.json) {
		printJson(item);
	} else {
		process.stdout.write(`${item.id}\t${item.status}\t${item.title}\t${item.deps}\n`);
	}
	return 0;
}

async function cmdClaim(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const id = args.positional[0];
	if (!id) {
		process.stderr.write("usage: roadmap claim <id> [--no-worktree]\n");
		return 1;
	}
	const noWorktree = args.flags["no-worktree"] === true;
	try {
		const { branch, worktree } = await roadmap.claimItem(id, noWorktree ? { noWorktree: true } : undefined);
		process.stdout.write(`branch=${branch}\nworktree=${worktree}\n`);
	} catch (err) {
		if (err instanceof AlreadyClaimedError) {
			// git's ref lock is the claim arbiter (issue #12): the loser of a pick
			// race exits 3 so /pick maps it to `pick-result: already-claimed`.
			process.stderr.write(`${err.message}\n`);
			return 3;
		}
		throw err;
	}
	return 0;
}

async function cmdPlanPath(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const id = args.flags.id;
	const worktree = args.flags.worktree;
	if (typeof id !== "string" || typeof worktree !== "string") {
		process.stderr.write("usage: roadmap plan-path --id <id> --worktree <path>\n");
		return 1;
	}
	const path = roadmap.resolvePlanPath({ id, worktree });
	process.stdout.write(`${path}\n`);
	return existsSync(path) ? 0 : 2;
}

async function cmdPublishPlan(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const id = args.flags.id;
	const file = args.flags.file;
	if (typeof id !== "string" || typeof file !== "string") {
		process.stderr.write("usage: roadmap publish-plan --id <id> --file <path>\n");
		return 1;
	}
	const body = readFileSync(file, "utf-8");
	await roadmap.publishPlan(body, { id, worktree: publishRoot() });
	return 0;
}

async function cmdMarkDone(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const id = args.positional[0];
	if (!id) {
		process.stderr.write("usage: roadmap mark-done <id> [--note <text>]\n");
		return 1;
	}
	const note = typeof args.flags.note === "string" ? args.flags.note : undefined;
	await roadmap.markDone(id, note ? { note } : undefined);
	return 0;
}

async function cmdCreateItem(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const title = args.flags.title;
	if (typeof title !== "string") {
		process.stderr.write("usage: roadmap create-item --title <t> [--deps <csv>] [--scope <x>] [--to <r>] [--after <id>] [--priority high|normal] [--deferred] [--create] [--prefix <PFX>] [--format checkbox|table] [--json]\n");
		return 1;
	}
	const deps =
		typeof args.flags.deps === "string"
			? args.flags.deps
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: undefined;
	const scope = typeof args.flags.scope === "string" ? (args.flags.scope as "XS" | "S" | "M" | "L" | "XL") : undefined;
	const roadmapArg = typeof args.flags.to === "string" ? args.flags.to : undefined;
	const after = typeof args.flags.after === "string" ? args.flags.after : undefined;
	const priority = args.flags.priority === "high" ? "high" : args.flags.priority === "normal" ? "normal" : undefined;
	const deferred = args.flags.deferred === true;
	const create = args.flags.create === true;
	const prefix = typeof args.flags.prefix === "string" ? args.flags.prefix : undefined;
	const rawFormat = args.flags.format;
	if (rawFormat !== undefined && !isMarkdownRoadmapFormat(rawFormat)) {
		process.stderr.write("usage: roadmap create-item --format checkbox|table\n");
		return 1;
	}
	const format = rawFormat;
	const created = await roadmap.createItem({ title, deps, scope, roadmap: roadmapArg, after, priority, deferred, create, prefix, format });
	if (args.flags.json) printJson(created);
	else process.stdout.write(`${created.id}\t${created.title}\n`);
	return 0;
}

async function cmdArchivePlan(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const id = args.positional[0];
	if (!id) {
		process.stderr.write("usage: roadmap archive-plan <id>\n");
		return 1;
	}
	await roadmap.archivePlan(id);
	return 0;
}

async function cmdSource(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	if (args.flags.json) printJson({ name: roadmap.name });
	else process.stdout.write(`${roadmap.name}\n`);
	return 0;
}

const HANDLERS: Record<string, (args: Args) => Promise<number>> = {
	list: cmdList,
	next: cmdNext,
	get: cmdGet,
	claim: cmdClaim,
	"plan-path": cmdPlanPath,
	"publish-plan": cmdPublishPlan,
	"mark-done": cmdMarkDone,
	"create-item": cmdCreateItem,
	"archive-plan": cmdArchivePlan,
	source: cmdSource,
};

export async function main(argv: string[]): Promise<number> {
	const [sub, ...rest] = argv;
	if (!sub || sub === "--help" || sub === "-h") {
		process.stdout.write(`pelaggio roadmap <subcommand>\n\nSubcommands: ${Object.keys(HANDLERS).join(", ")}\n`);
		return sub ? 0 : 1;
	}
	const handler = HANDLERS[sub];
	if (!handler) {
		process.stderr.write(`unknown subcommand: ${sub}\n`);
		return 1;
	}
	try {
		return await handler(parseArgs(rest));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write(`${msg}\n`);
		return 1;
	}
}

// Run when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	defaultFactory()
		.then((factory) => {
			setRoadmapFactory(factory);
			return main(process.argv.slice(2));
		})
		.then((code) => process.exit(code));
}
