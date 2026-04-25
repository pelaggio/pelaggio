import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface RegistryEntry {
	slug: string;
	path: string;
}

export class Registry {
	private readonly map = new Map<string, string>();

	constructor(entries: RegistryEntry[]) {
		for (const entry of entries) {
			this.map.set(entry.slug, entry.path);
		}
	}

	path(slug: string): string {
		const p = this.map.get(slug);
		if (p === undefined) {
			throw new RegistryError(`unknown repo slug ${JSON.stringify(slug)}`, "unknown-slug");
		}
		return p;
	}

	has(slug: string): boolean {
		return this.map.has(slug);
	}

	entries(): RegistryEntry[] {
		return Array.from(this.map, ([slug, path]) => ({ slug, path }));
	}
}

export class RegistryError extends Error {
	constructor(
		message: string,
		readonly code: "unknown-slug",
	) {
		super(message);
	}
}

const EXAMPLE_HINT = "infra/autopilot-server/repos.yml.example";

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadRegistry(path: string): Registry {
	if (!existsSync(path)) {
		throw new Error(`registry file not found at ${path}\n(See ${EXAMPLE_HINT} for the expected format.)`);
	}
	const raw = readFileSync(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (e) {
		const hint = e instanceof Error ? e.message : String(e);
		throw new Error(`Failed to parse ${path}: ${hint}`);
	}
	if (parsed === null || parsed === undefined) {
		throw new Error(`${path}: empty file; expected top-level \`repos:\` map (see ${EXAMPLE_HINT})`);
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`${path}: expected a YAML map at the top level, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
	}
	if (!("repos" in parsed)) {
		throw new Error(`${path}: missing \`repos:\` key (see ${EXAMPLE_HINT})`);
	}
	const repos = parsed.repos;
	if (!isPlainObject(repos)) {
		throw new Error(`${path}: \`repos\` must be a map of slug → path`);
	}

	const entries: RegistryEntry[] = [];
	for (const [slug, value] of Object.entries(repos)) {
		if (typeof value !== "string") {
			throw new Error(`${path}: \`repos.${slug}\` must be a string path, got ${typeof value}`);
		}
		if (value.trim() === "") {
			throw new Error(`${path}: \`repos.${slug}\` is empty`);
		}
		const absolute = isAbsolute(value) ? value : resolve(value);
		entries.push({ slug, path: absolute });
	}

	warnOnBasenameCollisions(entries);

	return new Registry(entries);
}

function warnOnBasenameCollisions(entries: RegistryEntry[]): void {
	const byBase = new Map<string, string[]>();
	for (const entry of entries) {
		const base = basename(entry.path);
		const list = byBase.get(base) ?? [];
		list.push(entry.slug);
		byBase.set(base, list);
	}
	for (const [base, slugs] of byBase) {
		if (slugs.length > 1) {
			console.warn(`autopilot-server: worktree-prefix collision on basename ${JSON.stringify(base)} for slugs ${slugs.map((s) => JSON.stringify(s)).join(", ")} — autopilot's worktree detection may misattribute branches across these repos.`);
		}
	}
}
