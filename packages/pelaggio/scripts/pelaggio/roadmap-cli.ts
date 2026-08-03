#!/usr/bin/env tsx

/**
 * `pelaggio roadmap <subcommand>` — dispatcher that bridges skill
 * bodies (running inside SDK sessions with `Bash(npx:*)`) to the configured
 * `RoadmapSource` adapter. Skills call this instead of reading
 * docs/task-index.md / docs/roadmap-*.md directly, so a single CLI works
 * across markdown / github-issues / linear adapters.
 *
 * Exit codes: 0 success, 2 "not found" (callers distinguish from crashes),
 * 3 "already claimed" (claim lost the race — the feat/<id> branch exists),
 * 4 "stale-quarantined" (claim refused a suspected already-done/obsolete item; #217).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_FLOW_POLICY, type FlowSnapshot } from "./flow-policy.js";
import { AlreadyClaimedError, isMarkdownRoadmapFormat, type RoadmapSource } from "./roadmap/index.js";
import { activeQuarantineIds, clearEntry, listQuarantine, loadQuarantine, resolveKeep, upsertHits } from "./roadmap/stale-quarantine.js";
import { scanStaleItems } from "./roadmap/stale-scan.js";
import type { RoadmapItemStatus, Scope } from "./roadmap/types.js";

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

let repoOverride: string | null = null;

/** Test seam: pin the repo used for the staleness scan / quarantine store, avoiding the
 *  eager `config.REPO` resolution (which would target the real repo, not a temp fixture). */
export function setRepo(repo: string): void {
	repoOverride = repo;
}

async function resolveRepoPath(): Promise<string> {
	if (repoOverride) return repoOverride;
	const { REPO } = await import("./config.js");
	return REPO;
}

async function defaultFactory(): Promise<() => RoadmapSource> {
	const { REPO, ROADMAP_GITHUB, ROADMAP_LINEAR, ROADMAP_SOURCE } = await import("./config.js");
	setRepo(REPO);
	const { getRoadmapSource } = await import("./roadmap/index.js");
	return () => getRoadmapSource(ROADMAP_SOURCE, { repo: REPO, github: ROADMAP_GITHUB, linear: ROADMAP_LINEAR });
}

/**
 * Cheap best-effort write-through (#217): scan the open set, persist active hits, and return the
 * gating id set. FAIL-OPEN on the hot path — a lock timeout / write error must never block a pick,
 * so it is caught and swallowed and policy still evaluates against the last-persisted set (or empty).
 */
async function refreshQuarantineIds(repo: string, items: readonly RoadmapItemStatus[]): Promise<ReadonlySet<string>> {
	try {
		const hits = scanStaleItems(items, repo);
		const openIds = new Set(items.filter((item) => item.status === "open").map((item) => item.id));
		return activeQuarantineIds(await upsertHits(repo, hits, openIds), items);
	} catch (err) {
		process.stderr.write(`⚠ stale quarantine refresh skipped: ${err instanceof Error ? err.message : String(err)}\n`);
		try {
			return activeQuarantineIds(loadQuarantine(repo), items);
		} catch {
			return new Set();
		}
	}
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

export function buildFlowSnapshot(items: readonly RoadmapItemStatus[], opts?: { topic?: string; maxScope?: Scope }): FlowSnapshot {
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
		const priority = item.priority;
		return {
			item,
			dependencies,
			unresolvedDependencies,
			fifoOrdinal,
			...(typeof priority === "number" && Number.isFinite(priority) ? { priority } : {}),
		};
	});
	return { candidates, readiness: { kind: "derived" }, ...(opts?.topic ? { topic: opts.topic } : {}), ...(opts?.maxScope ? { maxScope: opts.maxScope } : {}) };
}

