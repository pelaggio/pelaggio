import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { CreateItemOpts, ItemStatus, MarkDoneContext, RoadmapItem, RoadmapItemStatus, RoadmapSource, RoadmapSourceName } from "./types.js";

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

	resolvePlanPath(ctx: { id: string; worktree: string }): string {
		return resolve(ctx.worktree, "docs", "plans", `${ctx.id.toLowerCase()}.md`);
	}

	async publishPlan(_body: string, _ctx: { id: string; worktree: string }): Promise<void> {
		// Markdown: plan already lives on disk after /plan writes it. No-op.
	}

	async listOpenItems(): Promise<RoadmapItem[]> {
		const out: RoadmapItem[] = [];
		const docsDir = resolve(this.repo, "docs");
		if (!existsSync(docsDir)) return out;
		const roadmaps = listRoadmapFiles(docsDir);
		for (const file of roadmaps) {
			const path = resolve(docsDir, file);
			const body = readFileSync(path, "utf-8");
			for (const row of [...parseOpenTableRows(body), ...parseCheckboxRows(body)]) {
				// Skip crossed-out (completed) rows.
				if (row.item.startsWith("~~")) continue;
				const m = row.item.match(/^([A-Z]+-?\d[\dA-Z-]*)\.?\s*(.*)$/);
				if (!m) continue;
				out.push({ id: m[1], title: m[2].trim(), deps: row.deps, sourceRef: path });
			}
		}
		return out;
	}

	async listItems(opts?: { includeDone?: boolean }): Promise<RoadmapItemStatus[]> {
		const out: RoadmapItemStatus[] = [];
		const docsDir = resolve(this.repo, "docs");
		if (!existsSync(docsDir)) return out;
		const roadmaps = listRoadmapFiles(docsDir);
		for (const file of roadmaps) {
			const path = resolve(docsDir, file);
			const body = readFileSync(path, "utf-8");
			for (const row of [...parseOpenTableRows(body), ...parseCheckboxRows(body)]) {
				const isDone = row.item.startsWith("~~");
				if (isDone && !opts?.includeDone) continue;
				const cleaned = row.item.replace(/^~~|~~$/g, "");
				const m = cleaned.match(/^([A-Z]+-?\d[\dA-Z]*)\.?\s*(.*)$/);
				if (!m) continue;
				const id = m[1];
				const title = m[2].trim();
				let status: ItemStatus = "open";
				let blockedReason: string | undefined;
				if (isDone) status = "done";
				else if (/^blocked:/i.test(row.deps)) {
					status = "blocked";
					blockedReason = row.deps.replace(/^blocked:\s*/i, "").trim();
				}
				const item: RoadmapItemStatus = { id, title, deps: row.deps, sourceRef: path, status };
				if (blockedReason) item.blockedReason = blockedReason;
				out.push(item);
			}
		}
		return out;
	}

	async getItem(id: string): Promise<RoadmapItemStatus | null> {
		const all = await this.listItems({ includeDone: true });
		const hit = all.find((r) => r.id.toUpperCase() === id.toUpperCase());
		if (hit) return hit;
		// Also check "Recently completed" lists across roadmap files and task-index.md.
		const completedRe = new RegExp(`^-\\s+${escapeRegex(id)}\\s*✓`, "mi");
		const docsDir = resolve(this.repo, "docs");
		if (existsSync(docsDir)) {
			for (const file of readdirSync(docsDir)) {
				if (!file.endsWith(".md")) continue;
				if (!file.startsWith("roadmap-") && file !== "task-index.md") continue;
				const path = resolve(docsDir, file);
				if (completedRe.test(readFileSync(path, "utf-8"))) {
					return { id, title: "", deps: "", sourceRef: path, status: "done" };
				}
			}
		}
		return null;
	}

	async claimItem(id: string, opts?: { noWorktree?: boolean }): Promise<{ branch: string; worktree: string }> {
		const branch = `feat/${id.toLowerCase()}`;
		if (opts?.noWorktree) {
			execSync(`git checkout -b ${branch} main`, { cwd: this.repo, stdio: "pipe" });
			return { branch, worktree: this.repo };
		}
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
		const updatedRoadmap = detectFormat(roadmapBody) === "checkbox" ? markCheckboxRowDone(roadmapBody, id, note) : strikethroughRoadmapRow(roadmapBody, id, note);
		if (updatedRoadmap === roadmapBody) {
			// No open row was rewritten. Distinguish the idempotent case (the item is
			// already marked done → a safe no-op the bookkeeping tail relies on) from a
			// real failure (the row is genuinely absent / format has drifted while the
			// item is still open → must surface, not be swallowed as "already done").
			if (roadmapRowState(roadmapBody, id) === "done") return;
			throw new Error(`markDone: could not locate open row for ${id} in ${roadmapPath}`);
		}
		writeFileSync(roadmapPath, updatedRoadmap);

		const indexPath = resolveTaskIndexPath(docsDir);
		const indexExists = existsSync(indexPath);
		if (indexExists) {
			const indexBody = readFileSync(indexPath, "utf-8");
			const updatedIndex = moveToCompleted(indexBody, id);
			if (updatedIndex !== indexBody) writeFileSync(indexPath, updatedIndex);
		}

		// Commit only the paths this call touched (own pathspec) with `--no-verify`,
		// so a consumer's pre-commit hook can't break the pipeline and an unrelated
		// staged change can't be swept into the roadmap commit.
		const paths = [relative(this.repo, roadmapPath)];
		if (indexExists) paths.push(relative(this.repo, indexPath));
		const pathArgs = paths.map((p) => JSON.stringify(p)).join(" ");
		execSync(`git add ${pathArgs}`, { cwd: this.repo, stdio: "pipe" });
		const msg = note ? `docs: mark ${id} done — ${note}` : `docs: mark ${id} done`;
		execSync(`git commit --no-verify -m ${JSON.stringify(msg)} -- ${pathArgs}`, { cwd: this.repo, stdio: "pipe" });
	}

	async createItem(opts: CreateItemOpts): Promise<RoadmapItem> {
		const docsDir = resolve(this.repo, "docs");
		if (!existsSync(docsDir)) throw new Error("createItem: docs/ dir missing");

		// Pick target roadmap.
		const roadmaps = listRoadmapFiles(docsDir);
		if (roadmaps.length === 0) throw new Error("createItem: no docs/roadmap-*.md files found");
		let targetFile: string | undefined;
		if (opts.roadmap) {
			targetFile = roadmaps.find((f) => f.toLowerCase().includes(opts.roadmap!.toLowerCase()));
			if (!targetFile) throw new Error(`createItem: no roadmap file matches '${opts.roadmap}'`);
		} else {
			targetFile = roadmaps[0];
		}
		const targetPath = resolve(docsDir, targetFile);
		const body = readFileSync(targetPath, "utf-8");

		// Determine ID prefix by scanning existing item rows (checkbox/table) plus
		// "Recently completed" list lines (`- ID ✓`, the shape getItem honors and
		// /tidy produces) — not arbitrary prose. Prose tokens like "ADR-0003" or
		// "WSL2" would otherwise pollute the count and mis-allocate the next ID
		// (issue #46). Completed lines must count or the ID high-water mark is lost
		// when rows are pruned, re-minting a shipped item's ID. The prefix grammar
		// is [A-Z]+ (unbounded, like the row parsers') so any row they accept counts.
		const idRe = /^([A-Z]+)-?(\d+)/;
		const prefixCounts = new Map<string, number>();
		const maxByPrefix = new Map<string, number>();
		const count = (p: string, n: number) => {
			prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
			maxByPrefix.set(p, Math.max(maxByPrefix.get(p) ?? 0, n));
		};
		for (const row of [...parseOpenTableRows(body), ...parseCheckboxRows(body)]) {
			const m = row.item.replace(/^~~\s*|\s*~~$/g, "").match(idRe);
			if (!m) continue;
			count(m[1], parseInt(m[2], 10));
		}
		for (const m of body.matchAll(/^-\s+([A-Z]+)-?(\d+)[\dA-Z-]*\s*✓/gmu)) {
			count(m[1], parseInt(m[2], 10));
		}
		const prefix = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "ITEM";
		const nextN = (maxByPrefix.get(prefix) ?? 0) + 1;
		const id = `${prefix}-${nextN}`;

		const deps = (opts.deps ?? []).join(", ") || "—";
		const scope = opts.scope ?? "M";
		const title = opts.title;

		// Detect format: table vs checkbox.
		const format = detectFormat(body);
		let updated = body;
		if (format === "table") {
			const row = `| ${id}. ${title} | ${deps} |`;
			updated = appendOpenTableRow(body, row);
		} else {
			const line = `- [ ] **${id}. ${title}** — ${title}. Scope: ${scope}.${opts.deps && opts.deps.length > 0 ? ` Depends on ${deps}.` : ""}`;
			updated = `${body.replace(/\n*$/, "")}\n${line}\n`;
		}
		writeFileSync(targetPath, updated);

		// Update task-index.md if present.
		const indexPath = resolveTaskIndexPath(docsDir);
		const indexExists = existsSync(indexPath);
		if (indexExists) {
			const indexBody = readFileSync(indexPath, "utf-8");
			const roadmapSlug = targetFile.replace(/^roadmap-/, "").replace(/\.md$/, "");
			const row = `| ${id} | ${title} | ${deps} | — | ${roadmapSlug} |`;
			const updatedIndex = appendOpenTableRow(indexBody, row);
			if (updatedIndex !== indexBody) writeFileSync(indexPath, updatedIndex);
		}

		// Commit the new item immediately. markDone/archivePlan already commit;
		// createItem was the lone write that left the tree dirty — the exact
		// unstaged state a later ship's clean-tree requirement (or a merge's
		// discard-dirty recovery) could destroy, taking a deferred item with it.
		// `--no-verify` + own pathspec: a consumer's pre-commit hook must not break
		// the calling step, and only the files this call touched are committed.
		const staged = [relative(this.repo, targetPath)];
		if (indexExists) staged.push(relative(this.repo, indexPath));
		const stagedArgs = staged.map((p) => JSON.stringify(p)).join(" ");
		execSync(`git add ${stagedArgs}`, { cwd: this.repo, stdio: "pipe" });
		execSync(`git commit --no-verify -m ${JSON.stringify(`docs: add roadmap item ${id} — ${title}`)} -- ${stagedArgs}`, { cwd: this.repo, stdio: "pipe" });

		return { id, title, deps, sourceRef: targetPath };
	}

	async archivePlan(id: string): Promise<void> {
		const planPath = this.findPlanFile(id.toLowerCase());
		if (!planPath) return;
		const plansDir = resolve(this.repo, "docs", "plans");
		const archivedDir = resolve(this.repo, "docs", "archived");
		if (!planPath.startsWith(plansDir)) return;
		const filename = planPath.slice(plansDir.length + 1);
		const dest = resolve(archivedDir, filename);
		mkdirSync(archivedDir, { recursive: true });
		execSync(`git mv ${JSON.stringify(planPath)} ${JSON.stringify(dest)}`, { cwd: this.repo, stdio: "pipe" });
		// `--no-verify` + own pathspec (the renamed pair), consistent with markDone/createItem.
		const renamed = `${JSON.stringify(relative(this.repo, planPath))} ${JSON.stringify(relative(this.repo, dest))}`;
		execSync(`git commit --no-verify -m ${JSON.stringify(`docs: archive plan for ${id}`)} -- ${renamed}`, { cwd: this.repo, stdio: "pipe" });
	}

	isCharterPickRace(id: string): boolean {
		const indexPath = resolveTaskIndexPath(resolve(this.repo, "docs"));
		if (!existsSync(indexPath)) return false;
		if (!readFileSync(indexPath, "utf-8").includes(id)) return false;
		try {
			const relPath = relative(this.repo, indexPath);
			const head = execSync(`git show HEAD:${relPath}`, {
				cwd: this.repo,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			return !head.includes(id);
		} catch {
			// HEAD has no task-index.md yet — the whole file is uncommitted.
			return true;
		}
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
		for (const file of listRoadmapFiles(docsDir)) {
			const path = resolve(docsDir, file);
			const body = readFileSync(path, "utf-8");
			// Match open AND already-done rows (a struck-through `| ~~ID. …~~ |`) so
			// markDone can recognize an already-done item and treat it as an idempotent
			// no-op rather than mistaking it for a genuinely-absent item.
			if (new RegExp(`^\\|\\s*(?:~~\\s*)?${escapeRegex(id)}\\.`, "m").test(body)) return path;
			if (new RegExp(`^-\\s+\\[[ x]\\]\\s+\\*\\*${escapeRegex(id)}\\.`, "m").test(body)) return path;
		}
		return null;
	}
}

// ── Markdown helpers ──────────────────────────────────────────────────

interface RoadmapRow {
	item: string;
	deps: string;
}

function parseCheckboxRows(body: string): RoadmapRow[] {
	const re = /^-\s+\[([ x])\]\s+\*\*([A-Z]+-?\d[\dA-Z-]*)\.\s*(.+?)\*\*(?:\s+—\s+.*?)?(?:\s+Depends on\s+(.+?)\.)?\s*$/gm;
	const rows: RoadmapRow[] = [];
	for (const m of body.matchAll(re)) {
		const [, mark, id, title, deps] = m;
		// Emulate table convention: wrap done rows in ~~...~~ so downstream
		// status detection (`row.item.startsWith("~~")`) continues to work
		// without a second code path.
		const item = mark === "x" ? `~~${id}. ${title.trim()}~~` : `${id}. ${title.trim()}`;
		rows.push({ item, deps: (deps ?? "—").trim() });
	}
	return rows;
}

function markCheckboxRowDone(body: string, id: string, note?: string): string {
	const re = new RegExp(`^(-\\s+)\\[ \\](\\s+\\*\\*${escapeRegex(id)}\\..*)$`, "m");
	const done = note ? ` **Done** — ${note}` : " **Done**";
	return body.replace(re, (_match, prefix: string, rest: string) => `${prefix}[x]${rest}${done}`);
}

function resolveTaskIndexPath(docsDir: string): string {
	const primary = resolve(docsDir, "task-index.md");
	const alt = resolve(docsDir, "roadmap-task-index.md");
	if (existsSync(alt) && !existsSync(primary)) return alt;
	return primary;
}

// `roadmap-task-index.md` (fathom) shares the `roadmap-*.md` shape, so the
// glob picks it up alongside real roadmaps. Exclude it everywhere we list
// roadmap files — otherwise `createItem` with no `--roadmap` arg can land
// rows in the index file when readdir order surfaces it first.
function listRoadmapFiles(docsDir: string): string[] {
	return readdirSync(docsDir).filter((f) => f.startsWith("roadmap-") && f.endsWith(".md") && f !== "roadmap-task-index.md");
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

/**
 * Whether an item's row is open, already marked done, or genuinely absent — in
 * either roadmap format. Lets `markDone` treat an already-done item as an
 * idempotent no-op while still surfacing a real "row not found" (format drift
 * with the item still open) as an error the bookkeeping tail must not swallow.
 */
function roadmapRowState(body: string, id: string): "open" | "done" | "absent" {
	const esc = escapeRegex(id);
	if (detectFormat(body) === "checkbox") {
		if (new RegExp(`^-\\s+\\[ \\]\\s+\\*\\*${esc}\\.`, "m").test(body)) return "open";
		if (new RegExp(`^-\\s+\\[x\\]\\s+\\*\\*${esc}\\.`, "im").test(body)) return "done";
		return "absent";
	}
	// Table format: a done row is struck through — `| ~~ID. …~~ | **Done** |`.
	if (new RegExp(`^\\|\\s*~~\\s*${esc}\\.`, "m").test(body)) return "done";
	if (new RegExp(`^\\|\\s*${esc}\\.`, "m").test(body)) return "open";
	return "absent";
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

function detectFormat(body: string): "table" | "checkbox" {
	if (/^\|\s*Item\s*\|\s*Depends on\s*\|/m.test(body)) return "table";
	if (/^-\s+\[[ x]\]\s+\*\*/m.test(body)) return "checkbox";
	return "table";
}

function appendOpenTableRow(body: string, row: string): string {
	const lines = body.split("\n");
	// Roadmap files use `| Item | Depends on |`; task-index uses `| ID | Title | ...`.
	// Accept either as the open-items header.
	let headerIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^\|\s*(Item|ID)\s*\|/.test(lines[i])) {
			headerIdx = i;
			break;
		}
	}
	if (headerIdx < 0) {
		// Append to end.
		return `${body.replace(/\n*$/, "")}\n${row}\n`;
	}
	// Skip header + separator.
	let j = headerIdx + 1;
	if (j < lines.length && /^\|[-\s|]+\|$/.test(lines[j])) j++;
	// Advance through body rows.
	while (j < lines.length && lines[j].startsWith("|")) j++;
	lines.splice(j, 0, row);
	return lines.join("\n");
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
