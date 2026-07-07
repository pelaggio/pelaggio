#!/usr/bin/env tsx

/**
 * `pnpm check:skills` — lint `.claude/skills/<name>/SKILL.md` frontmatter,
 * `!cat` inline includes, and `$ARGUMENTS` usage.
 *
 * Pure checker — no auto-fix. Exits 0 on success, 1 on any violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { REPO } from "./config.js";

export type Violation = { file: string; line?: number; rule: string; message: string };
export type SkillSchema = { required: readonly string[]; optional: readonly string[] };

export const SKILL_SCHEMA: SkillSchema = {
	required: ["name", "description", "allowed-tools"],
	optional: ["argument-hint", "context", "agent", "effort", "disable-model-invocation", "consumer"],
};

const ALLOWED_EFFORTS = ["min", "low", "medium", "high", "max"] as const;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
// Group 1: include path. Group 2: optional `2>/dev/null` graceful suffix — when
// present, a missing file is opt-in (not a violation), matching the shell
// semantics that the include is allowed to be absent at the consumer's discretion.
const INCLUDE_RE = /!\x60cat\s+([^\x60\s]+)(\s+2>\/dev\/null)?\x60/g;
// `npx claude-autopilot …` (bare, no scope) — collides with an unrelated public
// package on stale npx caches and triggered the recursion incident in TOOL-50.
const NPX_BARE_AUTOPILOT_RE = /\bnpx\s+(?:--\S+\s+)*claude-autopilot\b/g;
// `pnpm autopilot <subcommand>` — the exact substitution the agent reached for
// when the bare-name invocation failed. `pnpm autopilot` is the pipeline entry,
// not a CLI dispatcher, so this shape would re-enter the pipeline.
const PNPM_AUTOPILOT_SUBCOMMAND_RE = /\bpnpm\s+autopilot\s+(?:roadmap|worktree-deps|sync)\b/g;
// Model IDs belong only in config.ts's MODEL_PROFILES. A skill/template body that
// pins one (e.g. `claude-opus-<version>`) silently goes stale the next time
// /bump-models refreshes config, and the pipeline already injects the per-step
// model — bodies must stay model-agnostic. Family list is closed and changes
// ~yearly (when /bump-models runs); extend it here when a new family ships.
// Digit-after-family requirement keeps worktree/branch names (`claude-autopilot`
// plus an issue-number suffix) and prose out. The tail must end on an alphanumeric so a trailing sentence
// period/comma isn't captured into the reported ID. (Examples here use
// `<version>` placeholders, not real digits: /bump-models sweeps the tree with
// `rg 'claude-[a-z]+-[0-9]'` and this file must not trip it.)
const MODEL_ID_RE = /\bclaude-(?:opus|sonnet|haiku|fable)-[0-9](?:[0-9a-z.-]*[0-9a-z])?/g;

function lineOf(body: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (body.charCodeAt(i) === 10) line++;
	return line;
}

/** Flag hardcoded Claude model IDs anywhere in `body`. `rel` is the repo-relative path for reporting. */
function scanModelIds(body: string, rel: string): Violation[] {
	const out: Violation[] = [];
	MODEL_ID_RE.lastIndex = 0;
	let hit: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((hit = MODEL_ID_RE.exec(body)) !== null) {
		out.push({
			file: rel,
			line: lineOf(body, hit.index),
			rule: "model-id.hardcoded",
			message: `hardcoded model ID \`${hit[0]}\` — model IDs live only in config.ts's MODEL_PROFILES; keep bodies model-agnostic`,
		});
	}
	return out;
}

function findFieldLine(frontmatterBody: string, key: string): number | undefined {
	const lines = frontmatterBody.split(/\r?\n/);
	const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) return i + 2; // +1 for the opening --- line, +1 for 1-based
	}
	return undefined;
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