async function cmdNext(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const repo = await resolveRepoPath();
	const items = await roadmap.listItems({ includeDone: true });
	const topic = typeof args.flags.topic === "string" ? args.flags.topic : undefined;
	const staleQuarantinedIds = await refreshQuarantineIds(repo, items);
	const { CONFIG } = await import("./config.js");
	const result = DEFAULT_FLOW_POLICY.evaluate({ ...buildFlowSnapshot(items, { topic, maxScope: CONFIG.pick.maxScope }), staleQuarantinedIds });
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
	// Staleness gate (#217): refuse an active-quarantined item (exit 4). Read-only — no scan here;
	// the write-through lives on `next`. A missing item falls through to the adapter's own handling.
	const staleItem = await roadmap.getItem(id);
	if (staleItem) {
		const file = loadQuarantine(await resolveRepoPath());
		if (activeQuarantineIds(file, [staleItem]).has(staleItem.id)) {
			const entry = file.entries[staleItem.id];
			const reason = entry?.reason ?? "stale";
			const evidence = entry?.evidence.join("; ") || "—";
			process.stderr.write(`${staleItem.id} is stale-quarantined (${reason}); evidence: ${evidence}\n`);
			process.stderr.write(`resolve first: npx pelaggio roadmap stale-resolve ${staleItem.id} --as done|keep\n`);
			return 4;
		}
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

async function cmdBackfillPriorityLabels(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	if (typeof roadmap.backfillPriorityLabels !== "function") {
		process.stderr.write(`backfill-priority-labels is not supported by the "${roadmap.name}" roadmap source\n`);
		return 1;
	}
	const result = await roadmap.backfillPriorityLabels();
	if (args.flags.json) {
		printJson(result);
	} else if (result.conflicts.length > 0) {
		process.stderr.write(`conflicts (body Priority: high + label priority:normal): ${result.conflicts.join(", ")}\n`);
		process.stderr.write(`scanned=${result.scanned} labeled=0 — resolve conflicts, then re-run\n`);
	} else {
		process.stdout.write(`scanned=${result.scanned} labeled=${result.labeled}\n`);
	}
	return result.conflicts.length > 0 ? 1 : 0;
}

async function cmdStaleScan(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const repo = await resolveRepoPath();
	const items = await roadmap.listItems({ includeDone: true });
	const hits = scanStaleItems(items, repo);
	const write = args.flags.write === true;
	if (write) {
		const openIds = new Set(items.filter((item) => item.status === "open").map((item) => item.id));
		await upsertHits(repo, hits, openIds);
	}
	if (args.flags.json) {
		printJson({ hits, wrote: write });
		return 0;
	}
	if (hits.length === 0) {
		process.stdout.write("no stale candidates\n");
		return 0;
	}
	for (const hit of hits) {
		process.stdout.write(`${hit.id}\t${hit.reason}\t${hit.evidence.join("; ")}\n`);
	}
	if (write) process.stdout.write(`\nquarantined ${hits.length} item(s) — resolve with: npx pelaggio roadmap stale-resolve <id> --as done|keep\n`);
	return 0;
}

async function cmdStaleList(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const repo = await resolveRepoPath();
	const items = await roadmap.listItems({ includeDone: true });
	const rows = listQuarantine(loadQuarantine(repo), items);
	if (args.flags.json) {
		printJson(rows);
		return 0;
	}
	if (rows.length === 0) {
		process.stdout.write("no active quarantine entries\n");
		return 0;
	}
	for (const row of rows) {
		process.stdout.write(`${row.id}\t${row.reason}${row.suppressed ? " (keep)" : ""}\t${row.evidence.join("; ")}\t${row.quarantinedAt}\n`);
	}
	return 0;
}

async function cmdStaleResolve(args: Args): Promise<number> {
	const roadmap = makeRoadmap();
	const repo = await resolveRepoPath();
	const id = args.positional[0];
	const as = args.flags.as;
	if (!id || (as !== "done" && as !== "keep")) {
		process.stderr.write("usage: roadmap stale-resolve <id> --as done|keep [--note <text>]\n");
		return 1;
	}
	const item = await roadmap.getItem(id);
	if (!item) {
		process.stderr.write(`not found: ${id}\n`);
		return 2;
	}
	const entry = loadQuarantine(repo).entries[item.id];
	if (!entry) {
		process.stderr.write(`not quarantined: ${item.id}\n`);
		return 2;
	}
	if (as === "keep") {
		await resolveKeep(repo, item.id, item);
		process.stdout.write(`kept ${item.id} — sticky until the item changes\n`);
		return 0;
	}
	const note = typeof args.flags.note === "string" ? args.flags.note : `stale-resolve done: ${entry.reason} — ${entry.evidence.join("; ") || "no evidence"}`;
	// markDone throwing propagates to main() (exit 1) BEFORE clearEntry, so a failed close retains the entry.
	await roadmap.markDone(item.id, { note });
	await clearEntry(repo, item.id);
	process.stdout.write(`marked ${item.id} done and cleared quarantine\n`);
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
	"backfill-priority-labels": cmdBackfillPriorityLabels,
	"stale-scan": cmdStaleScan,
	"stale-list": cmdStaleList,
	"stale-resolve": cmdStaleResolve,
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
