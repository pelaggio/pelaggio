import { appendFileSync } from "node:fs";
import { makeSecretScrubber } from "./secret-hygiene.js";
import type { CycleStatus, StepEmit, StepEvent } from "./types.js";

// Redact credential-shaped strings and secret env-var values from the verbose file transcript
// before it lands on disk (#237 / TC-014). This is the sink where raw agent stdout is captured
// (see TC-001 known_limits), so scrub-before-write here covers every driver's emitted output.
const scrubTranscript = makeSecretScrubber();

// ── TUI-enabled detection ──────────────────────────────────────────────

export function computeTuiEnabled(env: NodeJS.ProcessEnv = process.env, stderr: { isTTY?: boolean } = process.stderr): boolean {
	if (env.PELAGGIO_PLAIN === "1") return false;
	return !!stderr.isTTY;
}

export const TUI_ENABLED = computeTuiEnabled();

// ── ANSI helpers ───────────────────────────────────────────────────────

const wrap = TUI_ENABLED
	? (open: string, close: string) =>
			(s: string): string =>
				`\x1b[${open}m${s}\x1b[${close}m`
	: (_open: string, _close: string) =>
			(s: string): string =>
				s;

export const A = {
	bold: wrap("1", "22"),
	dim: wrap("2", "22"),
	cyan: wrap("36", "39"),
	yellow: wrap("33", "39"),
	green: wrap("32", "39"),
	red: wrap("31", "39"),
	magenta: wrap("35", "39"),
	clearLine: TUI_ENABLED ? "\x1b[2K\r" : "",
	hideCursor: TUI_ENABLED ? "\x1b[?25l" : "",
	showCursor: TUI_ENABLED ? "\x1b[?25h" : "",
};

export function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function fmtElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function truncate(text: string, max: number): string {
	return stripAnsi(text).length > max ? text.slice(0, max - 1) + A.dim("…") : text;
}

// ── Tool display helpers ───────────────────────────────────────────────

const TOOL_VERBS: Record<string, string> = {
	Read: "Reading",
	Write: "Writing",
	Edit: "Editing",
	Bash: "Running",
	Glob: "Searching",
	Grep: "Searching",
	Agent: "Delegating",
};

export const MUTATING_TOOLS = new Set(["Write", "Edit", "Bash", "Agent"]);

export function toolVerb(name: string): string {
	return TOOL_VERBS[name] ?? "Using";
}

export function toolBrief(name: string, input: Record<string, unknown>): string {
	const rel = (p: unknown): string => String(p).replace(/^.*[/\\](?=apps|packages|src|scripts|docs|\.claude)/, "");
	switch (name) {
		case "Read":
		case "Write":
		case "Edit":
			return rel(input.file_path ?? "");
		case "Bash":
			return String(input.description ?? input.command ?? "").slice(0, 60);
		case "Glob":
			return `${input.pattern}${input.path ? ` in ${rel(input.path)}` : ""}`;
		case "Grep":
			return `/${input.pattern}/${input.path ? ` in ${rel(input.path)}` : ""}`;
		case "Agent":
			return String(input.description ?? "").slice(0, 50);
		default: {
			const first = Object.entries(input).find(([, v]) => typeof v === "string");
			return first ? String(first[1]).slice(0, 50) : "";
		}
	}
}

// ── Spinner ────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private text = "";
	private liveStatus: LiveStatus | null;
	private readonly plain: boolean;

	constructor(liveStatus: LiveStatus | null = null, opts: { plain?: boolean } = {}) {
		this.liveStatus = liveStatus;
		this.plain = opts.plain ?? !TUI_ENABLED;
	}

	start(text: string): void {
		if (this.plain) return;
		this.text = text;
		this.frame = 0;
		this.render();
		this.interval = setInterval(() => {
			this.render();
			if (this.liveStatus?.statusBar.active) this.liveStatus.render();
		}, 80);
	}

	private render(): void {
		const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
		const cols = process.stderr.columns || 80;
		const text = truncate(this.text, Math.max(0, cols - 6));
		process.stderr.write(`${A.clearLine}│  ${A.cyan(f)} ${A.dim(text)}`);
		this.frame++;
	}

	stop(finalLine?: string): void {
		if (this.plain) return;
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
		process.stderr.write(A.clearLine);
		if (finalLine) {
			const cols = process.stderr.columns || 80;
			process.stderr.write(`│  ${truncate(finalLine, Math.max(0, cols - 4))}\n`);
		}
	}

	get active(): boolean {
		return this.interval !== null;
	}
}

