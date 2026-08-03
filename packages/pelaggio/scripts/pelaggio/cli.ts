import { parseArgs } from "node:util";
import type { Flags } from "./types.js";

export type CliIntent = { kind: "run"; flags: Flags } | { kind: "stats"; json: boolean } | { kind: "error"; message: string; exitCode: number };

const OPTIONS = {
	cycles: { type: "string", default: "1" },
	parallel: { type: "string", default: "1" },
	item: { type: "string" },
	resume: { type: "string" },
	from: { type: "string" },
	// Resume-only: path to a file of PR-review findings injected into the implement step
	// (issue #60). No default → unset stays `undefined`.
	"review-findings": { type: "string" },
	verbose: { type: "boolean", default: false },
	trace: { type: "boolean", default: false },
	budget: { type: "string", default: "40" },
	// No default: an unset flag stays `undefined` so `park.max-wait` config can take
	// effect. Precedence (resolved in the orchestrator): CLI flag > config > "6h".
	"max-wait": { type: "string" },
	target: { type: "string" },
	// Pin a model/provider profile for the whole run (issue #247), overriding the automatic
	// quick-mode downgrade. No default → unset stays `undefined`; validated in runOrchestrator.
	profile: { type: "string" },
	"dry-run": { type: "boolean", default: false },
	"no-worktree": { type: "boolean", default: false },
	// Continuous mode (issue #82). No default → unset stays `undefined` so resolveContinuousConfig
	// can distinguish "off" from an explicit `--continuous`.
	continuous: { type: "boolean" },
	// drain | watch. Setting --preset alone enables continuous (default drain when --continuous
	// is set without --preset). Validated in resolveContinuousConfig.
	preset: { type: "string" },
	// Per-calendar-day USD hard cap. No default → unset stays `undefined` (no day cap).
	"day-budget": { type: "string" },
	// Watch-mode free-probe sleep. No default → resolveContinuousConfig uses "5m".
	"probe-interval": { type: "string" },
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
				message: `unexpected extra args after 'stats': ${JSON.stringify(positionals.slice(1))}. Usage: pelaggio stats [--json]`,
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
				`unknown positional args: ${tokens}. The pipeline entry (\`pnpm pelaggio\`) accepts only flags and the \`stats\` subcommand. ` +
				`Subcommands like \`roadmap\` live on the CLI: \`npx pelaggio ${positionals.join(" ")}\`. ` +
				`See TOOL-50: substituting \`pnpm pelaggio …\` for a subcommand re-enters the pipeline instead of dispatching the CLI.`,
			exitCode: 2,
		};
	}

	return { kind: "run", flags: values as Flags };
}
