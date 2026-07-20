import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { withMutationLock } from "./roadmap/mutation-lock.js";
import type { Decision, Step } from "./types.js";

export const DECISIONS_HEADER = "| Decision | Status | Chosen/leaning | Alternatives | Source | Date |";
const RULE = "| --- | --- | --- | --- | --- | --- |";
export const DECISIONS_SKELETON = `# Decisions\n\nStatus values are \`default-taken\`, \`resolved\`, or \`resolved→ADR-nnnn\`. Source is an item, pull request, or review-note reference.\n\n## Active\n\n${DECISIONS_HEADER}\n${RULE}\n\n## Resolved\n\n${DECISIONS_HEADER}\n${RULE}\n`;

export interface DecisionAppendInput {
	decision: Decision;
	occurrence: number;
}

export interface AppendDecisionsInput {
	itemId?: string;
	runId: string;
	step: Step;
	attempt: number;
	decisions: DecisionAppendInput[];
	source: string;
	now?: Date;
}

export type DecisionWriteResult = { status: "written"; ids: string[] } | { status: "duplicate"; ids: string[] } | { status: "failed"; error: string; ids: [] };

function cell(value: string | undefined): string {
	return (value ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function normalize(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

export function decisionId(input: Omit<AppendDecisionsInput, "decisions" | "now" | "source">, row: DecisionAppendInput): string {
	const d = row.decision;
	return createHash("sha256")
		.update([input.itemId ?? input.runId, input.step, input.attempt, row.occurrence, normalize(d.fork), normalize(d.chosen ?? ""), normalize(d.alternatives ?? "")].join("\0"))
		.digest("hex")
		.slice(0, 16);
}

function marker(id: string): string {
	return `<!-- decision:${id} -->`;
}

function insertRows(body: string, heading: "Active" | "Resolved", rows: string): string {
	const start = body.indexOf(`## ${heading}`);
	if (start < 0) throw new Error(`decisions register missing ${heading} section`);
	const rule = body.indexOf(RULE, start);
	if (rule < 0) throw new Error(`decisions register missing ${heading} table`);
	const at = body.indexOf("\n", rule) + 1;
	return `${body.slice(0, at)}${rows}${body.slice(at)}`;
}

function commit(repo: string, paths: string[], message: string): void {
	const rel = paths.map((path) => relative(repo, path));
	execFileSync("git", ["add", "--", ...rel], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["commit", "--no-verify", "-m", message, "--", ...rel], { cwd: repo, stdio: "pipe" });
}

export async function appendDecisions(repo: string, input: AppendDecisionsInput): Promise<DecisionWriteResult> {
	try {
		return await withMutationLock(repo, () => {
			const path = resolve(repo, "docs", "decisions.md");
			let body = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : DECISIONS_SKELETON;
			const ids = input.decisions.map((row) => decisionId(input, row));
			const fresh = input.decisions.filter((_, index) => !body.includes(marker(ids[index])));
			if (!fresh.length) return { status: "duplicate" as const, ids };
			const date = (input.now ?? new Date()).toISOString().slice(0, 10);
			const rows = fresh
				.map((row) => {
					const id = decisionId(input, row);
					return `| ${cell(row.decision.fork)} | default-taken | ${cell(row.decision.chosen)} | ${cell(row.decision.alternatives)} | ${cell(input.source)} | ${date} |\n${marker(id)}\n`;
				})
				.join("");
			body = insertRows(body, "Active", rows);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`);
			commit(repo, [path], `docs: record ${fresh.length} decision${fresh.length === 1 ? "" : "s"}`);
			return { status: "written" as const, ids };
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`⚠ decisions: ${message}\n`);
		return { status: "failed", error: message, ids: [] };
	}
}

function rowBlock(body: string, id: string): { start: number; end: number; row: string } {
	const needle = marker(id);
	const markerAt = body.indexOf(needle);
	if (markerAt < 0 || body.indexOf(needle, markerAt + 1) >= 0) throw new Error(`decision ID must select exactly one row: ${id}`);
	const rowStart = body.lastIndexOf("\n|", markerAt) + 1;
	const end = body.indexOf("\n", markerAt) + 1;
	if (rowStart <= 0 || end <= 0 || body.slice(rowStart, markerAt).includes("## ")) throw new Error(`invalid decision row for ID: ${id}`);
	return { start: rowStart, end, row: body.slice(rowStart, body.indexOf("\n", rowStart)) };
}

function splitRow(row: string): string[] {
	return row
		.slice(1, -1)
		.split(/(?<!\\)\|/)
		.map((part) => part.trim());
}

export async function resolveDecision(repo: string, id: string, options: { adr?: string; now?: Date } = {}): Promise<void> {
	if (options.adr && !/^ADR-\d{4}$/i.test(options.adr)) throw new Error("--adr must match ADR-nnnn");
	await withMutationLock(repo, () => {
		const path = resolve(repo, "docs", "decisions.md");
		const body = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
		const block = rowBlock(body, id);
		const activeEnd = body.indexOf("## Resolved");
		if (block.start >= activeEnd) throw new Error(`decision is not active: ${id}`);
		const cells = splitRow(block.row);
		cells[1] = options.adr ? `resolved→${options.adr.toUpperCase()}` : "resolved";
		cells[5] = (options.now ?? new Date()).toISOString().slice(0, 10);
		const moved = `| ${cells.join(" | ")} |\n${marker(id)}\n`;
		const without = body.slice(0, block.start) + body.slice(block.end);
		writeFileSync(path, insertRows(without, "Resolved", moved));
		commit(repo, [path], `docs: resolve decision ${id}`);
	});
}

export async function archiveResolvedDecisions(repo: string, cutoff: Date): Promise<number> {
	return withMutationLock(repo, () => {
		const path = resolve(repo, "docs", "decisions.md");
		let body = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
		const resolvedAt = body.indexOf("## Resolved");
		const matches = [...body.slice(resolvedAt).matchAll(/^\| .*\|\n<!-- decision:([a-f0-9]+) -->\n/gm)];
		const selected = matches.filter((match) => {
			const cells = splitRow(match[0].split("\n")[0]);
			return new Date(`${cells[5]}T00:00:00Z`) < cutoff;
		});
		if (!selected.length) return 0;
		const rows = selected.map((match) => match[0]).join("");
		for (const match of [...selected].reverse()) {
			const start = resolvedAt + (match.index ?? 0);
			body = body.slice(0, start) + body.slice(start + match[0].length);
		}
		const archive = resolve(repo, "docs", "archived", "decisions.md");
		let archived = existsSync(archive) ? readFileSync(archive, "utf8").replace(/\r\n/g, "\n") : DECISIONS_SKELETON;
		archived = insertRows(archived, "Resolved", rows);
		mkdirSync(dirname(archive), { recursive: true });
		writeFileSync(path, body);
		writeFileSync(archive, archived);
		commit(repo, [path, archive], `docs: archive ${selected.length} resolved decision${selected.length === 1 ? "" : "s"}`);
		return selected.length;
	});
}
