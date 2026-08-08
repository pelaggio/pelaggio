/**
 * ADR shape gate — enforces the three-layer seam documented in `docs/decisions/README.md`.
 *
 * An ADR carries invariants (`## Decision`) and the constraints a replacement must also satisfy
 * (`## Constraints on any implementation`). Construction — how it is built today — lives in a detail
 * doc, and the ADR points at it. This check enforces the mechanical part of that split.
 *
 * Ratcheted: ADRs not yet re-cut are listed in `adr-shape-baseline.json` and exempt. The baseline may
 * only shrink — an entry is removed in the same change that lands the ADR's construction home.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { findMarkdownFiles, repoRoot } from "./verify-links.js";

const BASELINE = "ci/adr-shape-baseline.json";
const SOFT_LINE_LIMIT = 70;

/** Required sections, in order. */
export const REQUIRED_SECTIONS = ["Context", "Decision", "Constraints on any implementation", "Alternatives not taken", "Consequences", "Construction"] as const;

const REQUIRED_KEYS = ["title", "status", "date", "claims", "construction"] as const;

/** Construction leaks: a source path, or a backticked call-shaped symbol. Deliberately narrow. */
const SOURCE_PATH = /\b[\w./-]+\.ts\b/;
const CALL_SYMBOL = /`[A-Za-z_$][\w$.]*\(\)`/;

export interface ShapeViolation {
	file: string;
	line: number;
	rule: string;
	detail: string;
}

interface Baseline {
	exempt: string[];
}

/** GitHub-style heading slug, enough to resolve a `#anchor` in a sibling doc. */
export function slug(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-");
}

export function frontmatter(content: string): Record<string, string> | null {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
	if (!match) return null;
	const out: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
		if (kv) out[kv[1]] = kv[2].trim();
	}
	return out;
}

/** `## `-level headings, in document order, with their 1-indexed line numbers. */
export function sections(content: string): { title: string; line: number }[] {
	return content
		.split("\n")
		.map((text, index) => ({ text, line: index + 1 }))
		.filter(({ text }) => text.startsWith("## "))
		.map(({ text, line }) => ({ title: text.slice(3).trim(), line }));
}

