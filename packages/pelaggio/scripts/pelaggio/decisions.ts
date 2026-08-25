import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { listWorktreesIn, parseDecisions } from "./helpers.js";
import { withMutationLock } from "./roadmap/mutation-lock.js";
import type { Decision, EmittedDecision, ReviewEscalation, ReviewResolution, Step } from "./types.js";

export const DECISIONS_HEADER = "| Decision | Status | Chosen/leaning | Alternatives | Source | Date |";
const RULE = "| --- | --- | --- | --- | --- | --- |";
const DECISION_ID_RE = /^(?:[a-f0-9]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEGACY_UNATTRIBUTED = "legacy-unattributed";
const DECISION_LOG_DIR = "decision-log";

export const DECISIONS_SKELETON = `# Decisions\n\nStatus values are \`default-taken\`, \`resolved\`, or \`resolved→ADR-nnnn\`. Source is an item, pull request, or review-note reference.\n\n## Active\n\n${DECISIONS_HEADER}\n${RULE}\n\n## Resolved\n\n${DECISIONS_HEADER}\n${RULE}\n`;

export interface DecisionAppendInput {
	id: string;
	contentFingerprint: string;
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
export type ReviewEscalationLookup =
	| { state: "missing" }
	| { state: "invalid"; error: string }
	| { state: "active"; id: string; escalation: ReviewEscalation }
	| { state: "resolved-proceed" | "resolved-block"; id: string; escalation: ReviewEscalation; resolution: ReviewResolution };

export type ReviewEscalationRecommendation = {
	disposition: "proceed" | "block";
	source: "judge" | "deterministic-policy";
	rationale: string;
};

export interface ReviewEscalationAdjudication {
	spend: { amount: number; estimated: boolean };
	/** Copied from the sibling escalation; parse fails closed on mismatch. */
	evidenceFingerprint: string;
	recommendedDefault?: ReviewEscalationRecommendation;
}

export interface ReviewEscalationWriteInput {
	escalation: ReviewEscalation;
	adjudication: ReviewEscalationAdjudication;
	now?: Date;
}

export interface MigrateDecisionsResult {
	status: "written" | "noop";
	owners: string[];
	rows: number;
	reconciled: number;
	unattributed: number;
}

export interface RebuildIndexResult {
	status: "written" | "noop";
	rows: number;
}

interface DedupeCoords {
	runId: string;
	step: string;
	occurrence: number;
}

interface DecisionMeta {
	aliases: string[];
	contentFingerprint?: string;
	dedupe?: DedupeCoords;
}

interface StoredDecision {
	id: string;
	section: "Active" | "Resolved";
	cells: string[];
	meta: DecisionMeta;
	escalation?: { escalation: ReviewEscalation; resolution?: ReviewResolution };
	adjudication?: ReviewEscalationAdjudication;
	/** Source order within the parsed file (stable for migration/reconcile). */
	order: number;
}

interface AuthorityFile {
	owner: string;
	active: StoredDecision[];
	resolved: StoredDecision[];
}

function cell(value: string | undefined): string {
	return (value ?? "")
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/[\r\n\u2028\u2029]+/g, " ")
		.trim();
}

function normalize(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

/** Deterministic, case-preserving canonicalization for fork identity: collapse whitespace and strip trailing sentence punctuation. Never semantic. */
function normalizeIdentity(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[\s.,;:!?]+$/, "");
}

/** Fork-identity dedupe key: the normalized (fork, chosen) pair. Alternatives are deliberately excluded. */
function forkIdentityKey(decision: Decision): string {
	return [normalizeIdentity(decision.fork), normalizeIdentity(decision.chosen ?? "")].join("\0");
}

function unescapeCell(value: string): string {
	return value.replace(/\\\|/g, "|").replace(/\\\\/g, "\\");
}

/** Semantic content fingerprint (full SHA-256 hex). Does not include run/step/attempt/item. */
export function contentFingerprint(decision: Decision): string {
	return createHash("sha256")
		.update([normalize(decision.fork), normalize(decision.chosen ?? ""), normalize(decision.alternatives ?? "")].join("\0"))
		.digest("hex");
}

/** Parse DECISION: sentinels and assign opaque emission IDs + fingerprints. */
export function emitDecisionsFromText(text: string, createId: () => string = randomUUID): EmittedDecision[] {
	return parseDecisions(text).map((decision) => ({
		id: createId(),
		contentFingerprint: contentFingerprint(decision),
		decision,
	}));
}

export function reviewEscalationId(input: ReviewEscalation): string {
	return createHash("sha256")
		.update([input.itemId, input.step, input.reviewedSha, input.evidenceFingerprint, String(input.hasSafetyBlocker)].join("\0"))
		.digest("hex")
		.slice(0, 16);
}

export function reviewEscalationCommands(id: string, escalation: Pick<ReviewEscalation, "itemId" | "evidenceFingerprint">): { proceedResolve: string; resume: string; blockResolve: string } {
	const decisionId = validateCommandToken(id, "decision ID");
	const itemId = validateCommandToken(escalation.itemId, "item ID");
	const evidenceFingerprint = validateCommandToken(escalation.evidenceFingerprint, "evidence fingerprint");
	return {
		proceedResolve: `npx pelaggio decisions resolve ${decisionId} --disposition proceed --by <actor> --reason "<rationale>"`,
		resume: `pnpm pelaggio --resume ${itemId} --acknowledge-escalation ${evidenceFingerprint}`,
		blockResolve: `npx pelaggio decisions resolve ${decisionId} --disposition block --by <actor> --reason "<rationale>"`,
	};
}

function validateCommandToken(value: string, label: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)) throw new Error(`unsafe review escalation ${label}: ${JSON.stringify(value)}`);
	return value;
}

export function validateOwner(owner: string): string {
	if (!owner || owner !== owner.trim()) throw new Error(`unsafe decision-log owner: ${JSON.stringify(owner)}`);
	if (owner.includes("/") || owner.includes("\\") || owner.includes("\0") || owner.includes("..") || owner.startsWith(".")) {
		throw new Error(`unsafe decision-log owner: ${JSON.stringify(owner)}`);
	}
	if (!OWNER_RE.test(owner)) throw new Error(`unsafe decision-log owner: ${JSON.stringify(owner)}`);
	return owner;
}

export function ownerForEmission(input: { itemId?: string; runId: string }): string {
	if (input.itemId !== undefined && input.itemId !== "") return validateOwner(input.itemId);
	return validateOwner(`run-${input.runId}`);
}

