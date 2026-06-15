#!/usr/bin/env tsx

/**
 * `claude-autopilot roadmap <subcommand>` — dispatcher that bridges skill
 * bodies (running inside SDK sessions with `Bash(npx:*)`) to the configured
 * `RoadmapSource` adapter. Skills call this instead of reading
 * docs/task-index.md / docs/roadmap-*.md directly, so a single CLI works
 * across markdown / github-issues / linear adapters.
 *
 * Exit codes: 0 success, 2 "not found" (callers distinguish from crashes).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { activeClaim, activeClaims, type Claim, canonicalId, ownerPid, reapStale, recordClaim, releaseClaim, resolveMainRepo, withClaimLock } from "./claim-ledger.js";
import type { RoadmapItemStatus, RoadmapSource } from "./roadmap/index.js";

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

/**
 * Overlay `in-progress` onto an open item that has an active (live) claim in the
 * ledger. Blocked/done/unknown statuses are left as-is — the durable source
 * still wins for those; the ledger only distinguishes "open" from "open but a
 * live cycle already holds it".
 */
function overlayInProgress(item: RoadmapItemStatus, claims: Record<string, Claim>): RoadmapItemStatus {
	if (item.status === "open" && canonicalId(item.id) in claims) {
		return { ...item, status: "in-progress" };
	}
	return item;
}

async function cmdList(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const includeDone = args.flags["include-done"] === true;
	const items = await roadmap.listItems({ includeDone });
	const claims = activeClaims(resolveMainRepo());
	const overlaid = items.map((it) => overlayInProgress(it, claims));
	if (args.flags.json) {
		printJson(overlaid);
		return 0;
	}
	for (const it of overlaid) {
		process.stdout.write(`${it.id}\t${it.status}\t${it.title}\t${it.deps}\n`);
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
	const claim = activeClaim(resolveMainRepo(), id);
	const overlaid = overlayInProgress(item, claim ? { [canonicalId(id)]: claim } : {});
	if (args.flags.json) {
		printJson(overlaid);
	} else {
		process.stdout.write(`${overlaid.id}\t${overlaid.status}\t${overlaid.title}\t${overlaid.deps}\n`);
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
	const mainRepo = resolveMainRepo();
	// The atomic unit is check-not-claimed → create branch+worktree → record. It
	// must be one critical section regardless of adapter, so the whole claim runs
	// under the lock (network adapters' API call included — claims are rare).
	return withClaimLock(mainRepo, async () => {
		reapStale(mainRepo);
		if (activeClaim(mainRepo, id)) {
			process.stdout.write("claim-result: already-claimed\n");
			return 3;
		}
		const { branch, worktree } = await roadmap.claimItem(id, noWorktree ? { noWorktree: true } : undefined);
		recordClaim(mainRepo, { id, branch, worktree, claimedAt: Date.now(), pid: ownerPid() });
		process.stdout.write(`branch=${branch}\nworktree=${worktree}\n`);
		return 0;
	});
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
	const mainRepo = resolveMainRepo();
	if (roadmap.name === "markdown") {
		// Markdown mutates shared local roadmap files — serialize the edit under
		// the lock alongside releasing the claim.
		await withClaimLock(mainRepo, async () => {
			await roadmap.markDone(id, note ? { note } : undefined);
			releaseClaim(mainRepo, id);
		});
	} else {
		// Network adapters mutate a remote that already serializes — keep the API
		// call outside the lock and only lock the JSON release.
		await roadmap.markDone(id, note ? { note } : undefined);
		await withClaimLock(mainRepo, () => releaseClaim(mainRepo, id));
	}
	return 0;
}

async function cmdCreateItem(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const title = args.flags.title;
	if (typeof title !== "string") {
		process.stderr.write("usage: roadmap create-item --title <t> [--deps <csv>] [--scope <x>] [--to <r>] [--after <id>] [--priority high|normal] [--deferred] [--json]\n");
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
	const opts = { title, deps, scope, roadmap: roadmapArg, after, priority, deferred };
	// Markdown appends to shared local roadmap files — serialize under the lock.
	// Network adapters POST to a remote that already serializes.
	const created = roadmap.name === "markdown" ? await withClaimLock(resolveMainRepo(), () => roadmap.createItem(opts)) : await roadmap.createItem(opts);
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
		process.stdout.write(`claude-autopilot roadmap <subcommand>\n\nSubcommands: ${Object.keys(HANDLERS).join(", ")}\n`);
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