// ── Status bar (pinned at terminal bottom) ─────────────────────────────

export class StatusBar {
	readonly plain: boolean;
	active = false;
	reservedLines = 2;
	lastLines: string[] = [];
	// Registered once on first setup(); setup() is re-invoked per auto-resume round
	// (pipeline park loop), so an unguarded `.on` would stack a listener per round.
	private resizeListener: (() => void) | null = null;

	constructor(opts: { plain?: boolean } = {}) {
		this.plain = opts.plain ?? !TUI_ENABLED;
	}

	setup(lines = 2): void {
		if (this.plain) return;
		this.reservedLines = lines;
		this.applyScrollRegion();
		process.stderr.write("\x1b[1;1H");
		this.active = true;
		if (!this.resizeListener) {
			this.resizeListener = () => {
				if (!this.active) return;
				process.stderr.write("\x1b[2J\x1b[1;1H");
				this.applyScrollRegion();
				this.update(this.lastLines);
			};
			process.stderr.on("resize", this.resizeListener);
		}
	}

	private applyScrollRegion(): void {
		const rows = process.stderr.rows || 24;
		process.stderr.write(`\x1b[1;${rows - this.reservedLines}r`);
	}

	update(lines: string[]): void {
		if (this.plain || !this.active) return;
		this.lastLines = lines;
		const rows = process.stderr.rows || 24;
		const cols = process.stderr.columns || 80;
		const startRow = rows - this.reservedLines + 1;
		let esc = "\x1b[s";
		for (let i = 0; i < this.reservedLines; i++) {
			const content = lines[i] ?? "";
			const visible = stripAnsi(content).length;
			const pad = Math.max(0, cols - visible);
			esc += `\x1b[${startRow + i};1H\x1b[2K${content}${" ".repeat(pad)}`;
		}
		esc += "\x1b[u";
		process.stderr.write(esc);
	}

	teardown(): void {
		if (this.plain) return;
		if (!this.active) return;
		const rows = process.stderr.rows || 24;
		const startRow = rows - this.reservedLines + 1;
		process.stderr.write(`\x1b[1;${rows}r`);
		for (let i = 0; i < this.reservedLines; i++) {
			process.stderr.write(`\x1b[${startRow + i};1H\x1b[2K`);
		}
		process.stderr.write(`\x1b[${rows};1H`);
		this.active = false;
	}
}

// ── Live status (renders cycle progress into status bar) ───────────────

export class LiveStatus {
	cycles: CycleStatus[] = [];
	totalCycles = 0;
	multiline = false;
	readonly statusBar: StatusBar;

	constructor(statusBar: StatusBar) {
		this.statusBar = statusBar;
	}

	render(): void {
		const cols = process.stderr.columns || 80;
		const cost = this.cycles.reduce((sum, c) => sum + c.cost, 0);

		if (this.multiline) {
			const lines: string[] = [];
			for (const s of this.cycles) {
				if (s.status !== "running") continue;
				const step = s.step ? A.magenta(s.step) : A.dim("waiting");
				const turns = s.turns ? ` ${A.dim(`t${s.turns}`)}` : "";
				const activity = s.lastActivity ? `  ${A.dim(s.lastActivity)}` : "";
				lines.push(truncate(`${A.cyan("◆")} ${A.bold(s.itemId)} ${step}${turns}${activity}`, cols - 1));
			}
			const done = this.cycles.filter((c) => c.status === "done").length;
			const warnings = this.cycles.filter((c) => c.status === "warning").length;
			const failed = this.cycles.filter((c) => c.status === "failed").length;
			const remaining = this.totalCycles - this.cycles.length;
			let summary = A.dim("──");
			if (done) summary += `  ${A.green(`${done}✓`)}`;
			if (warnings) summary += `  ${A.yellow(`${warnings}⚠`)}`;
			if (failed) summary += `  ${A.red(`${failed}✗`)}`;
			if (remaining > 0) summary += `  ${A.dim(`+${remaining}`)}`;
			summary += `  ${A.dim("$")}${cost.toFixed(2)}`;
			summary += `  ${A.dim("──")}`;
			lines.push(truncate(summary, cols - 1));
			this.statusBar.update(lines);
		} else {
			const items = this.cycles.map((s) => {
				const icon = s.status === "done" ? A.green("✓") : s.status === "warning" ? A.yellow("⚠") : s.status === "running" ? A.cyan("◆") : s.status === "failed" ? A.red("✗") : A.dim("○");
				let label = `${icon} ${s.itemId}`;
				if (s.status === "running") {
					if (s.step) {
						label += ` ${A.magenta(s.step)}`;
						if (s.turns) label += ` ${A.dim(`t${s.turns}`)}`;
						if (s.lastActivity) label += `  ${A.dim(s.lastActivity)}`;
					} else {
						label += ` ${A.dim("waiting")}`;
					}
				}
				return label;
			});
			const remaining = this.totalCycles - this.cycles.length;
			if (remaining > 0) items.push(A.dim(`+${remaining} remaining`));
			const line = `${items.join("  ")}  ${A.dim("│")}  ${A.dim("$")}${cost.toFixed(2)}`;
			this.statusBar.update([truncate(line, cols - 1)]);
		}
	}
}

