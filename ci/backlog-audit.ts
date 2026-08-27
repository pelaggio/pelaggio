/**
 * Backlog intake-conformance audit over a roadmap issue dump.
 *
 * This is INSTRUMENTATION, not a check: it exits 0 regardless and prints a report. ADR-0011
 * decided against a Definition-of-Ready intake gate, and `throughput-economy.md` refuted the
 * check-ratchet for this repo — so nothing here may become a blocking gate on filing. What it
 * buys is a measurement: which open items a planner cannot act on without re-deriving intent,
 * and whether that population is a legacy stock or a live intake defect.
 *
 * Every signal is a deterministic property of the item's own text or of the tracker's own state
 * (a declared dependency that is closed). None of them reads a model's judgment of quality, and
 * none of them asserts an item is wrong — an empty charter is a refinement candidate, never a
 * closure warrant.
 *
 * The tracker is mutable — titles, bodies, labels and state all move — so a live re-run would not
 * reproduce a published number. Following `review-gate-baseline.md`, the evidence committed here is
 * the DERIVED signal set plus a `count:hash` corpus fingerprint, not the bodies it was derived from.
 * Default mode reports the pinned snapshot. `--issues <dump>` recomputes from a live GitHub dump
 * (`GET /repos/:owner/:repo/issues?state=all`, PRs dropped) and reports drift against the pin;
 * `--issues <dump> --write` re-pins.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The roadmap pickup label from `.pelaggio.yml` (`roadmap.github.label`). */
export const ROADMAP_LABEL = "autopilot";

/**
 * A charter shorter than this — after the machine-readable `Depends on:` / `Scope:` preamble is
 * removed — carries no outcome, no constraint and no evidence: the title is the whole spec.
 */
export const EMPTY_CHARTER_CHARS = 120;

export interface IssueRecord {
	number: number;
	title: string;
	body?: string | null;
	state: "open" | "closed";
	labels: readonly (string | { name?: string })[];
	created_at: string;
	updated_at: string;
	pull_request?: unknown;
}

export interface ItemSignals {
	number: number;
	title: string;
	labels: readonly string[];
	createdAt: string;
	updatedAt: string;
	/** Charter body is the title and nothing else. */
	emptyCharter: boolean;
	/** Carries no acceptance/evidence surface a planner could bind a check to. */
	noAcceptanceEvidence: boolean;
	/** Open, but missing the roadmap pickup label — `/pick` can never surface it. */
	unpickable: boolean;
	/** Declares dependencies and every one of them is now closed. */
	unblocked: boolean;
	/** Cites identifiers from before the autopilot → pelaggio rename. */
	legacyVocabulary: boolean;
	declaredDeps: readonly number[];
}

export function labelNames(labels: IssueRecord["labels"]): string[] {
	return labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
}

/** Strip the machine-readable preamble the markdown/github adapters write, leaving prose. */
export function charterProse(body: string | null | undefined): string {
	return (body ?? "").replace(/^[ \t]*(?:depends[- ]on|scope)[ \t]*:.*$/gim, "").trim();
}

export function isEmptyCharter(body: string | null | undefined): boolean {
	return charterProse(body).length < EMPTY_CHARTER_CHARS;
}

/**
 * An acceptance surface is anything a later step could bind a check to: an Acceptance/Evidence
 * heading, an unchecked task box, a `charter-contract.md` `AC-n` anchor, or a `verify:` binding.
 */
const ACCEPTANCE_RE = /^[ \t]*#+[ \t]*(?:acceptance|evidence|verify)|^[ \t]*[-*]?[ \t]*\[ \]|^[ \t]*AC-\d|verify:/im;

export function hasAcceptanceEvidence(body: string | null | undefined): boolean {
	return ACCEPTANCE_RE.test(body ?? "");
}

/**
 * Identifiers that did not survive the autopilot → pelaggio rename. A body carrying one cites a
 * package, path or artifact that no longer exists, so its "touchpoints" section is unusable.
 */
const LEGACY_RE = /claude-autopilot|packages\/autopilot\b|scripts\/autopilot\/|@cdhorne\/|pnpm autopilot\b|autopilot-server|autopilot-log\.jsonl/;

export function hasLegacyVocabulary(text: string): boolean {
	return LEGACY_RE.test(text);
}