function checkConstruction(file: string, value: string | undefined, root: string): ShapeViolation[] {
	if (value === undefined) return [];
	if (value === "none") return [];
	const [path, anchor] = value.split("#");
	const abs = resolve(root, path);
	if (!existsSync(abs)) return [{ file, line: 1, rule: "construction-path", detail: `construction: ${value} — path does not exist` }];
	if (!anchor) return [];
	const headings = readFileSync(abs, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("#"))
		.map((l) => slug(l.replace(/^#+\s*/, "")));
	if (!headings.includes(anchor)) return [{ file, line: 1, rule: "construction-anchor", detail: `construction: ${value} — no heading in ${path} slugs to #${anchor}` }];
	return [];
}

export function checkAdr(file: string, content: string, root: string): ShapeViolation[] {
	const violations: ShapeViolation[] = [];
	const fm = frontmatter(content);
	if (!fm) return [{ file, line: 1, rule: "frontmatter", detail: "missing frontmatter block" }];
	for (const key of REQUIRED_KEYS) {
		if (fm[key] === undefined) violations.push({ file, line: 1, rule: "frontmatter", detail: `missing required key \`${key}\`` });
	}
	violations.push(...checkConstruction(file, fm.construction, root));

	const found = sections(content);
	const titles = found.map((s) => s.title);
	const expected = REQUIRED_SECTIONS.filter((s) => titles.includes(s));
	for (const required of REQUIRED_SECTIONS) {
		if (!titles.includes(required)) violations.push({ file, line: 1, rule: "section-missing", detail: `no \`## ${required}\` section` });
	}
	// Order is checked over the sections that are present, so a missing section reports once, not twice.
	const presentInOrder = titles.filter((t): t is (typeof REQUIRED_SECTIONS)[number] => (REQUIRED_SECTIONS as readonly string[]).includes(t));
	if (presentInOrder.join("|") !== expected.join("|")) {
		violations.push({ file, line: 1, rule: "section-order", detail: `sections out of order: ${presentInOrder.join(" → ")}` });
	}

	// Construction leaks: everything from `## Construction` onward is exempt by definition.
	const constructionLine = found.find((s) => s.title === "Construction")?.line ?? Number.POSITIVE_INFINITY;
	content.split("\n").forEach((text, index) => {
		const line = index + 1;
		if (line >= constructionLine) return;
		if (SOURCE_PATH.test(text)) violations.push({ file, line, rule: "construction-leak", detail: `source path outside \`## Construction\`: ${text.trim().slice(0, 80)}` });
		else if (CALL_SYMBOL.test(text)) violations.push({ file, line, rule: "construction-leak", detail: `code symbol outside \`## Construction\`: ${text.trim().slice(0, 80)}` });
	});

	return violations;
}

/** Repo-relative ADR paths, excluding the README and the template. */
export function adrFiles(root: string, dir: string): string[] {
	return findMarkdownFiles(dir)
		.map((f) =>
			resolve(f)
				.slice(root.length + 1)
				.replace(/\\/g, "/"),
		)
		.filter((f) => !f.endsWith("README.md") && !f.endsWith("_TEMPLATE.md"))
		.sort();
}

export function loadBaseline(root: string): Baseline {
	const path = resolve(root, BASELINE);
	if (!existsSync(path)) return { exempt: [] };
	return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

export function runAdrShapeGate(root = repoRoot(), dir = resolve(root, "docs/decisions")): number {
	const baseline = loadBaseline(root);
	const exempt = new Set(baseline.exempt);
	const files = adrFiles(root, dir);

	const enforced = files.filter((f) => !exempt.has(f));
	const violations = enforced.flatMap((f) => checkAdr(f, readFileSync(resolve(root, f), "utf8"), root));
	const long = enforced.filter((f) => readFileSync(resolve(root, f), "utf8").split("\n").length > SOFT_LINE_LIMIT);
	const stale = [...exempt].filter((f) => !files.includes(f));

	console.log(`\n  Pelaggio ADR shape gate\n  ${"-".repeat(70)}`);
	console.log(`  ${enforced.length} enforced, ${exempt.size} baselined (ratchet: baseline may only shrink)`);
	for (const v of violations) console.log(`  ${v.file}:${v.line}  [${v.rule}] ${v.detail}`);
	for (const f of long) console.log(`  ${f}  [long] past ${SOFT_LINE_LIMIT} lines — warning only; apply the cut test`);
	for (const f of stale) console.log(`  ${f}  [baseline-stale] listed in ${BASELINE} but no such ADR`);

	const failures = violations.length + stale.length;
	console.log(`  ${"-".repeat(70)}\n  ${failures} violation${failures === 1 ? "" : "s"}${long.length ? `, ${long.length} warning${long.length === 1 ? "" : "s"}` : ""}\n`);
	return failures === 0 ? 0 : 1;
}

/** `--write-baseline` seeds the ratchet from current state. Never run in CI. */
export function writeBaseline(root = repoRoot(), dir = resolve(root, "docs/decisions")): string[] {
	const files = adrFiles(root, dir);
	const exempt = files.filter((f) => checkAdr(f, readFileSync(resolve(root, f), "utf8"), root).length > 0);
	writeFileSync(resolve(root, BASELINE), `${JSON.stringify({ exempt }, null, "\t")}\n`, "utf8");
	return exempt;
}

if (process.argv[1]?.endsWith("verify-adr-shape.ts")) {
	if (process.argv.includes("--write-baseline")) {
		const exempt = writeBaseline();
		console.log(`\n  wrote ${BASELINE} — ${exempt.length} ADR${exempt.length === 1 ? "" : "s"} baselined\n`);
	} else {
		process.exitCode = runAdrShapeGate();
	}
}