// ── Step renderer factory (Observer callback) ──────────────────────────

export interface StepRendererOpts {
	verbose: boolean;
	trace: boolean;
	toFile: boolean;
	logPath?: string;
	liveStatus: LiveStatus;
	workerStatus?: CycleStatus;
	plain?: boolean;
}

export function createStepRenderer(opts: StepRendererOpts): StepEmit {
	const { verbose, trace, toFile, logPath, liveStatus, workerStatus: ws } = opts;

	const plain = opts.plain ?? !TUI_ENABLED;
	const ttyVerbose = verbose && !toFile && !plain;
	const plainVerbose = verbose && !toFile && plain;
	const fileVerbose = toFile;

	const w = (s: string): void => {
		if (ttyVerbose) process.stderr.write(s);
	};
	const ln = (s: string): void => w(`│  ${s}\n`);
	const plainLine: (s: string) => void = plainVerbose
		? (s): void => {
				process.stderr.write(stripAnsi(s));
			}
		: fileVerbose && logPath
			? (s): void => {
					appendFileSync(logPath, scrubTranscript(stripAnsi(s)));
				}
			: (_s): void => {};

	const spinner = ttyVerbose ? new Spinner(liveStatus) : null;
	let lastToolName = "";
	let lastToolBrief = "";

	if (ttyVerbose) process.stderr.write(A.hideCursor);

	return (event: StepEvent): void => {
		switch (event.type) {
			case "step_header": {
				if (ws) {
					ws.step = event.name;
					ws.turns = 0;
					ws.lastActivity = undefined;
				}
				if (ttyVerbose) {
					w(`\n╭─ ${A.bold(event.name)} ${A.dim("─".repeat(Math.max(1, 48 - event.name.length)))}\n`);
					ln(`${A.dim("model")} ${A.cyan(event.model)}  ${A.dim("budget")} $${event.budget.toFixed(2)}  ${A.dim("max")} ${event.maxTurns} turns`);
					if (trace && event.prompt) {
						ln("");
						const lines = event.prompt.split("\n");
						ln(A.dim(`prompt (${event.prompt.length} chars):`));
						for (const pl of lines.slice(0, 6)) ln(`  ${A.dim(pl.slice(0, 120))}`);
						if (lines.length > 6) ln(`  ${A.dim(`… +${lines.length - 6} lines`)}`);
					}
					w("│\n");
				}
				plainLine(`\n── ${event.name} ── model: ${event.model}  budget: $${event.budget.toFixed(2)}  max: ${event.maxTurns} turns\n`);
				if (trace && event.prompt) {
					const lines = event.prompt.split("\n");
					plainLine(`   prompt (${event.prompt.length} chars):\n`);
					for (const pl of lines.slice(0, 6)) plainLine(`     ${pl.slice(0, 120)}\n`);
					if (lines.length > 6) plainLine(`     … +${lines.length - 6} lines\n`);
				}
				break;
			}

			case "init": {
				if (trace) {
					spinner?.stop();
					const info = `${event.model} · ${event.toolCount} tools`;
					if (ttyVerbose) ln(A.cyan(info));
					plainLine(`   ${info}\n`);
				}
				break;
			}

			case "compact": {
				spinner?.stop();
				if (ttyVerbose) ln(A.dim("⟳ context compacted"));
				plainLine("   ⟳ context compacted\n");
				break;
			}

			case "rate_limit": {
				spinner?.stop();
				if (ttyVerbose) ln(A.yellow(`⏸ rate limit hit (${event.limitType}) — parking`));
				plainLine(`   ⏸ rate limit hit (${event.limitType}) — parking\n`);
				break;
			}

			case "turn": {
				if (ws) ws.turns = (ws.turns ?? 0) + 1;
				break;
			}

			case "text": {
				if (trace) {
					spinner?.stop();
					const lines = event.content.trim().split("\n");
					if (ttyVerbose) {
						for (const l of lines.slice(0, 4)) ln(`  ${A.dim(l.slice(0, 100))}`);
						if (lines.length > 4) ln(`  ${A.dim(`… +${lines.length - 4} lines`)}`);
					}
					for (const l of lines.slice(0, 4)) plainLine(`     ${l.slice(0, 100)}\n`);
					if (lines.length > 4) plainLine(`     … +${lines.length - 4} lines\n`);
				}
				break;
			}

			case "tool_use": {
				const verb = toolVerb(event.name);
				if (ttyVerbose) {
					if (spinner!.active && MUTATING_TOOLS.has(lastToolName)) {
						spinner!.stop(`${A.yellow("▸")} ${A.bold(lastToolName)}  ${A.dim(lastToolBrief)}`);
					} else {
						spinner!.stop();
					}
					spinner!.start(`${verb} ${event.brief}`);
				}
				const marker = event.mutating ? "▸" : "·";
				plainLine(`   ${marker} ${verb} ${event.brief}\n`);
				lastToolName = event.name;
				lastToolBrief = event.brief;
				if (ws) ws.lastActivity = `${event.mutating ? "▸" : "·"} ${verb} ${event.brief}`;
				break;
			}

			case "tool_error": {
				if (ttyVerbose) {
					spinner!.stop(`${A.red("✗")} ${A.bold(event.name)}  ${A.dim(event.brief)}`);
					ln(`  ${A.red(event.error.slice(0, 120))}`);
				}
				plainLine(`   ✗ ${event.name}: ${event.error.slice(0, 200)}\n`);
				break;
			}

			case "edit_loop": {
				const fileName = event.file.replace(/^.*[/\\]/, "");
				spinner?.stop(`${A.red("⚠")} edit loop: ${A.bold(fileName)} edited ${event.count} times`);
				if (ttyVerbose) ln(A.red(`aborting — stuck in edit loop on ${fileName}`));
				plainLine(`   ⚠ EDIT LOOP: ${fileName} edited ${event.count} times — aborting\n`);
				break;
			}

			case "sdk_error": {
				spinner?.stop();
				if (ttyVerbose) ln(`${A.red("✗")} SDK error: ${A.dim(event.message.slice(0, 120))}`);
				plainLine(`   ✗ SDK error: ${event.message.slice(0, 200)}\n`);
				break;
			}

			case "blocked": {
				spinner?.stop();
				if (ttyVerbose) ln(`${A.red("⚠")} blocked: ${A.dim(event.reason.slice(0, 120))}`);
				plainLine(`   ⚠ BLOCKED: ${event.reason.slice(0, 200)}\n`);
				break;
			}

			case "stalled_ask": {
				if (ttyVerbose) ln(A.dim(`… stalled-ask (observe-only): ${event.tail.slice(0, 100)}`));
				plainLine(`   … stalled-ask (observe-only): ${event.tail.slice(0, 120)}\n`);
				break;
			}

			case "decision": {
				spinner?.stop();
				const fork = event.decision.fork.slice(0, 160);
				if (ttyVerbose) ln(`${A.yellow("⚑")} ${fork}`);
				// The flag is always human-visible, independent of verbose/trace, and is
				// still copied to a configured transcript.
				if (!ttyVerbose) process.stderr.write(`⚑ ${fork}\n`);
				if (!ttyVerbose && fileVerbose && logPath) appendFileSync(logPath, `⚑ ${fork}\n`);
				break;
			}

			case "done": {
				spinner?.stop();
				if (ttyVerbose) {
					process.stderr.write(A.showCursor);
					w("│\n");
					const icon = event.ok ? A.green("✓") : A.red("✗");
					ln(`${icon} ${event.ok ? A.green("done") : A.red(`FAILED (${event.subtype})`)}  ${A.dim("$")}${event.cost.toFixed(2)}  ${A.dim("·")} ${event.turns} turns  ${A.dim("·")} ${fmtElapsed(event.elapsed)}`);
					w(`╰${"─".repeat(51)}\n`);
				}
				plainLine(`   ${event.ok ? "✓ done" : `✗ FAILED (${event.subtype})`}  $${event.cost.toFixed(2)}  ${event.turns} turns  ${fmtElapsed(event.elapsed)}\n`);
				if (ws) ws.step = undefined;
				break;
			}
		}
	};
}
