#!/usr/bin/env tsx
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type RoadmapItem = {
	id: string;
	title: string;
	deps: string;
	status: "open" | "done";
	roadmap: string;
};

export type TaskIndexItem = {
	id: string;
	title: string;
	deps: string;
	plan: string;
	roadmap: string;
};

export type Drift = { kind: "missing-from-index"; item: RoadmapItem } | { kind: "missing-from-roadmap"; item: TaskIndexItem } | { kind: "id-collision"; id: string; roadmaps: string[] };

const ROADMAP_OPEN_RE = /^\|\s*(TOOL-\d+)\.\s+(.+?)\s*\|\s*(.+?)\s*\|\s*$/;
const ROADMAP_DONE_RE = /^\|\s*~~(TOOL-\d+)\.\s+(.+?)~~\s*\|\s*(.+?)\s*\|\s*$/;
const TASK_INDEX_RE = /^\|\s*(TOOL-\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\S+)\s*\|\s*$/;

export function parseRoadmap(body: string, roadmap: string): RoadmapItem[] {
	const lines = body.split("\n");
	const items: RoadmapItem[] = [];
	let inTable = false;
	let headerSeen = false;

	for (const raw of lines) {
		const line = raw.trimEnd();

		if (!inTable) {
			if (/^\|\s*Item\s*\|\s*Depends on\s*\|\s*$/.test(line)) {
				inTable = true;
				headerSeen = false;
			}
			continue;
		}

		if (!headerSeen) {
			if (/^\|\s*-+\s*\|\s*-+\s*\|\s*$/.test(line)) {
				headerSeen = true;
			}
			continue;
		}

		if (line === "" || line.startsWith("---")) {
			inTable = false;
			headerSeen = false;
			continue;
		}

		const done = ROADMAP_DONE_RE.exec(line);
		if (done) {
			items.push({ id: done[1], title: done[2], deps: done[3], status: "done", roadmap });
			continue;
		}
		const open = ROADMAP_OPEN_RE.exec(line);
		if (open) {
			items.push({ id: open[1], title: open[2], deps: open[3], status: "open", roadmap });
		}
	}

	return items;
}

export function parseTaskIndex(body: string): TaskIndexItem[] {
	const lines = body.split("\n");
	const items: TaskIndexItem[] = [];
	let inSection = false;
	let headerSeen = false;

	for (const raw of lines) {
		const line = raw.trimEnd();

		if (!inSection) {
			if (/^##\s+Open items\s*$/.test(line)) {
				inSection = true;
			}
			continue;
		}

		if (/^##\s+/.test(line)) {
			break;
		}

		if (!headerSeen) {
			if (/^\|\s*-+\s*\|/.test(line)) {
				headerSeen = true;
			}
			continue;
		}

		const m = TASK_INDEX_RE.exec(line);
		if (m) {
			items.push({ id: m[1], title: m[2], deps: m[3], plan: m[4], roadmap: m[5] });
		}
	}

	return items;
}

export function findDrift(roadmapItems: RoadmapItem[], taskIndex: TaskIndexItem[]): Drift[] {
	const drift: Drift[] = [];
	const openByRoadmap = new Map<string, RoadmapItem[]>();
	const indexById = new Map<string, TaskIndexItem>();

	for (const item of taskIndex) indexById.set(item.id, item);

	for (const item of roadmapItems) {
		if (item.status !== "open") continue;
		const existing = openByRoadmap.get(item.id);
		if (existing) existing.push(item);
		else openByRoadmap.set(item.id, [item]);
	}

	for (const [id, items] of openByRoadmap) {
		if (items.length > 1) {
			drift.push({ kind: "id-collision", id, roadmaps: items.map((i) => i.roadmap) });
		}
	}

	for (const [id, items] of openByRoadmap) {
		if (!indexById.has(id)) {
			drift.push({ kind: "missing-from-index", item: items[0] });
		}
	}

	for (const item of taskIndex) {
		if (!openByRoadmap.has(item.id)) {
			drift.push({ kind: "missing-from-roadmap", item });
		}
	}

	return drift;
}