function validateDecisionId(id: string): string {
	if (!DECISION_ID_RE.test(id)) throw new Error(`invalid decision ID: ${id}`);
	return id;
}

function marker(id: string): string {
	return `<!-- decision:${id} -->`;
}

function metaMarker(meta: DecisionMeta): string {
	const payload: Record<string, unknown> = {};
	if (meta.aliases.length) payload.aliases = meta.aliases;
	if (meta.contentFingerprint) payload.contentFingerprint = meta.contentFingerprint;
	if (meta.dedupe) payload.dedupe = meta.dedupe;
	return `<!-- decision-meta:${Buffer.from(JSON.stringify(payload)).toString("base64url")} -->`;
}

const escalationMarker = (value: { escalation: ReviewEscalation; resolution?: ReviewResolution }): string => `<!-- review-escalation:${Buffer.from(JSON.stringify(value)).toString("base64url")} -->`;

const adjudicationMarker = (value: ReviewEscalationAdjudication): string => `<!-- review-adjudication:${Buffer.from(JSON.stringify(value)).toString("base64url")} -->`;

function decisionLogDir(repo: string): string {
	const dir = resolve(repo, "docs", DECISION_LOG_DIR);
	requireExistingAncestorInRepo(repo, dir, "decision-log directory");
	return dir;
}

function requireExistingAncestorInRepo(repo: string, target: string, label: string): void {
	const repoReal = realpathSync(repo);
	let ancestor = target;
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) throw new Error(`${label} has no existing ancestor: ${target}`);
		ancestor = parent;
	}
	const ancestorReal = realpathSync(ancestor);
	if (ancestorReal !== repoReal && !ancestorReal.startsWith(`${repoReal}/`)) {
		throw new Error(`${label} escapes the repo (symlink?): ${ancestor} -> ${ancestorReal}`);
	}
}

