import { parseArgs } from "node:util";
import type { Flags } from "./types.js";

export type CliIntent = { kind: "run"; flags: Flags } | { kind: "stats"; json: boolean } | { kind: "error"; message: string; exitCode: number };

const OPTIONS = {
	cycles: { type: "string", default: "1" },
	parallel: { type: "string", default: "1" },
	item: { type: "string" },
	resume: { type: "string" },
	from: { type: "string" },
	verbose: { type: "boolean", default: false },
	trace: { type: "boolean", default: false },
	budget: { type: "string", default: "40" },
	"max-wait": { type: "string", default: "6h" },
	target: { type: "string" },
	"dry-run": { type: "boolean", default: false },
	"no-worktree": { type: "boolean", default: false },
	json: { type: "boolean", default: false },
} as const;

export function parseCli(argv: string[]): CliIntent {
	let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; args: string[] }>>;
	try {
		parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { kind: "error", message, exitCode: 2 };
	}

	const { values, positionals } = parsed;

	if (positionals[0] === "stats") {
		if (positionals.length > 1) {
			return {
				kind: "error",
				message: `unexpected extra args after 'stats': ${JSON.stringify(positionals.slice(1))}. Usage: claude-autopilot stats [--json]`,
				exitCode: 2,
			};
		}
		return { kind: "stats", json: !!values.json };
	}

	if (positionals.length > 0) {
		const tokens = JSON.stringify(positionals);
		return {
			kind: "error",
			message:
				`unknown positional args: ${tokens}. The pipeline entry (\`pnpm autopilot\`) accepts only flags and the \`stats\` subcommand. ` +
				`Subcommands like \`roadmap\` live on the CLI: \`npx @cdhorne/claude-autopilot ${positionals.join(" ")}\`. ` +
				`See TOOL-50: a stale npx cache can resolve a bare \`claude-autopilot\` to an unrelated public package, causing the agent to substitute \`pnpm autopilot …\` and recurse the pipeline.`,
			exitCode: 2,
		};
	}

	return { kind: "run", flags: values as Flags };
}