/** Parse the adapter's `Depends on: 170, 171` preamble. Prose mentions of `#N` are not deps. */
export function declaredDeps(body: string | null | undefined): number[] {
	const out = new Set<number>();
	for (const m of (body ?? "").matchAll(/^[ \t]*(?:\*\*)?depends[- ]on(?:\*\*)?[ \t]*:?[ \t]*(.+)$/gim)) {
		for (const n of m[1].matchAll(/\d{1,6}/g)) out.add(Number(n[0]));
	}
	return [...out].sort((a, b) => a - b);
}

export function computeSignals(issues: readonly IssueRecord[]): ItemSignals[] {
	const items = issues.filter((i) => !i.pull_request);
	const state = new Map(items.map((i) => [i.number, i.state]));
	return items
		.filter((i) => i.state === "open")
		.map((i) => {
			const deps = declaredDeps(i.body).filter((d) => state.has(d));
			return {
				number: i.number,
				title: i.title,
				labels: labelNames(i.labels),
				createdAt: i.created_at,
				updatedAt: i.updated_at,
				emptyCharter: isEmptyCharter(i.body),
				noAcceptanceEvidence: !hasAcceptanceEvidence(i.body),
				unpickable: !labelNames(i.labels).includes(ROADMAP_LABEL),
				unblocked: deps.length > 0 && deps.every((d) => state.get(d) === "closed"),
				legacyVocabulary: hasLegacyVocabulary(`${i.title}\n${i.body ?? ""}`),
				declaredDeps: deps,
			};
		})
		.sort((a, b) => a.number - b.number);
}

export interface PeriodRow {
	period: string;
	filed: number;
	empty: number;
	withAcceptance: number;
}

/**
 * Intake quality over time, across EVERY item ever filed (not just the open ones) — otherwise
 * closure selects the sample and a well-specified month looks identical to a stagnant one.
 * Half-month buckets: the repo files ~100/month, so whole months hide the trend that matters.
 */
export function intakeTrend(issues: readonly IssueRecord[]): PeriodRow[] {
	const buckets = new Map<string, PeriodRow>();
	for (const i of issues) {
		if (i.pull_request) continue;
		const period = `${i.created_at.slice(0, 7)}-${Number(i.created_at.slice(8, 10)) <= 15 ? "H1" : "H2"}`;
		const row = buckets.get(period) ?? { period, filed: 0, empty: 0, withAcceptance: 0 };
		row.filed += 1;
		if (isEmptyCharter(i.body)) row.empty += 1;
		if (hasAcceptanceEvidence(i.body)) row.withAcceptance += 1;
		buckets.set(period, row);
	}
	return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
}

export const PINNED_SNAPSHOT = join("docs", "agent-context", "data", "backlog-signals-2026-08-27.json");

export interface PinnedSnapshot {
	/** `<item count>:<12 hex of the body-content digest>` — changes if any charter text changed. */
	fingerprint: string;
	observedAt: string;
	openCount: number;
	trend: PeriodRow[];
	items: ItemSignals[];
}

/**
 * Identity of the corpus the signals were derived from. Covers every item's number, state and
 * charter text, so a re-derivation that lands on the same fingerprint is reading the same corpus.
 */
export function fingerprint(issues: readonly IssueRecord[]): string {
	const items = issues.filter((i) => !i.pull_request).sort((a, b) => a.number - b.number);
	const h = createHash("sha256");
	for (const i of items) h.update(`${i.number}\u0000${i.state}\u0000${i.title}\u0000${i.body ?? ""}\u0000`);
	return `${items.length}:${h.digest("hex").slice(0, 12)}`;
}

export function buildSnapshot(issues: readonly IssueRecord[], observedAt: string): PinnedSnapshot {
	const items = computeSignals(issues);
	return { fingerprint: fingerprint(issues), observedAt, openCount: items.length, trend: intakeTrend(issues), items };
}

export function repoRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function flagValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function pct(n: number, total: number): string {
	return total === 0 ? "  0%" : `${`${Math.round((100 * n) / total)}`.padStart(3)}%`;
}

function section(title: string, rows: readonly ItemSignals[]): void {
	process.stdout.write(`\n  ${title} — ${rows.length}\n  ${"─".repeat(74)}\n`);
	for (const r of rows) {
		const parked = r.labels.includes("deferred") ? "deferred" : "";
		process.stdout.write(`  #${String(r.number).padEnd(5)}${parked.padEnd(10)}${r.title.slice(0, 58)}\n`);
	}
}