/** Lint a single SKILL.md file. `absPath` is the skill file, `repoRoot` resolves `!cat` paths. */
export function lintSkillFile(absPath: string, repoRoot: string): Violation[] {
	const violations: Violation[] = [];
	const rel = relative(repoRoot, absPath) || absPath;
	const body = readFileSync(absPath, "utf-8");

	const match = body.match(FRONTMATTER_RE);
	if (!match) {
		violations.push({ file: rel, rule: "frontmatter.missing", message: "SKILL.md must start with `---` YAML frontmatter" });
		return sortViolations(violations);
	}

	const frontmatterBody = match[1];
	let parsed: unknown;
	try {
		parsed = parseYaml(frontmatterBody);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		violations.push({ file: rel, rule: "frontmatter.invalid-yaml", message: msg });
		return sortViolations(violations);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		violations.push({ file: rel, rule: "frontmatter.invalid-yaml", message: "frontmatter must be a YAML mapping" });
		return sortViolations(violations);
	}

	const fm = parsed as Record<string, unknown>;

	for (const key of SKILL_SCHEMA.required) {
		if (!(key in fm)) {
			violations.push({ file: rel, rule: "frontmatter.required-missing", message: `missing "${key}"` });
		} else if (!isNonEmptyString(fm[key])) {
			violations.push({
				file: rel,
				line: findFieldLine(frontmatterBody, key),
				rule: "frontmatter.required-invalid",
				message: `"${key}" must be a non-empty string`,
			});
		}
	}

	const known = new Set<string>([...SKILL_SCHEMA.required, ...SKILL_SCHEMA.optional]);
	for (const key of Object.keys(fm)) {
		if (!known.has(key)) {
			violations.push({
				file: rel,
				line: findFieldLine(frontmatterBody, key),
				rule: "frontmatter.unknown-field",
				message: `unknown field "${key}"`,
			});
		}
	}

	const expectedName = basename(dirname(absPath));
	if (isNonEmptyString(fm.name) && fm.name !== expectedName) {
		violations.push({
			file: rel,
			line: findFieldLine(frontmatterBody, "name"),
			rule: "frontmatter.name-mismatch",
			message: `name "${fm.name}" does not match directory "${expectedName}"`,
		});
	}

	if ("consumer" in fm && typeof fm.consumer !== "boolean") {
		violations.push({
			file: rel,
			line: findFieldLine(frontmatterBody, "consumer"),
			rule: "frontmatter.type-mismatch",
			message: `"consumer" must be a boolean`,
		});
	}
	if ("disable-model-invocation" in fm && typeof fm["disable-model-invocation"] !== "boolean") {
		violations.push({
			file: rel,
			line: findFieldLine(frontmatterBody, "disable-model-invocation"),
			rule: "frontmatter.type-mismatch",
			message: `"disable-model-invocation" must be a boolean`,
		});
	}
	if ("context" in fm && fm.context !== "fork") {
		violations.push({
			file: rel,
			line: findFieldLine(frontmatterBody, "context"),
			rule: "frontmatter.type-mismatch",
			message: `"context" must be "fork"`,
		});
	}
	if ("effort" in fm && !(ALLOWED_EFFORTS as readonly unknown[]).includes(fm.effort)) {
		violations.push({
			file: rel,
			line: findFieldLine(frontmatterBody, "effort"),
			rule: "frontmatter.type-mismatch",
			message: `"effort" must be one of ${ALLOWED_EFFORTS.map((e) => `"${e}"`).join(", ")}`,
		});
	}
	if ("agent" in fm && !isNonEmptyString(fm.agent)) {
		violations.push({
			file: rel,
			line: findFieldLine(frontmatterBody, "agent"),
			rule: "frontmatter.type-mismatch",
			message: `"agent" must be a non-empty string`,
		});
	}
	if ("argument-hint" in fm && !isNonEmptyString(fm["argument-hint"])) {
		violations.push({
			file: rel,
			line: findFieldLine(frontmatterBody, "argument-hint"),
			rule: "frontmatter.type-mismatch",
			message: `"argument-hint" must be a non-empty string`,
		});
	}

	// Skills that reference autopilot internals (scripts/autopilot/*.ts) make no
	// sense when synced into a consumer repo — those paths don't exist there.
	// Require them to declare `consumer: false` so sync omits them.
	if (fm.consumer !== false) {
		const internalRef = /(?:packages\/autopilot\/)?scripts\/autopilot\/[\w.-]+\.ts/.exec(body);
		if (internalRef) {
			violations.push({
				file: rel,
				line: lineOf(body, internalRef.index),
				rule: "consumer.internal-ref",
				message: `references \`${internalRef[0]}\` (package internal) but is not marked \`consumer: false\``,
			});
		}
	}

	// !cat include resolution
	INCLUDE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((m = INCLUDE_RE.exec(body)) !== null) {
		const includePath = m[1];
		const graceful = m[2] !== undefined;
		const resolved = resolve(repoRoot, includePath);
		if (!existsSync(resolved) && !graceful) {
			violations.push({
				file: rel,
				line: lineOf(body, m.index),
				rule: "include.dangling",
				message: `!\`cat ${includePath}\` — file not found`,
			});
		}
	}

	// TOOL-50 collision-vulnerable invocations
	const skillBody = body.slice(match[0].length);
	const bodyOffset = match[0].length;
	NPX_BARE_AUTOPILOT_RE.lastIndex = 0;
	let bareHit: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((bareHit = NPX_BARE_AUTOPILOT_RE.exec(skillBody)) !== null) {
		violations.push({
			file: rel,
			line: lineOf(body, bodyOffset + bareHit.index),
			rule: "skill.npx-bare-autopilot",
			message: "use 'npx @cdhorne/claude-autopilot' — the bare 'claude-autopilot' name collides with a public package and can recurse the pipeline (TOOL-50)",
		});
	}
	PNPM_AUTOPILOT_SUBCOMMAND_RE.lastIndex = 0;
	let pnpmHit: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((pnpmHit = PNPM_AUTOPILOT_SUBCOMMAND_RE.exec(skillBody)) !== null) {
		violations.push({
			file: rel,
			line: lineOf(body, bodyOffset + pnpmHit.index),
			rule: "skill.pnpm-autopilot-subcommand",
			message: "'pnpm autopilot' is the pipeline entry; subcommands go through 'npx @cdhorne/claude-autopilot' (TOOL-50)",
		});
	}

	// $ARGUMENTS without argument-hint
	const argIdx = body.indexOf("$ARGUMENTS");
	if (argIdx !== -1 && !isNonEmptyString(fm["argument-hint"])) {
		violations.push({
			file: rel,
			line: lineOf(body, argIdx),
			rule: "arguments.no-hint",
			message: "$ARGUMENTS used but frontmatter has no `argument-hint`",
		});
	}

	// bump-models exists to document and refresh these IDs — exempt it wholesale.
	if (expectedName !== "bump-models") {
		violations.push(...scanModelIds(body, rel));
	}

	return sortViolations(violations);
}