export function formatDrift(drift: Drift[]): string {
	const missingIndex = drift.filter((d): d is Extract<Drift, { kind: "missing-from-index" }> => d.kind === "missing-from-index");
	const missingRoadmap = drift.filter((d): d is Extract<Drift, { kind: "missing-from-roadmap" }> => d.kind === "missing-from-roadmap");
	const collisions = drift.filter((d): d is Extract<Drift, { kind: "id-collision" }> => d.kind === "id-collision");

	const out: string[] = ["task-index ↔ roadmap drift detected:", ""];

	if (missingIndex.length > 0) {
		out.push("Missing from task-index (add these rows):");
		for (const d of missingIndex) {
			out.push(`  ${d.item.id}  [${d.item.roadmap}]  ${d.item.title}`);
		}
		out.push("");
	}

	if (missingRoadmap.length > 0) {
		out.push("Missing from any roadmap:");
		for (const d of missingRoadmap) {
			out.push(`  ${d.item.id}  (task-index row has no open roadmap counterpart)`);
		}
		out.push("");
	}

	if (collisions.length > 0) {
		out.push("ID collisions:");
		for (const d of collisions) {
			out.push(`  ${d.id}: appears in ${d.roadmaps.join(", ")}`);
		}
		out.push("");
	}

	if (missingIndex.length > 0) {
		out.push("Run 'pnpm check:roadmap --fix' to add missing task-index rows.");
	}

	return out.join("\n");
}

export function deriveFixDeps(rawDeps: string, roadmapItems: RoadmapItem[]): string {
	const doneIds = new Set(roadmapItems.filter((i) => i.status === "done").map((i) => i.id));
	const tokens = rawDeps
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && !doneIds.has(t));
	if (tokens.length === 0) return "—";
	return tokens.join(", ");
}

export function applyFix(taskIndexBody: string, additions: { item: RoadmapItem; deps: string }[]): string {
	if (additions.length === 0) return taskIndexBody;

	const lines = taskIndexBody.split("\n");
	let inSection = false;
	let headerSeen = false;
	let insertAt = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trimEnd();
		if (!inSection) {
			if (/^##\s+Open items\s*$/.test(line)) inSection = true;
			continue;
		}
		if (/^##\s+/.test(line)) {
			insertAt = i;
			break;
		}
		if (!headerSeen) {
			if (/^\|\s*-+\s*\|/.test(line)) headerSeen = true;
			continue;
		}
		if (TASK_INDEX_RE.test(line) || /^\|/.test(line)) {
			insertAt = i + 1;
		}
	}

	if (insertAt < 0) insertAt = lines.length;

	const newRows = additions.map(({ item, deps }) => `| ${item.id} | ${item.title} | ${deps} | — | ${item.roadmap} |`);

	while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;

	lines.splice(insertAt, 0, ...newRows);
	return lines.join("\n");
}

export function roadmapNameFromFile(filename: string): string {
	const base = basename(filename, ".md");
	return base.replace(/^roadmap-/, "");
}

function findRepoRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "..");
}

function loadRoadmaps(docsDir: string): { name: string; body: string; items: RoadmapItem[] }[] {
	const entries = readdirSync(docsDir)
		.filter((f) => /^roadmap-.+\.md$/.test(f))
		.sort();
	return entries.map((f) => {
		const body = readFileSync(join(docsDir, f), "utf8");
		const name = roadmapNameFromFile(f);
		return { name, body, items: parseRoadmap(body, name) };
	});
}

function runCli(argv: string[]): number {
	const fix = argv.includes("--fix");
	const repoRoot = findRepoRoot();
	const docsDir = join(repoRoot, "docs");
	const taskIndexPath = join(docsDir, "task-index.md");

	const roadmaps = loadRoadmaps(docsDir);
	const allItems = roadmaps.flatMap((r) => r.items);
	const taskIndexBody = readFileSync(taskIndexPath, "utf8");
	const taskIndex = parseTaskIndex(taskIndexBody);

	const drift = findDrift(allItems, taskIndex);

	if (drift.length === 0) {
		console.log("task-index and roadmap-*.md are consistent.");
		return 0;
	}

	if (fix) {
		const additions = drift.filter((d): d is Extract<Drift, { kind: "missing-from-index" }> => d.kind === "missing-from-index").map((d) => ({ item: d.item, deps: deriveFixDeps(d.item.deps, allItems) }));

		if (additions.length > 0) {
			const next = applyFix(taskIndexBody, additions);
			if (next !== taskIndexBody) {
				writeFileSync(taskIndexPath, next);
				console.log(`Added ${additions.length} row(s) to ${taskIndexPath}.`);
			}
		}

		const residual = drift.filter((d) => d.kind !== "missing-from-index");
		if (residual.length === 0) return 0;
		console.error(formatDrift(residual));
		return 1;
	}

	console.error(formatDrift(drift));
	return 1;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
	process.exit(runCli(process.argv.slice(2)));
}