function report(snap: PinnedSnapshot, source: string): void {
	const { items: signals, openCount: n } = snap;
	const count = (f: (s: ItemSignals) => boolean): number => signals.filter(f).length;
	process.stdout.write(`\nbacklog intake audit — ${source}\n`);
	process.stdout.write(`  corpus ${snap.fingerprint}   observed ${snap.observedAt}\n\n`);
	process.stdout.write(`  open items                 ${String(n).padStart(3)}\n`);
	for (const [label, f] of [
		["empty charter", (s: ItemSignals) => s.emptyCharter],
		["no acceptance evidence", (s: ItemSignals) => s.noAcceptanceEvidence],
		["unpickable (no label)", (s: ItemSignals) => s.unpickable],
		["unblocked, still parked", (s: ItemSignals) => s.unblocked],
		["legacy vocabulary", (s: ItemSignals) => s.legacyVocabulary],
	] as const) {
		process.stdout.write(`  ${label.padEnd(26)}${String(count(f)).padStart(3)}  ${pct(count(f), n)}\n`);
	}

	process.stdout.write(`\n  intake trend (every item ever filed — closure would otherwise select the sample)\n  ${"─".repeat(74)}\n`);
	process.stdout.write(`  ${"period".padEnd(12)}${"filed".padEnd(8)}${"empty".padEnd(8)}${"empty%".padEnd(9)}acceptance%\n`);
	for (const r of snap.trend) {
		process.stdout.write(`  ${r.period.padEnd(12)}${String(r.filed).padEnd(8)}${String(r.empty).padEnd(8)}${pct(r.empty, r.filed).padEnd(9)}${pct(r.withAcceptance, r.filed)}\n`);
	}

	section(
		"unpickable — open but outside the roadmap label",
		signals.filter((s) => s.unpickable),
	);
	section(
		"legacy vocabulary — cites pre-rename identifiers",
		signals.filter((s) => s.legacyVocabulary),
	);
	section(
		"unblocked — every declared dependency is closed",
		signals.filter((s) => s.unblocked),
	);
	section(
		"empty charter — the title is the whole spec",
		signals.filter((s) => s.emptyCharter),
	);
	process.stdout.write("\n");
}

function main(): void {
	const pinnedPath = join(repoRoot(), PINNED_SNAPSHOT);
	const dump = flagValue("--issues");
	if (!dump) {
		try {
			report(JSON.parse(readFileSync(pinnedPath, "utf8")) as PinnedSnapshot, `${PINNED_SNAPSHOT} (pinned)`);
		} catch (err) {
			process.stdout.write(`backlog-audit: cannot read the pinned snapshot — ${err instanceof Error ? err.message : String(err)}\n`);
			process.stdout.write(`re-pin with: --issues <dump> --write\n`);
		}
		return;
	}
	let issues: IssueRecord[];
	try {
		issues = JSON.parse(readFileSync(dump, "utf8")) as IssueRecord[];
	} catch (err) {
		process.stdout.write(`backlog-audit: cannot read ${dump} — ${err instanceof Error ? err.message : String(err)}\n`);
		return;
	}
	const observedAt = flagValue("--observed-at") ?? new Date().toISOString().slice(0, 10);
	const snap = buildSnapshot(issues, observedAt);
	report(snap, `${dump} (live)`);
	if (process.argv.includes("--write")) {
		writeFileSync(pinnedPath, `${JSON.stringify(snap, null, "\t")}\n`);
		process.stdout.write(`  re-pinned ${PINNED_SNAPSHOT} at ${snap.fingerprint}\n\n`);
		return;
	}
	try {
		const pinned = JSON.parse(readFileSync(pinnedPath, "utf8")) as PinnedSnapshot;
		if (pinned.fingerprint !== snap.fingerprint) {
			process.stdout.write(`  DRIFT: pinned ${pinned.fingerprint} (${pinned.openCount} open) vs live ${snap.fingerprint} (${snap.openCount} open)\n`);
			process.stdout.write(`  the published numbers describe the pinned corpus; re-pin with --write to move the baseline\n\n`);
		}
	} catch {
		/* no pin yet — the live report is the whole output */
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