function sortViolations(violations: Violation[]): Violation[] {
	return violations.sort((a, b) => {
		if (a.file !== b.file) return a.file < b.file ? -1 : 1;
		const al = a.line ?? 0;
		const bl = b.line ?? 0;
		if (al !== bl) return al - bl;
		return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
	});
}

/** Lint every `.claude/skills/<name>/SKILL.md` under `repoRoot` (directories starting with `_` are skipped). */
export function lintAllSkills(repoRoot: string): Violation[] {
	const skillsRoot = resolve(repoRoot, ".claude/skills");
	if (!existsSync(skillsRoot)) return [];

	const out: Violation[] = [];
	for (const entry of readdirSync(skillsRoot).sort()) {
		if (entry.startsWith("_")) continue;
		const skillDir = resolve(skillsRoot, entry);
		if (!statSync(skillDir).isDirectory()) continue;
		const skillFile = resolve(skillDir, "SKILL.md");
		if (!existsSync(skillFile)) continue;
		out.push(...lintSkillFile(skillFile, repoRoot));
	}
	return sortViolations(out);
}

function walkMarkdown(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkMarkdown(full));
		else if (entry.name.endsWith(".md")) out.push(full);
	}
	return out;
}

/** Lint template markdown under `.claude-templates/` for hardcoded model IDs. */
export function lintTemplates(repoRoot: string): Violation[] {
	const root = resolve(repoRoot, ".claude-templates");
	if (!existsSync(root)) return [];
	const out: Violation[] = [];
	for (const abs of walkMarkdown(root)) {
		out.push(...scanModelIds(readFileSync(abs, "utf-8"), relative(repoRoot, abs) || abs));
	}
	return sortViolations(out);
}

export function formatViolations(violations: Violation[]): string {
	if (violations.length === 0) return "";
	const lines = violations.map((v) => {
		const loc = v.line !== undefined ? `${v.file}:${v.line}` : v.file;
		return `${loc} [${v.rule}] ${v.message}`;
	});
	const files = new Set(violations.map((v) => v.file));
	lines.push("");
	lines.push(`${violations.length} violation${violations.length === 1 ? "" : "s"} in ${files.size} file${files.size === 1 ? "" : "s"}`);
	return lines.join("\n");
}

export async function main(_argv: string[]): Promise<number> {
	const violations = sortViolations([...lintAllSkills(REPO), ...lintTemplates(REPO)]);
	if (violations.length === 0) return 0;
	console.log(formatViolations(violations));
	return 1;
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : err);
			process.exit(1);
		});
}
