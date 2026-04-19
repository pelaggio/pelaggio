import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MarkDoneContext, RoadmapItem, RoadmapSource, RoadmapSourceName } from "./types.js";

export class MarkdownRoadmap implements RoadmapSource {
	readonly name: RoadmapSourceName = "markdown";
	private readonly repo: string;

	constructor(opts: { repo: string }) {
		this.repo = opts.repo;
	}

	async parseItemId(text: string): Promise<string | null> {
		const known = (await this.listOpenItems()).map((it) => it.id);
		const branchMatch = text.match(/feat\/([a-z0-9][a-z0-9-]*)/i);
		if (branchMatch && known.length > 0) {
			const slug = branchMatch[1].toLowerCase();
			let best: string | null = null;
			for (const id of known) {
				const lower = id.toLowerCase();
				if (slug.startsWith(lower) && (!best || lower.length > best.length)) best = id;
			}
			if (best) return best;
		}
		if (known.length > 0) {
			let best: string | null = null;
			for (const id of known) {
				const re = new RegExp(`\\b${escapeRegex(id)}\\b`);
				if (re.test(text) && (!best || id.length > best.length)) best = id;
			}
			if (best) return best;
		}
		if (branchMatch) {
			const slug = branchMatch[1];
			const idMatch = slug.match(/^([a-z][\da-z]*(?:-\d+)?)/i);
			if (idMatch) return idMatch[1].toUpperCase();
		}
		const explicit = text.match(/\b([A-Z]{1,4}-?\d[\dA-Z]*)\b/);
		return explicit?.[1] ?? null;
	}

	isQuickScope(text: string): boolean {
		return /scope:\s*x?s\b/i.test(text) || /\bbug\b|\bfix:/i.test(text);
	}

	async getItemPlan(ref: { worktree?: string; id?: string }): Promise<string | null> {
		if (ref.worktree) {
			const fromBranch = this.findPlanPathFromWorktree(ref.worktree);
			if (fromBranch) return fromBranch;
		}
		if (ref.id) return this.findPlanFile(ref.id.toLowerCase());
		return null;
	}

	async listOpenItems(): Promise<RoadmapItem[]> {
		const out: RoadmapItem[] = [];
		const docsDir = resolve(this.repo, "docs");
		if (!existsSync(docsDir)) return out;
		const roadmaps = readdirSync(docsDir).filter((f) => f.startsWith("roadmap-") && f.endsWith(".md"));
		for (const file of roadmaps) {
			const path = resolve(docsDir, file);
			const body = readFileSync(path, "utf-8");
			for (const row of parseOpenTableRows(body)) {
				// Skip crossed-out (completed) rows.
				if (row.item.startsWith("~~")) continue;
				const m = row.item.match(/^([A-Z]+-?\d[\dA-Z-]*)\.?\s*(.*)$/);
				if (!m) continue;
				out.push({ id: m[1], title: m[2].trim(), deps: row.deps, sourceRef: path });
			}
		}
		return out;
	}

	async claimItem(id: string): Promise<{ branch: string; worktree: string }> {
		const branch = `feat/${id.toLowerCase()}`;
		const prefix = process.env.CLAUDE_AUTOPILOT_WORKTREE_PREFIX ?? `${this.repo.split("/").pop()}-`;
		const worktree = resolve(this.repo, "..", `${prefix}${id.toLowerCase()}`);
		execSync(`git worktree add -b ${branch} ${worktree} main`, { cwd: this.repo, stdio: "pipe" });
		return { branch, worktree };
	}

