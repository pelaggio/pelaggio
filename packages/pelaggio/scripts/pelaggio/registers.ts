/**
 * The `.dev/` register table (L0, pure): every directory or file pelaggio keeps under a
 * checkout's `.dev/`, who writes it, and therefore what the seat guards must deny.
 *
 * This is the one place that knows a `.dev` child by name. Path construction goes through
 * `registerPath` / `registerRelativePath`, whose `name` parameter is the closed `RegisterName`
 * union, so an unregistered child cannot be built through the API — and `registers.test.ts`
 * fails on any `.dev` token in a string, template or regex literal anywhere else in the two
 * packages, so it cannot be built around the API either (plan step 7a; guarded-actions §8.2).
 *
 * `kind`:
 * - `harness`   — written only by the harness. Seats may not Write/Edit it and may not name it
 *                 in a Bash command (mere mention is denied, fail closed — #386/#510), except
 *                 entries flagged `agentReads`, which skills legitimately read (tidy reads the
 *                 cycle log) and so stay Bash-mentionable while remaining Write/Edit-denied.
 * - `agent`     — written by agents during a step (plans, ship bodies, review findings).
 * - `seat-tree` — harness-created trees that agents run *inside* (seat worktrees, review heads).
 *
 * Excluded primitives (step 7b): `attempt-identity` keeps its O_EXCL allocator, `file-lock` is a
 * lock, `flow-events` is append-only JSONL, `execution-receipt` keeps its verifying writer. They
 * are registered here for their *paths* only.
 */
import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const DEV_DIR = ".dev";

export type RegisterKind = "harness" | "agent" | "seat-tree";
export type RegisterShape = "dir" | "file" | "file-family";

export interface RegisterSpec {
	/** Directory or file name directly under `.dev/`; for `file-family`, the shared filename prefix. */
	readonly name: string;
	readonly kind: RegisterKind;
	readonly shape: RegisterShape;
	/** Harness-written but legitimately read by skills; stays Bash-mentionable. */
	readonly agentReads?: true;
}

export const REGISTERS = [
	// ── harness evidence stores (Bash mention + Write/Edit denied) ──
	{ name: "sessions", kind: "harness", shape: "dir" },
	{ name: "pr-review-gate-records", kind: "harness", shape: "dir" },
	{ name: "pr-review-adjudication-sources", kind: "harness", shape: "dir" },
	{ name: "pr-review-finding-dispositions", kind: "harness", shape: "dir" },
	{ name: "freshness-gate-records", kind: "harness", shape: "dir" },
	{ name: "effects", kind: "harness", shape: "dir" },
	{ name: "execution-receipts", kind: "harness", shape: "dir" },
	{ name: "attempts", kind: "harness", shape: "dir" },
	{ name: "flow-events", kind: "harness", shape: "dir" },
	{ name: "review-records", kind: "harness", shape: "dir" },
	{ name: "doc-review-records", kind: "harness", shape: "dir" },
	{ name: "doc-review-transcripts", kind: "harness", shape: "dir" },
	{ name: "review-requests", kind: "harness", shape: "dir" },
	{ name: "archive", kind: "harness", shape: "dir" },
	{ name: "revise-exec", kind: "harness", shape: "dir" },
	{ name: "roadmap-mutation.lock", kind: "harness", shape: "file" },
	{ name: "revise-claim.lock", kind: "harness", shape: "file" },
	{ name: "node-modules-repair.lock", kind: "harness", shape: "file" },
	// ── harness-written, skill-read ──
	{ name: "pelaggio-log.jsonl", kind: "harness", shape: "file", agentReads: true },
	{ name: "stale-quarantine.json", kind: "harness", shape: "file", agentReads: true },
	{ name: "pelaggio-", kind: "harness", shape: "file-family", agentReads: true }, // pelaggio-<n>.log, pelaggio-resume-<id>.log
	// ── agent-written ──
	{ name: "plans", kind: "agent", shape: "dir" },
	{ name: "ship", kind: "agent", shape: "dir" },
	{ name: "review-findings-", kind: "agent", shape: "file-family" }, // review-findings-<id>.md
	// ── seat trees agents run inside ──
	{ name: "authoring-review-seats", kind: "seat-tree", shape: "dir" },
	{ name: "review-heads", kind: "seat-tree", shape: "dir" },
	{ name: "contained-runs", kind: "seat-tree", shape: "dir" },
] as const satisfies readonly RegisterSpec[];

