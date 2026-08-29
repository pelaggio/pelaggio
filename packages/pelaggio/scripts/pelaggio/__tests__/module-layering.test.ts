/**
 * Module layering conformance — `docs/plans/module-architecture.md` §4.
 *
 * Every non-test module under `scripts/pelaggio` is assigned a layer; an import may only point
 * at the same layer or lower, and entry (L5) modules may be imported only by the package barrel
 * and `main.ts`. Violations are ratcheted through a baseline fixture of exact edges: a new
 * violating edge fails, and a baseline edge that no longer exists fails too (remove it in the
 * same PR that fixes it). An unlisted module fails — extract-and-require, not default-allow.
 *
 * Regenerate the baseline: `MODULE_LAYERING_WRITE=1 npx tsx --test <this file>`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "__tests__", "fixtures", "module-layering-baseline.json");

/** Admission questions per layer live in the plan §2; this table is the path-anchored answer. */
export const LAYERS: Record<string, 0 | 1 | 2 | 3 | 4 | 5> = {
	// L0 foundation — pure types/config/util; no I/O beyond config load, no `.dev` writes.
	"types.ts": 0,
	"config.ts": 0,
	"cli.ts": 0,
	"tui.ts": 0,
	"secret-hygiene.ts": 0,
	"file-lock.ts": 0,
	"artifact-root.ts": 0,
	"attempt-identity.ts": 0,
	"review/taxonomy.ts": 0,
	"review/document.ts": 0,
	"roadmap/types.ts": 0,
	// L1 infra — registers, git, confinement; never policy.
	"flow-events.ts": 1,
	"execution-receipt.ts": 1,
	"freshness-gate-record.ts": 1,
	"pr-review-gate-record.ts": 1,
	"review-findings-archive.ts": 1,
	"review/findings.ts": 1,
	"review/record.ts": 1,
	"review/seats.ts": 1,
	"github-posting.ts": 1,
	"confinement/roots.ts": 1,
	"confinement/sessions.ts": 1,
	"roadmap/beads.ts": 1,
	"roadmap/git-claim.ts": 1,
	"roadmap/github-issues.ts": 1,
	"roadmap/index.ts": 1,
	"roadmap/linear.ts": 1,
	"roadmap/markdown.ts": 1,
	"roadmap/mutation-lock.ts": 1,
	"roadmap/stale-quarantine.ts": 1,
	"roadmap/stale-scan.ts": 1,
	// L2 domain — decides policy/verdicts/dispositions without spawning a provider.
	"effects.ts": 2,
	"decisions.ts": 2,
	"review/loop.ts": 2,
	"review/carry.ts": 2,
	"review/adjudication.ts": 2,
	"review/bench.ts": 2,
	"ship/assisted-by.ts": 2,
	"ship/auto-merge-pr.ts": 2,
	"ship/bookkeeping.ts": 2,
	"ship/ci-guard.ts": 2,
	"ship/decision.ts": 2,
	"ship/direct-push.ts": 2,
	"ship/index.ts": 2,
	"ship/pr-effects.ts": 2,
	"ship/pull-request.ts": 2,
	"provider-routing.ts": 2,
	"driver-assignment.ts": 2,
	"flow-policy.ts": 2,
	"continuous.ts": 2,
	"stats.ts": 2,
	"notify.ts": 2,
	"review-sweep.ts": 2,
	"revise-sweep.ts": 2,
	"review-request-queue.ts": 2,
	"worktree-deps.ts": 2,
	"run-lifecycle.ts": 2,
	"run-lifecycle-worker.ts": 2,
	// L3 execution — spawns or talks to a model/agent process.
	"step-runner.ts": 3,
	"step-runner-shared.ts": 3,
	"codex-provider.ts": 3,
	"grok-provider.ts": 3,
	"opencode-provider.ts": 3,
	"claude-seat.ts": 3,
	"acp-client.ts": 3,
	"contained-execution.ts": 3,
	"egress-broker.ts": 3,
	"egress-policies.ts": 3,
	"grok-sandbox.ts": 3,
	// L4 orchestration — sequences steps or seats end-to-end.
	"pipeline.ts": 4,
	"helpers.ts": 4, // dissolved in plan step 4
	// L5 entry — parses argv and exits. Importable only by index.ts / main.ts.
	"index.ts": 5,
	"main.ts": 5,
	"init.ts": 5,
	"sync.ts": 5,
	"check-skills.ts": 5,
	"decisions-cli.ts": 5,
	"doc-review-cli.ts": 5,
	"land-cli.ts": 5,
	"pr-adjudicate-cli.ts": 5,
	"pr-review-cli.ts": 5,
	"review-bench-cli.ts": 5,
	"revise-cli.ts": 5,
	"roadmap-cli.ts": 5,
	"run-contained-cli.ts": 5,
	"sessions-cli.ts": 5,
	"taxonomy-cli.ts": 5,
};

