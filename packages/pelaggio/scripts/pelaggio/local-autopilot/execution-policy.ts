import { lstatSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { localGit } from "./git.js";
import { configPath, policyDir } from "./paths.js";
import { configProblem } from "./transport.js";
import type { ExecutionAssurance, LocalConfig, ParseResult } from "./types.js";

function foldPathCase(path: string): string {
	return path.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Untracked is a provenance check, not proof that policy contents are trustworthy. */
export function resolveExecutionAssurance(cwd: string, config: LocalConfig, allowHost: boolean): ParseResult<ExecutionAssurance> {
	const host: ParseResult<ExecutionAssurance> = { ok: true, value: { mode: "host", contained: false, effectsEnforced: false } };
	if (allowHost) return host;
	if (config.execution?.mode !== "host") {
		return { ok: false, problem: configProblem("contained-unavailable", "contained harness execution is not available in this preview; pass --allow-host-execution or set execution.mode: host in untracked local policy") };
	}
	try {
		if (lstatSync(policyDir(cwd)).isSymbolicLink() || lstatSync(configPath(cwd)).isSymbolicLink()) {
			return { ok: false, problem: configProblem("host-consent-required", "symlink policy cannot authorize host execution; pass --allow-host-execution; run state is unchanged") };
		}
		const git = (args: string[]): string => localGit(cwd, args);
		const root = git(["rev-parse", "--show-toplevel"]).trim();
		const path = relative(root, resolve(configPath(cwd)))
			.split(sep)
			.join("/");
		if (path.startsWith("../") || path === "..") throw new Error("policy outside repository");
		const ancestorPaths = path.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
		const ancestors = new Set(ancestorPaths.map(foldPathCase));
		// Case-insensitive literal pathspecs avoid scanning unrelated index entries, including on case-sensitive hosts.
		// Compare exact identities afterward: tracked siblings still confer no authority.
		const pathspecs = ancestorPaths.map((entry) => `:(top,icase,literal)${entry}`);
		const indexed = git(["-C", root, "ls-files", "--cached", "--full-name", "-z", "--", ...pathspecs]).split("\0");
		const deleted = git(["-C", root, "diff", "--no-relative", "--cached", "--name-only", "--diff-filter=D", "-z", "--", ...pathspecs]).split("\0");
		if ([...indexed, ...deleted].some((entry) => ancestors.has(foldPathCase(entry)))) {
			return { ok: false, problem: configProblem("host-consent-required", "repository-owned policy cannot authorize host execution; pass --allow-host-execution; run state is unchanged") };
		}
		return host;
	} catch {
		return { ok: false, problem: configProblem("host-consent-required", "could not establish untracked local policy provenance; pass --allow-host-execution; run state is unchanged") };
	}
}