function authorityPath(repo: string, owner: string): string {
	const path = resolve(decisionLogDir(repo), `${validateOwner(owner)}.md`);
	// A worker could pre-plant this path as a symlink; the harness-privileged
	// append must never follow it out of the decision-log directory. Fail closed
	// on any non-regular file (the caller surfaces the error).
	try {
		if (lstatSync(path).isSymbolicLink()) throw new Error(`decision-log authority is a symlink, refusing: ${path}`);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	return path;
}

function archivePath(repo: string, owner: string): string {
	const archiveDir = resolve(decisionLogDir(repo), "archive");
	requireExistingAncestorInRepo(repo, archiveDir, "decision-log archive directory");
	const path = resolve(archiveDir, `${validateOwner(owner)}.md`);
	try {
		if (lstatSync(path).isSymbolicLink()) throw new Error(`decision-log archive is a symlink, refusing: ${path}`);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	return path;
}

function splitRow(row: string): string[] {
	return row
		.slice(1, -1)
		.split(/(?<!\\)\|/)
		.map((part) => part.trim());
}

function requireMatchGroup(match: RegExpMatchArray, index: number, label: string): string {
	const value = match[index];
	if (value === undefined) throw new Error(`missing ${label}`);
	return value;
}

function cellAt(cells: string[], index: number): string {
	return cells[index] ?? "";
}

function parseMetaPayload(raw: string): DecisionMeta {
	const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed decision metadata");
	const obj = value as Record<string, unknown>;
	const aliases: string[] = [];
	if (obj.aliases !== undefined) {
		if (!Array.isArray(obj.aliases) || !obj.aliases.every((a) => typeof a === "string" && DECISION_ID_RE.test(a))) {
			throw new Error("malformed decision metadata aliases");
		}
		aliases.push(...(obj.aliases as string[]));
	}
	let contentFingerprint: string | undefined;
	if (obj.contentFingerprint !== undefined) {
		if (typeof obj.contentFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(obj.contentFingerprint)) {
			throw new Error("malformed decision content fingerprint");
		}
		contentFingerprint = obj.contentFingerprint.toLowerCase();
	}
	let dedupe: DedupeCoords | undefined;
	if (obj.dedupe !== undefined) {
		if (!obj.dedupe || typeof obj.dedupe !== "object" || Array.isArray(obj.dedupe)) throw new Error("malformed decision dedupe coords");
		const d = obj.dedupe as Record<string, unknown>;
		if (typeof d.runId !== "string" || typeof d.step !== "string" || typeof d.occurrence !== "number" || !Number.isInteger(d.occurrence) || d.occurrence < 0) {
			throw new Error("malformed decision dedupe coords");
		}
		dedupe = { runId: d.runId, step: d.step, occurrence: d.occurrence };
	}
	return { aliases, ...(contentFingerprint ? { contentFingerprint } : {}), ...(dedupe ? { dedupe } : {}) };
}

function parseEscalationMetadata(encoded: string): { escalation: ReviewEscalation; resolution?: ReviewResolution } {
	const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	if (!value || typeof value !== "object" || !("escalation" in value)) throw new Error("malformed review escalation metadata");
	const obj = value as { escalation: unknown; resolution?: unknown };
	if (!obj.escalation || typeof obj.escalation !== "object") throw new Error("malformed review escalation metadata");
	const esc = obj.escalation as Record<string, unknown>;
	if (esc.kind !== "review-escalation" || typeof esc.itemId !== "string" || typeof esc.reviewedSha !== "string") {
		throw new Error("malformed review escalation metadata");
	}
	// A record without evidence binding can never mint proceed authority: the resume
	// ack gate compares against this fingerprint, and undefined must not match anything.
	if (typeof esc.evidenceFingerprint !== "string" || esc.evidenceFingerprint.length === 0) {
		throw new Error("malformed review escalation metadata: missing evidenceFingerprint");
	}
	return value as { escalation: ReviewEscalation; resolution?: ReviewResolution };
}

function validateAdjudication(value: unknown, expectedFingerprint: string): ReviewEscalationAdjudication {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed review adjudication metadata");
	const obj = value as Record<string, unknown>;
	if (typeof obj.evidenceFingerprint !== "string" || obj.evidenceFingerprint.length === 0) {
		throw new Error("malformed review adjudication metadata: missing evidenceFingerprint");
	}
	if (obj.evidenceFingerprint !== expectedFingerprint) {
		throw new Error("malformed review adjudication metadata: evidenceFingerprint mismatch");
	}
	if (!obj.spend || typeof obj.spend !== "object" || Array.isArray(obj.spend)) {
		throw new Error("malformed review adjudication metadata: spend");
	}
	const spendObj = obj.spend as Record<string, unknown>;
	if (typeof spendObj.amount !== "number" || !Number.isFinite(spendObj.amount) || spendObj.amount < 0) {
		throw new Error("malformed review adjudication metadata: spend.amount");
	}
	if (typeof spendObj.estimated !== "boolean") {
		throw new Error("malformed review adjudication metadata: spend.estimated");
	}
	let recommendedDefault: ReviewEscalationRecommendation | undefined;
	if (obj.recommendedDefault !== undefined) {
		if (!obj.recommendedDefault || typeof obj.recommendedDefault !== "object" || Array.isArray(obj.recommendedDefault)) {
			throw new Error("malformed review adjudication metadata: recommendedDefault");
		}
		const rec = obj.recommendedDefault as Record<string, unknown>;
		if (rec.disposition !== "proceed" && rec.disposition !== "block") {
			throw new Error("malformed review adjudication metadata: recommendedDefault.disposition");
		}
		if (rec.source !== "judge" && rec.source !== "deterministic-policy") {
			throw new Error("malformed review adjudication metadata: recommendedDefault.source");
		}
		if (typeof rec.rationale !== "string" || rec.rationale.trim() === "") {
			throw new Error("malformed review adjudication metadata: recommendedDefault.rationale");
		}
		recommendedDefault = { disposition: rec.disposition, source: rec.source, rationale: rec.rationale };
	}
	return {
		spend: { amount: spendObj.amount, estimated: spendObj.estimated },
		evidenceFingerprint: obj.evidenceFingerprint,
		...(recommendedDefault ? { recommendedDefault } : {}),
	};
}

function parseAdjudicationMetadata(encoded: string, sibling: ReviewEscalation): ReviewEscalationAdjudication {
	const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	return validateAdjudication(value, sibling.evidenceFingerprint);
}

function longestBacktickRun(text: string): number {
	let max = 0;
	let current = 0;
	for (const ch of text) {
		if (ch === "`") {
			current += 1;
			if (current > max) max = current;
		} else {
			current = 0;
		}
	}
	return max;
}

/** Neutralize substrings that would retarget parseAuthorityBody's non-Markdown scanners. */
function neutralizeParserSignificant(text: string): string {
	return text.replace(/^## (Active|Resolved)$/gm, "## $1.").replace(/<!--/g, "< !--");
}

/** Keep record-sourced values inside one inline-code span without parser-significant text. */
function inlineUntrusted(text: string): string {
	const singleLine = neutralizeParserSignificant(text)
		.replace(/[\r\n\u2028\u2029]+/g, " ")
		.replace(/`/g, "'");
	return `\`${singleLine}\``;
}

/**
 * Table cells built from record-sourced values. `cell()` alone escapes pipes and folds
 * newlines, but a stray backtick still opens a code span that swallows the rest of the row.
 * Operator-authored decision cells keep `cell()`'s verbatim behavior.
 */
function untrustedCell(text: string): string {
	return cell(neutralizeParserSignificant(text).replace(/`/g, "'"));
}

function fenceUntrusted(text: string): string {
	const neutralized = neutralizeParserSignificant(text);
	const fence = "`".repeat(Math.max(3, longestBacktickRun(neutralized) + 1));
	return `${fence}\n${neutralized}\n${fence}`;
}

function packetState(resolution?: ReviewResolution): "active" | "resolved-proceed" | "resolved-block" {
	if (!resolution) return "active";
	return resolution.disposition === "proceed" ? "resolved-proceed" : "resolved-block";
}

function formatCycleSpend(spend: { amount: number; estimated: boolean }): string {
	const dollars = `$${spend.amount.toFixed(2)}`;
	return spend.estimated ? `~${dollars}` : dollars;
}

function renderReviewerLine(driver: ReviewEscalation["drivers"][number]): string {
	const modelBit = driver.identity.model ? `, ${inlineUntrusted(driver.identity.model)}` : "";
	return `- **${inlineUntrusted(driver.identity.role)} / ${inlineUntrusted(driver.identity.seatId)}** (${inlineUntrusted(driver.identity.provider)}${modelBit}, session ${inlineUntrusted(driver.identity.sessionId)}): **${inlineUntrusted(driver.verdict)}**\n${fenceUntrusted(driver.rationale)}`;
}

function renderReviewEscalationPacket(id: string, escalation: ReviewEscalation, resolution: ReviewResolution | undefined, adjudication: ReviewEscalationAdjudication): string {
	const commands = reviewEscalationCommands(id, escalation);
	const lines: string[] = [
		`### Review escalation packet ${inlineUntrusted(id)} (${inlineUntrusted(packetState(resolution))})`,
		"",
		`- Reviewed SHA: ${inlineUntrusted(escalation.reviewedSha)}`,
		`- Evidence fingerprint: ${inlineUntrusted(escalation.evidenceFingerprint)}`,
		`- Review record: ${inlineUntrusted(escalation.reviewRecordSource)}`,
		`- Safety blocker: ${inlineUntrusted(escalation.hasSafetyBlocker ? "yes" : "no")}`,
		`- Cycle spend: ${inlineUntrusted(formatCycleSpend(adjudication.spend))}`,
		"",
		"#### Reviewers",
		"",
	];
	if (escalation.drivers.length === 0) {
		lines.push("- (none recorded)");
		lines.push("");
	} else {
		for (const driver of escalation.drivers) {
			lines.push(renderReviewerLine(driver));
			lines.push("");
		}
	}
	if (adjudication.recommendedDefault) {
		const rec = adjudication.recommendedDefault;
		lines.push(`Recommended default: ${inlineUntrusted(rec.disposition)} (${rec.source})`);
		lines.push("");
		lines.push(fenceUntrusted(rec.rationale));
	} else {
		lines.push("Choices: proceed or block. No recommended default on this record.");
	}
	lines.push("");
	if (resolution) {
		lines.push("#### Resolution");
		lines.push("");
		lines.push(`- Disposition: ${inlineUntrusted(resolution.disposition)}`);
		lines.push(`- Actor: ${inlineUntrusted(resolution.actor)}`);
		lines.push(`- Timestamp: ${inlineUntrusted(resolution.timestamp)}`);
		if (resolution.adr) lines.push(`- ADR: ${inlineUntrusted(resolution.adr)}`);
		lines.push("- Rationale:");
		lines.push(fenceUntrusted(resolution.rationale));
		if (resolution.disposition === "block") {
			lines.push("");
			lines.push("Acknowledgement cannot resume a `resolved-block` record.");
		}
		lines.push("");
	}
	lines.push("#### Commands");
	lines.push("");
	lines.push("Proceed (resolve, then resume with acknowledgement):");
	lines.push(commands.proceedResolve);
	lines.push(commands.resume);
	lines.push("");
	lines.push("Block:");
	lines.push(commands.blockResolve);
	lines.push("");
	return `${lines.join("\n")}\n`;
}

function sectionHeadingIndex(body: string, heading: "Active" | "Resolved"): number {
	return body.match(new RegExp(`^## ${heading}$`, "m"))?.index ?? -1;
}

function parseAuthorityBody(body: string, owner: string): AuthorityFile {
	const normalized = body.replace(/\r\n/g, "\n");
	const activeAt = sectionHeadingIndex(normalized, "Active");
	const resolvedAt = sectionHeadingIndex(normalized, "Resolved");
	if (activeAt < 0 || resolvedAt < 0 || resolvedAt < activeAt) throw new Error(`decision log missing Active/Resolved sections: ${owner}`);

	const entries: StoredDecision[] = [];
	const rowRe = /^\| (.+) \|\n<!-- decision:([^\s]+) -->\n(?:<!-- decision-meta:([A-Za-z0-9_-]+) -->\n)?(?:<!-- review-escalation:([A-Za-z0-9_-]+) -->\n(?:<!-- review-adjudication:([A-Za-z0-9_-]+) -->\n)?)?/gm;
	let order = 0;
	for (const match of normalized.matchAll(rowRe)) {
		const full = match[0];
		const id = validateDecisionId(requireMatchGroup(match, 2, "decision id"));
		const rowLine = full.split("\n")[0] ?? "";
		const cells = splitRow(rowLine);
		if (cells.length !== 6) throw new Error(`decision row must have 6 cells: ${id}`);
		const metaRaw = match[3];
		const escRaw = match[4];
		const adjRaw = match[5];
		const meta = metaRaw ? parseMetaPayload(metaRaw) : { aliases: [] as string[] };
		const escalation = escRaw ? parseEscalationMetadata(escRaw) : undefined;
		if (adjRaw && !escalation) throw new Error(`review adjudication without escalation: ${id}`);
		const adjudication = adjRaw && escalation ? parseAdjudicationMetadata(adjRaw, escalation.escalation) : undefined;
		const at = match.index ?? 0;
		const section: "Active" | "Resolved" = at < resolvedAt ? "Active" : "Resolved";
		if (escalation && reviewEscalationId(escalation.escalation) !== id) {
			// Validation deferred to lookup for fail-closed invalid; still store for render fidelity.
		}
		entries.push({ id, section, cells, meta, ...(escalation ? { escalation } : {}), ...(adjudication ? { adjudication } : {}), order: order++ });
	}

	// Fail closed on duplicate IDs/aliases within the file.
	const seen = new Map<string, string>();
	for (const entry of entries) {
		const ids = [entry.id, ...entry.meta.aliases];
		for (const id of ids) {
			const prev = seen.get(id);
			if (prev && prev !== entry.id) throw new Error(`duplicate decision ID/alias ${id} in ${owner}`);
			seen.set(id, entry.id);
		}
	}

	return {
		owner,
		active: entries.filter((e) => e.section === "Active"),
		resolved: entries.filter((e) => e.section === "Resolved"),
	};
}

function readAuthorityFile(path: string, owner: string): AuthorityFile {
	if (!existsSync(path)) return { owner, active: [], resolved: [] };
	return parseAuthorityBody(readFileSync(path, "utf8"), owner);
}

function renderEntry(entry: StoredDecision): string {
	const row = `| ${entry.cells.join(" | ")} |\n${marker(entry.id)}\n${metaMarker(entry.meta)}\n`;
	if (!entry.escalation) return row;
	let out = `${row}${escalationMarker(entry.escalation)}\n`;
	if (!entry.adjudication) return out;
	out += `${adjudicationMarker(entry.adjudication)}\n`;
	out += renderReviewEscalationPacket(entry.id, entry.escalation.escalation, entry.escalation.resolution, entry.adjudication);
	return out.endsWith("\n") ? out : `${out}\n`;
}

function renderAuthority(file: AuthorityFile): string {
	const header = `# Decision log — ${file.owner}\n\nStatus values are \`default-taken\`, \`resolved\`, or \`resolved→ADR-nnnn\`. Source is an item, pull request, or review-note reference.\n\n`;
	const active = `## Active\n\n${DECISIONS_HEADER}\n${RULE}\n${file.active.map(renderEntry).join("")}`;
	const resolved = `## Resolved\n\n${DECISIONS_HEADER}\n${RULE}\n${file.resolved.map(renderEntry).join("")}`;
	const body = `${header}${active}\n${resolved}`;
	return body.endsWith("\n") ? body : `${body}\n`;
}

function writeAuthority(repo: string, file: AuthorityFile): string {
	const path = authorityPath(repo, file.owner);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, renderAuthority(file));
	return path;
}

function commit(repo: string, paths: string[], message: string): void {
	const rel = paths.map((path) => relative(repo, path));
	execFileSync("git", ["add", "--", ...rel], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["commit", "--no-verify", "-m", message, "--", ...rel], { cwd: repo, stdio: "pipe" });
}

function listOwnerFiles(repo: string): string[] {
	const dir = decisionLogDir(repo);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md") && name !== "README.md")
		.map((name) => name.slice(0, -3))
		.filter((owner) => {
			try {
				validateOwner(owner);
				return true;
			} catch {
				return false;
			}
		})
		.sort();
}

function allEntries(file: AuthorityFile): StoredDecision[] {
	return [...file.active, ...file.resolved];
}

function findByIdOrAlias(file: AuthorityFile, id: string): StoredDecision | undefined {
	return allEntries(file).find((e) => e.id === id || e.meta.aliases.includes(id));
}

function semanticEqual(a: StoredDecision, b: StoredDecision): boolean {
	const cellsEqual = a.cells.every((c, i) => normalize(unescapeCell(c)) === normalize(unescapeCell(cellAt(b.cells, i))));
	if (!cellsEqual) return false;
	if (Boolean(a.escalation) !== Boolean(b.escalation)) return false;
	if (a.escalation && b.escalation) {
		return JSON.stringify(a.escalation) === JSON.stringify(b.escalation);
	}
	const fa =
		a.meta.contentFingerprint ??
		contentFingerprint({
			fork: unescapeCell(cellAt(a.cells, 0)),
			chosen: unescapeCell(cellAt(a.cells, 2)) || undefined,
			alternatives: unescapeCell(cellAt(a.cells, 3)) || undefined,
		});
	const fb =
		b.meta.contentFingerprint ??
		contentFingerprint({
			fork: unescapeCell(cellAt(b.cells, 0)),
			chosen: unescapeCell(cellAt(b.cells, 2)) || undefined,
			alternatives: unescapeCell(cellAt(b.cells, 3)) || undefined,
		});
	return fa === fb;
}

function decisionFromCells(cells: string[]): Decision {
	const fork = unescapeCell(cellAt(cells, 0));
	const chosen = unescapeCell(cellAt(cells, 2));
	const alternatives = unescapeCell(cellAt(cells, 3));
	return { fork, ...(chosen ? { chosen } : {}), ...(alternatives ? { alternatives } : {}) };
}

function scanRepoForId(repo: string, id: string): Array<{ repo: string; owner: string; entry: StoredDecision; file: AuthorityFile }> {
	const hits: Array<{ repo: string; owner: string; entry: StoredDecision; file: AuthorityFile }> = [];
	for (const owner of listOwnerFiles(repo)) {
		const file = readAuthorityFile(authorityPath(repo, owner), owner);
		const entry = findByIdOrAlias(file, id);
		if (entry) hits.push({ repo, owner, entry, file });
	}
	return hits;
}

function isMainCheckout(repo: string): boolean {
	try {
		return execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() === "main";
	} catch {
		return false;
	}
}

/**
 * Append emitted decisions to the per-owner authority file.
 *
 * Dedupe rule (fork identity, deterministic): within one owner's log a decision's
 * identity is the normalized, case-sensitive (fork, chosen) pair —
 * normalizeIdentity() text canonicalization only, never fuzzy or semantic
 * matching. Re-emissions of the same identity collapse into the existing row
 * regardless of run, step, attempt, occurrence, source, or alternatives; the
 * surviving row keeps its first-emission provenance and alternatives. A same-fork
 * emission whose normalized chosen differs, including by case, is a genuine
 * re-decision and appends (supersession material). Shipped logs are append-only:
 * pre-existing near-duplicate rows are never rewritten; the rule governs new
 * appends only. Escalation rows are excluded — their identity is
 * reviewEscalationId().
 */
export async function appendDecisions(repo: string, input: AppendDecisionsInput): Promise<DecisionWriteResult> {
	try {
		const owner = ownerForEmission(input);
		return (() => {
			const path = authorityPath(repo, owner);
			const file = existsSync(path) ? readAuthorityFile(path, owner) : { owner, active: [], resolved: [] };
			const ids: string[] = [];
			const fresh: StoredDecision[] = [];
			const date = (input.now ?? new Date()).toISOString().slice(0, 10);

			for (const row of input.decisions) {
				const id = validateDecisionId(row.id);
				const expectedFp = contentFingerprint(row.decision);
				if (row.contentFingerprint.toLowerCase() !== expectedFp) {
					throw new Error(`content fingerprint mismatch for decision ${id}`);
				}
				const fingerprint = expectedFp;

				// ID / alias collision with unequal content → fail closed
				const byId = findByIdOrAlias(file, id);
				if (byId) {
					const existingFp = byId.meta.contentFingerprint ?? contentFingerprint(decisionFromCells(byId.cells));
					if (existingFp !== fingerprint || byId.escalation) {
						throw new Error(`decision ID collision with unequal content: ${id}`);
					}
					ids.push(byId.id);
					continue;
				}

				// Fork-identity dedupe (see doc comment): same normalized (fork, chosen)
				// is one decision across steps, runs, and rewordings of alternatives.
				const identity = forkIdentityKey(row.decision);
				const byIdentity = [...allEntries(file), ...fresh].find((e) => !e.escalation && forkIdentityKey(decisionFromCells(e.cells)) === identity);
				if (byIdentity) {
					ids.push(byIdentity.id);
					continue;
				}

				ids.push(id);
				fresh.push({
					id,
					section: "Active",
					cells: [cell(row.decision.fork), "default-taken", cell(row.decision.chosen), cell(row.decision.alternatives), cell(input.source), date],
					meta: {
						aliases: [],
						contentFingerprint: fingerprint,
						dedupe: { runId: input.runId, step: input.step, occurrence: row.occurrence },
					},
					order: allEntries(file).length + fresh.length,
				});
			}

			if (!fresh.length) return { status: "duplicate" as const, ids };
			file.active.push(...fresh);
			writeAuthority(repo, file);
			commit(repo, [path], `docs: record ${fresh.length} decision${fresh.length === 1 ? "" : "s"}`);
			return { status: "written" as const, ids };
		})();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`⚠ decisions: ${message}\n`);
		return { status: "failed", error: message, ids: [] };
	}
}

export async function appendReviewEscalation(repo: string, input: ReviewEscalationWriteInput): Promise<DecisionWriteResult> {
	const escalation = input.escalation;
	const id = reviewEscalationId(escalation);
	try {
		const adjudication = validateAdjudication(input.adjudication, escalation.evidenceFingerprint);
		const now = input.now ?? new Date();
		const owner = validateOwner(escalation.itemId);
		return (() => {
			const path = authorityPath(repo, owner);
			const file = existsSync(path) ? readAuthorityFile(path, owner) : { owner, active: [], resolved: [] };
			const existing = findByIdOrAlias(file, id);
			if (existing) {
				if (!existing.escalation || reviewEscalationId(existing.escalation.escalation) !== id) {
					throw new Error(`decision ID collision with unequal content: ${id}`);
				}
				return { status: "duplicate" as const, ids: [id] };
			}
			file.active.push({
				id,
				section: "Active",
				cells: [untrustedCell(`Cross-model review split for ${escalation.itemId}`), "default-taken", "Human adjudication required", "proceed or block", untrustedCell(escalation.reviewRecordSource), now.toISOString().slice(0, 10)],
				meta: { aliases: [] },
				escalation: { escalation },
				adjudication,
				order: allEntries(file).length,
			});
			writeAuthority(repo, file);
			commit(repo, [path], `docs: record review escalation ${id}`);
			return { status: "written" as const, ids: [id] };
		})();
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error), ids: [] };
	}
}

function lookupEscalationInFile(file: AuthorityFile, itemId: string, reviewedSha: string): ReviewEscalationLookup {
	const matches = allEntries(file).filter((e) => e.escalation && e.escalation.escalation.itemId === itemId && e.escalation.escalation.reviewedSha === reviewedSha);
	if (matches.length === 0) return { state: "missing" };
	if (matches.length !== 1) return { state: "invalid", error: "multiple review escalations match item and SHA" };
	const entry = matches[0];
	if (!entry?.escalation) return { state: "invalid", error: "review escalation metadata missing" };
	const metadata = entry.escalation;
	if (reviewEscalationId(metadata.escalation) !== entry.id) return { state: "invalid", error: "review escalation ID does not match its evidence" };
	if (entry.section === "Active") return { state: "active", id: entry.id, escalation: metadata.escalation };
	if (!metadata.resolution?.actor.trim() || !metadata.resolution.rationale.trim()) return { state: "invalid", error: "review resolution audit is incomplete" };
	return {
		state: metadata.resolution.disposition === "proceed" ? "resolved-proceed" : "resolved-block",
		id: entry.id,
		escalation: metadata.escalation,
		resolution: metadata.resolution,
	};
}

/**
 * Escalation lookups read COMMITTED content only (`git show HEAD:<path>`), never the
 * working tree: escalation records gate whether the adversarial review loop can be
 * skipped, and a step could otherwise plant an uncommitted forged resolved-proceed
 * file at the current HEAD. Residual (tracked as a follow-up charter): an agent that
 * commits a forged record via Bash is not stopped here — full mitigation is moving
 * escalation authority to harness-owned storage.
 */
function readCommittedAuthorityFile(repo: string, owner: string): AuthorityFile {
	const rel = relative(repo, authorityPath(repo, owner));
	let body: string;
	try {
		body = execFileSync("git", ["show", `HEAD:${rel}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		// Absent from HEAD is a genuine miss. Parse errors must not be collapsed into
		// missing — a corrupt committed authority file is fail-closed invalid.
		return { owner, active: [], resolved: [] };
	}
	return parseAuthorityBody(body, owner);
}

export function lookupReviewEscalation(repo: string, itemId: string, reviewedSha: string): ReviewEscalationLookup {
	try {
		const hitOwn = lookupEscalationInFile(readCommittedAuthorityFile(repo, itemId), itemId, reviewedSha);
		if (hitOwn.state !== "missing") return hitOwn;
		// Fallback: scan authority files (alias / mis-owned edge cases).
		let found: ReviewEscalationLookup | undefined;
		for (const owner of listOwnerFiles(repo)) {
			const hit = lookupEscalationInFile(readCommittedAuthorityFile(repo, owner), itemId, reviewedSha);
			if (hit.state === "missing") continue;
			if (found) return { state: "invalid", error: "multiple review escalations match item and SHA" };
			found = hit;
		}
		return found ?? { state: "missing" };
	} catch (error) {
		return { state: "invalid", error: error instanceof Error ? error.message : String(error) };
	}
}

function locateDecision(repo: string, id: string): { repo: string; owner: string; entry: StoredDecision; file: AuthorityFile } {
	validateDecisionId(id);
	const local = scanRepoForId(repo, id);
	if (local.length === 1) {
		const hit = local[0];
		if (!hit) throw new Error(`decision not found: ${id}`);
		return hit;
	}
	if (local.length > 1) throw new Error(`decision ID matches multiple rows: ${id}`);

	if (isMainCheckout(repo)) {
		const siblings = listWorktreesIn(repo).filter((wt) => resolve(wt) !== resolve(repo));
		const hits: Array<{ repo: string; owner: string; entry: StoredDecision; file: AuthorityFile }> = [];
		for (const wt of siblings) {
			hits.push(...scanRepoForId(wt, id));
		}
		if (hits.length === 1) {
			const hit = hits[0];
			if (!hit) throw new Error(`decision not found: ${id}`);
			return hit;
		}
		if (hits.length > 1) throw new Error(`decision ID matches multiple worktrees: ${id}`);
	}
	throw new Error(`decision not found: ${id}`);
}

export async function resolveDecision(repo: string, id: string, options: { adr?: string; now?: Date; disposition?: "proceed" | "block"; actor?: string; rationale?: string } = {}): Promise<string> {
	if (options.adr && !/^ADR-\d{4}$/i.test(options.adr)) throw new Error("--adr must match ADR-nnnn");
	const located = locateDecision(repo, id);
	const mutationRepo = located.repo;
	return withMutationLock(mutationRepo, () => {
		// Re-read under lock.
		const file = readAuthorityFile(authorityPath(mutationRepo, located.owner), located.owner);
		const entry = findByIdOrAlias(file, id);
		if (!entry) throw new Error(`decision not found: ${id}`);
		if (entry.section !== "Active") throw new Error(`decision is not active: ${entry.id}`);
		const isEscalation = Boolean(entry.escalation);
		if (isEscalation && (!options.disposition || !options.actor?.trim() || !options.rationale?.trim())) {
			throw new Error("review escalation resolution requires disposition, actor, and rationale");
		}
		const cells = [...entry.cells];
		cells[1] = options.adr ? `resolved→${options.adr.toUpperCase()}` : "resolved";
		cells[5] = (options.now ?? new Date()).toISOString().slice(0, 10);
		const moved: StoredDecision = {
			...entry,
			section: "Resolved",
			cells,
			...(isEscalation
				? {
						escalation: {
							escalation: entry.escalation!.escalation,
							resolution: {
								disposition: options.disposition!,
								actor: options.actor!.trim(),
								rationale: options.rationale!.trim(),
								timestamp: (options.now ?? new Date()).toISOString(),
								...(options.adr ? { adr: options.adr.toUpperCase() } : {}),
							},
						},
					}
				: {}),
		};
		file.active = file.active.filter((e) => e.id !== entry.id);
		file.resolved = [moved, ...file.resolved];
		const path = writeAuthority(mutationRepo, file);
		commit(mutationRepo, [path], `docs: resolve decision ${entry.id}`);
		return entry.id;
	});
}

export async function archiveResolvedDecisions(repo: string, cutoff: Date): Promise<number> {
	return withMutationLock(repo, () => {
		const owners = listOwnerFiles(repo);
		if (!owners.length) return 0;
		const changed: string[] = [];
		let total = 0;
		for (const owner of owners) {
			const path = authorityPath(repo, owner);
			const file = readAuthorityFile(path, owner);
			const keep: StoredDecision[] = [];
			const archive: StoredDecision[] = [];
			for (const entry of file.resolved) {
				const date = entry.cells[5];
				if (new Date(`${date}T00:00:00Z`) < cutoff) archive.push(entry);
				else keep.push(entry);
			}
			if (!archive.length) continue;
			file.resolved = keep;
			writeAuthority(repo, file);
			changed.push(path);
			const aPath = archivePath(repo, owner);
			const existing = existsSync(aPath) ? readAuthorityFile(aPath, owner) : { owner, active: [], resolved: [] };
			existing.resolved = [...archive, ...existing.resolved];
			mkdirSync(dirname(aPath), { recursive: true });
			writeFileSync(aPath, renderAuthority(existing));
			changed.push(aPath);
			total += archive.length;
		}
		if (!total) return 0;
		commit(repo, changed, `docs: archive ${total} resolved decision${total === 1 ? "" : "s"}`);
		return total;
	});
}

function ownerFromSource(source: string, escalationItemId?: string): string {
	if (escalationItemId) {
		try {
			return validateOwner(escalationItemId);
		} catch {
			// fall through
		}
	}
	const issue = source.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/i);
	if (issue?.[1]) return validateOwner(issue[1]);
	const review = source.match(/\.dev\/review-records\/[^/]*-(\d+)\.json$/);
	if (review?.[1]) return validateOwner(review[1]);
	if (/^\d+$/.test(source.trim())) return validateOwner(source.trim());
	const bare = source.match(/^#?(\d+)$/);
	if (bare?.[1]) return validateOwner(bare[1]);
	return LEGACY_UNATTRIBUTED;
}

function parseLegacyRegister(body: string): Array<StoredDecision & { owner: string }> {
	const normalized = body.replace(/\r\n/g, "\n");
	const resolvedAt = normalized.indexOf("## Resolved");
	if (normalized.indexOf("## Active") < 0 || resolvedAt < 0) throw new Error("legacy decisions register missing Active/Resolved sections");

	const rowRe = /^\| (.+) \|\n<!-- decision:([a-f0-9]+) -->\n(?:<!-- review-escalation:([A-Za-z0-9_-]+) -->\n)?/gm;
	const rows: Array<StoredDecision & { owner: string }> = [];
	let order = 0;
	for (const match of normalized.matchAll(rowRe)) {
		const id = requireMatchGroup(match, 2, "legacy decision id");
		const rowLine = match[0].split("\n")[0] ?? "";
		const cells = splitRow(rowLine);
		if (cells.length !== 6) throw new Error(`legacy decision row must have 6 cells: ${id}`);
		const escRaw = match[3];
		const escalation = escRaw ? parseEscalationMetadata(escRaw) : undefined;
		const section: "Active" | "Resolved" = (match.index ?? 0) < resolvedAt ? "Active" : "Resolved";
		const decision = decisionFromCells(cells);
		const fingerprint = escalation ? undefined : contentFingerprint(decision);
		const owner = ownerFromSource(unescapeCell(cellAt(cells, 4)), escalation?.escalation.itemId);
		rows.push({
			id,
			section,
			cells,
			meta: {
				aliases: [],
				...(fingerprint ? { contentFingerprint: fingerprint } : {}),
				...(!escalation
					? {
							dedupe: { runId: "legacy", step: "migrated", occurrence: order },
						}
					: {}),
			},
			...(escalation ? { escalation } : {}),
			order: order++,
			owner,
		});
	}
	return rows;
}

function reconcileOwnerRows(rows: StoredDecision[]): { kept: StoredDecision[]; reconciled: number } {
	const bySection = new Map<string, StoredDecision[]>();
	for (const row of rows) {
		const key = `${row.section}\0${row.cells[4]}`;
		const list = bySection.get(key) ?? [];
		list.push(row);
		bySection.set(key, list);
	}
	const kept: StoredDecision[] = [];
	let reconciled = 0;
	const idOwners = new Map<string, StoredDecision>();

	for (const group of bySection.values()) {
		group.sort((a, b) => a.order - b.order);
		const canonicals: StoredDecision[] = [];
		for (const row of group) {
			const dup = canonicals.find((c) => semanticEqual(c, row));
			if (dup) {
				if (dup.id !== row.id) {
					// Same content, different ID → alias
					if (!dup.meta.aliases.includes(row.id) && dup.id !== row.id) dup.meta.aliases.push(row.id);
					for (const alias of row.meta.aliases) {
						if (alias !== dup.id && !dup.meta.aliases.includes(alias)) dup.meta.aliases.push(alias);
					}
					reconciled += 1;
				}
				continue;
			}
			// ID collision with unequal content across any kept row → fail later via idOwners
			canonicals.push({ ...row, meta: { ...row.meta, aliases: [...row.meta.aliases] } });
		}
		kept.push(...canonicals);
	}

	// Global ID uniqueness with unequal content
	for (const row of kept) {
		for (const id of [row.id, ...row.meta.aliases]) {
			const prev = idOwners.get(id);
			if (prev && prev !== row && !semanticEqual(prev, row)) {
				throw new Error(`migration aborted: ID collision with unequal content: ${id}`);
			}
			idOwners.set(id, row);
		}
	}
	kept.sort((a, b) => a.order - b.order);
	return { kept, reconciled };
}

export async function migrateDecisions(repo: string): Promise<MigrateDecisionsResult> {
	return withMutationLock(repo, () => {
		const legacyPath = resolve(repo, "docs", "decisions.md");
		if (!existsSync(legacyPath)) {
			return { status: "noop", owners: [], rows: 0, reconciled: 0, unattributed: 0 };
		}
		const body = readFileSync(legacyPath, "utf8");
		// Generated index is not a migration source — authority already lives under decision-log/.
		if (body.includes("docs/decision-log/") && body.includes("rebuild-index")) {
			return { status: "noop", owners: listOwnerFiles(repo), rows: 0, reconciled: 0, unattributed: 0 };
		}
		const legacyRows = (() => {
			try {
				return parseLegacyRegister(body);
			} catch (e) {
				// Only a genuinely empty skeleton may no-op. A body carrying decision
				// markers or table rows that fails to parse is corruption; failing open
				// here would silently strand operational decisions unmigrated.
				if (body.includes("<!-- decision:") || /^\| .+ \|$/m.test(body)) {
					const msg = e instanceof Error ? e.message : String(e);
					throw new Error(`legacy decisions register is unparseable — refusing to no-op the migration: ${msg}`);
				}
				return [] as Array<StoredDecision & { owner: string }>;
			}
		})();

		if (!legacyRows.length) {
			return { status: "noop", owners: listOwnerFiles(repo), rows: 0, reconciled: 0, unattributed: 0 };
		}

		const byOwner = new Map<string, StoredDecision[]>();
		for (const row of legacyRows) {
			const list = byOwner.get(row.owner) ?? [];
			list.push(row);
			byOwner.set(row.owner, list);
		}

		const planned = new Map<string, string>();
		let reconciled = 0;
		let unattributed = 0;
		const ownerNames: string[] = [];

		for (const [owner, rows] of [...byOwner.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			ownerNames.push(owner);
			if (owner === LEGACY_UNATTRIBUTED) unattributed += rows.length;
			const { kept, reconciled: r } = reconcileOwnerRows(rows);
			reconciled += r;
			const file: AuthorityFile = {
				owner,
				active: kept.filter((e) => e.section === "Active"),
				resolved: kept.filter((e) => e.section === "Resolved"),
			};
			planned.set(owner, renderAuthority(file));
		}

		// Fail closed if existing authority disagrees
		for (const [owner, rendered] of planned) {
			const path = authorityPath(repo, owner);
			if (existsSync(path)) {
				const existing = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
				if (existing !== rendered) {
					// Idempotent only when byte-identical; otherwise refuse overwrite.
					const existingFile = readAuthorityFile(path, owner);
					const plannedFile = parseAuthorityBody(rendered, owner);
					const existingIds = new Set(allEntries(existingFile).flatMap((e) => [e.id, ...e.meta.aliases]));
					const plannedEntries = allEntries(plannedFile);
					for (const entry of plannedEntries) {
						const hit = findByIdOrAlias(existingFile, entry.id);
						if (hit && !semanticEqual(hit, entry)) {
							throw new Error(`migration aborted: existing authority disagrees for ${entry.id} in ${owner}`);
						}
						for (const alias of entry.meta.aliases) {
							if (existingIds.has(alias)) {
								const h = findByIdOrAlias(existingFile, alias);
								if (h && !semanticEqual(h, entry)) {
									throw new Error(`migration aborted: existing authority disagrees for alias ${alias} in ${owner}`);
								}
							}
						}
					}
					// Merge: if existing is a superset or equal semantically for shared IDs, keep existing when identical render after merge is hard —
					// plan: re-running against identical outputs is no-op; disagreement fails closed.
					// If files differ but shared IDs agree, still fail closed rather than silently merge.
					throw new Error(`migration aborted: existing authority for ${owner} differs from migration output`);
				}
			}
		}

		// If all planned files already exist and match, no-op
		const allMatch = [...planned.entries()].every(([owner, rendered]) => {
			const path = authorityPath(repo, owner);
			return existsSync(path) && readFileSync(path, "utf8").replace(/\r\n/g, "\n") === rendered;
		});
		if (allMatch) {
			return { status: "noop", owners: ownerNames, rows: legacyRows.length, reconciled, unattributed };
		}

		const paths: string[] = [];
		for (const [owner, rendered] of planned) {
			const path = authorityPath(repo, owner);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, rendered);
			paths.push(path);
		}
		commit(repo, paths, `docs: migrate decision log to per-item authority (${paths.length} owners)`);
		return { status: "written", owners: ownerNames, rows: legacyRows.length, reconciled, unattributed };
	});
}

function indexBanner(): string {
	return `# Decisions (generated index)

> **Do not edit.** This file is a deterministic projection of \`docs/decision-log/\`.
> Authoritative records live in \`docs/decision-log/<owner>.md\`.
> Regenerate with \`npx pelaggio decisions rebuild-index\`.

Status values are \`default-taken\`, \`resolved\`, or \`resolved→ADR-nnnn\`. Source is an item, pull request, or review-note reference.

`;
}

function sortEntries(entries: Array<StoredDecision & { owner: string }>): Array<StoredDecision & { owner: string }> {
	return [...entries].sort((a, b) => {
		const dateCmp = (a.cells[5] ?? "").localeCompare(b.cells[5] ?? "");
		if (dateCmp !== 0) return dateCmp;
		const ownerCmp = a.owner.localeCompare(b.owner);
		if (ownerCmp !== 0) return ownerCmp;
		return a.id.localeCompare(b.id);
	});
}

function renderIndexEntry(entry: StoredDecision): string {
	// Projection includes markers for operator discoverability; aliases stay metadata-only (not second rows).
	const row = `| ${entry.cells.join(" | ")} |\n${marker(entry.id)}\n`;
	if (entry.meta.aliases.length || entry.meta.contentFingerprint || entry.meta.dedupe) {
		// Keep meta for round-trip operator tooling reading the index; not authoritative.
	}
	return entry.escalation ? `${row}${escalationMarker(entry.escalation)}\n` : row;
}

export async function rebuildDecisionIndex(repo: string): Promise<RebuildIndexResult> {
	return withMutationLock(repo, () => {
		const owners = listOwnerFiles(repo);
		const active: Array<StoredDecision & { owner: string }> = [];
		const resolved: Array<StoredDecision & { owner: string }> = [];
		for (const owner of owners) {
			const file = readAuthorityFile(authorityPath(repo, owner), owner);
			// Validate by re-parse round-trip
			for (const e of file.active) active.push({ ...e, owner });
			for (const e of file.resolved) resolved.push({ ...e, owner });
		}
		const sortedActive = sortEntries(active);
		const sortedResolved = sortEntries(resolved);
		const body = `${indexBanner()}` + `## Active\n\n${DECISIONS_HEADER}\n${RULE}\n${sortedActive.map(renderIndexEntry).join("")}\n` + `## Resolved\n\n${DECISIONS_HEADER}\n${RULE}\n${sortedResolved.map(renderIndexEntry).join("")}`;
		const rendered = body.endsWith("\n") ? body : `${body}\n`;
		const path = resolve(repo, "docs", "decisions.md");
		if (existsSync(path) && readFileSync(path, "utf8").replace(/\r\n/g, "\n") === rendered) {
			return { status: "noop", rows: sortedActive.length + sortedResolved.length };
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, rendered);
		commit(repo, [path], "docs: rebuild decision index from decision-log");
		return { status: "written", rows: sortedActive.length + sortedResolved.length };
	});
}