export type RegisterName = (typeof REGISTERS)[number]["name"];

/** The table viewed through the wide spec type (the `as const` members omit optional fields). */
export const REGISTER_SPECS: readonly RegisterSpec[] = REGISTERS;

export function registerSpec(name: RegisterName): RegisterSpec {
	const spec = REGISTER_SPECS.find((r) => r.name === name);
	if (!spec) throw new Error(`unknown register: ${name}`);
	return spec;
}

/** `<root>/.dev` — private on purpose: exporting it would let callers compose unregistered children. */
function devRoot(root: string): string {
	return resolve(root, DEV_DIR);
}

/** Create `<root>/.dev` (recursively). The path itself is not returned — use `registerPath` for children. */
export function ensureDevRoot(root: string): void {
	mkdirSync(devRoot(root), { recursive: true });
}

/** `<root>/.dev/<name>[/segments…]` — the only way to build an absolute register path. */
export function registerPath(root: string, name: RegisterName, ...segments: string[]): string {
	return resolve(root, DEV_DIR, name, ...segments);
}

/** `<root>/.dev/<prefix><rest>` for a `file-family` register (e.g. `pelaggio-3.log`). */
export function registerFamilyPath(root: string, family: RegisterName, rest: string): string {
	if (registerSpec(family).shape !== "file-family") throw new Error(`${family} is not a file family`);
	return resolve(root, DEV_DIR, `${family}${rest}`);
}

/** `.dev/<prefix><rest>` for a `file-family` register, relative. */
export function registerFamilyRelativePath(family: RegisterName, rest: string): string {
	if (registerSpec(family).shape !== "file-family") throw new Error(`${family} is not a file family`);
	return `${DEV_DIR}/${family}${rest}`;
}

/** `.dev/<name>[/segments…]` — for worktree-relative records and prose. */
export function registerRelativePath(name: RegisterName, ...segments: string[]): string {
	return [DEV_DIR, name, ...segments].join("/");
}

/**
 * Registers a seat may not name in a Bash command nor Write/Edit: harness-written and not
 * skill-read. Derived, never hand-listed — a new harness register is denied by construction.
 */
export function bashDeniedRegisters(): readonly RegisterName[] {
	return REGISTER_SPECS.filter((r) => r.kind === "harness" && !r.agentReads).map((r) => r.name as RegisterName);
}

export interface WriteDeniedRegister {
	readonly name: RegisterName;
	readonly shape: RegisterShape;
	/** Absolute directory / file path, or the absolute filename prefix for a `file-family`. */
	readonly path: string;
}

/**
 * Every harness register under `root`, as the Write/Edit guard must see it. All harness entries
 * are included — `agentReads` relaxes Bash *mention* only; a skill may read the cycle log, never
 * write it — and file-shaped registers (locks, the log, the quarantine file) are covered as well
 * as directories. Derived, never hand-listed.
 */
export function writeDeniedRegisters(root: string): readonly WriteDeniedRegister[] {
	return REGISTER_SPECS.filter((r) => r.kind === "harness").map((r) => ({ name: r.name as RegisterName, shape: r.shape, path: resolve(root, DEV_DIR, r.name) }));
}

/**
 * The harness register an absolute path lands in under `root`, or `null`. Directories match any
 * descendant, files match exactly, file families match by filename prefix in `.dev` itself.
 */
export function writeDeniedRegisterFor(root: string, absolutePath: string): WriteDeniedRegister | null {
	for (const register of writeDeniedRegisters(root)) {
		if (register.shape === "dir") {
			if (absolutePath === register.path || absolutePath.startsWith(`${register.path}/`)) return register;
		} else if (register.shape === "file") {
			if (absolutePath === register.path) return register;
		} else if (dirname(absolutePath) === devRoot(root) && basename(absolutePath).startsWith(register.name)) {
			return register;
		}
	}
	return null;
}
