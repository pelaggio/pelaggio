import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { parseLocalConfig } from "./parse.js";
import { configPath } from "./paths.js";
import { configProblem } from "./transport.js";
import type { LocalConfig, ParseResult } from "./types.js";

export function loadLocalConfig(cwd: string): ParseResult<LocalConfig> {
	const path = configPath(cwd);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { ok: false, problem: configProblem("missing-config", `missing ${path}; write uncommitted local policy before starting a run`) };
		}
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		return { ok: false, problem: configProblem("invalid-yaml", err instanceof Error ? err.message : String(err)) };
	}
	if (parsed === null || parsed === undefined) {
		return { ok: false, problem: configProblem("empty-config", "local config is empty") };
	}
	return parseLocalConfig(parsed);
}