	async markDone(id: string, ctx?: MarkDoneContext): Promise<void> {
		const docsDir = resolve(this.repo, "docs");
		const roadmapPath = this.findRoadmapContainingItem(id, docsDir);
		if (!roadmapPath) throw new Error(`markDone: item ${id} not found in any docs/roadmap-*.md`);

		const note = ctx?.note?.trim();
		const roadmapBody = readFileSync(roadmapPath, "utf-8");
		const updatedRoadmap = strikethroughRoadmapRow(roadmapBody, id, note);
		if (updatedRoadmap === roadmapBody) throw new Error(`markDone: could not locate open row for ${id} in ${roadmapPath}`);
		writeFileSync(roadmapPath, updatedRoadmap);

		const indexPath = resolve(docsDir, "task-index.md");
		if (existsSync(indexPath)) {
			const indexBody = readFileSync(indexPath, "utf-8");
			const updatedIndex = moveToCompleted(indexBody, id);
			if (updatedIndex !== indexBody) writeFileSync(indexPath, updatedIndex);
		}

		execSync(`git add docs/roadmap-*.md docs/task-index.md`, { cwd: this.repo, stdio: "pipe" });
		const msg = note ? `docs: mark ${id} done — ${note}` : `docs: mark ${id} done`;
		execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: this.repo, stdio: "pipe" });
	}

	private findPlanPathFromWorktree(worktree: string): string | null {
		try {
			const branch = execSync("git branch --show-current", { cwd: worktree, encoding: "utf-8" }).trim();
			const slug = branch.replace(/^feat\//, "");
			return this.findPlanFile(slug);
		} catch {
			return null;
		}
	}

	/**
	 * Sync lookup for a plan file by slug (e.g. "tool-9" or "tool-9-roadmap-source").
	 * Exposed for callers that cannot `await` (e.g. `detectResumeStep`); prefer
	 * `getItemPlan()` on the interface where possible.
	 */
	findPlanFile(slug: string): string | null {
		const dirs = [resolve(this.repo, "docs", "plans"), resolve(this.repo, ".dev", "plans")];
		for (const dir of dirs) {
			const exact = resolve(dir, `${slug}.md`);
			if (existsSync(exact)) return exact;
		}
		const idMatch = slug.match(/^([a-z]+-?\d+)/i);
		if (idMatch) {
			const prefix = `${idMatch[1].toLowerCase()}-`;
			for (const dir of dirs) {
				if (!existsSync(dir)) continue;
				const hit = readdirSync(dir).find((f) => f.toLowerCase().startsWith(prefix) && f.endsWith(".md"));
				if (hit) return resolve(dir, hit);
			}
		}
		return null;
	}

	private findRoadmapContainingItem(id: string, docsDir: string): string | null {
		if (!existsSync(docsDir)) return null;
		for (const file of readdirSync(docsDir)) {
			if (!file.startsWith("roadmap-") || !file.endsWith(".md")) continue;
			const path = resolve(docsDir, file);
			const body = readFileSync(path, "utf-8");
			if (new RegExp(`^\\|\\s*${escapeRegex(id)}\\.`, "m").test(body)) return path;
		}
		return null;
	}
}

// ── Markdown helpers ──────────────────────────────────────────────────

interface RoadmapRow {
	item: string;
	deps: string;
}

function parseOpenTableRows(body: string): RoadmapRow[] {
	const rows: RoadmapRow[] = [];
	const lines = body.split("\n");
	let inTable = false;
	for (const line of lines) {
		if (/^\|\s*Item\s*\|\s*Depends on\s*\|/.test(line)) {
			inTable = true;
			continue;
		}
		if (inTable) {
			if (/^\|[-\s|]+\|$/.test(line)) continue;
			if (!line.startsWith("|")) {
				inTable = false;
				continue;
			}
			const cells = line
				.split("|")
				.slice(1, -1)
				.map((s) => s.trim());
			if (cells.length < 2) continue;
			rows.push({ item: cells[0], deps: cells[1] });
		}
	}
	return rows;
}

function strikethroughRoadmapRow(body: string, id: string, note?: string): string {
	const rowRegex = new RegExp(`^\\|\\s*(${escapeRegex(id)}\\.[^|]*)\\|([^|]*)\\|\\s*$`, "m");
	return body.replace(rowRegex, (_match, item: string, _deps: string) => {
		const trimmedItem = item.trim();
		if (trimmedItem.startsWith("~~")) return _match;
		const done = note ? `**Done** — ${note}` : "**Done**";
		return `| ~~${trimmedItem}~~ | ${done} |`;
	});
}

function moveToCompleted(body: string, id: string): string {
	const lines = body.split("\n");
	const rowIdx = lines.findIndex((l) => new RegExp(`^\\|\\s*${escapeRegex(id)}\\s*\\|`).test(l));
	if (rowIdx < 0) return body;
	lines.splice(rowIdx, 1);
	const completedIdx = lines.findIndex((l) => /^##\s+Recently completed\b/i.test(l));
	if (completedIdx < 0) return lines.join("\n");
	let insertAt = completedIdx + 1;
	while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
	lines.splice(insertAt, 0, `- ${id} ✓`);
	return lines.join("\n");
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