const ENTRY_IMPORTERS = new Set(["index.ts", "main.ts"]);

function listModules(dir = ROOT): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (name === "__tests__" || name === "node_modules") continue;
		if (statSync(full).isDirectory()) out.push(...listModules(full));
		else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(relative(ROOT, full));
	}
	return out.sort();
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*["'](\.[^"']+)["']/g;

/** Relative import edges, resolved to module paths; `.js` specifiers map to `.ts` sources. */
export function importEdges(modules: string[]): Array<[string, string]> {
	const edges: Array<[string, string]> = [];
	for (const from of modules) {
		const src = readFileSync(join(ROOT, from), "utf8");
		for (const m of src.matchAll(IMPORT_RE)) {
			let to = normalize(join(dirname(from), m[1]));
			if (to.endsWith(".js")) to = `${to.slice(0, -3)}.ts`;
			if (to.endsWith(".mjs")) to = `${to.slice(0, -4)}.ts`;
			edges.push([from, to]);
		}
	}
	return edges;
}

export function violations(modules: string[], edges: Array<[string, string]>): string[] {
	const out = new Set<string>();
	for (const [from, to] of edges) {
		if (!modules.includes(to)) continue; // non-.ts sibling (e.g. worker .mjs shim) — not a module edge
		const lf = LAYERS[from];
		const lt = LAYERS[to];
		if (lf === undefined || lt === undefined) continue; // reported by the unlisted-module test
		const label = `${from} -> ${to}`;
		if (lt === 5 && !ENTRY_IMPORTERS.has(from)) out.add(`${label} (entry module imported)`);
		else if (lf < lt) out.add(`${label} (L${lf} -> L${lt})`);
	}
	return [...out].sort();
}

/** Intra-layer cycles are a diagnostic, not a gate — printed so plan steps can burn them down. */
function intraLayerCycles(edges: Array<[string, string]>): string[] {
	const adj = new Map<string, string[]>();
	for (const [a, b] of edges) {
		if (LAYERS[a] !== undefined && LAYERS[a] === LAYERS[b]) adj.set(a, [...(adj.get(a) ?? []), b]);
	}
	const found = new Set<string>();
	for (const start of adj.keys()) {
		const stack: Array<[string, string[]]> = [[start, [start]]];
		while (stack.length) {
			const [n, path] = stack.pop() as [string, string[]];
			for (const t of adj.get(n) ?? []) {
				if (t === start) {
					// Canonicalize rotations so each cycle prints once.
					const i = path.indexOf([...path].sort()[0]);
					const rotated = [...path.slice(i), ...path.slice(0, i)];
					found.add([...rotated, rotated[0]].join(" -> "));
				} else if (!path.includes(t) && path.length < 5) stack.push([t, [...path, t]]);
			}
		}
	}
	return [...found].sort();
}

describe("module layering", () => {
	const modules = listModules();
	const edges = importEdges(modules);

	it("every module is assigned a layer (extract-and-require)", () => {
		const unlisted = modules.filter((m) => LAYERS[m] === undefined);
		assert.deepEqual(unlisted, [], `assign a layer in LAYERS for: ${unlisted.join(", ")}`);
		const stale = Object.keys(LAYERS).filter((m) => !modules.includes(m));
		assert.deepEqual(stale, [], `LAYERS names modules that no longer exist: ${stale.join(", ")}`);
	});

	it("violating edges match the baseline exactly (ratchet)", () => {
		const current = violations(modules, edges);
		if (process.env.MODULE_LAYERING_WRITE) {
			writeFileSync(BASELINE_PATH, `${JSON.stringify({ edges: current }, null, "\t")}\n`);
		}
		const baseline: string[] = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).edges;
		const added = current.filter((e) => !baseline.includes(e));
		const fixed = baseline.filter((e) => !current.includes(e));
		assert.deepEqual(added, [], `new layering violations (fix them or, for a planned move, extend the baseline deliberately):\n  ${added.join("\n  ")}`);
		assert.deepEqual(fixed, [], `baseline edges no longer violate — remove them from the fixture:\n  ${fixed.join("\n  ")}`);
	});

	it("reports intra-layer cycles as a diagnostic", () => {
		const cycles = intraLayerCycles(edges);
		if (cycles.length) console.log(`[module-layering] ${cycles.length} intra-layer cycle path(s):\n  ${cycles.join("\n  ")}`);
	});
});
