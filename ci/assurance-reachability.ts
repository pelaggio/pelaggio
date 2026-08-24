/**
 * Reachability over a realization's named symbols.
 *
 * A realization claims a proposition is *implemented*. Existence checks — the file is present, the
 * function is defined, the unit tests pass — cannot distinguish an implemented mechanism from a
 * defined-but-uncalled one. #625 is the worked example: `buildClaudeSeatEnv` had a file, a
 * definition, and thorough tests, and no caller, so a documented trust guarantee never executed.
 * Fifteen review rolls on its own PR did not surface it, because per-PR review reads a diff.
 *
 * Reachable here means "referenced from production source other than its own definition". That is a
 * deliberately weak proxy for real call-graph reachability: it is cheap, has no false negatives for
 * the #625 shape (zero references is zero references), and its false POSITIVES — a symbol referenced
 * only from dead code — are a smaller problem than the silence it replaces.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".claude"]);

/** Production TypeScript under `roots`: no tests, no fixtures, no generated output. */
export function productionSources(repo: string, roots: readonly string[]): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (SKIP_DIRS.has(entry)) continue;
			const full = join(dir, entry);
			let isDir: boolean;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				if (entry === "__tests__") continue;
				walk(full);
			} else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) {
				out.push(full);
			}
		}
	};
	for (const root of roots) walk(join(repo, root));
	return out;
}

/**
 * Blank out comments and string literals so prose cannot vouch for a symbol.
 *
 * This checker's own doc comment names `buildClaudeSeatEnv` as its worked example, which made the
 * unreachable symbol report as reachable on the first run — the failure mode the check exists to
 * catch, reproduced by the check itself. Replaced with spaces rather than removed so line numbers
 * and the definition-line regex still see the original layout.
 */
export function stripCommentsAndStrings(source: string): string {
	const out = source.split("");
	let i = 0;
	const blank = (from: number, to: number): void => {
		for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	while (i < source.length) {
		const two = source.slice(i, i + 2);
		if (two === "//") {
			const end = source.indexOf("\n", i);
			blank(i, end === -1 ? source.length : end);
			i = end === -1 ? source.length : end;
		} else if (two === "/*") {
			const end = source.indexOf("*/", i + 2);
			blank(i, end === -1 ? source.length : end + 2);
			i = end === -1 ? source.length : end + 2;
		} else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
			const quote = source[i];
			let k = i + 1;
			while (k < source.length && source[k] !== quote) k += source[k] === "\\" ? 2 : 1;
			blank(i + 1, k);
			i = k + 1;
		} else {
			i++;
		}
	}
	return out.join("");
}

export interface SymbolReachability {
	symbol: string;
	definedIn: string[];
	referencedFrom: string[];
	reachable: boolean;
}

/** Lines that DEFINE `symbol` rather than use it — excluded so a definition cannot vouch for itself. */
function isDefinitionLine(line: string, symbol: string): boolean {
	const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:export\\s+)?(?:async\\s+)?(?:function|class|const|let|var|type|interface|enum)\\s+${s}\\b`).test(line);
}

export function checkSymbolReachability(repo: string, symbol: string, roots: readonly string[] = ["packages", "ci"]): SymbolReachability {
	const word = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	const definedIn: string[] = [];
	const referencedFrom: string[] = [];
	for (const file of productionSources(repo, roots)) {
		let lines: string[];
		try {
			lines = stripCommentsAndStrings(readFileSync(file, "utf8")).split("\n");
		} catch {
			continue;
		}
		let defines = false;
		let uses = false;
		for (const line of lines) {
			if (!word.test(line)) continue;
			if (isDefinitionLine(line, symbol)) defines = true;
			else uses = true;
		}
		const rel = relative(repo, file);
		if (defines) definedIn.push(rel);
		// A re-export (`export { x } from "./y"`) is a reference, not a call, but it is also not the
		// #625 shape — it means someone deliberately published the symbol. Counted as a reference.
		if (uses) referencedFrom.push(rel);
	}
	return { symbol, definedIn, referencedFrom, reachable: referencedFrom.length > 0 };
}
